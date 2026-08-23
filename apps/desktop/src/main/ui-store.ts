import { SUPERVISOR_ID, type Runtime, type ToolTrace, type TokenSnapshot, type AskRequest } from '@shanhai/runtime'
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WindowType } from './window-manager'
import { notifySessionTaskComplete } from './notifications'

/**
 * 主进程集中式 UI 共享状态（多窗口桌面系统的唯一权威 UI 状态源）。
 *
 * 职责：把渲染进程 App.tsx 里的跨窗口共享状态（会话消息流 / 流式输出 / 审批队列 / token / 轨迹 /
 * 登录态 / 会话列表 / 当前会话 / 模型 / 审批策略 / 重试弹窗等）全部上移到主进程内存。
 * - 事件驱动状态（streaming / 工具步骤 / 审批 / 提问 / token / 轨迹 / 浏览器窗口）由 initUiStore 监听 runtime 事件内部更新；
 * - 动作驱动状态（user/assistant 气泡、busy、会话列表、当前会话、模型、审批策略等）由窗口通过 patchUiState 深合并更新；
 * - 所有窗口通过 subscribeUiState 订阅快照，保证跨窗口一致。
 */

type GatewayModel = Awaited<ReturnType<Runtime['listModels']>>[number]

export interface SessionListItem {
  id: string
  title: string
  workDir: string
  lastActiveAt: number
  busy: boolean
}

export type ChatItem =
  | { kind: 'user'; content: string; images?: string[]; pending?: boolean; queueId?: string; turnSeq?: number }
  | { kind: 'assistant'; content: string; reasoningContent?: string; turnSeq?: number; turnDuration?: number }
  | { kind: 'tool'; trace: ToolTrace }

export interface SessionUIState {
  items: ChatItem[]
  streaming: string
  streamingReasoning: string
  busy: boolean
  terminalPanelOpen: boolean
  turnStartTs?: number
  /** 是否存在未完成轮次（任务中断/挂起，可「继续执行」）。会话级隔离：每个会话各自记录，避免多会话/后台任务下按钮串扰 */
  incompleteTurn: boolean
}

/** runtime.getSessionHistory 返回的历史条目类型 */
type HistoryItem = Awaited<ReturnType<Runtime['getSessionHistory']>>[number]

/** 工具结果在 UI 内存里的截断上限（字符）：超过则截断，避免超大结果（读大文件/命令输出爆炸/抓取大页面）
 *  随每次 ui:state 全量快照广播反复复制导致内存放大。完整结果仍完整持久化在后端 session 文件（persistSession 不截断）。 */
const MAX_TOOL_RESULT_CHARS = 4000

/** 图片/二进制字段：截断会破坏 base64 图片完整性，跳过截断 */
const SKIP_TRUNCATE_FIELDS = new Set(['imageBase64', 'imageUrl', 'base64', 'data'])

/** 截断工具结果：字符串直接截断，对象递归截断超长字符串字段（跳过图片字段） */
function truncateToolResult(result: unknown): unknown {
  if (typeof result === 'string') {
    return result.length > MAX_TOOL_RESULT_CHARS ? result.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…（已截断）' : result
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.length > MAX_TOOL_RESULT_CHARS && !SKIP_TRUNCATE_FIELDS.has(k)) {
        out[k] = v.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…（已截断）'
        changed = true
      } else {
        out[k] = v
      }
    }
    return changed ? out : result
  }
  return result
}

