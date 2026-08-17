import { Events } from './event'
import { Fiber } from './fiber'
import type { Capability, Disposable, Effect, EventOptions, Inject } from '../types'

/** 插件三种形态（对齐 Cordis） */
export type PluginFunction<T = unknown> = (ctx: Context, config: T) => unknown
export type PluginConstructor<T = unknown> = new (ctx: Context, config: T) => unknown
export interface PluginObject<T = unknown> {
  name?: string
  inject?: string[]
  provide?: string[]
  intercept?: Record<string, boolean>
  apply(ctx: Context, config: T): unknown
}
export type Plugin<T = unknown> = PluginFunction<T> | PluginConstructor<T> | PluginObject<T>

export interface ContextMeta {
  fiber?: Fiber
  [key: string]: unknown
}

/**
 * Context：组合上下文（对外是 Proxy，`ctx.xxx` 直接解析服务）。
 *
 * - 服务解析：先查自身，再沿父链向上
 * - extend：创建继承父服务的子上下文
 * - isolate：作用域隔离（同名服务解析到不同实现）
 * - plugin/inject：注册插件（返回 Fiber）
 * - on/emit：事件（监听器挂到所属 fiber，卸载自动撤销）
 */
export class Context {
  readonly root: Context
  readonly fiber: Fiber | null
  private readonly parent: Context | null
  private readonly services = new Map<string, unknown>()
  private readonly events: Events
  private readonly isolates = new Map<string, Map<symbol, unknown>>()
  private readonly fibers: Fiber[] = []
  private caps: Capability | null = null

  constructor(parent?: Context, meta: ContextMeta = {}) {
    this.parent = parent ?? null
    this.root = parent?.root ?? this
    this.fiber = meta.fiber ?? null
    // 事件总线与父共享（同一事件域）
    this.events = parent?.events ?? new Events()
  }

  /** 服务解析：先查自身，再沿父链，最后查隔离作用域。越界消费（consume 未声明）抛错 */
  getService(name: string): unknown {
    if (this.caps?.consume && !this.caps.consume.includes(name)) {
      throw new Error(`capability denied: cannot consume "${name}"`)
    }
    if (this.services.has(name)) return this.services.get(name)
    const isolated = this.lookupIsolate(name)
    if (isolated !== undefined) return isolated
    return this.parent?.getService(name)
  }

  /** 注册服务（Service 构造时自动调用）。越界提供（provide 未声明）抛错 */
  provide(name: string, impl: unknown, _check?: (...args: unknown[]) => boolean): void {
    if (this.caps?.provide && !this.caps.provide.includes(name)) {
      throw new Error(`capability denied: cannot provide "${name}"`)
    }
    this.services.set(name, impl)
    // 依赖变化会触发依赖此服务的 fiber reload（由 registry 层处理）
  }

  /** 能力清单（least privilege）：创建带能力约束的子上下文，越界即抛错 */
  guard(caps: Capability): Context {
    const child = this.extend()
    child.caps = caps
    return child
  }

  /** 创建继承父服务的子上下文 */
  extend(meta: ContextMeta = {}): Context {
    return createContext(this, meta)
  }

  /** 作用域隔离：同名服务在不同 label 下解析到不同实现 */
  isolate(name: string, label?: symbol): Context {
    const key = label ?? Symbol(name)
    if (!this.isolates.has(name)) this.isolates.set(name, new Map())
    this.isolates.get(name)!.set(key, undefined)
    const child = this.extend()
    // 隔离服务的读写落在 child 的隔离表上
    child.setIsolate(name, key)
    return child
  }

  private setIsolate(name: string, key: symbol): void {
    if (!this.isolates.has(name)) this.isolates.set(name, new Map())
    this.isolates.get(name)!.set(key, undefined)
  }

  private lookupIsolate(name: string): unknown {
    const map = this.isolates.get(name)
    if (!map) return undefined
    for (const value of map.values()) {
      if (value !== undefined) return value
    }
    return undefined
  }

