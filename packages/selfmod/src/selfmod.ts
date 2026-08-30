import { PluginInventory, PluginStore, DisposerStack, type DynamicPackage } from '@shanhai/kernel'
import type { ToolContract } from '@shanhai/tools'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { scaffoldPlugin, SCAFFOLD_WORKSPACE_DIR } from './scaffold'
import { buildPlugin, verifyBuildArtifacts, type PluginBuildResult } from './build'

// 主进程 require 上下文（加载 host 半编译产物 host.cjs；selfmod 被 desktop/runtime bundle 成 ESM，故用 createRequire 拿 CJS require）
const nodeRequire = createRequire(import.meta.url)

/**
 * K5 自修改运行时（对齐 DSH 的 extensions 机制）：让 agent 在会话中检查、定义、运行、停止自己的插件。
 *
 * 职责划分：
 * - `PluginInventory`（kernel 包）只负责「内存清单」（define / inspect / undefine 的记录壳）。
 * - 本文件负责「运行时执行」：plugin_run 加载 host 半编译产物、窗口应用投递 + round-trip 审批、
 *   以及把 plugin_* 工具注册为 model-facing 工具。
 *
 * 沙箱约束（对齐设计文档 1.9）：
 * - host 半以 require 自包含 bundle 的方式加载（越权审计兜底，信任立场等同 bash 访问）。
 * - 沙箱 ctx façade 刻意不暴露 effect()，cleanup 路径只限 on / provide / tools.register / openWindow 四条，
 *   且都自动撤销——从机制上杜绝「裸副作用」导致无法热插拔（openWindow 撤销时自动关闭已打开的窗口）。
 * - 动态 package 仅内存态：不落盘、不装包、不存活重启；session 隔离（一个会话定义的 package 其他会话不可见）。
 */

/**
 * host 半代码契约：必须 `module.exports = (ctx) => disposer`。
 * ctx 提供 on / provide / tools.register / openWindow / closeWindow 五条能力；disposer 可为函数 / null / Iterable / Promise，撤销时逆序调用。
 */
interface HostFacade {
  on(name: string, listener: (...args: unknown[]) => unknown): void
  provide(name: string, impl: unknown): void
  tools: { register(tool: ToolContract): void }
  /** 打开本插件的窗口应用（appId 缺省 = 插件 id，已安装插件即持久化 id；窗口内容由 client 半源码提供） */
  openWindow(appId?: string): void
  /** 关闭本插件的窗口应用（appId 缺省 = 插件 id）；撤销/卸载/停止时也会自动关闭所有已打开窗口 */
  closeWindow(appId?: string): void
}

/**
 * 插件注册的全局工具条目（集中存储于 SelfModifyRuntime.pluginTools Registry）。
 * 插件 host 半 `ctx.tools.register(tool)` 不再直接把工具 push 进顶层工具表，而是收集到这里，
 * 由统一调度工具 `plugin_tool` 按 action 分派执行（形如 computer-use 的 skill_run）。含来源插件/风险标记。
 */
interface PluginToolEntry {
  name: string
  tool: ToolContract
  pkgId: string
  pkgName: string
}

/** 自修改运行时对外的依赖注入点（由 bootstrap 装配，桥接到内核事件总线 / 工具注册表 / IPC） */
export interface SelfModifyHooks {
  /** 系统已知的服务名（plugin_inspect 报告用） */
  listServices(): string[]
  /** 当前可见的工具名（plugin_inspect 报告用；sessionId 用于区分管家会话与普通会话的工具集） */
  listTools(sessionId?: string): string[]
  /** 当前可挂载/替换的 UI 插槽名（plugin_inspect 报告用，对齐内核 UI slot 表面） */
  listSlots(): string[]
  /** 动态注册事件监听（host 半 ctx.on），返回撤销函数 */
  onEvent(name: string, listener: (...args: unknown[]) => unknown): () => void
  /** round-trip 审批：带 browser 半的 run 阻塞在这里，直到用户在页面 approve/reject */
  requestClientRun(pkg: DynamicPackage, sessionId: string): Promise<boolean>
  /** 投递 browser 半代码到渲染进程（slots 注册渲染） */
  deliverClient(pkg: DynamicPackage): Promise<void>
  /** 通知渲染进程卸载 browser 半 */
  removeClient(pkgId: string): Promise<void>
  /** 打开插件的窗口应用（appId = 插件持久化 id；由主进程 openApp 复用 app 窗口类型承载，窗口内容由 client 半源码提供） */
  openAppWindow(appId: string): void
  /** 关闭插件的窗口应用（appId = 插件持久化 id；由主进程 closeApp 销毁对应 app 窗口） */
  closeAppWindow(appId: string): void
}

/** 兼容两种导出形态：CJS `module.exports = fn`（mod 即 fn）与 ESM→CJS 转换 `export default fn`（mod.default = fn） */
function extractFactory(mod: unknown): unknown {
  if (typeof mod === 'function') return mod
  if (mod && typeof mod === 'object') {
    const m = mod as Record<string, unknown>
    if (typeof m.default === 'function') return m.default
    if (typeof m.factory === 'function') return m.factory
  }
  return mod
}

/**
 * require 加载 host 半编译产物（自包含 bundle），返回工厂函数 (ctx) => disposer。
 *
 * 第 3 步：host 半改为加载 esbuild 打包的 dist/host.cjs，从而能 require 第三方依赖。
 * - 依赖解析：host.cjs 应为「自包含 bundle」（esbuild --bundle --platform=node --format=cjs），第三方依赖已打进产物，
 *   主进程只 require 产物、不做运行时 node_modules 解析。
 * - 越权防护（兜底审计）：产物必须自包含，不得 external 山海内部包 / electron 主进程 API——
 *   否则插件可 require('electron') 触达主进程底层能力。命中则拒绝加载。
 */
