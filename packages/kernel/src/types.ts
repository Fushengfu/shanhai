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

/**
 * 能力风险等级（阶段2 能力级审批，对齐 ToolContract.riskLevel 的三档，
 * 但作用到「跨插件能力调用」这一层，与「会话级审批策略」独立）。
 * - read-only：只读（文件读 / 网络 GET）——默认放行
 * - write：写（文件写 / 网络 POST）——按 ask 策略审批
 * - destructive：破坏性（浏览器 DOM 操作 / 任意页注入 / 发消息）——逐次强制审批
 */
export type CapabilityRisk = 'read-only' | 'write' | 'destructive'

/**
 * 能力元数据（系统插件在 ctx.provideCapability 注册能力时声明）。
 * 只有声明了元数据的能力调用才走「能力级审批」；普通 `ctx.provide` 注册的服务无元数据、
 * 保持原有路由行为（不经审批），避免误伤现网插件。
 */
export interface CapabilityMeta {
  /** 能力名（如 network:http / filesystem） */
  name: string
  /** 风险等级 */
  risk: CapabilityRisk
  /** 显式审批策略（缺省按 risk 推断：read-only→allow、write→ask、destructive→always） */
  approval?: 'allow' | 'ask' | 'always'
}
