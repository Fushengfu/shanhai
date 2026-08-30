import { useSyncExternalStore } from 'react'
import type {
  ApprovalRequest,
  AskRequest,
  BrowserWindowItem,
  GatewayModel,
  RetryPrompt,
  SessionListItem,
  SessionUIState,
  TokenSnapshot,
} from './types'

/**
 * 主进程 UI 共享 store 的渲染进程客户端。
 *
 * 多窗口桌面系统：聊天窗口 / 桌面壳 / 应用窗口都不再各自维护全局共享状态，
 * 而是通过 useUiStore() 订阅主进程 ui-store 的快照；写入走 patchUiStore()（本地乐观深合并 + IPC patch）。
 * 底层用 useSyncExternalStore 订阅主进程推送（ui:state 事件），保证跨窗口一致。
 */

/** 完整的共享状态快照（本地缓存 + 主进程广播），字段与主进程 ui-store 的 UiStoreState 对齐 */
export interface SharedState {
  loggedIn: boolean
  username: string | null
  loginOpen: boolean
  appMenuOpen: boolean
  currentSessionId: string
  sessions: SessionListItem[]
  sessionMap: Record<string, SessionUIState>
  models: GatewayModel[]
  selectedModel: string
  approvalPolicy: 'ask' | 'workdir' | 'never'
  tokenStatsBySession: Record<string, TokenSnapshot>
  approvalQueues: Record<string, ApprovalRequest[]>
  askQueues: Record<string, AskRequest[]>
  browserWindows: BrowserWindowItem[]
  retryPrompt: RetryPrompt | null
  wallpaper: string | null
}

const EMPTY_STATE: SharedState = {
  loggedIn: false,
  username: null,
  loginOpen: false,
  appMenuOpen: false,
  currentSessionId: '',
  sessions: [],
  sessionMap: {},
  models: [],
  selectedModel: '',
  approvalPolicy: 'ask',
  tokenStatsBySession: {},
  approvalQueues: {},
  askQueues: {},
  browserWindows: [],
  retryPrompt: null,
  wallpaper: null,
}

let snapshot: SharedState = EMPTY_STATE
const listeners = new Set<() => void>()
let initialized = false

/** 流式增量（正文 + 思考）的本地累加缓存：主进程 chat:delta/chat:reasoning 独立小事件直发，
 *  不走全量 ui:state 快照（避免每个 token 全量广播导致内存放大）。会话结束（busy=false）时清空。 */
const EMPTY_STREAMING = { text: '', reasoning: '' }
let streamingCache: Record<string, { text: string; reasoning: string }> = {}
let streamingVersion = 0
const streamingListeners = new Set<() => void>()

let streamingRafId: number | null = null

/** 流式增量渲染节流：onDelta/onReasoning 高频到达（每 token 一次），用 requestAnimationFrame
 *  合并到「每帧一次」通知，避免每个 token 都触发一次 React 全量重渲染导致掉帧。
 *  数据本身在 onDelta/onReasoning 里已同步累加进 streamingCache，这里只控制「通知订阅者」的频率。 */
function notifyStreaming(): void {
  if (streamingRafId !== null) return
  streamingRafId = requestAnimationFrame(() => {
    streamingRafId = null
    streamingVersion++
    streamingListeners.forEach((l) => l())
  })
}

/** 深合并：对象递归合并，数组整体替换，标量替换。用于字段级 patch（不覆盖主进程事件刚更新的其他字段）。 */
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

function ensureInit(): void {
  if (initialized) return
  initialized = true
  void window.shanhai?.getUiState().then((s) => {
    snapshot = s as unknown as SharedState
    listeners.forEach((l) => l())
  })
  window.shanhai?.onUiState((s) => {
    snapshot = s as unknown as SharedState
    // 会话结束（busy=false）时清空该会话的流式累加（items 已重建，streaming 切换为最终正文）
    const sm = (s as unknown as SharedState).sessionMap ?? {}
    for (const sid of Object.keys(sm)) {
      const sess = sm[sid]
      if (sess && !sess.busy) {
        const cur = streamingCache[sid]
        if (cur && (cur.text || cur.reasoning)) delete streamingCache[sid]
      }
    }
    listeners.forEach((l) => l())
    notifyStreaming()
  })
  // 流式增量：主进程独立小事件直发（不走全量 ui:state），本地累加
  window.shanhai?.onDelta((sid, text) => {
    const cur = streamingCache[sid] ?? { text: '', reasoning: '' }
    streamingCache[sid] = { ...cur, text: cur.text + text }
    notifyStreaming()
  })
  window.shanhai?.onReasoning((sid, text) => {
    const cur = streamingCache[sid] ?? { text: '', reasoning: '' }
    streamingCache[sid] = { ...cur, reasoning: cur.reasoning + text }
    notifyStreaming()
  })
}

function getSnapshot(): SharedState {
  ensureInit()
  return snapshot
}

function subscribe(cb: () => void): () => void {
  ensureInit()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 订阅全局 UI 共享状态（会话消息流/流式/审批/token/轨迹/当前会话/模型/登录态等），跨窗口一致 */
export function useUiStore(): SharedState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 订阅指定会话的流式增量（正文 text + 思考 reasoning），由主进程 chat:delta/chat:reasoning 独立小事件本地累加。
 *  用于替代 ctx.cur.streaming / ctx.cur.streamingReasoning（后者已从全量快照剥离，不再实时更新）。 */
export function useStreaming(sessionId: string): { text: string; reasoning: string } {
  return useSyncExternalStore(
    (cb) => {
      ensureInit()
      streamingListeners.add(cb)
      return () => {
        streamingListeners.delete(cb)
      }
    },
    () => streamingCache[sessionId] ?? EMPTY_STREAMING,
    () => EMPTY_STREAMING,
  )
}

/** 同步读取当前共享状态快照（供动作函数在本地计算新值后 patch） */
export function getUiStoreSnapshot(): SharedState {
  ensureInit()
  return snapshot
}

/** 更新共享状态（字段级深合并：本地乐观更新 + IPC patch，主进程合并后广播覆盖） */
export function patchUiStore(patch: DeepPartial<SharedState>): void {
  ensureInit()
  snapshot = deepMerge(snapshot, patch)
  listeners.forEach((l) => l())
  void window.shanhai?.patchUiState(patch as never)
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U> ? T[K] | Array<DeepPartial<U>> : T[K] extends object ? DeepPartial<T[K]> : T[K]
}
