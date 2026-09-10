import { createContext, useContext } from 'react'
import type * as React from 'react'
import type {
  ApprovalRequest,
  AskRequest,
  BrowserWindowItem,
  ClientRunRequest,
  DmQuotePayload,
  GatewayModel,
  RetryPrompt,
  SessionListItem,
  SessionUIState,
  TokenSnapshot,
} from './types'
import type { ChatComposerSeed, ChatComposerState } from './components/ChatComposer'

/**
 * UI 上下文（框架派生 props 的载体）：shell（App）持有应用状态，通过 UIContext 派生给各 slot 插件组件，
 * 业务组件不手写订阅、不硬编码 props 传递（对齐 K3「组件 props 由框架派生」）。
 */

export interface UIContextValue {
  // —— 通用 ——
  loggedIn: boolean
  username: string | null
  /**
   * 【任务235】当前登录用户**自己的**头像 URL（未登录 / 网关未下发 / 老配置无该字段时 null）。
   * 只读、只用于「有头像则显示头像」；绝不涉及 memberId，也不用于任何判定。
   */
  avatar: string | null
  currentSessionId: string
  cur: SessionUIState
  isEmpty: boolean
  sidebarCollapsed: boolean
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  /**
   * 【任务218 · 单窗口合并】右侧主区当前展示哪一路：
   * - 'session'    = 当前会话的消息流（聊天窗口的原有形态，默认值）
   * - 'supervisor' = 会话管家（左列「会话管家」合成条目被选中时）
   *
   * 为什么放在 UIContext 而不是某个子组件里：左列（shell.sidebar 插件）负责「点」，主区（App）负责「渲染」，
   * 两者是同一棵树上的兄弟节点，必须由共同祖先持有这个开关。这是**纯渲染层视图状态**，
   * 不写进主进程 ui-store、不影响 runtime 的 currentSessionId（管家永远不成为当前会话）。
   */
  mainView: 'session' | 'supervisor'
  setMainView: (v: 'session' | 'supervisor') => void
  /** 顶部状态栏（header + 浏览器标签条）实际高度，侧滑面板顶部从它下方开始 */
  headerHeight: number
  // 主题：亮/暗模式切换
  theme: 'light' | 'dark'
  toggleTheme: () => void

  // —— shell.sidebar ——
  sortedSessions: SessionListItem[]
  sessionBusy: (id: string) => boolean
  editingSessionId: string | null
  editingTitle: string
  setEditingTitle: (t: string) => void
  createSession: () => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  switchToSession: (id: string) => Promise<void>
  setEditingSessionId: (id: string | null) => void
  handleLogout: () => Promise<void>
  setLoginOpen: (v: boolean) => void

  // —— shell.header ——
  setMemoryPanelOpen: (v: boolean) => void
  setTracePanelOpen: (v: boolean) => void
  setSettingsPanelOpen: (v: boolean) => void
  browserWindows: BrowserWindowItem[]
  showBrowserWindow: (appId: string) => Promise<void>
  closeBrowserWindow: (appId: string) => Promise<void>

  // —— shell.chat ——
  incompleteTurn: boolean
  curApproval: ApprovalRequest | null
  curAsk: AskRequest | null
  curClientRunRequest: ClientRunRequest | null
  retryPrompt: RetryPrompt | null
  resendMessage: (userIndex: number) => void
  editResend: (userIndex: number, newContent: string) => void
  resumeMessage: () => void
  setPreviewImage: (v: string | null) => void
  respondApproval: (outcome: 'allowed-once' | 'rejected') => Promise<void>
  respondAsk: (answer: string) => Promise<void>
  cancelAsk: () => Promise<void>
  respondClientRun: (approved: boolean) => Promise<void>
  respondRetry: (action: 'retry' | 'cancel') => void

  // —— shell.composer ——
  /** Composer 当前输入的真值缓存（App 的 send 读取；ChatComposer 每次 render 同步最新值） */
  composerRef: React.MutableRefObject<ChatComposerState>
  /** 外部重置信号（草稿恢复 / 新建清空 / 发送清空），seq 递增触发 ChatComposer 重同步自身输入态 */
  composerSeed: ChatComposerSeed
  /** 欢迎页建议点击：把建议文本填入输入框（保留现有附件）。默认追加；传 replace=true 为整体替换。 */
  setComposerInput: (text: string, replace?: boolean) => void
  /**
   * 【安全红线】最近一次「私信引用到本会话」的来源信息（null = 没有）。
   * 只在本地用户于私信面板显式点击「引用到会话」后由 App 设置，用于在输入区上方显示来源提示条；
   * 私信原文是被**追加**进输入框的（等价于本地用户自己打字），本状态不触发任何发送或执行。
   */
  dmQuote: DmQuotePayload | null
  /** 关闭来源提示条（只隐藏提示，不撤销已追加进输入框的文字） */
  clearDmQuote: () => void
  queueCount: number
  models: GatewayModel[]
  selectedModel: string
  setSelectedModel: (v: string) => void
  systemModels: GatewayModel[]
  customModels: GatewayModel[]
  approvalPolicy: 'ask' | 'workdir' | 'never'
  workDir: string
  workDirName: string
  send: () => Promise<void>
  stopSend: () => void
  pickWorkdir: () => Promise<void>
  switchApprovalPolicy: (policy: 'ask' | 'workdir' | 'never') => void
  selectModel: (id: string) => void
  handleRemoveModel: (id: string) => Promise<void>
  setCustomModelDrawerOpen: (v: boolean) => void

  // —— shell.welcome ——
  // （复用 setInput）

  // —— shell.statusbar ——
  currentTokenStats: TokenSnapshot | null

  // —— shell.panels ——
  customModelDrawerOpen: boolean
  addCustomModel: (input: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic'; contextLength?: number; supportsVision?: boolean }) => Promise<void>
  updateCustomModel: (id: string, input: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic'; contextLength?: number; supportsVision?: boolean }) => Promise<void>
  removeCustomModel: (id: string) => Promise<void>
  tracePanelOpen: boolean
  memoryPanelOpen: boolean
  settingsPanelOpen: boolean

  // —— shell.terminal ——
  terminalPanelOpen: boolean
  setTerminalPanelOpen: (v: boolean) => void

  // —— shell.overlays ——
  loginOpen: boolean
  handleLogin: (u: string, p: string) => Promise<void>
  handleRegister: (u: string, p: string, nickname?: string, phone?: string, email?: string) => Promise<void>
  previewImage: string | null
  /** 【P3】发送被本地闸门拦下时的可见原因（App 持有，输入区渲染） */
  sendNotice: string
}

export const UIContext = createContext<UIContextValue | null>(null)

/** 在 slot 插件组件内读取框架派生的状态与操作 */
export function useUIContext(): UIContextValue {
  const ctx = useContext(UIContext)
  if (!ctx) throw new Error('useUIContext 必须在 UIContext.Provider 内使用')
  return ctx
}
