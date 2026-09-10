import { useStreaming } from '../store-client'
import { useUIContext } from '../ui-context'
import type { ClientRunRequest } from '../types'
import type { SessionFeed } from './session-feed'

/**
 * 聊天窗口侧的 feed 类型：`SessionFeed` 中**声明为 optional 的 4 个字段**（两窗口能力面不对等，
 * 见 session-feed.ts 的说明）在聊天窗口**全部提供**，故此处把它们重新收窄为必填。
 *
 * 为什么需要这一层：`SessionFeed` 把 4 个字段改 optional 后，调用方 `plugins/ChatPlugin` 里
 * `feed.respondRetry('retry')` / `feed.respondClientRun(true)` 这类**直接调用**在 strict 模式下会报
 * 「Cannot invoke an object which is possibly 'undefined'」。聊天窗口侧并没有少能力，只是接口为了
 * 兼容管家窗口而放宽了 —— 用返回类型的收窄把「本 adapter 一定提供」这件事在类型层钉死，
 * **纯类型声明，零运行时行为**（不改变 useChatFeed 的任何取值）。
 */
export type ChatSessionFeed = SessionFeed & {
  clientRunRequest: ClientRunRequest | null
  resumeMessage: () => void
  respondClientRun: (approved: boolean) => Promise<void>
  respondRetry: (action: 'retry' | 'cancel') => void
}

/**
 * ChatFeed：`SessionFeed` 的**聊天窗口适配器** —— 把聊天窗口的两处既有数据来源
 * （`useUIContext()` 派生的 props 载体 + `useStreaming()` 的流式窄订阅）适配成统一接口。
 *
 * 铁律：本文件**只做取用与改名，不做任何转换、兜底、派生或默认值**。
 *   - 每个字段都是**原引用直通**（`items` / `streaming` / 各动作函数），不复制对象、不包裹箭头函数 ——
 *     包一层会让依赖数组里的引用每次都变（吸底跟随 effect 的 deps 直接依赖这些值），属行为变更。
 *   - `streaming` 直通 `useStreaming()` 的返回值，保持 `{ text, reasoning }` 两个子字段各自独立。
 *   - `send` / `stop` 分别对应 `ctx.send` / `ctx.stopSend`（**注意是交叉命名**：接口侧统一叫 stop，
 *     源头叫 stopSend）。
 *   - 不在这里读 `ctx.cur.streaming` / `ctx.cur.streamingReasoning`：全量快照里这两个字段已剥离、恒空。
 *
 * 消费方：plugins/ChatPlugin（本轮唯一接线处）。管家窗口有自己的 `useUiStoreSelector` 来源，
 * 第 4 步才有 `SupervisorFeed`；在那之前管家窗口**一行都不改**。
 */
export function useChatFeed(): ChatSessionFeed {
  const ctx = useUIContext()
  const streaming = useStreaming(ctx.currentSessionId)

  return {
    sessionId: ctx.currentSessionId,
    items: ctx.cur.items,
    busy: ctx.cur.busy,
    turnStartTs: ctx.cur.turnStartTs,
    incompleteTurn: ctx.incompleteTurn,
    isEmpty: ctx.isEmpty,
    streaming,
    approval: ctx.curApproval,
    ask: ctx.curAsk,
    retryPrompt: ctx.retryPrompt,
    clientRunRequest: ctx.curClientRunRequest,
    resendMessage: ctx.resendMessage,
    editResend: ctx.editResend,
    resumeMessage: ctx.resumeMessage,
    setPreviewImage: ctx.setPreviewImage,
    respondApproval: ctx.respondApproval,
    respondAsk: ctx.respondAsk,
    cancelAsk: ctx.cancelAsk,
    respondClientRun: ctx.respondClientRun,
    respondRetry: ctx.respondRetry,
    send: ctx.send,
    stop: ctx.stopSend,
  }
}