function loadHostEntry(entry: string): (ctx: HostFacade) => unknown {
  const src = readFileSync(entry, 'utf8')
  if (/\brequire\s*\(\s*['"](electron|@shanhai[^'"]*)['"]\s*\)/.test(src)) {
    throw new Error('host 半编译产物违规 external（electron / @shanhai/*），请以自包含 bundle 重新构建')
  }
  const resolved = nodeRequire.resolve(entry)
  delete nodeRequire.cache[resolved]
  const factory = extractFactory(nodeRequire(entry))
  if (typeof factory !== 'function') {
    throw new Error('host 半编译产物必须导出工厂函数：(ctx) => disposer')
  }
  return factory as (ctx: HostFacade) => unknown
}

/** 卸载 host 半编译产物：清除 require 缓存，避免重复加载/内存泄漏（stop/uninstall/撤回时调用） */
function unloadHostEntry(entry: string): void {
  try {
    const resolved = nodeRequire.resolve(entry)
    delete nodeRequire.cache[resolved]
  } catch {
    // 产物已删除 / 从未加载
  }
}

/** 规范化插件 id（name 转 kebab-case；空或含非法字符则报错）。persistIdOf 与 plugin_build/test_load/verify 共用 */
function normalizePluginId(raw: string): string {
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!id) {
    throw new Error('插件 name 无法生成持久化 id（需含字母/数字/连字符），请给插件一个英文短 id（如 todo-list）')
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`非法持久化 id（仅允许字母/数字/下划线/连字符）: ${id}`)
  }
  return id
}

export class SelfModifyRuntime {
  private readonly inventory = new PluginInventory()
  private readonly services = new Map<string, unknown>()
  /** 按「插件 id → 服务名 → impl」分组的 host 半服务表（client 半 RPC 用，见 invokeService）。与 services 并存：前者全局去重供 plugin_inspect 报告，后者按插件隔离供 RPC 调用。 */
  private readonly hostServices = new Map<string, Map<string, unknown>>()
  /**
   * 插件注册的全局工具 Registry：host 半 `ctx.tools.register(tool)` 收集到这里（按工具名索引），
   * 不再直接 push 进顶层工具表。由统一调度工具 `plugin_tool` 按 action 分派执行。含来源插件/风险标记。
   */
  private readonly pluginTools = new Map<string, PluginToolEntry>()
  private readonly disposers = new Map<string, () => Promise<void>>()

  constructor(
    private readonly hooks: SelfModifyHooks,
    private readonly store: PluginStore | null = null,
  ) {}

  /** plugin_inspect：只读报告（服务 / 工具 / 动态 package / 已安装插件 / UI 插槽表面） */
  inspect(sessionId: string): unknown {
    const all = this.inventory.list()
    return {
      services: [...new Set([...this.hooks.listServices(), ...this.services.keys()])],
      tools: this.hooks.listTools(sessionId),
      /** 插件注册的全局工具名（经 plugin_tool 分派，不直接进顶层工具表） */
      pluginTools: this.listPluginTools(),
      packages: all.filter((p) => p.sessionId === sessionId && p.status !== 'installed'),
      installed: all.filter((p) => p.status === 'installed'),
      slots: this.hooks.listSlots(),
    }
  }

  /** plugin_define：记录 package（语法检查不运行），返回卡片 */
  define(
    def: {
      name: string
      purpose: string
      /** 版本号（如 2.0.0），install 时随 manifest 落盘；覆盖升级时用于标识版本 */
      version?: string
      permissions?: string[]
      icon?: string
      dependencies?: Record<string, string>
      /** host 半编译产物绝对路径（工程化链路 / 测试加载用；install 时会自动探测，通常无需显式传） */
      entryHost?: string
      /** client 半窗口入口绝对路径（工程化链路 / 测试加载用） */
      entryHtml?: string
    },
    sessionId: string,
  ): DynamicPackage {
    return this.inventory.define({ ...def, sessionId })
  }

  /** plugin_run：加载 host 半编译产物 + 投递窗口应用（带 UI 的需人 approve；skipApproval 供 install/restore 复用，免重复审批） */
  async run(
    id: string,
    sessionId: string,
    opts: { skipApproval?: boolean } = {},
  ): Promise<{ clientDelivered: boolean }> {
    const pkg = this.inventory.get(id)
    if (!pkg) throw new Error(`动态包不存在: ${id}`)
    if (pkg.sessionId !== sessionId && pkg.sessionId !== '*') {
      throw new Error(`动态包 "${pkg.name}" 属于其他会话，无权运行`)
    }
    if (pkg.status === 'running') throw new Error(`动态包 "${pkg.name}" 已在运行`)
    if (!pkg.entryHost && !pkg.entryHtml) {
      throw new Error(`动态包 "${pkg.name}" 没有可运行的产物（需 dist/host.cjs / dist/client.html 至少其一）`)
    }

    const stack = new DisposerStack()

    // —— 窗口应用：round-trip 审批（用户 approve 才投递；reject 则撤销并抛错）——
    // 有 client 编译产物（entryHtml）要注册窗口应用。
    // skipApproval（install/restore 已获授权）时直接投递，不再二次弹审批。
    // 必须先于 host 半 factory：factory 内 ctx.openWindow() 会触发主进程 openApp → isPluginApp 反查
    // 窗口注册表；若此时尚未 deliverClient 注册，会误判为非插件窗口（挂错 preload + 走 loadWindowContent
    // 降级，显示「未知应用」而非编译产物）。故先注册窗口应用，再执行 host 半。
    let clientDelivered = false
    if (pkg.entryHtml) {
      const approved = opts.skipApproval ? true : await this.hooks.requestClientRun(pkg, sessionId)
      if (!approved) {
        await stack.dispose()
        throw new Error(`用户拒绝了动态包 "${pkg.name}" 的窗口应用投递`)
      }
      await this.hooks.deliverClient(pkg)
      clientDelivered = true
    }

    // —— host 半：require 编译产物（entryHost）。facade 只暴露五条能力 ——
    try {
      if (pkg.entryHost && existsSync(pkg.entryHost)) {
        const factory = loadHostEntry(pkg.entryHost)
        // 卸载时清 require 缓存，避免重复加载/内存泄漏（stack 撤销时调用）
        const entry = pkg.entryHost
        stack.collect(() => unloadHostEntry(entry))
        const ret = await factory(this.buildFacade(pkg, stack))
        stack.collect(ret as () => void | Promise<void>)
      }
    } catch (err) {
      // host 半执行失败（越权审计拒绝 / factory 抛错）：撤销已收集的 disposer 与已投递的 client 半，
      // 避免残留半注册状态（on/provide/tools.register/openWindow + 界面组件），再把错误抛给上层。
      await stack.dispose()
      if (clientDelivered) {
        await this.hooks.removeClient(pkg.id).catch(() => undefined)
      }
      throw err
    }

    this.disposers.set(pkg.id, () => stack.dispose())
    this.inventory.setStatus(pkg.id, 'running')
    return { clientDelivered }
  }

