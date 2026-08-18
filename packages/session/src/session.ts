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
  | 'tool/call'
  | 'tool/result'
  | 'approval/policy'
  | 'approval/request'
  | 'approval/outcome'

export type ApprovalPolicy = 'ask' | 'never'
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 事件 → 载荷的类型映射（类型化事件，编译期约束载荷） */
export interface EventData {
  'turn/start': { turn: number }
  'turn/end': { turn: number; text: string }
  /** content 为文本；attachments 为多模态附件（图片/音频/视频），会话回放时一并还原 */
  'user/message': { content: string; attachments?: unknown[] }
  'assistant/delta': { text: string }
  'assistant/message': { content: string }
  'tool/call': { callId: string; name: string; args: Record<string, unknown> }
  'tool/result': { callId: string; name: string; result?: unknown; error?: string }
  'approval/policy': { policy: ApprovalPolicy }
  'approval/request': { id: string; toolName: string; args: Record<string, unknown>; riskLevel: string }
  'approval/outcome': { id: string; outcome: ApprovalOutcome }
}

export interface SessionEvent<T extends AgentEventType = AgentEventType> {
  type: T
  data: EventData[T]
  timestamp: number
}

export class Session {
  private readonly events: SessionEvent[] = []

  append<T extends AgentEventType>(type: T, data: EventData[T]): SessionEvent<T> {
    const event = { type, data, timestamp: Date.now() } as SessionEvent<T>
    this.events.push(event as SessionEvent)
    return event
  }

  list(): SessionEvent[] {
    return [...this.events]
  }

  /** 从历史事件恢复（会话持久化加载用），返回恢复的事件数 */
  restore(events: SessionEvent[]): number {
    for (const e of events) {
      this.events.push(e as SessionEvent)
    }
    return events.length
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
