import { DisposerStack, collectEffect } from './dispose'
import type { Disposable, Effect, FiberState } from '../types'
import type { Context } from './context'

let uidCounter = 0

/** 插件执行函数：ctx 为 Context 代理，config 为经校验的配置 */
export type FiberApply = (ctx: Context, config: unknown) => unknown

export interface FiberMeta {
  /** 诊断名（fiber 名 / logger 名） */
  name?: string
  /** 声明的服务依赖（硬依赖） */
  inject?: string[]
  /** 声明提供的服务名 */
  provide?: string[]
}

/**
 * Fiber：单个插件实例的生命周期容器。
 *
 * 六态：PENDING → LOADING → ACTIVE / FAILED；UNLOADING → DISPOSED。
 * 核心是「注册即副作用」：effect() 立即执行，返回的 disposer 随 fiber 逆序撤销。
 *
 * 关键设计（对齐 Cordis）：`then` 等待 setup settle 后 resolve 为 **disposeAsync 函数**
 * （而非 fiber 自身），从而避免「resolve(thenable) 自引用」导致的 Promise 递归死循环。
 * 因此 `await fiber` 的语义是「等它加载完，拿到撤销函数」，fiber 本身在 settle 后即 ACTIVE。
 */
export class Fiber {
  readonly uid: number = ++uidCounter
  state: FiberState = 'PENDING'
  readonly config: unknown
  /** 注入服务的实现快照（加载完成后由 ServiceStore 填充） */
  store: Record<string, unknown> | undefined

  private readonly disposers = new DisposerStack()
  private setupTask: Promise<void> = Promise.resolve()
  private _apply: FiberApply | undefined
  private _meta: FiberMeta

  constructor(apply: FiberApply | undefined, config: unknown, meta: FiberMeta = {}) {
    this._apply = apply
    this.config = config
    this._meta = meta
  }

  get name(): string | undefined {
    return this._meta.name
  }

  get inject(): string[] | undefined {
    return this._meta.inject
  }

  get provide(): string[] | undefined {
    return this._meta.provide
  }

  /** PromiseLike：等待 setup settle，resolve 为 disposeAsync（撤销函数），避免 thenable 自引用 */
  then<TResult1 = Disposable, TResult2 = never>(
    onFulfilled?: ((value: Disposable) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.setupTask)
      .then(() => this.disposeAsync)
      .then(onFulfilled as (value: Disposable) => TResult1 | PromiseLike<TResult1>, onRejected)
  }

  /**
   * 注册副作用：execute 立即执行，返回的 disposer 逆序撤销。
   * 返回一个「只撤销本 effect」的 disposer（fiber 卸载时会整体撤销）。
   */
  effect(execute: () => Effect, label?: string): Disposable {
    void label
    const collected: Disposable[] = []
    collectEffect(execute(), (d) => collected.push(d))
    for (const d of collected) {
      this.disposers.collect(d)
    }
    return async () => {
      for (const d of collected.reverse()) {
        await d()
      }
    }
  }

  /** 加载：执行 apply，六态转换。失败置 FAILED 并抛错（响亮失败）。 */
  async load(ctx: Context): Promise<void> {
    if (this.state === 'DISPOSED' || this.state === 'LOADING') return
    this.state = 'LOADING'
    this.setupTask = (async () => {
      try {
        await this._apply?.(ctx, this.config)
        this.state = 'ACTIVE'
      } catch (err) {
        this.state = 'FAILED'
        throw err
      }
    })()
    // 防止 unhandled rejection（apply 失败时仍能通过 then 的 onRejected 观察到）
    this.setupTask.catch(() => undefined)
    await this.setupTask
  }

  /** 撤销函数：逆序撤销全部副作用，置 DISPOSED */
  private readonly disposeAsync = async (): Promise<void> => {
    if (this.state === 'DISPOSED') return
    this.state = 'UNLOADING'
    await this.disposers.dispose()
    this.state = 'DISPOSED'
  }

  /** 卸载：等待 cleanup 完成 */
  async dispose(): Promise<void> {
    await this.disposeAsync()
  }

  /** 卸载后立即用当前配置重载 */
  async restart(ctx: Context): Promise<void> {
    await this.dispose()
    this.state = 'PENDING'
    await this.load(ctx)
  }

  /** 等待当前 setup settle（启动错误会 reject） */
  await(): Promise<void> {
    return this.setupTask
  }
}