  /** 构造 host 半 façade：只暴露 on / provide / tools.register / openWindow / closeWindow 五条能力，且都自动撤销（不暴露 effect()） */
  private buildFacade(pkg: DynamicPackage, stack: DisposerStack): HostFacade {
    return {
      on: (name, listener) => {
        const off = this.hooks.onEvent(name, listener)
        stack.collect(() => {
          off()
        })
      },
      provide: (name, impl) => {
        // 全局命名服务（plugin_inspect 报告用）
        this.services.set(name, impl)
        // 按插件 id 分组（client 半 RPC 用：client 只能调「本插件」注册的服务，见 invokeService）
        let byId = this.hostServices.get(pkg.id)
        if (!byId) {
          byId = new Map()
          this.hostServices.set(pkg.id, byId)
        }
        byId.set(name, impl)
        stack.collect(() => {
          if (this.services.get(name) === impl) this.services.delete(name)
          const m = this.hostServices.get(pkg.id)
          if (m && m.get(name) === impl) m.delete(name)
        })
      },
      tools: {
        register: (tool) => {
          // 插件工具统一收集进 Registry（不再 push 进顶层工具表），由 plugin_tool 按 action 分派。
          this.pluginTools.set(tool.name, { name: tool.name, tool, pkgId: pkg.id, pkgName: pkg.name })
          stack.collect(() => {
            const cur = this.pluginTools.get(tool.name)
            if (cur && cur.tool === tool) this.pluginTools.delete(tool.name)
          })
        },
      },
      openWindow: (appId) => {
        // 打开本插件的窗口应用：appId 缺省 = 插件 id（已安装插件即持久化 id）
        // 自动注册撤销：plugin_stop / plugin_uninstall / plugin_test 撤回时自动关闭该窗口
        const target = appId ?? pkg.id
        this.hooks.openAppWindow(target)
        stack.collect(() => {
          this.hooks.closeAppWindow(target)
        })
      },
      closeWindow: (appId) => {
        // 显式关闭本插件的窗口应用（appId 缺省 = 插件 id）
        this.hooks.closeAppWindow(appId ?? pkg.id)
      },
      // 刻意不暴露 effect()：动态 package 的 cleanup 只能走上面几条，杜绝裸副作用
    }
  }

  /** plugin_stop：撤回 host 半 + browser 半，定义保留可再跑 */
  async stop(id: string): Promise<void> {
    const pkg = this.inventory.get(id)
    if (!pkg) throw new Error(`动态包不存在: ${id}`)
    const disposer = this.disposers.get(id)
    if (disposer) {
      await disposer()
      this.disposers.delete(id)
    }
    await this.hooks.removeClient(id)
    this.inventory.setStatus(id, 'stopped')
  }

  /** plugin_undefine：停止并遗忘定义 */
  async undefine(id: string): Promise<void> {
    await this.stop(id)
    this.inventory.remove(id)
  }

  /** plugin_test：临时运行 + 立即撤回，返回验证结果（不持久化、不影响正式安装） */
  async test(id: string, sessionId: string): Promise<{ ok: boolean; clientDelivered: boolean }> {
    const pkg = this.inventory.get(id)
    if (!pkg) throw new Error(`动态包不存在: ${id}`)
    if (pkg.sessionId !== sessionId && pkg.sessionId !== '*') {
      throw new Error(`动态包 "${pkg.name}" 属于其他会话，无权测试`)
    }
    // 幂等：无论之前什么状态，都「撤回 → 运行 → 撤回」走一遍
    if (pkg.status === 'running') await this.stop(id)
    const { clientDelivered } = await this.run(id, sessionId)
    await this.stop(id)
    return { ok: true, clientDelivered }
  }

  /**
   * client 半 → host 半自定义 RPC：按「插件 id + 服务名」调用 host 半 provide() 注册的服务。
   * 由主进程 plugin:invoke 的 invokePluginService 能力反查窗口 appId → 插件 id 后调用。
   * 安全边界：只查「本插件」的服务表（hostServices 按插件 id 分组），无法越权调其它插件/内核服务；
   * 返回值经 IPC 回传渲染进程，必须是 JSON 可序列化数据（函数/类实例会被序列化丢弃）。
   */
  async invokeService(appId: string, name: string, args: unknown[] = []): Promise<unknown> {
    const impl = this.hostServices.get(appId)?.get(name)
    if (typeof impl !== 'function') {
      throw new Error(`插件 "${appId}" 未注册可调用的 host 服务「${name}」（需在 host 半用 ctx.provide(name, fn) 注册）`)
    }
    return (impl as (...a: unknown[]) => unknown)(...args)
  }

  /** plugin_tool 统一分派：查 Registry 找到对应插件工具并执行（找不到给明确报错） */
  async dispatchPluginTool(action: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.pluginTools.get(action)
    if (!entry) {
      const available = [...this.pluginTools.keys()]
      throw new Error(
        `插件工具不存在：${action}` +
          (available.length > 0 ? `（当前已注册的插件工具：${available.join(', ')}）` : '（当前没有任何插件工具）') +
          '。可先用 plugin_apps 或 plugin_inspect 查看可用工具清单',
      )
    }
    return entry.tool.execute(args)
  }

