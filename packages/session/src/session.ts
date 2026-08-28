/**
 * 会话（对齐 dsh-session）：类型化事件日志，回放即状态。
 *
 * 每个可观测步骤落一条事件（turn/* / user/message / assistant/* / tool/* / approval/*），
 * 会话状态 = 事件日志的回放结果，天然支持断点续跑与审计。
 */

export type AgentEventType =
  | 'turn/start'
  | 'turn/end'
  | 'user/message'
  | 'assistant/delta'
  | 'assistant/message'
  /** 原始带系统内置标签的模型输出（审计用）：检测到模型输出含系统保留标签时的「原始完整输出」。
   * 持久化层会把它分流到独立审计文件 tagged-outputs.jsonl，不写入主事件日志 events.jsonl（保证主日志不含标签）。 */
  | 'assistant/raw'
  | 'tool/call'
  | 'tool/result'
  | 'usage/record'
  | 'model/select'
  | 'approval/policy'
  | 'approval/request'
  | 'approval/outcome'
  | 'retry/snapshot'

/**
 * 审批策略（安全模式，会话级）：
 * - 'ask'：危险操作每次询问（工作目录内也审批）
 * - 'workdir'：工作目录内免审批，访问工作目录外才审批
 * - 'never'：从不询问，所有范围直接执行
 */
export type ApprovalPolicy = 'ask' | 'workdir' | 'never'
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 事件 → 载荷的类型映射（类型化事件，编译期约束载荷） */
export interface EventData {
  'turn/start': { turn: number }
  'turn/end': { turn: number; text: string }
  /** content 为文本；attachments 为多模态附件（图片/音频/视频），会话回放时一并还原。injected 标记「插入模式」任务执行中注入的消息（UI 不显示为独立用户气泡） */
  'user/message': { content: string; attachments?: unknown[]; injected?: boolean }
  'assistant/delta': { text: string }
  'assistant/message': { content: string; reasoningContent?: string }
  'assistant/raw': { content: string }
  'tool/call': { callId: string; name: string; args: Record<string, unknown>; reasoningContent?: string }
  'tool/result': { callId: string; name: string; result?: unknown; error?: string }
  /** 模型每次调用返回的真实 token 用量（接口返回 usage.total_tokens，非本地估算），持久化用于断点续跑时恢复压缩判断与累计 token 统计 */
  'usage/record': { totalTokens: number; promptTokens: number; completionTokens: number; cachedPromptTokens?: number }
  /** 会话级模型选择：切模型时向当前会话追加一条 model/select 事件，切回该会话时回放恢复 */
  'model/select': { modelId: string }
  'approval/policy': { policy: ApprovalPolicy }
  'approval/request': { id: string; toolName: string; args: Record<string, unknown>; riskLevel: string }
  'approval/outcome': { id: string; outcome: ApprovalOutcome }
  /** 失败重试挂起快照：重试耗尽后保存「失败节点发给模型的完整 messages 快照 + 重入位置」，供重启后精确重试（body 与失败完全一致） */
  'retry/snapshot': { messages: unknown[]; step: number; maxSteps: number; atLimit: boolean; reason?: string }
}

export interface SessionEvent<T extends AgentEventType = AgentEventType> {
  type: T
  data: EventData[T]
  timestamp: number
}

export class Session {
  private readonly events: SessionEvent[] = []

  /**
   * 已持久化的事件数（前 persistedCount 条已落盘）。由持久化层读写，用于增量追加：
   * 每次 persist 只把 [persistedCount, length) 区间的新事件追加写盘，避免 O(n) 全量重写。
   */
  persistedCount = 0
  /** 自上次持久化以来是否发生过截断/删除（truncate/removeLast），命中时需全量重写磁盘，而非增量追加 */
  private needsRewrite = false

  append<T extends AgentEventType>(type: T, data: EventData[T]): SessionEvent<T> {
    const event = { type, data, timestamp: Date.now() } as SessionEvent<T>
    this.events.push(event as SessionEvent)
    return event
  }

  list(): SessionEvent[] {
    return [...this.events]
  }

  /** 当前事件总数（供持久化层判断是否有新增事件，避免 list() 全量复制） */
  get size(): number {
    return this.events.length
  }

  /** 返回 [start, end) 区间的浅拷贝（增量持久化用，避免 list() 全量复制） */
  slice(start: number, end?: number): SessionEvent[] {
    return this.events.slice(start, end)
  }

  /** 从历史事件恢复（会话持久化加载用），返回恢复的事件数 */
  restore(events: SessionEvent[]): number {
    for (const e of events) {
      this.events.push(e as SessionEvent)
    }
    this.persistedCount = this.events.length
    this.needsRewrite = false
    return events.length
  }

  /**
   * 截断事件日志：只保留前 count 条，丢弃其后的所有事件。
   * 用于「重新发送 / 编辑后重发」——把某条用户消息及其之后的回复/工具过程裁掉，重新生成。
   * 返回被删除的事件数。
   */
  truncate(count: number): number {
    if (count < 0) count = 0
    if (count >= this.events.length) return 0
    const removed = this.events.length - count
    this.events.length = count
    if (this.persistedCount > count) this.persistedCount = count
    this.needsRewrite = true
    return removed
  }

  /**
   * 移除事件日志中指定类型的最后一条事件（用于覆盖/清理临时标记事件，如失败重试挂起快照 retry/snapshot）。
   * 返回是否移除成功。
   */
  removeLast(type: AgentEventType): boolean {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.type === type) {
        this.events.splice(i, 1)
        if (i < this.persistedCount) this.persistedCount -= 1
        this.needsRewrite = true
        return true
      }
    }
    return false
  }

  /** 是否发生过需要全量重写磁盘的修改（truncate/removeLast） */
  requireRewrite(): boolean {
    return this.needsRewrite
  }

  /** 持久化完成后调用：清除重写标记，并把已持久化游标推进到当前长度 */
  markPersisted(): void {
    this.needsRewrite = false
    this.persistedCount = this.events.length
  }
}

/** 从事件日志回放，得出当前生效的审批策略（最近一条 approval/policy） */
export function effectiveApprovalPolicy(events: SessionEvent[]): ApprovalPolicy | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.type === 'approval/policy') {
      return (e.data as { policy: ApprovalPolicy }).policy
    }
  }
  return undefined
}

/** 从事件日志回放，得出该会话最近一次选中的模型 id（最近一条 model/select），无记录返回 undefined */
export function effectiveModelId(events: SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.type === 'model/select') {
      return (e.data as { modelId: string }).modelId
    }
  }
  return undefined
}