/** 把后端历史消息（HistoryItem[]）转换为消息流 items（ChatItem[]）：tool-result 合并到同 callId 的 tool-call */
function historyToChatItems(history: HistoryItem[]): ChatItem[] {
  const out: ChatItem[] = []
  for (const h of history) {
    if (h.kind === 'user') {
      const images = ((h.attachments ?? []) as Array<{ image_url?: { url?: string } }>)
        .map((a) => a?.image_url?.url)
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
      out.push({ kind: 'user', content: h.content ?? '', images, turnSeq: h.turnSeq })
    } else if (h.kind === 'assistant') {
      out.push({ kind: 'assistant', content: h.content ?? '', reasoningContent: h.reasoningContent, turnSeq: h.turnSeq, turnDuration: h.turnDuration })
    } else if (h.trace) {
      const trace = h.trace
      if (trace.kind === 'tool-result') {
        const idx = [...out].reverse().findIndex((it) => it.kind === 'tool' && it.trace.kind === 'tool-call' && it.trace.callId === trace.callId)
        if (idx >= 0) {
          const realIdx = out.length - 1 - idx
          const base = (out[realIdx] as Extract<ChatItem, { kind: 'tool' }>).trace
          out[realIdx] = { kind: 'tool', trace: { ...base, kind: 'tool-result', result: truncateToolResult(trace.result), error: trace.error } }
          continue
        }
      }
      out.push({ kind: 'tool', trace })
    }
  }
  return out
}

export interface ApprovalRequest {
  id: string
  sessionId?: string
  toolName: string
  args: Record<string, unknown>
  riskLevel: string
}

export interface ExpertTrace {
  sessionId?: string
  turnSeq?: number
  stepId: string
  expertId: string
  expertName: string
  title: string
  status: 'started' | 'completed' | 'failed'
  result?: string
  error?: string
}

export interface BrowserWindowItem {
  appId: string
  url: string
  title: string
  label?: string
}

export interface RetryPrompt {
  sessionId: string
  message: string
}

export interface UiStoreState {
  loggedIn: boolean
  username: string | null
  currentSessionId: string
  sessions: SessionListItem[]
  sessionMap: Record<string, SessionUIState>
  models: GatewayModel[]
  selectedModel: string
  approvalPolicy: 'ask' | 'workdir' | 'never'
  tokenStatsBySession: Record<string, TokenSnapshot>
  approvalQueues: Record<string, ApprovalRequest[]>
  askQueues: Record<string, AskRequest[]>
  expertTraces: Record<string, ExpertTrace[]>
  browserWindows: BrowserWindowItem[]
  retryPrompt: RetryPrompt | null
  /** 桌面壳壁纸：CSS backgroundImage 值（预设渐变字符串或 data:image base64）。null = 默认渐变 */
  wallpaper: string | null
}

export const EMPTY_SESSION: SessionUIState = {
  items: [],
  streaming: '',
  streamingReasoning: '',
  busy: false,
  terminalPanelOpen: false,
  incompleteTurn: false,
}

const INITIAL_STATE: UiStoreState = {
  loggedIn: false,
  username: null,
  currentSessionId: '',
  sessions: [],
  sessionMap: {},
  models: [],
  selectedModel: '',
  approvalPolicy: 'ask',
  tokenStatsBySession: {},
  approvalQueues: {},
  askQueues: {},
  expertTraces: {},
  browserWindows: [],
  retryPrompt: null,
  wallpaper: null,
}

let state: UiStoreState = INITIAL_STATE

/** 壁纸持久化文件路径（userData 目录下的 wallpaper.json，独立于 runtime config，避免跨包耦合） */
function wallpaperPath(): string {
  return join(app.getPath('userData'), 'wallpaper.json')
}

/** 读取持久化的壁纸（CSS backgroundImage 值）；无文件/损坏返回 null */
export function getWallpaper(): string | null {
  try {
    const raw = readFileSync(wallpaperPath(), 'utf8')
    const parsed = JSON.parse(raw) as { wallpaper?: unknown }
    return typeof parsed.wallpaper === 'string' ? parsed.wallpaper : null
  } catch {
    return null
  }
}

/** 持久化壁纸（写 userData/wallpaper.json）；失败只告警，不中断 */
export function setWallpaper(wallpaper: string | null): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(wallpaperPath(), JSON.stringify({ wallpaper }), 'utf8')
  } catch (err) {
    console.warn('[山海] 保存壁纸失败：', err)
  }
}

const listeners = new Set<() => void>()

export function getUiState(): UiStoreState {
  return state
}