  /** 列出插件注册的全局工具名（plugin_inspect / plugin_test_load 报告用，经 plugin_tool 分派） */
  listPluginTools(): string[] {
    return [...this.pluginTools.keys()]
  }

  /** plugin_apps：列出所有已安装插件（含窗口应用与纯工具插件），区分有无窗口 */
  listPluginApps(): Array<Record<string, unknown>> {
    return this.inventory
      .list()
      .filter((p) => p.status === 'installed')
      .map((p) => {
        const hasWindow = !!p.entryHtml
        return {
          id: p.id,
          name: p.name,
          purpose: p.purpose,
          version: p.version,
          hasWindow,
          kind: hasWindow ? 'app' : 'tool',
          services: [...(this.hostServices.get(p.id)?.keys() ?? [])],
          tools: [...this.pluginTools.values()].filter((e) => e.pkgId === p.id).map((e) => e.name),
        }
      })
  }

  /** 计算持久化 id：name 转 kebab-case；空或含非法字符则报错 */
  private static persistIdOf(pkg: DynamicPackage, explicit?: string): string {
    return normalizePluginId(explicit ?? pkg.name)
  }

  /**
   * 部署编译产物 + 静态资源（第 7 步收口）：消除「plugin_build 产物在 workspace、install 探测 plugins/<id>/dist」之间的手动 cp。
   * - dist：plugins/<id>/dist 无任何产物、但 plugins-workspace/<id>/dist 有，则自动复制整个 dist 过去，再交给 install 探测。
   * - icon：workspace 根级的 icon.svg / icon.png 自动复制到 plugins/<id>/ 下（install 自动部署 icon，无需手动 cp）。
   * 已有产物或 workspace 无产物时静默跳过（保持向后兼容：用户手动 cp 的场景不受影响）。
   * 注意：本方法在 install 的「覆盖升级 uninstall 删除旧目录」之后调用，故 icon 复制不会被 uninstall 误删。
   */
  private async deployArtifacts(id: string): Promise<void> {
    if (!this.store) return
    const hostEntry = this.store.entryFile(id, 'host')
    const htmlEntry = this.store.entryFile(id, 'client')
    // 1) dist 产物部署
    if (!existsSync(hostEntry) && !existsSync(htmlEntry)) {
      const wsDist = join(SCAFFOLD_WORKSPACE_DIR, id, 'dist')
      if (existsSync(wsDist) && (existsSync(join(wsDist, 'host.cjs')) || existsSync(join(wsDist, 'client.html')))) {
        const targetDist = dirname(hostEntry)
        await fs.mkdir(targetDist, { recursive: true })
        await fs.cp(wsDist, targetDist, { recursive: true })
      }
    }
    // 2) icon 部署（workspace 根级 icon 文件 → plugins/<id>/）
    for (const iconName of ['icon.svg', 'icon.png']) {
      const wsIcon = join(SCAFFOLD_WORKSPACE_DIR, id, iconName)
      if (!existsSync(wsIcon)) continue
      const targetIcon = this.store.resourceFile(id, iconName)
      if (!targetIcon) continue
      await fs.mkdir(dirname(targetIcon), { recursive: true })
      await fs.copyFile(wsIcon, targetIcon)
    }
  }

  /** plugin_install：把验证通过的动态包持久化到内核并激活（跨会话、跨重启留存） */
  async install(dynId: string, sessionId: string, persistId?: string): Promise<{ id: string; installed: boolean }> {
    const pkg = this.inventory.get(dynId)
    if (!pkg) throw new Error(`动态包不存在: ${dynId}`)
    if (pkg.sessionId !== sessionId) throw new Error(`动态包 "${pkg.name}" 属于其他会话，无权安装`)
    if (!this.store) throw new Error('插件仓库未装配，无法安装')

    const id = SelfModifyRuntime.persistIdOf(pkg, persistId)

    // 已存在同名已安装插件 → 视为升级：先卸载旧的（撤销运行 + 删除旧目录含旧 dist）。
    // 必须在 deployArtifacts 之前：否则旧 dist 会让 deployArtifacts「已有产物即跳过」→ 新产物不部署，
    // 而随后 uninstall 又把旧 dist 整个目录删掉，最终 manifest 指向已删除文件（覆盖升级产物丢失）。
    if (this.inventory.list().some((p) => p.id === id && p.status === 'installed')) {
      await this.uninstall(id)
    }

    // 部署产物：workspace/dist 有产物且 plugins/<id>/dist 无产物时自动复制（消除手动 cp）。
    // 覆盖升级时旧目录已在上一步删除，此处会正常部署新产物。
    await this.deployArtifacts(id)

    // 探测编译产物（id 确定后，产物路径 = ~/.shanhai/plugins/<id>/dist/{host.cjs,client.html}）
    const entryHost = this.store.entryFile(id, 'host')
    const entryHtml = this.store.entryFile(id, 'client')
    const hasHost = existsSync(entryHost)
    const hasHtml = existsSync(entryHtml)

    // 至少要有一种可执行载体：host 编译产物 / client 编译产物
    if (!hasHost && !hasHtml) {
      throw new Error(`动态包 "${pkg.name}" 没有可安装的产物（需 dist/host.cjs / dist/client.html 至少其一）`)
    }

    // 若已 running 先撤回（用旧 id 正确卸载 client），再以持久化 id 重新激活
    if (pkg.status === 'running') {
      await this.stop(dynId)
    }
    this.inventory.rename(dynId, id)
    this.inventory.setSession(id, '*')
    // 把探测到的产物路径写回 package（run 阶段据此 require host.cjs / 注册 client.html 窗口应用）
    pkg.entryHost = hasHost ? entryHost : undefined
    pkg.entryHtml = hasHtml ? entryHtml : undefined

    // icon 默认探测：pkg.icon 未显式声明时，自动探测 plugins/<id>/ 下的 icon.svg / icon.png，
    // 并写回 pkg.icon——这样 deliverClient 广播给渲染进程的 icon 与 store.install 落盘的 icon 一致，
    // 确保「scaffold 默认带 icon.svg + install 自动部署 icon」一次到位，无需 AI 手动声明 icon。
    if (!pkg.icon) {
      for (const iconName of ['icon.svg', 'icon.png']) {
        const iconFile = this.store.resourceFile(id, iconName)
        if (iconFile && existsSync(iconFile)) {
          pkg.icon = iconName
          break
        }
      }
    }

    // 激活（install 工具顶层已审批，skipApproval 避免 browser 半二次弹窗）
    await this.run(id, sessionId, { skipApproval: true })

    // 持久化（permissions / entryHost / entryHtml / icon / dependencies / kind 随 manifest 落盘，install 顶层审批即视为批准其声明的权限）
    // kind：有编译产物（dist/host.cjs 或 dist/client.html）记为 bundled（工程化）。
    await this.store.install({
      id,
      name: pkg.name,
      purpose: pkg.purpose,
      version: pkg.version,
      permissions: pkg.permissions ?? [],
      entryHost: pkg.entryHost,
      entryHtml: pkg.entryHtml,
      icon: pkg.icon,
      dependencies: pkg.dependencies,
      kind: 'bundled',
      installedAt: Date.now(),
    })

    this.inventory.setStatus(id, 'installed')
    return { id, installed: true }
  }

