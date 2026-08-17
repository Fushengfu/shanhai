/**
 * Service 基类：符号化扩展点（对齐 Cordis）。
 *
 * 五个静态符号：
 * - invoke：可调用服务（如 ctx.logger() 直接调用）
 * - check：可用性谓词，返回 false 则服务不可用
 * - extend：派生扩展服务实例
 * - config / resolveConfig：拦截配置（phantom 类型参数 + 合并）
 */

export interface ServiceContext {
  provide(name: string, impl: unknown, check?: (...args: unknown[]) => boolean): void
}

export abstract class Service<T = never> {
  readonly name: string

  static readonly invoke: unique symbol = Symbol('service.invoke')
  static readonly check: unique symbol = Symbol('service.check')
  static readonly extend: unique symbol = Symbol('service.extend')
  static readonly config: unique symbol = Symbol('service.config')
  static readonly resolveConfig: unique symbol = Symbol('service.resolveConfig')

  constructor(ctx: ServiceContext, name: string) {
    this.name = name
    // 构造即注册：自动 provide 到 ctx，可用性谓词挂在 check 符号上
    ctx.provide(name, this, this.check)
  }

  /** 可用性谓词：默认可用，子类可覆盖 */
  protected check(..._args: unknown[]): boolean {
    return true
  }
}
