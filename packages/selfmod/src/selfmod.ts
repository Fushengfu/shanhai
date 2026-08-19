import { PluginInventory, DisposerStack, type DynamicPackage } from '@shanhai/kernel'
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
  /** 当前可见的工具名（plugin_inspect 报告用） */
  listTools(): string[]
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

  constructor(private readonly hooks: SelfModifyHooks) {}

  /** plugin_inspect：只读报告（服务 / 工具 / 动态 package / slot 表面），按会话过滤动态包 */
  inspect(sessionId: string): unknown {
    return {
      services: [...new Set([...this.hooks.listServices(), ...this.services.keys()])],
      tools: this.hooks.listTools(),
      packages: this.inventory.list().filter((p) => p.sessionId === sessionId),
      slots: ['dynamic-extension'],
    }
  }

  /** plugin_define：记录 package（语法检查不运行），返回卡片 */
  define(def: { name: string; purpose: string; code?: string; client?: string }, sessionId: string): DynamicPackage {
    return this.inventory.define({ ...def, sessionId })
  }

  /** plugin_run：vm 评估 host 半 + 投递 browser 半（带 UI 的需人 approve） */
  async run(id: string, sessionId: string): Promise<{ clientDelivered: boolean }> {
    const pkg = this.inventory.get(id)
    if (!pkg) throw new Error(`动态包不存在: ${id}`)
    if (pkg.sessionId !== sessionId) throw new Error(`动态包 "${pkg.name}" 属于其他会话，无权运行`)
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
    let clientDelivered = false
    if (pkg.client) {
      const approved = await this.hooks.requestClientRun(pkg, sessionId)
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

  /** 五个 model-facing 工具（plugin_inspect / define / run / stop / undefine） */
  createTools(getSessionId: () => string): ToolContract[] {
    const sid = (): string => getSessionId()

    const inspectTool: ToolContract = {
      name: 'plugin_inspect',
      description:
        '查看当前可自我升级的运行时表面：已注册的服务、可用工具、动态插件包、UI 插槽。' +
        '当你需要了解「能往哪里挂自定义 UI / 注册什么服务 / 有哪些工具可用」时使用。',
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
        'code 是 host 半源码（运行在进程内，导出函数 (ctx) => disposer，ctx 提供 on/provide/tools.register），' +
        'client 是 browser 半源码（投递到界面，形如 (React, slots) => { slots.register({slot,id,component}) }）。' +
        '定义后返回 dyn-<n> id，用户会看到一张卡片，需再调 plugin_run 才会真正生效。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '包名' },
          purpose: { type: 'string', description: '用途说明（一句话）' },
          code: { type: 'string', description: 'host 半源码（可选）' },
          client: { type: 'string', description: 'browser 半源码（可选）' },
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
      riskLevel: 'irreversible',
      approvalRequired: true,
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

    return [inspectTool, defineTool, runTool, stopTool, undefineTool]
  }
}