  /** plugin_uninstall：卸载已安装插件（撤销运行 + 删除持久化文件） */
  async uninstall(persistId: string): Promise<{ uninstalled: boolean }> {
    if (!this.store) throw new Error('插件仓库未装配，无法卸载')
    const pkg = this.inventory.get(persistId)
    if (pkg) {
      const disposer = this.disposers.get(persistId)
      if (disposer) {
        await disposer()
        this.disposers.delete(persistId)
      }
      await this.hooks.removeClient(persistId)
      this.inventory.remove(persistId)
    }
    await this.store.uninstall(persistId)
    return { uninstalled: true }
  }

  /** 启动时恢复：加载所有已安装插件并重新激活（免审批，之前已授权） */
  async restoreAll(): Promise<number> {
    if (!this.store) return 0
    const metas = await this.store.list()
    let restored = 0
    for (const meta of metas) {
      // 已加载则跳过（幂等）
      if (this.inventory.list().some((p) => p.id === meta.id && p.status === 'installed')) continue
      const pkg = this.inventory.define({
        id: meta.id,
        name: meta.name,
        purpose: meta.purpose,
        version: meta.version,
        sessionId: '*',
        permissions: meta.permissions ?? [],
        entryHost: meta.entryHost,
        entryHtml: meta.entryHtml,
        icon: meta.icon,
        dependencies: meta.dependencies,
      })
      try {
        await this.run(pkg.id, '*', { skipApproval: true })
        this.inventory.setStatus(pkg.id, 'installed')
        restored++
      } catch (err) {
        // 单个插件恢复失败不影响其他插件，也不影响启动
        console.error(`[selfmod] 恢复已安装插件失败: ${meta.id}`, err)
      }
    }
    return restored
  }

  /**
   * plugin_build：进程内编译插件应用项目（第 6 步）。
   * 用山海进程内已有的 esbuild / vite 构建 dist/host.cjs + dist/client.html，不依赖用户手动 npm install。
   */
  async build(id: string, projectDir?: string): Promise<PluginBuildResult> {
    const dir = projectDir ? String(projectDir) : join(SCAFFOLD_WORKSPACE_DIR, id)
    return buildPlugin(dir, id)
  }

