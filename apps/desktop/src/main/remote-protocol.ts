import type { Runtime, ToolTrace } from '@shanhai/runtime'
import { SUPERVISOR_ID } from '@shanhai/runtime'
import { getRuntime } from './runtime'
import { removeApprovalRequest, removeAskRequest } from './ui-store'

/**
 * 远程连接「协议层」：与传输方式无关的公共逻辑（命令路由 + 事件转发 + 结果截断）。
 *
 * 桌面端有两种远程接入方式，都复用本文件：
 * - 局域网直连（remote-server.ts）：桌面端起 WS 服务，手机连同一 WiFi；
 * - 网关中继（remote-relay.ts）：桌面端作为 Host 连网关 bridge，手机作为 Client 连网关，外网可达。
 *
 * 两者共用同一套命令/事件 JSON 协议（见 docs/山海远程连接协议.md）。
 */

/** 工具结果 / 历史 tool-result 转发前的截断长度（控制传输量，完整内容仍由桌面端磁盘持久化） */
export const MAX_RESULT_CHARS = 4000

/**
 * 同步历史的最大轮数（一轮 = 一次用户输入到该轮完整回复结束，含其中所有工具调用与结果）。
 * 超出只返回最近 MAX_HISTORY_TURNS 轮，控制单次同步传输量——避免事件日志变大后，
 * 手机端一次性渲染全部历史导致卡死/超时/白屏。
 */
export const MAX_HISTORY_TURNS = 20

/**
 * 按「轮次」截断历史：一轮以 user 消息为边界（getSessionHistory 里 user 消息带 turnSeq，从 1 起递增，
 * 该轮后续的 assistant/tool 消息都归属这轮）。保留最近 maxTurns 个完整轮次，返回 { items, truncated }。
 */
export function sliceHistoryByTurns(
  items: unknown[],
  maxTurns: number,
): { items: unknown[]; truncated: boolean } {
  // 收集所有 user 消息的下标（turn 边界）
  const userIdx: number[] = []
  for (let i = 0; i < items.length; i++) {
    if ((items[i] as { kind?: string }).kind === 'user') userIdx.push(i)
  }
  if (userIdx.length <= maxTurns) return { items, truncated: false }
  const start = userIdx[userIdx.length - maxTurns]!
  return { items: items.slice(start), truncated: true }
}

/**
 * 增量过滤：只保留 turnSeq > sinceTurnSeq 的轮次（新轮次起点必为 user 消息，从该起点截到末尾）。
 * sinceTurnSeq <= 0 时返回全量。
 */
export function sliceHistorySinceTurn(items: unknown[], sinceTurnSeq: number): unknown[] {
  if (sinceTurnSeq <= 0) return items
  const idx = items.findIndex((it) => {
    const turnSeq = (it as { turnSeq?: number }).turnSeq
    return turnSeq != null && turnSeq > sinceTurnSeq
  })
  if (idx < 0) return []
  return items.slice(idx)
}

/**
 * 加载更早历史：返回 turnSeq < beforeTurnSeq 的轮次，再保留其中最近 maxTurns 轮。
 * 客户端上滑到最早消息时，用「当前已加载的最早 turnSeq」作为 beforeTurnSeq 请求更早。
 */
export function sliceHistoryBeforeTurn(items: unknown[], beforeTurnSeq: number, maxTurns: number): { items: unknown[]; truncated: boolean } {
  if (beforeTurnSeq <= 0) return sliceHistoryByTurns(items, maxTurns)
  // 找到第一个 turnSeq >= beforeTurnSeq 的 item 下标，其之前的都是「更早」历史
  const cutIdx = items.findIndex((it) => {
    const turnSeq = (it as { turnSeq?: number }).turnSeq
    return turnSeq != null && turnSeq >= beforeTurnSeq
  })
  const earlier = cutIdx < 0 ? items : items.slice(0, cutIdx)
  return sliceHistoryByTurns(earlier, maxTurns)
}

/** get_history / get_supervisor_history 的统一返回体 */
export interface HistoryPayload {
  items: unknown[]
  truncated: boolean
}

export interface IncomingCmd {
  type: 'cmd'
  id: number
  cmd: string
  payload: Record<string, unknown>
}

/** 截断超长工具结果（转字符串截断），控制传输量；不改变原始对象语义（短结果原样返回） */
export function truncateResult(result: unknown): unknown {
  if (result === undefined || result === null) return result
  let s: string
  try {
    s = typeof result === 'string' ? result : JSON.stringify(result)
  } catch {
    s = String(result)
  }
  if (s.length <= MAX_RESULT_CHARS) return result
  return `${s.slice(0, MAX_RESULT_CHARS)}…（已截断，共 ${s.length} 字符，完整内容见桌面端）`
}