/**
 * 按窗口类型过滤共享状态快照（内存优化：避免把「含所有会话完整历史」的重快照广播给不消费它的窗口）。
 * - chat / supervisor / app：消费完整状态（消息流/审批/提问/token/轨迹等）→ 原样返回
 * - desktop：桌面壳只展示登录态 + 壁纸，不需要消息流等重数据 → 返回精简快照
 * - dock / supervisor-bubble：纯静态窗口（图标栏 / 管家悬浮图标），不消费任何共享状态 → 返回空快照
 */
export function filterUiStateForWindow(type: WindowType | undefined, s: UiStoreState): UiStoreState {
  switch (type) {
    case 'desktop':
      return { ...INITIAL_STATE, loggedIn: s.loggedIn, username: s.username, wallpaper: s.wallpaper }
    case 'dock':
    case 'supervisor-bubble':
      return { ...INITIAL_STATE }
    case 'chat':
    case 'supervisor':
    case 'app':
    default:
      return s
  }
}

/** 判断窗口类型是否消费共享状态（dock/supervisor-bubble 不消费，广播时直接跳过，连空快照都不发） */
export function windowConsumesUiState(type: WindowType | undefined): boolean {
  return type !== 'dock' && type !== 'supervisor-bubble'
}

export function subscribeUiState(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 深合并：对象递归合并，数组整体替换，标量替换。用于窗口动作的字段级 patch（不覆盖其他字段）。 */
function deepMerge<T>(target: T, patch: unknown): T {
  if (patch === null || patch === undefined) return patch as T
  if (Array.isArray(patch)) return patch as T
  if (Array.isArray(target) || Array.isArray(patch)) return patch as T
  if (typeof patch === 'object' && typeof target === 'object' && target !== null) {
    const out: Record<string, unknown> = { ...(target as Record<string, unknown>) }
    for (const k of Object.keys(patch as Record<string, unknown>)) {
      out[k] = deepMerge((target as Record<string, unknown>)[k], (patch as Record<string, unknown>)[k])
    }
    return out as T
  }
  return patch as T
}

/** 字段级 patch（深合并 + 广播）。窗口动作后调用，不覆盖主进程事件刚更新的其他字段。 */
export function patchUiState(patch: DeepPartial<UiStoreState>): void {
  state = deepMerge(state, patch)
  listeners.forEach((l) => l())
}

/** 内部函数式更新（主进程事件监听用，单一写者无竞态） */
function mutate(fn: (s: UiStoreState) => UiStoreState): void {
  state = fn(state)
  listeners.forEach((l) => l())
}

/** 从 runtime 装配初始状态 + 监听 runtime 事件维护事件驱动状态（streaming/工具步骤/审批/提问/token/轨迹/浏览器窗口） */
export function initUiStore(runtime: Runtime): void {
  state = {
    ...INITIAL_STATE,
    loggedIn: runtime.loggedIn,
    username: runtime.username,
    sessions: runtime.listSessions(),
    selectedModel: runtime.getCurrentModelId(),
    approvalPolicy: runtime.getApprovalPolicy(),
    wallpaper: getWallpaper(),
  }
  listeners.forEach((l) => l())

  // models 是异步的：初始拉取 + 模型刷新时重拉
  void runtime.listModels().then((models) => {
    mutate((s) => ({ ...s, models, selectedModel: runtime.getCurrentModelId() }))
  })
  runtime.onModelsChanged(() => {
    void runtime.listModels().then((models) => {
      mutate((s) => ({ ...s, models }))
    })
  })

  // 流式正文/思考增量不再进 ui-store：改为 push.ts 独立广播 ui:delta/ui:reasoning 小事件，
  // 由渲染进程 store-client 本地累加（避免每个 token 触发全量 ui:state 快照广播导致内存放大）。
  // 会话结束时 onSessionActivity('end') 会一次性重建 items 并清空 streaming。

  // 工具过程：tool-call 追加，tool-result 合并到同 callId 的 tool-call
  runtime.onToolTrace((trace) => {
    mutate((s) => {
      const cur = s.sessionMap[trace.sessionId] ?? EMPTY_SESSION
      let items = cur.items
      if (trace.kind === 'tool-result') {
        const idx = [...items].reverse().findIndex((it) => it.kind === 'tool' && it.trace.kind === 'tool-call' && it.trace.callId === trace.callId)
        if (idx >= 0) {
          const realIdx = items.length - 1 - idx
          const arr = [...items]
          const base = (arr[realIdx] as Extract<ChatItem, { kind: 'tool' }>).trace
          arr[realIdx] = { kind: 'tool', trace: { ...base, kind: 'tool-result', result: truncateToolResult(trace.result), error: trace.error } }
          items = arr
        } else {
          items = [...items, { kind: 'tool', trace }]
        }
      } else {
        items = [...items, { kind: 'tool', trace }]
      }
      return { ...s, sessionMap: { ...s.sessionMap, [trace.sessionId]: { ...cur, items } } }
    })

    // 浏览器工具/技能执行后同步窗口标签（会话级）
    const isBrowserAction =
      trace.name?.startsWith('browser_') ||
      (trace.name === 'skill_run' && (trace.args as { skillId?: string } | undefined)?.skillId === 'browser-use')
    if (isBrowserAction) {
      void runtime.listBrowserWindows(trace.sessionId).then((wins) => {
        mutate((s) => ({ ...s, browserWindows: wins ?? [] }))
      })
    }
  })

  // 审批请求按 sessionId 路由到对应会话队列
  runtime.onApprovalRequest((req) => {
    const sid = req.sessionId ?? state.currentSessionId
    if (!sid) return
    mutate((s) => ({ ...s, approvalQueues: { ...s.approvalQueues, [sid]: [...(s.approvalQueues[sid] ?? []), req] } }))
  })

  // AI 提问按 sessionId 路由
  runtime.onAskRequest((req) => {
    const sid = req.sessionId ?? state.currentSessionId
    if (!sid) return
    mutate((s) => ({ ...s, askQueues: { ...s.askQueues, [sid]: [...(s.askQueues[sid] ?? []), req] } }))
  })

  // token 用量按会话隔离
  runtime.onTokenStats((sessionId, stats) => {
    mutate((s) => ({ ...s, tokenStatsBySession: { ...s.tokenStatsBySession, [sessionId]: stats } }))
  })

  // 多专家编排轨迹
  runtime.onExpertTrace((trace) => {
    const sid = trace.sessionId ?? state.currentSessionId
    if (!sid) return
    mutate((s) => {
      const list = s.expertTraces[sid] ?? []
      const idx = list.findIndex((t) => t.stepId === trace.stepId)
      if (idx >= 0) {
        const next = [...list]
        next[idx] = { ...next[idx], ...trace }
        return { ...s, expertTraces: { ...s.expertTraces, [sid]: next } }
      }
      return { ...s, expertTraces: { ...s.expertTraces, [sid]: [...list, trace] } }
    })
  })

  // 会话开始/结束执行：开始→busy=true；结束→重新拉取该会话历史刷新消息流 + 刷新会话列表（busy=false）。
  // 这样「会话管家异步转发」等后台执行也能正确反映到所有窗口（处理中状态 + user/assistant 气泡）。
  runtime.onSessionActivity((sessionId, kind) => {
    if (kind === 'start') {
      mutate((s) => ({
        ...s,
        sessionMap: { ...s.sessionMap, [sessionId]: { ...(s.sessionMap[sessionId] ?? EMPTY_SESSION), busy: true } },
        sessions: s.sessions.map((it) => (it.id === sessionId ? { ...it, busy: true } : it)),
      }))
      return
    }
    try {
      const items = historyToChatItems(runtime.getSessionHistory(sessionId))
      const sessions = runtime.listSessions()
      mutate((s) => ({
        ...s,
        sessions,
        sessionMap: { ...s.sessionMap, [sessionId]: { ...(s.sessionMap[sessionId] ?? EMPTY_SESSION), items, streaming: '', streamingReasoning: '', busy: false } },
      }))
      // 任务结束系统通知：仅「用户会话正常完成」时提醒。
      // 排除管家会话自身（短任务、常驻窗口可见）；中断/失败/重试耗尽等未完成场景（hasIncompleteTurn=true）不通知，
      // 它们分别由用户主动停止、错误弹窗 / 重试弹窗承接，无需系统提醒。
      if (sessionId !== SUPERVISOR_ID && !runtime.hasIncompleteTurn(sessionId)) {
        const meta = sessions.find((it) => it.id === sessionId)
        const lastAssistant = [...items].reverse().find((it) => it.kind === 'assistant')
        const summary = lastAssistant && lastAssistant.kind === 'assistant' ? lastAssistant.content : ''
        notifySessionTaskComplete(sessionId, meta?.title ?? '', summary)
      }
    } catch {
      const sessions = runtime.listSessions()
      mutate((s) => ({
        ...s,
        sessions,
        sessionMap: { ...s.sessionMap, [sessionId]: { ...(s.sessionMap[sessionId] ?? EMPTY_SESSION), busy: false } },
      }))
    }
  })

  // 激活会话切换：同步 currentSessionId（管家 switch_session 工具切换后，聊天窗口侧边栏也能高亮到目标会话）
  runtime.onCurrentSessionChanged((sessionId) => {
    mutate((s) => ({ ...s, currentSessionId: sessionId }))
  })

  // 管家异步下发的目标会话任务完成：重新拉取管家会话历史，把回传的正文结果显示在管家窗口
  runtime.onSupervisorResult(() => {
    try {
      const items = historyToChatItems(runtime.getSessionHistory(SUPERVISOR_ID))
      mutate((s) => ({
        ...s,
        sessionMap: { ...s.sessionMap, [SUPERVISOR_ID]: { ...(s.sessionMap[SUPERVISOR_ID] ?? EMPTY_SESSION), items } },
      }))
    } catch {
      // 管家会话历史读取失败静默忽略（结果已由 runtime 持久化，下次加载历史可见）
    }
  })

  // 管家向目标会话下发任务：实时把 user 消息气泡同步到目标会话（区别于用户手动输入走渲染进程本地 push，
  // 管家下发是后端 runInSession 异步执行，没有本地 push，否则要等执行结束 onSessionActivity('end') 重建 items 才显示）。
  runtime.onUserMessage((sessionId, message, turnSeq) => {
    mutate((s) => {
      const cur = s.sessionMap[sessionId] ?? EMPTY_SESSION
      const last = cur.items[cur.items.length - 1]
      // 去重：末尾已是同内容 user 气泡则跳过（避免与执行结束后的 items 重建 / 重复事件冲突）
      if (last && last.kind === 'user' && last.content === message) return s
      return {
        ...s,
        sessionMap: {
          ...s.sessionMap,
          [sessionId]: { ...cur, items: [...cur.items, { kind: 'user', content: message, images: [], turnSeq }] },
        },
      }
    })
  })

  // 登录凭证整体失效（token + apiKey 都过期）：置为未登录态，UI 显示登录界面引导用户重新登录（而非静默失败）
  runtime.onAuthExpired(() => {
    mutate((s) => ({ ...s, loggedIn: false, username: null, models: [] }))
  })
}

// 让 patchUiState 接受深层 Partial
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U> ? T[K] | Array<DeepPartial<U>> : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/** 远程端（手机）应答审批后，同步清除桌面端对应队列项并广播（桌面端弹窗据此关闭） */
export function removeApprovalRequest(requestId: string): void {
  mutate((s) => {
    const next: Record<string, ApprovalRequest[]> = {}
    for (const [sid, list] of Object.entries(s.approvalQueues)) {
      next[sid] = list.filter((r) => r.id !== requestId)
    }
    return { ...s, approvalQueues: next }
  })
}

/** 远程端（手机）应答提问/选择器后，同步清除桌面端对应队列项并广播 */
export function removeAskRequest(requestId: string): void {
  mutate((s) => {
    const next: Record<string, AskRequest[]> = {}
    for (const [sid, list] of Object.entries(s.askQueues)) {
      next[sid] = list.filter((r) => r.id !== requestId)
    }
    return { ...s, askQueues: next }
  })
}
