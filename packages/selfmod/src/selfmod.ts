import { PluginInventory, PluginStore, DisposerStack, type DynamicPackage } from '@shanhai/kernel'
import type { ToolContract } from '@shanhai/tools'
import vm from 'node:vm'
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
 * - 本文件负责「运行时执行」：plugin_run 的 vm 沙箱评估 host 半、browser 半投递 + round-trip 审批、
 *   以及把五个 plugin_* 工具注册为 model-facing 工具。
 *
 * 沙箱约束（对齐设计文档 1.9）：
 * - host 半在 node:vm 中评估，隔离 globals（非安全边界，信任立场等同 bash 访问）。
 * - 沙箱 ctx façade 刻意不暴露 effect()，cleanup 路径只限 on / provide / tools.register / openWindow 四条，
 *   且都自动撤销——从机制上杜绝「裸副作用」导致无法热插拔（openWindow 撤销时自动关闭已打开的窗口）。
 * - 动态 package 仅内存态：不落盘、不装包、不存活重启；session 隔离（一个会话定义的 package 其他会话不可见）。
 */

/**
 * host 半代码契约：必须 `module.exports = (ctx) => disposer`（不能写裸箭头函数，否则 vm 沙箱取不到导出函数会报错）。
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

/** 自修改运行时对外的依赖注入点（由 bootstrap 装配，桥接到内核事件总线 / 工具注册表 / IPC） */
export interface SelfModifyHooks {
  /** 系统已知的服务名（plugin_inspect 报告用） */
  listServices(): string[]
  /** 当前可见的工具名（plugin_inspect 报告用；sessionId 用于区分管家会话与普通会话的工具集） */
  listTools(sessionId?: string): string[]
  /** 当前可挂载/替换的 UI 插槽名（plugin_inspect 报告用，对齐内核 UI slot 表面） */
  listSlots(): string[]
  /** 动态注册工具（host 半 tools.register），返回撤销函数 */
  registerTool(tool: ToolContract): () => void
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

/** vm 沙箱评估 host 半代码，拿到工厂函数 (ctx) => disposer */
function evalHostCode(code: string): (ctx: HostFacade) => unknown {
  const sandbox: { module: { exports: unknown }; exports: unknown } = {
    module: { exports: {} },
    exports: {},
  }
  const context = vm.createContext(sandbox)
  // filename 仅用于诊断（报错堆栈定位），不代表真实文件
  const script = new vm.Script(code, { filename: 'dynamic-package-host.js' })
  script.runInContext(context)
  const factory = sandbox.module.exports
  if (typeof factory !== 'function') {
    throw new Error('host 半代码必须导出函数：(ctx) => disposer')
  }
  return factory as (ctx: HostFacade) => unknown
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
 * 第 3 步：host 半脱离 node:vm 源码字符串，改为加载 esbuild 打包的 dist/host.cjs，从而能 require 第三方依赖。
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
      code?: string
      client?: string
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

  /** plugin_run：vm 评估 host 半 + 投递 browser 半（带 UI 的需人 approve；skipApproval 供 install/restore 复用，免重复审批） */
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
    if (!pkg.code && !pkg.client && !pkg.entryHost && !pkg.entryHtml) {
      throw new Error(`动态包 "${pkg.name}" 没有可运行的代码（需 code / client / entryHost / entryHtml 至少其一）`)
    }

    const stack = new DisposerStack()

    // —— host 半：优先 require 编译产物（entryHost），否则 vm 沙箱评估源码（code）。facade 只暴露五条能力 ——
    if (pkg.entryHost && existsSync(pkg.entryHost)) {
      const factory = loadHostEntry(pkg.entryHost)
      // 卸载时清 require 缓存，避免重复加载/内存泄漏（stack 撤销时调用）
      const entry = pkg.entryHost
      stack.collect(() => unloadHostEntry(entry))
      const ret = await factory(this.buildFacade(pkg, stack))
      stack.collect(ret as () => void | Promise<void>)
    } else if (pkg.code) {
      const factory = evalHostCode(pkg.code)
      const ret = await factory(this.buildFacade(pkg, stack))
      stack.collect(ret as () => void | Promise<void>)
    }

    // —— browser 半：round-trip 审批（用户 approve 才投递；reject 则撤销 host 半并抛错）——
    // 有 client 源码（slots/窗口组件）或 client 编译产物（entryHtml）都要注册窗口应用。
    // skipApproval（install/restore 已获授权）时直接投递，不再二次弹审批。
    let clientDelivered = false
    if (pkg.client || pkg.entryHtml) {
      const approved = opts.skipApproval ? true : await this.hooks.requestClientRun(pkg, sessionId)
      if (!approved) {
        await stack.dispose()
        throw new Error(`用户拒绝了动态包 "${pkg.name}" 的浏览器半投递`)
      }
      await this.hooks.deliverClient(pkg)
      clientDelivered = true
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
        this.services.set(name, impl)
        stack.collect(() => {
          if (this.services.get(name) === impl) this.services.delete(name)
        })
      },
      tools: {
        register: (tool) => {
          const off = this.hooks.registerTool(tool)
          stack.collect(() => {
            off()
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

  /** 计算持久化 id：name 转 kebab-case；空或含非法字符则报错 */
  private static persistIdOf(pkg: DynamicPackage, explicit?: string): string {
    return normalizePluginId(explicit ?? pkg.name)
  }

  /**
   * 部署编译产物（第 7 步收口）：消除「plugin_build 产物在 workspace、install 探测 plugins/<id>/dist」之间的手动 cp。
   * 若 plugins/<id>/dist 无任何产物、但 plugins-workspace/<id>/dist 有，则自动复制整个 dist 过去，再交给 install 探测。
   * 已有产物或 workspace 无产物时静默跳过（保持向后兼容：用户手动 cp 的场景不受影响）。
   */
  private async deployArtifacts(id: string): Promise<void> {
    if (!this.store) return
    const hostEntry = this.store.entryFile(id, 'host')
    const htmlEntry = this.store.entryFile(id, 'client')
    if (existsSync(hostEntry) || existsSync(htmlEntry)) return
    const wsDist = join(SCAFFOLD_WORKSPACE_DIR, id, 'dist')
    if (!existsSync(wsDist)) return
    if (!existsSync(join(wsDist, 'host.cjs')) && !existsSync(join(wsDist, 'client.html'))) return
    const targetDist = dirname(hostEntry)
    await fs.mkdir(targetDist, { recursive: true })
    await fs.cp(wsDist, targetDist, { recursive: true })
  }

  /** plugin_install：把验证通过的动态包持久化到内核并激活（跨会话、跨重启留存） */
  async install(dynId: string, sessionId: string, persistId?: string): Promise<{ id: string; installed: boolean }> {
    const pkg = this.inventory.get(dynId)
    if (!pkg) throw new Error(`动态包不存在: ${dynId}`)
    if (pkg.sessionId !== sessionId) throw new Error(`动态包 "${pkg.name}" 属于其他会话，无权安装`)
    if (!this.store) throw new Error('插件仓库未装配，无法安装')

    const id = SelfModifyRuntime.persistIdOf(pkg, persistId)

    // 部署产物：workspace/dist 有产物且 plugins/<id>/dist 无产物时自动复制（消除手动 cp）
    await this.deployArtifacts(id)

    // 探测编译产物（id 确定后，产物路径 = ~/.shanhai/plugins/<id>/dist/{host.cjs,client.html}）
    const entryHost = this.store.entryFile(id, 'host')
    const entryHtml = this.store.entryFile(id, 'client')
    const hasHost = existsSync(entryHost)
    const hasHtml = existsSync(entryHtml)

    // 至少要有一种可执行载体：host 半源码 / client 半源码 / host 编译产物 / client 编译产物
    if (!pkg.code && !pkg.client && !hasHost && !hasHtml) {
      throw new Error(`动态包 "${pkg.name}" 没有可安装的代码（需 code / client / dist/host.cjs / dist/client.html 至少其一）`)
    }

    // 已存在同名已安装插件 → 视为升级：先卸载旧的
    if (this.inventory.list().some((p) => p.id === id && p.status === 'installed')) {
      await this.uninstall(id)
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

    // 激活（install 工具顶层已审批，skipApproval 避免 browser 半二次弹窗）
    await this.run(id, sessionId, { skipApproval: true })

    // 持久化（permissions / entryHost / entryHtml / icon / dependencies / kind 随 manifest 落盘，install 顶层审批即视为批准其声明的权限）
    // kind：有编译产物（dist/host.cjs 或 dist/client.html）记为 bundled（工程化），否则记为 source（快速原型，仅源码字符串）。
    await this.store.install({
      id,
      name: pkg.name,
      purpose: pkg.purpose,
      version: pkg.version,
      code: pkg.code,
      client: pkg.client,
      permissions: pkg.permissions ?? [],
      entryHost: pkg.entryHost,
      entryHtml: pkg.entryHtml,
      icon: pkg.icon,
      dependencies: pkg.dependencies,
      kind: hasHost || hasHtml ? 'bundled' : 'source',
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
        code: meta.code,
        client: meta.client,
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
    const registeredTools: string[] = []

    const mockHooks: SelfModifyHooks = {
      listServices: () => [],
      listTools: () => [],
      listSlots: () => [],
      registerTool: (tool) => {
        registeredTools.push(tool.name)
        return () => {}
      },
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
        registeredTools,
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
        '开发插件前先 skill_read plugin-protocol 读完整规范（本文是精炼速查版）。' +
        '定义一个动态插件包（仅记录、不运行），返回 dyn-<n> id。name 是包名，purpose 说明用途。' +
        '【host 半 code】两条链路：① 快速原型 = 源码字符串，必须 module.exports = (ctx) => disposer（不能写裸箭头函数，否则 vm 沙箱取不到导出会报错）；② 工程化 = 编译产物 dist/host.cjs（esbuild 自包含 bundle，require 加载、可 require 第三方依赖，install 时自动探测）。ctx 提供五条能力：' +
        'on(name,listener) 订阅内核事件、provide(name,impl) 注册命名服务、tools.register(tool) 注册全局工具、' +
        'openWindow(appId?) 打开本插件独立窗口、closeWindow(appId?) 关闭它；刻意不暴露 effect()，cleanup 只走前四条自动撤销路径。' +
        'disposer 可为 函数 / null / Iterable / Promise（撤销时逆序调用，单个失败不阻断其余）。' +
        '【client 半 client】两种形态（均用 new Function 编译、不经过 JSX，必须用 React.createElement 写、禁止 <div> 这类 JSX 语法）：' +
        '① UI 插槽形态（默认）：function(React, slots, useUIContext){ slots.register({ slot, id, component }) }，slots 只有 register 一个方法，component 内可调 useUIContext()；' +
        '② 窗口应用形态（配合 host 半 openWindow）：function(React, helpers){ return 组件函数 }（helpers={ close, appId, name }），必须 return 一个 React 组件函数、不能写箭头函数直接返回对象，且窗口形态在独立渲染进程、不能用 useUIContext()。' +
        '注意：openWindow 在 run/install 阶段即开窗（点 Dock 图标才开窗是另一条 openApp 链路）。' +
        'slot 分两类：① 覆盖型（后注册整体替换、注销回退）：shell.sidebar/shell.header/shell.chat/shell.composer/shell.statusbar/shell.terminal/shell.welcome/shell.panels/shell.overlays/dynamic-extension；' +
        '② 追加型（互不覆盖）：composer.below/composer.actions/header.actions/chat.below。想「加按钮/小组件」优先用追加型，不要用覆盖型替换整个区块。' +
        '闭环：plugin_define → plugin_test（自测，临时运行并撤回）→ plugin_install（安装进内核、跨会话/跨重启留存）→ plugin_uninstall（卸载）；plugin_run 仅临时运行、不持久化。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '包名' },
          purpose: { type: 'string', description: '用途说明（一句话）' },
          code: { type: 'string', description: 'host 半源码（可选）' },
          client: { type: 'string', description: 'browser 半源码（可选，须用 React.createElement，不能写 JSX）' },
          permissions: { type: 'array', items: { type: 'string' }, description: '可选：插件声明的白名单能力名清单（窗口应用形态才需要，用于调 window.shanhaiPlugin 桥）。完整可声明清单：getVersion / clipboardWriteText / clipboardReadText / speak / selectDirectory / listSessions / listMemory / getUiState(精简版) / closeApp(仅自身) / getWallpaper / getTokenStats。缺省=空数组=最小权限；install 时随 manifest 落盘并审批' },
          icon: { type: 'string', description: '可选：图标相对路径（相对插件目录，如 icon.png / assets/icon.png），供 Dock 图标渲染用；需该文件已放在 ~/.shanhai/plugins/<id>/ 下' },
          dependencies: { type: 'object', description: '可选：依赖声明（包名→版本），仅供工程化插件的 package.json 参考/审计，运行时不自解析依赖' },
        },
        required: ['name', 'purpose'],
      },
      riskLevel: 'readonly',
      execute: async (args) => {
        const pkg = this.define(
          {
            name: String(args.name ?? ''),
            purpose: String(args.purpose ?? ''),
            code: args.code ? String(args.code) : undefined,
            client: args.client ? String(args.client) : undefined,
            permissions: Array.isArray(args.permissions) ? args.permissions.map((x) => String(x)) : undefined,
            icon: args.icon ? String(args.icon) : undefined,
            dependencies: args.dependencies && typeof args.dependencies === 'object' ? (args.dependencies as Record<string, string>) : undefined,
          },
          sid(),
        )
        return { id: pkg.id, name: pkg.name, purpose: pkg.purpose, status: pkg.status, permissions: pkg.permissions }
      },
    }

    const runTool: ToolContract = {
      name: 'plugin_run',
      description:
        '运行一个已定义的动态插件包（先 plugin_define 拿到 id）。host 半在进程内执行，' +
        'browser 半会请求用户确认后投递到界面。返回 clientDelivered 表示界面部分是否已生效。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '动态包 id（plugin_define 返回的 dyn-<n>）' } },
        required: ['id'],
      },
      // 注意：不设 approvalRequired / 高危 riskLevel，避免与 browser 半投递审批（requestClientRun）叠加成双重确认。
      // host 半在 vm 沙箱内执行、facade 仅暴露三条自动撤销路径，风险可控；真正的「投递 UI 到界面」已在 requestClientRun 单独审批。
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
        '验证一个已定义的动态插件包：临时运行（host 半执行 + browser 半投递）后立即撤回，返回验证结果。' +
        '用于「开发完先自测、确认没问题再 plugin_install 安装」的闭环。测试不会持久化、不影响正式安装。',
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
        '可选 persistId 指定稳定英文 id，缺省用插件 name 生成。安装前建议先 plugin_test 验证。',
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

    return [inspectTool, defineTool, runTool, stopTool, undefineTool, testTool, installTool, uninstallTool, scaffoldTool, buildTool, testLoadTool, verifyTool]
  }
}
