import { PluginInventory, PluginStore, DisposerStack, type DynamicPackage } from '@shanhai/kernel'
import type { ToolContract } from '@shanhai/tools'
import vm from 'node:vm'

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
 * - 沙箱 ctx façade 刻意不暴露 effect()，cleanup 路径只限 on / provide / tools.register 三条，
 *   且三条都自动撤销——从机制上杜绝「裸副作用」导致无法热插拔。
 * - 动态 package 仅内存态：不落盘、不装包、不存活重启；session 隔离（一个会话定义的 package 其他会话不可见）。
 */

/** host 半代码契约：module.exports = (ctx) => disposer；ctx 只提供 on / provide / tools.register */
interface HostFacade {
  on(name: string, listener: (...args: unknown[]) => unknown): void
  provide(name: string, impl: unknown): void
  tools: { register(tool: ToolContract): void }
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
  define(def: { name: string; purpose: string; code?: string; client?: string }, sessionId: string): DynamicPackage {
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
    if (!pkg.code && !pkg.client) throw new Error(`动态包 "${pkg.name}" 没有可运行的代码`)

    const stack = new DisposerStack()

    // —— host 半：vm 沙箱评估，facade 只暴露 on / provide / tools.register 三条自动撤销路径 ——
    if (pkg.code) {
      const factory = evalHostCode(pkg.code)
      const facade: HostFacade = {
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
        // 刻意不暴露 effect()：动态 package 的 cleanup 只能走上面三条，杜绝裸副作用
      }
      const ret = await factory(facade)
      stack.collect(ret as () => void | Promise<void>)
    }

    // —— browser 半：round-trip 审批（用户 approve 才投递；reject 则撤销 host 半并抛错）——
    // skipApproval（install/restore 已获授权）时直接投递，不再二次弹审批。
    let clientDelivered = false
    if (pkg.client) {
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
    const raw = (explicit ?? pkg.name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (!raw) {
      throw new Error(`插件 name 无法生成持久化 id（需含字母/数字/连字符），请给插件一个英文短 id（如 todo-list）`)
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
      throw new Error(`非法持久化 id（仅允许字母/数字/下划线/连字符）: ${raw}`)
    }
    return raw
  }

  /** plugin_install：把验证通过的动态包持久化到内核并激活（跨会话、跨重启留存） */
  async install(dynId: string, sessionId: string, persistId?: string): Promise<{ id: string; installed: boolean }> {
    const pkg = this.inventory.get(dynId)
    if (!pkg) throw new Error(`动态包不存在: ${dynId}`)
    if (pkg.sessionId !== sessionId) throw new Error(`动态包 "${pkg.name}" 属于其他会话，无权安装`)
    if (!pkg.code && !pkg.client) throw new Error(`动态包 "${pkg.name}" 没有可安装的代码`)
    if (!this.store) throw new Error('插件仓库未装配，无法安装')

    const id = SelfModifyRuntime.persistIdOf(pkg, persistId)

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

    // 激活（install 工具顶层已审批，skipApproval 避免 browser 半二次弹窗）
    await this.run(id, sessionId, { skipApproval: true })

    // 持久化
    await this.store.install({
      id,
      name: pkg.name,
      purpose: pkg.purpose,
      version: pkg.version,
      code: pkg.code,
      client: pkg.client,
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
        '定义一个新的动态插件包（仅记录、不运行）。name 是包名，purpose 说明用途，' +
        'code 是 host 半源码（运行在进程内，导出函数 (ctx) => disposer，ctx 提供 on/provide/tools.register）。' +
        'client 是 browser 半源码（投递到界面），契约形如 (React, slots, useUIContext) => { slots.register({ slot, id, component }) }；' +
        'component 必须是 React 组件，内部可调 useUIContext() 获取会话/消息/输入/发消息等应用状态；' +
        '注意：client 代码在浏览器里用 new Function 执行，不经过 JSX 编译，所以写组件必须用 React.createElement(...)，禁止写 <div> 这类 JSX 语法。' +
        'slot 分两类：' +
        '① 覆盖型（整体替换该区块，后注册覆盖，注销回退）：shell.sidebar / shell.header / shell.chat / shell.composer / shell.statusbar / shell.welcome / shell.panels / shell.overlays / dynamic-extension；' +
        '② 追加型（往区块内部追加，互不覆盖，用于「加按钮/小组件」）：composer.below（输入框下方）/ composer.actions（输入框工具栏）/ header.actions（顶栏右侧）/ chat.below（消息流下方）。' +
        '想「在某处加一个按钮或小组件」时优先用追加型插槽，不要用覆盖型去替换整个区块。' +
        '定义后返回 dyn-<n> id。完整闭环：plugin_define（定义）→ plugin_test（自测）→ plugin_install（安装进内核，跨会话/跨重启留存）→ plugin_uninstall（卸载）；plugin_run 仅临时运行、不持久化。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '包名' },
          purpose: { type: 'string', description: '用途说明（一句话）' },
          code: { type: 'string', description: 'host 半源码（可选）' },
          client: { type: 'string', description: 'browser 半源码（可选，须用 React.createElement，不能写 JSX）' },
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
          },
          sid(),
        )
        return { id: pkg.id, name: pkg.name, purpose: pkg.purpose, status: pkg.status }
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

    return [inspectTool, defineTool, runTool, stopTool, undefineTool, testTool, installTool, uninstallTool]
  }
}
