import { useRef, useSyncExternalStore } from 'react'
import type {
  ApprovalRequest,
  AskRequest,
  BrowserWindowItem,
  CapabilityApprovalRequest,
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
  /** 能力级审批队列（插件调 write/destructive 能力时的全局审批请求） */
  capabilityApprovals: CapabilityApprovalRequest[]
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
  capabilityApprovals: [],
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
    // 流式累加缓存清理：① 会话结束（busy=false）时清空；② 会话已从 sessionMap 移除（被删除/切出）时清空残留，
    // 避免切换/删除会话后 streamingCache 长期持有无用增量文本（内存持续增长）。遍历 streamingCache 键（会话数级）。
    const sm = (s as unknown as SharedState).sessionMap ?? {}
    for (const sid of Object.keys(streamingCache)) {
      const sess = sm[sid]
      if (!sess) {
        delete streamingCache[sid]
        continue
      }
      if (!sess.busy) {
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

/** 浅比较：对象/数组逐字段 Object.is。用于窄订阅——selector 结果浅相等时返回上一次缓存引用，
 *  使 useSyncExternalStore 的 Object.is(getSnapshot) 判定为 true，从而跳过无关状态变化触发的重渲染。 */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
    return true
  }
  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

/** 窄订阅（selector 版）：只订阅 selector 选出的窄字段，窄字段浅比较不变时不触发重渲染。
 *  替代 useUiStore() 全量订阅，消除「其他会话的工具步骤 / token / 审批 / 流式等高频变化拖累本组件整体重渲染」的问题。
 *  注意：selector 每次返回新对象没关系，getSnapshot 内部用缓存引用 + 浅比较保证结果引用稳定。 */
export function useUiStoreSelector<T>(selector: (s: SharedState) => T): T {
  const cacheRef = useRef<{ val: T } | null>(null)
  const selRef = useRef(selector)
  selRef.current = selector

  const getSnap = (): T => {
    const s = getSnapshot()
    const next = selRef.current(s)
    const cache = cacheRef.current
    if (cache !== null && shallowEqual(cache.val, next)) {
      return cache.val
    }
    cacheRef.current = { val: next }
    return next
  }

  return useSyncExternalStore(subscribe, getSnap, getSnap)
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
