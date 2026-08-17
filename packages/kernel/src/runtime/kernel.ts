import { createContext, type Context, type Plugin } from './context'
import type { Inject } from '../types'

/**
 * Kernel：组合根。
 *
 * 持有根 Context（无父、无 fiber），提供插件的挂载/卸载入口。
 * 上层（runtime / desktop）通过 Kernel 装配底座服务与产品插件。
 */
export class Kernel {
  readonly ctx: Context

  constructor() {
    this.ctx = createContext()
  }

  /** 挂载插件：返回 Fiber（await 等待 settle，启动错误会 reject） */
  plugin<T>(plugin: Plugin<T>, config?: T) {
    return this.ctx.plugin(plugin, config)
  }

  /** 依赖注入简写 */
  inject<M extends Record<string, unknown>>(deps: Inject<M>, callback: Parameters<Context['inject']>[1]) {
    return this.ctx.inject(deps, callback)
  }

  /** 卸载根上下文全部 fiber（逆序） */
  async dispose(): Promise<void> {
    await this.ctx.dispose()
  }
}
