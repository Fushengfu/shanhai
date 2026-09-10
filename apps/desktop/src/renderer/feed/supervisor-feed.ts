import { getUiStoreSnapshot, useStreaming } from '../store-client'
import type { ApprovalRequest, AskRequest, ChatItem, RetryPrompt, SessionUIState } from '../types'
import type { SessionFeed } from './session-feed'

/**
 * SupervisorFeed：`SessionFeed` 的**会话管家窗口适配器** —— 与 `chat-feed.ts` 用同一套接法
 * （逐字段原引用直通、零转换、零兜底、零默认值，只有交叉命名才改名，如 `stop: stopSend`），
 * 只是数据来源不同：
 *   - 聊天窗口：`useUIContext()`（App 派生的 props 载体）+ `useStreaming(currentSessionId)`。
 *   - 管家窗口：`useUiStoreSelector()` 的窄订阅（cur / curApproval / curAsk）+ `useStreaming(SUPERVISOR_SID)`。
 *     管家是**独立 BrowserWindow**，没有 App 派生的 props 载体，故这几个来源由调用方传入
 *     （`ui.cur` / `ui.curApproval` / `ui.curAsk` 就是该窄订阅的原引用，直接透传、不复制）。
 *
 * 为什么拆成「数据面 hook + 组装函数」两个导出（与 chat-feed 单一 hook 的差异，如实登记）：
 *   - **数据面必须在组件早期就可用**：吸底跟随 effect、私信自动路由 effect、`send` 的依赖数组都在
 *     组件中段之前求值，若把整个 feed 放到组件后段组装，这些位置引用 `feed.xxx` 会踩 const 的 TDZ。
 *   - **动作面只能在组件中后段拿到**：resend / editResend / send / stop 等是本组件的 useCallback，
 *     定义位置在中间，且互相依赖（如 `send` 依赖 `cur.busy`），无法提前。
 *   - 两个导出都只做「原引用直通 + 换一个对象字面量」，不产生新值、不做转换。
 *   - `useSupervisorFeedData` 内部仍调用 `useStreaming(SUPERVISOR_SID)`：**订阅的位置与 id 与改造前完全一致**
 *     （原组件第 2 个 hook、同一个固定会话 id），因此 hook 顺序与订阅数都不变。
 *
 * 明确**不提供**的字段（如实不提供，不造假值、不造空实现，见 session-feed.ts 的 optional 说明）：
 *   - `clientRunRequest` / `respondClientRun`：该队列只存在于聊天窗口渲染进程的局部 state
 *     （App.tsx），管家窗口物理上取不到。
 *   - `respondRetry`：`retryPrompt` 的设置点全在聊天窗口 App.tsx 的失败路径，管家窗口没有这个入口。
 *   - `resumeMessage`：后端支持 resume(supervisor)，但管家窗口 GUI 没有「继续执行」入口
 *     （SupervisorApp 中已有注释说明按本窗口真实能力改写文案）。
 *
 * 同时说明**本适配器覆盖不到、仍由 SupervisorApp 直接取用**的两类数据（不在 `SessionFeed` 接口面内）：
 *   - `capabilityApproval` + `respondCapabilityApproval`（能力级审批，管家窗口独有）；
 *   - 输入区面（models / selectedModel / loggedIn / tokenStats / dmQuote / sendNotice / stopNotice …）。
 */

/** 数据面：`SessionFeed` 中与「消息流 + 等待态」相关的字段（动作面由调用方另行提供，见 buildSupervisorFeed） */
export interface SupervisorFeedData {
  sessionId: string
  items: ChatItem[]
  busy: boolean
  turnStartTs?: number
  incompleteTurn: boolean
  isEmpty: boolean
  streaming: { text: string; reasoning: string }
  approval: ApprovalRequest | null
  ask: AskRequest | null
  retryPrompt: RetryPrompt | null
}

/** 数据面入参：管家窗口的三处既有来源（原引用，不做任何转换） */
export interface SupervisorFeedSource {
  /** 固定为 'supervisor'（与 runtime 的 SUPERVISOR_ID 一致），由调用方传入，不在本文件重复字面量 */
  sessionId: string
  /** `useUiStoreSelector` 的 cur（已按 SUPERVISOR_SID 窄订阅的会话状态） */
  cur: SessionUIState
  /** `useUiStoreSelector` 的 curApproval（同源窄订阅） */
  curApproval: ApprovalRequest | null
  /** `useUiStoreSelector` 的 curAsk（同源窄订阅） */
  curAsk: AskRequest | null
}

/**
 * 管家窗口的消息流**数据面**。占用的 hook 只有一个 `useStreaming(sessionId)`（与原实现同位置、同 id）。
 * `retryPrompt` 取自 ui-store 快照：它是**全局单值**（store-client 的 SharedState.retryPrompt），
 * 本窗口没有自己的订阅（不加订阅 = 不改变本窗口的重渲染时机，属零行为变化）；
 * 且按上述说明，管家窗口不存在设置它的入口，故该字段对管家恒为初始值 —— 取值真实（不是硬编码 null）。
 */
export function useSupervisorFeedData(source: SupervisorFeedSource): SupervisorFeedData {
  const streaming = useStreaming(source.sessionId)
  const cur = source.cur
  return {
    sessionId: source.sessionId,
    items: cur.items,
    busy: cur.busy,
    turnStartTs: cur.turnStartTs,
    incompleteTurn: cur.incompleteTurn,
    // 与 SupervisorApp 中原本内联的空态判定逐字一致（items 为空且不在跑）
    isEmpty: cur.items.length === 0 && !cur.busy,
    streaming,
    approval: source.curApproval,
    ask: source.curAsk,
    retryPrompt: getUiStoreSnapshot().retryPrompt ?? null,
  }
}

/** 动作面：管家窗口自有的会话/等待态动作（组件内的既有 useCallback / function 声明，原引用直通） */
export interface SupervisorFeedActions {
  resendMessage: (userIndex: number) => void
  editResend: (userIndex: number, newContent: string) => void
  setPreviewImage: (v: string | null) => void
  respondApproval: (outcome: 'allowed-once' | 'rejected') => Promise<void>
  respondAsk: (answer: string) => Promise<void>
  cancelAsk: () => Promise<void>
  send: () => Promise<void>
  /** 管家窗口的停止（组件内叫 stopSend；接口侧统一叫 stop —— 与 chat-feed 同一种交叉命名） */
  stop: () => void
}

/**
 * 把数据面 + 动作面组装成统一 `SessionFeed`（纯组装，无 hook、无转换、无新值）。
 * 4 个 optional 字段如实不提供 —— 见文件头说明。
 */
export function buildSupervisorFeed(data: SupervisorFeedData, actions: SupervisorFeedActions): SessionFeed {
  return {
    sessionId: data.sessionId,
    items: data.items,
    busy: data.busy,
    turnStartTs: data.turnStartTs,
    incompleteTurn: data.incompleteTurn,
    isEmpty: data.isEmpty,
    streaming: data.streaming,
    approval: data.approval,
    ask: data.ask,
    retryPrompt: data.retryPrompt,
    resendMessage: actions.resendMessage,
    editResend: actions.editResend,
    setPreviewImage: actions.setPreviewImage,
    respondApproval: actions.respondApproval,
    respondAsk: actions.respondAsk,
    cancelAsk: actions.cancelAsk,
    send: actions.send,
    stop: actions.stop,
  }
}