  /**
   * plugin_test_load：把编译产物复制到临时目录（~/.shanhai/plugins-test/<id>/）做「干跑加载」，
   * 验证 host 半能 require + factory 被调用 + ctx 五条能力可用 + 能正常卸载回收（disposer + require.cache 清理），
   * 全程不触达正式 ~/.shanhai/plugins/、不注册 pluginApps、不广播 Dock（用 mock hooks + 独立 runtime 隔离）。
   */
  async testLoad(id: string, projectDir?: string): Promise<Record<string, unknown>> {
    const pid = normalizePluginId(id)
    const srcDir = projectDir ? String(projectDir) : join(SCAFFOLD_WORKSPACE_DIR, pid)
    const distDir = join(srcDir, 'dist')
    const hostSrc = join(distDir, 'host.cjs')
    const clientSrc = join(distDir, 'client.html')

    if (!existsSync(hostSrc) && !existsSync(clientSrc)) {
      throw new Error(`插件项目无编译产物（需先 plugin_build 产出 dist/host.cjs 或 dist/client.html）: ${srcDir}`)
    }

    // 复制到临时目录，隔离加载
    const tmpDir = join(homedir(), '.shanhai', 'plugins-test', pid)
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.cp(distDir, join(tmpDir, 'dist'), { recursive: true })
    const tmpHost = join(tmpDir, 'dist', 'host.cjs')

    const openCalls: string[] = []
    const closeCalls: string[] = []
    const events: string[] = []
    const provided: string[] = []

    const mockHooks: SelfModifyHooks = {
      listServices: () => [],
      listTools: () => [],
      listSlots: () => [],
      onEvent: (name) => {
        events.push(name)
        return () => {}
      },
      requestClientRun: async () => true,
      deliverClient: async () => {},
      removeClient: async () => {},
      openAppWindow: (appId) => openCalls.push(appId),
      closeAppWindow: (appId) => closeCalls.push(appId),
    }

    const mock = new SelfModifyRuntime(mockHooks, null)
    let factoryCalled = false
    let disposerCalled = false
    try {
      const pkg = mock.define({ name: pid, purpose: 'plugin_test_load 临时加载', entryHost: existsSync(tmpHost) ? tmpHost : undefined }, '*')
      const { clientDelivered } = await mock.run(pkg.id, '*')
      factoryCalled = true
      const report = mock.inspect('*') as { services: string[] }
      provided.push(...report.services.filter((s) => ![''].includes(s)))
      const hostLoaded = existsSync(tmpHost) ? nodeRequire.cache[nodeRequire.resolve(tmpHost)] !== undefined : true
      // 卸载回收
      await mock.stop(pkg.id)
      disposerCalled = true
      const cacheCleared = existsSync(tmpHost) ? nodeRequire.cache[nodeRequire.resolve(tmpHost)] === undefined : true
      return {
        ok: true,
        id: pid,
        tmpDir,
        hostEntry: tmpHost,
        clientHtml: existsSync(join(tmpDir, 'dist', 'client.html')) ? join(tmpDir, 'dist', 'client.html') : null,
        factoryCalled,
        hostLoaded,
        disposerCalled,
        requireCacheCleared: cacheCleared,
        openWindowCalls: openCalls,
        closeWindowCalls: closeCalls,
        eventSubscriptions: events,
        serviceNames: provided,
        registeredTools: mock.listPluginTools(),
        clientDelivered,
      }
    } finally {
      // 确保清理临时目录，不留残留
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }

  /**
   * plugin_verify：对编译产物做「等价验证」（不依赖 GUI 截图）：产物存在性 + host 半越权审计 +
   * host 半可加载（factory 是函数）+ client.html 结构（含 #root 与产物引用）。GUI 弹窗/白名单桥调用
   * 由 AI 在 install 后经 computer-use/browser-use 截图补充。
   */
  async verify(id: string, projectDir?: string): Promise<Record<string, unknown>> {
    const pid = normalizePluginId(id)
    const dir = projectDir ? String(projectDir) : join(SCAFFOLD_WORKSPACE_DIR, pid)
    const { hostEntry, clientHtml, hostAudit } = await verifyBuildArtifacts(dir)

    let hostLoadable: { ok: boolean; reason?: string } | null = null
    if (hostEntry) {
      try {
        const factory = loadHostEntry(hostEntry)
        hostLoadable = { ok: typeof factory === 'function' }
        unloadHostEntry(hostEntry)
      } catch (err) {
        hostLoadable = { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
    }

    let clientInfo: Record<string, unknown> | null = null
    if (clientHtml) {
      try {
        const html = await fs.readFile(clientHtml, 'utf8')
        clientInfo = {
          hasRoot: html.includes('id="root"') || html.includes("id='root'"),
          referencesAssets: /assets\//.test(html) || /src=/.test(html),
          bytes: html.length,
        }
      } catch (err) {
        clientInfo = { error: err instanceof Error ? err.message : String(err) }
      }
    }

    return {
      id: pid,
      projectDir: resolve(dir),
      hostEntry: hostEntry ? true : false,
      clientHtml: clientHtml ? true : false,
      hostAudit,
      hostLoadable,
      clientInfo,
      verdict: (hostAudit?.ok !== false && hostLoadable?.ok !== false && (hostEntry || clientHtml) ? 'pass' : 'fail'),
    }
  }

  /** 五个 model-facing 工具（plugin_inspect / define / run / stop / undefine） */
  createTools(getSessionId: () => string): ToolContract[] {
    const sid = (): string => getSessionId()

    const inspectTool: ToolContract = {
      name: 'plugin_inspect',
      description:
        '查看当前可自我升级的运行时表面：已注册的服务、可用工具、动态插件包、已安装插件、UI 插槽。' +
        '当你需要了解「能往哪里挂自定义 UI / 注册什么服务 / 有哪些工具可用 / 已安装了哪些插件」时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          what: { type: 'string', description: '可选：services | tools | packages | slots，不传返回全部' },
          name: { type: 'string', description: '可选：进一步过滤的名称' },
        },
      },
      riskLevel: 'readonly',
      execute: async () => this.inspect(sid()),
    }

    const defineTool: ToolContract = {
      name: 'plugin_define',
      description:
        '开发插件前先 skill_read plugin-protocol 读完整规范。' +
        '插件开发统一走「工程化独立应用」链路（源码字符串 code/client 快速原型已废弃移除）。' +
        'plugin_define 只登记插件元信息（name/purpose/permissions/icon/version/dependencies），不产出代码；' +
        '真正的插件产出走 plugin_scaffold（生成可编译项目）→ plugin_build（编译出 dist/ 产物）→ plugin_test_load（干跑加载）→ plugin_verify（等价验证）→ plugin_install（安装进内核）。' +
        'host 半编译产物 dist/host.cjs（esbuild 自包含 bundle，require 加载、可 require 第三方依赖）；client 半窗口入口 dist/client.html（loadFile 加载）。' +
        'host 半工厂契约 (ctx) => disposer，ctx 提供五条能力：on(name,listener) 订阅内核事件、provide(name,impl) 注册命名服务、tools.register(tool) 注册插件工具、openWindow(appId?) 打开本插件独立窗口、closeWindow(appId?) 关闭它；刻意不暴露 effect()，cleanup 只走前四条自动撤销路径。' +
        'disposer 可为 函数 / null / Iterable / Promise（撤销时逆序调用，单个失败不阻断其余）。' +
        '窗口应用默认「不自动开窗」——安装/加载后由用户点 Dock 图标主动打开（openApp → loadFile dist/client.html）；只有 host 半 factory 显式调 ctx.openWindow() 才会在 install 阶段立即开窗（会打断用户当前工作，不推荐）。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '包名' },
          purpose: { type: 'string', description: '用途说明（一句话）' },
          permissions: { type: 'array', items: { type: 'string' }, description: '可选：插件声明的白名单能力名清单（窗口应用形态才需要，用于调 window.shanhaiPlugin 桥）。完整可声明清单：getVersion / clipboardWriteText / clipboardReadText / speak / selectDirectory / listSessions / listMemory / getUiState(精简版) / closeApp(仅自身) / getWallpaper / getTokenStats。缺省=空数组=最小权限；install 时随 manifest 落盘并审批' },
          icon: { type: 'string', description: '可选：图标相对路径（相对插件目录，如 icon.png / assets/icon.png），供 Dock 图标渲染用；需该文件已放在 ~/.shanhai/plugins/<id>/ 下' },
          dependencies: { type: 'object', description: '可选：依赖声明（包名→版本），仅供工程化插件的 package.json 参考/审计，运行时不自解析依赖' },
          version: { type: 'string', description: '可选：插件版本号（如 2.0.0），install 时随 manifest.json 落盘；覆盖升级时用于标识版本' },
        },
        required: ['name', 'purpose'],
      },
      riskLevel: 'readonly',
      execute: async (args) => {
        const pkg = this.define(
          {
            name: String(args.name ?? ''),
            purpose: String(args.purpose ?? ''),
            permissions: Array.isArray(args.permissions) ? args.permissions.map((x) => String(x)) : undefined,
            icon: args.icon ? String(args.icon) : undefined,
            dependencies: args.dependencies && typeof args.dependencies === 'object' ? (args.dependencies as Record<string, string>) : undefined,
            version: args.version ? String(args.version) : undefined,
          },
          sid(),
        )
        return { id: pkg.id, name: pkg.name, purpose: pkg.purpose, status: pkg.status, permissions: pkg.permissions }
      },
    }