/** 截断一条工具 trace 的 result（tool-result 才处理） */
export function sanitizeTrace(trace: ToolTrace): ToolTrace {
  if (trace.kind !== 'tool-result' || trace.result === undefined) return trace
  return { ...trace, result: truncateResult(trace.result) }
}

/** 把历史消息转换为手机端可渲染的消息流：tool-result 按 callId 合并到同 callId 的 tool-call，
 * 并截断超长结果（等价于桌面端 historyToChatItems 的合并逻辑，避免刷新后 tool-call / tool-result 显示为两个卡片）。 */
export function sanitizeHistory(
  items: Array<{ kind: 'user' | 'assistant' | 'tool'; content?: string; reasoningContent?: string; trace?: ToolTrace; attachments?: unknown[]; turnSeq?: number; turnDuration?: number }>,
): unknown[] {
  const out: unknown[] = []
  for (const item of items) {
    if (item.kind === 'tool' && item.trace) {
      const trace = item.trace
      if (trace.kind === 'tool-result') {
        // 从后往前找同 callId 的 tool-call，找到则合并（保留 tool-call 的 name/args/reasoning/startTs）
        const idx = [...out].reverse().findIndex((it) => {
          const t = (it as { kind?: string; trace?: ToolTrace }).trace
          return (it as { kind?: string }).kind === 'tool' && t?.kind === 'tool-call' && t.callId === trace.callId
        })
        if (idx >= 0) {
          const realIdx = out.length - 1 - idx
          const base = (out[realIdx] as { kind: string; trace: ToolTrace }).trace
          out[realIdx] = {
            kind: 'tool',
            trace: {
              ...base,
              kind: 'tool-result',
              result: truncateResult(trace.result),
              error: trace.error,
              durationMs: trace.durationMs,
            },
          }
          continue
        }
      }
      out.push({ ...item, trace: sanitizeTrace(trace) })
    } else {
      out.push(item)
    }
  }
  return out
}

/** 组合 listSessions + describeSession，返回完整会话摘要列表（含模型/步数/上下文占用等）。
 * 排序与桌面端 sortedSessions 一致：进行中（busy）置顶，其余按最近活跃时间倒序。 */
export function listSessionsFull(): unknown[] {
  const runtime = getRuntime()
  return runtime
    .listSessions()
    .map((s) => runtime.describeSession(s.id))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => {
      if (a.busy !== b.busy) return a.busy ? -1 : 1
      return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
    })
}

/** 构建 get_history / get_supervisor_history 的返回体：默认保留最近 MAX_HISTORY_TURNS 轮，
 * 支持 sinceTurnSeq 增量（只返回新增轮次）与 beforeTurnSeq 分页（加载更早历史）。 */
function buildHistoryPayload(sessionId: string, payload: Record<string, unknown>): HistoryPayload {
  const runtime = getRuntime()
  const history = sanitizeHistory(runtime.getSessionHistory(sessionId))
  const sinceTurnSeq = Number(payload.sinceTurnSeq ?? 0) || 0
  const beforeTurnSeq = Number(payload.beforeTurnSeq ?? 0) || 0
  if (sinceTurnSeq > 0) {
    // 增量：只返回 sinceTurnSeq 之后的新轮次（数据量小，不额外截断）
    return { items: sliceHistorySinceTurn(history, sinceTurnSeq), truncated: false }
  }
  if (beforeTurnSeq > 0) {
    // 分页：加载 beforeTurnSeq 之前的更早历史（受 MAX_HISTORY_TURNS 上限保护）
    return sliceHistoryBeforeTurn(history, beforeTurnSeq, MAX_HISTORY_TURNS)
  }
  // 默认：保留最近 MAX_HISTORY_TURNS 轮
  return sliceHistoryByTurns(history, MAX_HISTORY_TURNS)
}

