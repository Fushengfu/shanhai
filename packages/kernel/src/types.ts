/**
 * 内核核心类型（仅类型定义，无运行时）。
 * 对齐 Cordis 的 fiber / context / service / event 语义。
 */

/** fiber 六态（对齐 Cordis FiberState） */
export type FiberState =
  | 'PENDING'
  | 'LOADING'
  | 'ACTIVE'
  | 'FAILED'
  | 'UNLOADING'
  | 'DISPOSED'

/** 副作用撤销函数：立即执行或返回 Promise */
export type Disposable = () => void | Promise<void>

/** effect 返回体：单个 disposer、Promise、或（异步）Iterable */
export type Effect =
  | Disposable
  | Promise<Disposable>
  | Iterable<Disposable>
  | AsyncIterable<Disposable>

/** 依赖声明：数组（只要服务）或 map（服务 + 该服务的拦截配置） */
export type Inject<M = Record<string, unknown>> =
  | (keyof M)[]
  | { [K in keyof M]?: M[K] }

/** 事件监听器选项 */
export interface EventOptions {
  /** 是否在 fiber 卸载时自动撤销（默认 true） */
  disposer?: boolean
  /** 是否只触发一次 */
  once?: boolean
  /** 触发优先级（大者先） */
  priority?: number
}

/** 服务可用性谓词：返回 false 则服务不可用 */
export type ServiceCheck = (...args: unknown[]) => boolean

/** 版本授权：单勾 / 双勾 */
export type Grant = 'once' | 'trusted'

/** 审批决策 */
export type ApprovalDecision = 'allow' | 'reject' | 'trust'

/** 插件版本状态 */
export type PluginState = 'staged' | 'pending' | 'active' | 'failed' | 'inactive'

/** 能力清单（least privilege） */
export interface Capability {
  provide?: string[]
  consume?: string[]
}