    const runTool: ToolContract = {
      name: 'plugin_run',
      description:
        '【已废弃】快速原型（源码字符串 code/client）路径已移除，插件统一走工程化独立应用。' +
        '请改用 plugin_scaffold → plugin_build → plugin_test_load → plugin_verify → plugin_install 闭环，不再用 plugin_run 临时运行源码字符串包。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '动态包 id（plugin_define 返回的 dyn-<n>）' } },
        required: ['id'],
      },
      // 注意：不设 approvalRequired / 高危 riskLevel，避免与 browser 半投递审批（requestClientRun）叠加成双重确认。
      // host 半以 require 编译产物执行、facade 仅暴露三条自动撤销路径，风险可控；真正的「投递 UI 到界面」已在 requestClientRun 单独审批。
      riskLevel: 'reversible',
      execute: async (args) => this.run(String(args.id ?? ''), sid()),
    }

    const stopTool: ToolContract = {
      name: 'plugin_stop',
      description: '撤回一个正在运行的动态插件包（host 半 + browser 半都撤销），定义保留，可再次 plugin_run。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '动态包 id（dyn-<n>）' } },
        required: ['id'],
      },
      riskLevel: 'readonly',
      execute: async (args) => {
        await this.stop(String(args.id ?? ''))
        return { stopped: true }
      },
    }

    const undefineTool: ToolContract = {
      name: 'plugin_undefine',
      description: '停止并永久遗忘一个动态插件包的定义。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '动态包 id（dyn-<n>）' } },
        required: ['id'],
      },
      riskLevel: 'readonly',
      execute: async (args) => {
        await this.undefine(String(args.id ?? ''))
        return { undefined: true }
      },
    }

    const testTool: ToolContract = {
      name: 'plugin_test',
      description:
        '【已废弃】快速原型（源码字符串）路径已移除。工程化自测请改用 plugin_test_load（把 dist 产物复制到临时目录干跑加载），验证能跑 + 能卸载回收。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '动态包 id（plugin_define 返回的 dyn-<n>）' } },
        required: ['id'],
      },
      riskLevel: 'reversible',
      execute: async (args) => this.test(String(args.id ?? ''), sid()),
    }

    const installTool: ToolContract = {
      name: 'plugin_install',
      description:
        '把一个验证通过的动态插件包正式安装到系统内核：持久化落盘（~/.shanhai/plugins/）并激活，' +
        '跨会话、跨重启留存，之后 AI 和用户都能持续使用。安装后返回持久化 id（用于 plugin_uninstall）。' +
        '可选 persistId 指定稳定英文 id，缺省用插件 name 生成。安装前建议先 plugin_test_load / plugin_verify 验证产物。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '动态包 id（plugin_define 返回的 dyn-<n>）' },
          persistId: { type: 'string', description: '可选：稳定英文持久化 id（如 todo-list），缺省由 name 生成' },
        },
        required: ['id'],
      },
      riskLevel: 'reversible',
      approvalRequired: true,
      execute: async (args) =>
        this.install(String(args.id ?? ''), sid(), args.persistId ? String(args.persistId) : undefined),
    }

    const uninstallTool: ToolContract = {
      name: 'plugin_uninstall',
      description:
        '卸载一个已安装的插件（撤销运行 + 删除持久化文件）。参数 id 是 plugin_install 返回的持久化 id。' +
        '卸载后该插件不再跨会话/跨重启存在；会话内动态包请用 plugin_undefine 遗忘。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '持久化 id（plugin_install 返回的 id）' } },
        required: ['id'],
      },
      riskLevel: 'reversible',
      approvalRequired: true,
      execute: async (args) => this.uninstall(String(args.id ?? '')),
    }

    const scaffoldTool: ToolContract = {
      name: 'plugin_scaffold',
      description:
        '从内置模板生成一个可编译的「插件应用」项目到 ~/.shanhai/plugins-workspace/<id>/（含 src/host.ts 主机半、' +
        'src/App.tsx + src/main.tsx + client.html 客户机半、package.json 依赖与 build 脚本、vite/esbuild 构建配置、tsconfig、README）。' +
        '用于「工程化开发复杂插件界面」。这是流水线第 1 步，后续用 plugin_build（进程内编译，免 npm install）→ plugin_test_load → plugin_verify → plugin_install（自动部署产物）串成闭环，无需手动 npm install / cp。' +
        '模板随包分发（终端用户不读仓库源码也能拿到）。生成后返回 dir（项目绝对路径）、files（文件清单）、nextSteps（下一步操作）。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '插件英文短 id（用于目录名 + 持久化 id，仅 [a-zA-Z0-9_-]，如 todo-list）' },
          name: { type: 'string', description: '可选：显示名（缺省 = id）' },
          purpose: { type: 'string', description: '可选：用途说明（缺省 = 山海插件应用）' },
        },
        required: ['id'],
      },
      riskLevel: 'reversible',
      execute: async (args) => {
        const result = await scaffoldPlugin(String(args.id ?? ''), {
          name: args.name ? String(args.name) : undefined,
          purpose: args.purpose ? String(args.purpose) : undefined,
        })
        return result
      },
    }

    const buildTool: ToolContract = {
      name: 'plugin_build',
      description:
        '编译一个「插件应用」项目（由 plugin_scaffold 生成，位于 ~/.shanhai/plugins-workspace/<id>/）到其 dist/ 目录，' +
        '产出 dist/host.cjs（esbuild 自包含 bundle）+ dist/client.html + dist/assets/*（vite 完整 React bundle）。' +
        '进程内构建：用山海自带的 esbuild/vite，不依赖用户手动 npm install / node。' +
        '这是「编写 → 编译 → 测试加载 → 验证 → 安装」流水线的第 2 步（scaffold 之后）。返回 hostEntry/clientHtml/assets/warnings。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '插件英文短 id（项目目录 ~/.shanhai/plugins-workspace/<id>/，缺省据此定位）' },
          projectDir: { type: 'string', description: '可选：插件项目目录绝对路径（缺省用 ~/.shanhai/plugins-workspace/<id>）' },
        },
        required: ['id'],
      },
      riskLevel: 'reversible',
      execute: async (args) => this.build(String(args.id ?? ''), args.projectDir ? String(args.projectDir) : undefined),
    }

    const testLoadTool: ToolContract = {
      name: 'plugin_test_load',
      description:
        '把编译产物复制到临时目录（~/.shanhai/plugins-test/<id>/）做「干跑加载」：require dist/host.cjs + 调用 factory，' +
        '验证 host 半能跑起来、ctx 五条能力（on/provide/tools.register/openWindow/closeWindow）可用、能正常卸载回收（disposer + require.cache 清理）。' +
        '不污染正式 ~/.shanhai/plugins/、不注册 Dock 图标。返回 factoryCalled/hostLoaded/disposerCalled/requireCacheCleared/各 ctx 能力调用记录。' +
        '流水线第 3 步（plugin_build 之后）。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '插件英文短 id（项目目录 ~/.shanhai/plugins-workspace/<id>/，缺省据此定位）' },
          projectDir: { type: 'string', description: '可选：插件项目目录绝对路径（缺省用 ~/.shanhai/plugins-workspace/<id>）' },
        },
        required: ['id'],
      },
      riskLevel: 'reversible',
      execute: async (args) => this.testLoad(String(args.id ?? ''), args.projectDir ? String(args.projectDir) : undefined),
    }

    const verifyTool: ToolContract = {
      name: 'plugin_verify',
      description:
        '对编译产物做「等价验证」：产物存在性（dist/host.cjs + dist/client.html）+ host 半越权审计（不 external electron/@shanhai/*）' +
        '+ host 半可加载（factory 是函数）+ client.html 结构（含 #root 与产物引用）。返回 verdict（pass/fail）。' +
        'GUI 弹窗/白名单桥 window.shanhaiPlugin 调用的截图验证由 AI 在 install 后用 computer-use/browser-use 补充。流水线第 4 步。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '插件英文短 id（项目目录 ~/.shanhai/plugins-workspace/<id>/，缺省据此定位）' },
          projectDir: { type: 'string', description: '可选：插件项目目录绝对路径（缺省用 ~/.shanhai/plugins-workspace/<id>）' },
        },
        required: ['id'],
      },
      riskLevel: 'readonly',
      execute: async (args) => this.verify(String(args.id ?? ''), args.projectDir ? String(args.projectDir) : undefined),
    }

    const pluginToolTool: ToolContract = {
      name: 'plugin_tool',
      description:
        '统一调度「插件注册的工具」。所有已安装插件通过 host 半 ctx.tools.register 注册的工具，都经此工具按 action 分派调用，不再作为顶层 function 暴露。' +
        '先用 plugin_apps（列出插件与它们的工具名）或 plugin_inspect（pluginTools 字段）查到可用的插件工具名，再用 plugin_tool 调用。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '要调用的插件工具名（= 插件 host 半 tools.register 时用的 name）' },
          args: { type: 'object', description: '传给该插件工具的参数对象（按该工具的 inputSchema 填）' },
        },
        required: ['action'],
      },
      riskLevel: 'reversible',
      /** 动态风险：按具体插件工具的 riskLevel / approvalRequired 决定审批粒度 */
      resolveRisk: (args): { riskLevel: import('@shanhai/tools').RiskLevel; approvalRequired: boolean } => {
        const name = String(args.action ?? '')
        const entry = this.pluginTools.get(name)
        if (!entry) return { riskLevel: 'reversible', approvalRequired: false }
        return { riskLevel: entry.tool.riskLevel, approvalRequired: entry.tool.approvalRequired ?? false }
      },
      execute: async (args) => {
        const action = String(args.action ?? '').trim()
        if (!action) throw new Error('plugin_tool 缺少 action 参数（要调用的插件工具名）')
        const a = args.args && typeof args.args === 'object' ? (args.args as Record<string, unknown>) : {}
        return this.dispatchPluginTool(action, a)
      },
    }

    const pluginAppsTool: ToolContract = {
      name: 'plugin_apps',
      description:
        '列出所有已安装的插件应用（含「有窗口的应用插件」与「纯工具插件」），返回 id / 名称 / 描述 / 版本 / 有无窗口 / 注册的服务 / 注册的工具。' +
        '拿到列表后：可用 plugin_tool 调用插件的工具，或对「有窗口的应用插件」用 computer_use / browser_use 做 UI 自动化操作。',
      inputSchema: { type: 'object', properties: {} },
      riskLevel: 'readonly',
      execute: async () => ({ apps: this.listPluginApps() }),
    }

    return [inspectTool, defineTool, runTool, stopTool, undefineTool, testTool, installTool, uninstallTool, scaffoldTool, buildTool, testLoadTool, verifyTool, pluginToolTool, pluginAppsTool]
  }
}
