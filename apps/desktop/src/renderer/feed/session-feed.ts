import type { ApprovalRequest, AskRequest, ChatItem, ClientRunRequest, RetryPrompt } from '../types'

/**
 * SessionFeed：**一个会话「消息流」的数据面 + 动作面**的统一视图（一个会话对应一份 feed）。
 *
 * 为什么要有这层（单窗口合并方案 · 第 3 步）：
 *   聊天窗口（plugins/ChatPlugin）与会话管家窗口（supervisor/SupervisorApp）当前各自从**两套不同来源**
 *   取同一批数据 —— 聊天窗口走 `useUIContext()`（App 派生的 props 载体）+ `useStreaming()`（窄订阅），
 *   管家窗口走 `useUiStoreSelector()/getUiStoreSnapshot()` + 自己的 supervisor IPC。
 *   第 5 步「单窗口双栏」要求右列用**同一套消息流组件**渲染两种数据源，因此先把「右列需要什么」
 *   抽成一个与来源无关的接口，再由各来源各写一个 adapter（本轮只有聊天侧 `ChatFeed`；
 *   管家侧 `SupervisorFeed` 留到第 4 步）。**合并只发生在渲染层，runtime 层不参与**。
 *
 * 字段集怎么来的（**由实测的消费面反推，不是照抄设计稿**）：
 *   逐个扫描 ChatPlugin.tsx 里对 `useUIContext()` / `useStreaming()` 的**全部**取用点，按「数据面 / 等待态 /
 *   消息级动作 / 会话级动作」归类；凡是该文件实际读到的字段才写进来。
 *   - `streaming` 保持 `{ text, reasoning }` **两个子字段分离**：正文与思考是两条独立增量流
 *     （主进程 chat:delta / chat:reasoning 两个事件），合一个字段会让「思考更新」误触发正文档位。
 *   - `turnStartTs` / `incompleteTurn` 是会话级标记，分别驱动「实时耗时」与「继续执行」入口。
 *   - 等待态（approval / ask / retryPrompt / clientRunRequest）是「输入区上方浮层」的数据源，
 *     消息流插件的渲染直接依赖它们，故属本接口而非 composer 面。
 *
 * 明确**不在**本接口里的东西（避免「为抽象而抽象」）：
 *   - `meta`（会话标题 / workDir 等）：消息流渲染**一处都没用到**（实测 0 取用点），不设想象字段。
 *   - `cur.streaming` / `cur.streamingReasoning`：全量快照里这两个字段已剥离、恒为空串，
 *     真正的流式增量只从 `useStreaming` 来（见 store-client 注释），收进接口只会误导实现者。
 *   - composer 的输入态 / 模型 / 审批策略 / 工作目录等：属输入区面，与「消息流」无关。
 */
export interface SessionFeed {
  // —— 身份 ——
  /** 当前会话 id（会话级机制：流式增量订阅、切会话重置等，都按它取） */
  sessionId: string

  // —— 消息流数据面 ——
  /** 按时间顺序的消息项（user / assistant / tool），由渲染侧按轮次分组 */
  items: ChatItem[]
  /** 是否有任务正在执行（决定实时气泡挂载与「尾部残留 tool」的归属） */
  busy: boolean
  /** 本轮任务起始时间戳（ms）；busy 时据此跳动显示已消耗耗时 */
  turnStartTs?: number
  /** 是否存在未完成轮次（可「继续执行」） */
  incompleteTurn: boolean
  /** 消息区是否为空（空态渲染：欢迎页 / 居中布局） */
  isEmpty: boolean
  /** 本轮流式增量：正文与思考**分开**保留，不得合并成单一字段 */
  streaming: { text: string; reasoning: string }

  // —— 等待态（输入区上方浮层的数据源）——
  /** 当前会话待审批的工具请求 */
  approval: ApprovalRequest | null
  /** 当前会话待回答的提问（普通提问 / 会话选择器 / 模型选择器，由 kind 分派） */
  ask: AskRequest | null
  /** 任务失败重试提示（按 sessionId 过滤后展示） */
  retryPrompt: RetryPrompt | null
  /**
   * 自修改（K5）browser 半投递审批请求。
   * ★本字段为 optional：该队列的唯一来源是**聊天窗口渲染进程内的局部 state**
   * （App.tsx 的 curClientRunRequest，由 api.onClientRunRequest 填充）；会话管家是**另一个 BrowserWindow**
   * （独立渲染进程），物理上取不到它。为管家侧造一个恒 null 的假值，就是「抽了没接」那类死代码的成因
   * （components/errorBubble.ts 抽出来后 0 引用、直到 216 才接上的教训）——**做不到的一侧如实不提供**。
   */
  clientRunRequest?: ClientRunRequest | null

  // —— 消息级动作 ——
  resendMessage: (userIndex: number) => void
  editResend: (userIndex: number, newContent: string) => void
  /**
   * 续跑未完成轮次。★optional：管家窗口没有这个入口（后端 resume(supervisor) 支持，
   * 但 GUI 无按钮，见 SupervisorApp 的注释），故管家的 adapter 如实不提供。
   */
  resumeMessage?: () => void
  setPreviewImage: (v: string | null) => void

  // —— 等待态动作 ——
  respondApproval: (outcome: 'allowed-once' | 'rejected') => Promise<void>
  respondAsk: (answer: string) => Promise<void>
  cancelAsk: () => Promise<void>
  /** 响应自修改投递审批。★optional：与 clientRunRequest 同因（管家窗口无此队列）。 */
  respondClientRun?: (approved: boolean) => Promise<void>
  /**
   * 响应任务失败重试提示。★optional：retryPrompt 的设置点全在聊天窗口 App.tsx
   * （发送/重发/续跑失败路径），管家窗口不存在该入口，故管家的 adapter 如实不提供。
   */
  respondRetry?: (action: 'retry' | 'cancel') => void

  // —— 会话级动作（发消息 / 停止）——
  /** 发送当前输入区内容（真值在 composer 的 ref 里，故无参） */
  send: () => Promise<void>
  /** 停止当前会话正在跑的任务 */
  stop: () => void
}