/** 处理一条命令，结果通过 send 回调返回（send 由调用方注入：局域网 socket 或网关连接） */
export async function handleCommand(send: (obj: unknown) => void, msg: IncomingCmd): Promise<void> {
  const runtime = getRuntime()
  const { id, cmd, payload } = msg
  try {
    let data: unknown
    switch (cmd) {
      case 'list_sessions':
        data = listSessionsFull()
        break
      case 'get_history':
        data = buildHistoryPayload(payload.sessionId as string, payload)
        break
      case 'get_supervisor_history':
        data = buildHistoryPayload(SUPERVISOR_ID, payload)
        break
      case 'run_supervisor':
        data = await runtime.runSupervisor(String(payload.message ?? ''))
        break
      case 'get_models':
        data = await runtime.listModels()
        break
      case 'send_message': {
        const sessionId = String(payload.sessionId ?? '')
        const message = String(payload.message ?? '')
        const mode = payload.mode === 'queue' ? 'queue' : 'insert'
        data = await runtime.runSession(sessionId, message, mode)
        break
      }
      case 'stop_session':
        runtime.stopSession(String(payload.sessionId ?? ''))
        data = { ok: true }
        break
      case 'resend':
        data = await runtime.resend(String(payload.sessionId ?? ''), Number(payload.userMessageIndex ?? 0), payload.newContent as string | undefined)
        break
      case 'resume':
        data = await runtime.resume(String(payload.sessionId ?? ''))
        break
      case 'retry':
        data = await runtime.retrySession(String(payload.sessionId ?? ''))
        break
      case 'create_session':
        data = { sessionId: runtime.createSession(payload.title as string | undefined, payload.workdir as string | undefined) }
        break
      case 'rename_session':
        runtime.renameSession(String(payload.sessionId ?? ''), String(payload.title ?? ''))
        data = { ok: true }
        break
      case 'delete_session':
        await runtime.deleteSession(String(payload.sessionId ?? ''))
        data = { ok: true }
        break
      case 'set_workdir':
        runtime.setSessionWorkdir(String(payload.sessionId ?? ''), String(payload.workdir ?? ''))
        data = { ok: true }
        break
      case 'set_model':
        data = runtime.setSessionModel(String(payload.sessionId ?? ''), String(payload.modelId ?? ''))
        break
      case 'switch_session':
        runtime.switchSession(String(payload.sessionId ?? ''))
        data = { ok: true }
        break
      case 'respond_approval': {
        const requestId = String(payload.requestId ?? '')
        runtime.respondApproval(payload.outcome === 'rejected' ? 'rejected' : 'allowed-once', requestId)
        // 同步清除桌面端审批队列（桌面端弹窗据此关闭），否则只有 agent 解除阻塞、弹窗仍残留
        removeApprovalRequest(requestId)
        data = { ok: true }
        break
      }
      case 'respond_ask': {
        const requestId = String(payload.requestId ?? '')
        runtime.respondAsk(requestId, String(payload.answer ?? ''))
        removeAskRequest(requestId)
        data = { ok: true }
        break
      }
      case 'cancel_ask': {
        const requestId = String(payload.requestId ?? '')
        runtime.cancelAsk(requestId)
        removeAskRequest(requestId)
        data = { ok: true }
        break
      }
      case 'get_pending_requests': {
        // 手机端连接/进入会话后主动查询待处理的审批/提问，恢复弹窗。
        // 审批与提问都是一次性广播事件，客户端若错过（切走会话、连接前已发出）需据此恢复，
        // 否则工具会一直阻塞等待应答、弹窗永远看不到。
        data = {
          approvals: runtime.listPendingApprovals(),
          asks: runtime.listPendingAsks(),
        }
        break
      }
      case 'get_token_stats':
        data = runtime.getTokenStats()
        break
      default:
        throw new Error(`未知命令: ${cmd}`)
    }
    send({ type: 'cmd_result', id, ok: true, data })
  } catch (err) {
    send({ type: 'cmd_result', id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

/** 订阅 runtime 事件并转发（broadcast 由调用方注入）。返回取消函数集合。 */
export function subscribeRuntimeEvents(runtime: Runtime, broadcast: (event: string, payload: unknown) => void): Array<() => void> {
  return [
    runtime.onDelta((sessionId, text) => broadcast('delta', { sessionId, text })),
    runtime.onReasoning((sessionId, text) => broadcast('reasoning', { sessionId, text })),
    runtime.onToolTrace((trace) => broadcast('tool_trace', sanitizeTrace(trace))),
    runtime.onSessionActivity((sessionId, kind) => broadcast('session_activity', { sessionId, kind })),
    runtime.onUserMessage((sessionId, message, turnSeq) => broadcast('user_message', { sessionId, message, turnSeq })),
    runtime.onApprovalRequest((req) => broadcast('approval_request', req)),
    runtime.onAskRequest((req) => broadcast('ask_request', req)),
    runtime.onApprovalResolved((requestId) => broadcast('approval_resolved', { requestId })),
    runtime.onAskResolved((requestId) => broadcast('ask_resolved', { requestId })),
    runtime.onSupervisorResult((sessionId, title, result, error) => broadcast('supervisor_result', { sessionId, title, result, error })),
    runtime.onTokenStats((sessionId, stats) => broadcast('token_stats', { sessionId, stats })),
    runtime.onCurrentSessionChanged((sessionId) => broadcast('current_session_changed', { sessionId })),
  ]
}