  /** 注册插件：解析三种形态，创建 Fiber 并异步加载，返回 Fiber（await 得到 disposeAsync） */
  plugin<T>(plugin: Plugin<T>, config?: T): Fiber {
    const apply = resolvePlugin(plugin)
    const meta = (typeof plugin === 'object' && plugin !== null ? plugin : {}) as PluginObject
    const fiber = new Fiber(apply, config ?? {}, {
      name: meta.name,
      inject: meta.inject,
      provide: meta.provide,
    })
    this.fibers.push(fiber)
    const child = this.extend({ fiber })
    // 异步加载（不阻塞），`await fiber` 会等到 settle
    void fiber.load(child).catch(() => undefined)
    return fiber
  }

  /** 依赖注入简写：ctx.inject(deps, callback) = ctx.plugin({ inject: deps, apply: callback }) */
  inject<M extends Record<string, unknown>>(
    deps: Inject<M>,
    callback: PluginFunction,
  ): Fiber {
    const inject = Array.isArray(deps) ? deps : Object.keys(deps)
    return this.plugin({
      inject: inject as string[],
      apply: callback,
    } as Plugin)
  }

  /** 注册事件监听：挂到所属 fiber（fiber 卸载自动撤销） */
  on(name: string, listener: (...args: unknown[]) => unknown, options?: EventOptions): () => boolean {
    const off = this.events.on(name, listener, options)
    this.fiber?.effect(() => () => {
      off()
    })
    return off
  }

  once(name: string, listener: (...args: unknown[]) => unknown, options?: EventOptions): () => boolean {
    return this.on(name, listener, { ...options, once: true })
  }

  emit(name: string, ...args: unknown[]): void {
    this.events.emit(name, ...args)
  }

  parallel(name: string, ...args: unknown[]): Promise<void> {
    return this.events.parallel(name, ...args)
  }

  serial(name: string, ...args: unknown[]): Promise<unknown> {
    return this.events.serial(name, ...args)
  }

  bail(name: string, ...args: unknown[]): unknown {
    return this.events.bail(name, ...args)
  }

  waterfall(name: string, ...args: unknown[]): unknown {
    return this.events.waterfall(name, ...args)
  }

  /** 注册副作用：挂到所属 fiber（无 fiber 则立即执行、无撤销） */
  effect(execute: () => Effect): Disposable {
    if (this.fiber) return this.fiber.effect(execute)
    const collected: Disposable[] = []
    // 根上下文无 fiber，副作用立即执行，返回空 disposer
    void collected
    return () => undefined
  }

  /** 卸载本上下文创建的全部 fiber（逆序） */
  async dispose(): Promise<void> {
    for (const fiber of this.fibers.slice().reverse()) {
      await fiber.dispose()
    }
    this.fibers.length = 0
  }
}

/** 创建 Proxy 包装的 Context：`ctx.xxx` 优先读自身属性/方法，否则解析服务 */
export function createContext(parent?: Context, meta?: ContextMeta): Context {
  const ctx = new Context(parent, meta)
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (value !== undefined) return value
      if (typeof prop === 'symbol') return undefined
      return target.getService(prop)
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver)
    },
  }) as Context
}

/** 解析插件三种形态为统一的 apply 函数 */
function resolvePlugin<T>(plugin: Plugin<T>): (ctx: Context, config: unknown) => unknown {
  if (typeof plugin === 'function') {
    if (isConstructor(plugin)) {
      return (ctx, config) => new (plugin as PluginConstructor)(ctx, config)
    }
    return (ctx, config) => (plugin as PluginFunction)(ctx, config)
  }
  return (ctx, config) => (plugin as PluginObject).apply(ctx, config)
}

function isConstructor(fn: object): boolean {
  const proto = (fn as { prototype?: object }).prototype
  return !!proto && Object.getOwnPropertyNames(proto).length > 0
}
