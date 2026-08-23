import type { ComponentType } from 'react'

/** Web Speech API 最小类型（renderer 端语音识别，Electron 内基于系统语音服务） */
export interface SpeechRecognitionAlternativeLike {
  transcript: string
}
export interface SpeechRecognitionResultLike {
  isFinal: boolean
  0?: SpeechRecognitionAlternativeLike
}
export interface SpeechRecognitionResultListLike {
  resultIndex: number
  results: Array<SpeechRecognitionResultLike | undefined>
  length: number
}
export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionResultListLike) => void) | null
  onend: (() => void) | null
  onerror: ((event: unknown) => void) | null
  start(): void
  stop(): void
}

export interface ToolTrace {
  kind: 'tool-call' | 'tool-result'
  sessionId: string
  callId: string
  name: string
  args?: Record<string, unknown>
  result?: unknown
  error?: string
  approvalRequired?: boolean
  approved?: boolean
  /** 本次工具调用对应的「思考」（模型在决定调用该工具前输出的 reasoning），工具步骤卡片折叠展示 */
  reasoning?: string
  /** 工具调用开始时间戳（ms）：tool-call 用于执行中实时计时 */
  startTs?: number
  /** 工具执行耗时（ms）：tool-result 用于完成后显示固定耗时 */
  durationMs?: number
}

export interface ApprovalRequest {
  id: string
  sessionId?: string
  toolName: string
  args: Record<string, unknown>
  riskLevel: string
}

/** 一张 macOS 系统壁纸的元信息（listSystemWallpapers 返回项） */
export interface SystemWallpaperMeta {
  id: string
  name: string
  thumbnail: string
}

/** 远程连接（手机端跨端连接）状态 */
export interface RemoteStatus {
  enabled: boolean
  port: number
  ip: string
  pairingCode: string
  pairingExpiresAt: number
  pairedClients: number
}

/** 远程连接（网关中继，外网可达）状态 */
export interface RelayStatus {
  enabled: boolean
  connected: boolean
  url: string
  username: string | null
  clientCount: number
}

/** 会话选择器中的单个会话选项（choose_session 工具专用） */
export interface AskSessionOption {
  id: string
  title: string
  busy: boolean
  active: boolean
  modelName: string
  workDir: string
  contextUsageRatio: number
  currentRequest: string
}

/** 模型选择器中的单个模型选项（choose_model 工具专用） */
export interface AskModelOption {
  id: string
  name: string
}

/** AI 向用户提问请求（单选/多选/填空/选择器交互） */
export interface AskRequest {
  id: string
  sessionId?: string
  question: string
  options?: string[]
  multiple?: boolean
  placeholder?: string
  /** 交互类型：text=普通提问/填空（默认）、session-picker=会话选择器、model-picker=模型选择器 */
  kind?: 'text' | 'session-picker' | 'model-picker'
  /** 会话选择器数据（kind=session-picker 时提供） */
  sessionOptions?: AskSessionOption[]
  /** 模型选择器数据（kind=model-picker 时提供） */
  modelOptions?: AskModelOption[]
}

/** 任务失败重试弹窗数据（网络/余额不足等可重试错误自动重试耗尽后弹出，用户选「重试/取消」） */
export interface RetryPrompt {
  sessionId: string
  /** 失败原因（展示给用户） */
  message: string
}

export interface GatewayModel {
  id: string
  name: string
  tier: string
  apiKey: string
  baseUrl: string
  model?: string
  /** 调用协议：openai（默认）/ anthropic */
  protocol?: 'openai' | 'anthropic'
  custom?: boolean
}

export interface ContentPart {
  type: 'text' | 'image_url' | 'input_audio' | 'input_video'
  text?: string
  image_url?: { url: string }
  input_audio?: { data: string; format: string }
  input_video?: { data: string; format: string }
}

export interface TokenSnapshot {
  totalPrompt: number
  totalCompletion: number
  total: number
  turnPrompt: number
  turnCompletion: number
  turn: number
  contextLength: number
  lastPrompt: number
  contextUsageRatio: number
  turnCachedPromptTokens: number
  totalCachedPromptTokens: number
  cacheHitRatio: number
  turnCount: number
}

export type HistoryItem =
  | { kind: 'user'; content?: string; attachments?: unknown[]; turnSeq?: number }
  | { kind: 'assistant'; content?: string; reasoningContent?: string; turnSeq?: number; turnDuration?: number }
  | { kind: 'tool'; trace?: ToolTrace }

/** 自修改（K5）browser 半投递的 round-trip 审批请求 */
export interface ClientRunRequest {
  requestId: string
  sessionId: string
  pkgId: string
  name: string
  purpose: string
}

/** 多专家编排轨迹（Triage 拆解 → 专家执行过程） */
export interface ExpertTrace {
  sessionId?: string
  /** 所属轮次序号（会话内 user 消息序号，从 1 开始）；用于把「多专家协作」卡片插到对应那一轮消息之后 */
  turnSeq?: number
  stepId: string
  expertId: string
  expertName: string
  title: string
  status: 'started' | 'completed' | 'failed'
  result?: string
  error?: string
}

/** 专家角色（多专家编排：内置 + 自定义；builtin 标记内置不可删，自定义可删） */
export interface Expert {
  id: string
  name: string
  description: string
  systemPrompt: string
  toolSet: string[]
  skillSet: string[]
  builtin: boolean
}

/** 长期记忆条目 */
export interface MemoryEntry {
  id: number
  scope: string
  key: string
  value: unknown
  source: string
  confidence: number
  timestamp: number
}

/** 通用设置（与 preload / runtime 的 AppSettings 对应） */
export interface AppSettings {
  browser: {
    /** 创建内置浏览器窗口时是否直接显示 */
    showOnCreate: boolean
    /** 是否开启「DeepSeek 网页版」桥接对接：关闭后不注册该模型，也不为每个会话预创建默认浏览器窗口 */
    enableWebBridge: boolean
  }
  messageSubmit: {
    /** 任务执行中继续发消息的策略：queue=排队等待，insert=打断插入 */
    mode: 'queue' | 'insert'
  }
  debug: {
    /** 是否记录每次 LLM 请求/响应原始数据（排查问题用） */
    traceLlm: boolean
  }
  voice: {
    /** 任务执行完、输出正文时是否自动语音播报 */
    enabled: boolean
  }
}

/** 设置补丁：允许只传某个分组的某个字段（嵌套 Partial） */
export type AppSettingsPatch = {
  browser?: Partial<AppSettings['browser']>
  messageSubmit?: Partial<AppSettings['messageSubmit']>
  debug?: Partial<AppSettings['debug']>
  voice?: Partial<AppSettings['voice']>
}

/** 一条 HTTP 原始请求/响应记录（排查问题用：请求一条、响应一条，含接口地址与完整 body） */
export interface HttpTraceRecord {
  ts: number
  sessionId: string
  model: string
  phase: 'request' | 'response'
  url: string
  method: string
  body?: unknown
  responseStatus?: number
  error?: string
}

/** 动态注册到 UI 插槽的组件（browser 半 slots.register 的产物） */
export interface ClientComponentReg {
  slot: string
  id: string
  pkgId: string
  Component: ComponentType
}

declare global {
  interface Window {
    shanhai?: {
      /** 当前窗口类型（desktop/chat/app/supervisor/supervisor-bubble） */
      windowType: 'desktop' | 'dock' | 'chat' | 'app' | 'supervisor' | 'supervisor-bubble'
      /** app 类型窗口的应用 id，非 app 窗口为 undefined */
      windowAppId?: string
      /** 打开（或聚焦）一个插件应用窗口 */
      openApp(appId: string): Promise<boolean>
      /** 关闭一个插件应用窗口 */
      closeApp(appId: string): Promise<void>
      /** 桌面被点击时，把聊天/应用窗口带回桌面之上（fire-and-forget） */
      restoreAboveDesktop(): void
      /** 隐藏聊天窗口（自定义关闭按钮，聊天窗口常驻不销毁） */
      hideChatWindow(): Promise<void>
      /** 隐藏当前发起窗口（常驻窗口如 supervisor 的自定义关闭按钮） */
      hideSelf(): Promise<void>
      /** 管家窗口关闭 → 隐藏窗口并显示悬浮图标 */
      hideSupervisorToBubble(): Promise<void>
      /** 点击悬浮图标 → 隐藏图标并恢复管家窗口 */
      showSupervisorFromBubble(): Promise<void>
      /** 拖动悬浮图标（按位移增量移动，fire-and-forget） */
      moveSupervisorBubble(dx: number, dy: number): void
      /** 最小化当前窗口（自定义标题栏按钮） */
      minimizeWindow(): void
      /** 切换当前窗口最大化/还原，返回操作后的最大化状态（自定义标题栏按钮） */
      toggleMaximizeWindow(): Promise<boolean>
      /** Dock 窗口根据图标栏内容自适应尺寸（渲染进程测量后回调，fire-and-forget） */
      resizeDock(width: number, height: number): void
      /** 切换主题（亮/暗）：通知主进程广播给所有窗口 */
      setTheme(theme: 'light' | 'dark'): void
      /** 订阅主题变更（主进程广播 ui:theme），返回取消订阅函数 */
      onThemeChange(cb: (theme: 'light' | 'dark') => void): () => void
      /** 读取桌面壁纸（CSS backgroundImage 值，null = 默认渐变） */
      getWallpaper(): Promise<string | null>
      /** 设置并持久化桌面壁纸（CSS backgroundImage 值，null = 恢复默认渐变） */
      setWallpaper(wallpaper: string | null): Promise<string | null>
      /** 列出 macOS 系统自带壁纸（含缩略图 data URL） */
      listSystemWallpapers(): Promise<SystemWallpaperMeta[]>
      /** 应用某张系统壁纸（源文件名），返回应用后的 CSS backgroundImage 值 */
      applySystemWallpaper(sourcePath: string): Promise<string>
      /** 开启远程连接（手机端跨端连接），返回含配对码/本机 IP 的状态 */
      remoteEnable(port?: number): Promise<RemoteStatus>
      /** 关闭远程连接 */
      remoteDisable(): Promise<RemoteStatus>
      /** 查询远程连接状态 */
      remoteStatus(): Promise<RemoteStatus>
      /** 开启网关中继（外网可达），桌面端作为 Host 连网关 */
      relayEnable(url?: string): Promise<RelayStatus>
      /** 关闭网关中继 */
      relayDisable(): Promise<RelayStatus>
      /** 查询网关中继状态 */
      relayStatus(): Promise<RelayStatus>
      /** 读取全局 UI 共享状态快照 */
      getUiState(): Promise<GlobalUiState>
      /** 订阅全局 UI 共享状态变化 */
      onUiState(cb: (state: GlobalUiState) => void): () => void
      /** 更新全局 UI 共享状态（字段级 patch） */
      patchUiState(patch: Partial<GlobalUiState>): Promise<void>
      status(): Promise<{ loggedIn: boolean; username: string | null }>
      login(u: string, p: string): Promise<{ username: string; nickname?: string }>
      logout(): Promise<void>
      listModels(): Promise<GatewayModel[]>
      refreshModels(): Promise<GatewayModel[]>
      onModelsChanged(cb: () => void): () => void
      addCustomModel(model: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic' }): Promise<GatewayModel>
      updateCustomModel(id: string, model: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic' }): Promise<GatewayModel>
      removeCustomModel(id: string): Promise<void>
      listSessions(): Promise<Array<{ id: string; title: string; workDir: string; lastActiveAt: number; busy: boolean }>>
      createSession(title?: string, workdir?: string): Promise<string>
      switchSession(id: string): Promise<void>
      renameSession(id: string, title: string): Promise<void>
      deleteSession(id: string): Promise<void>
      getSessionWorkdir(id?: string): Promise<string>
      setSessionWorkdir(id: string, workdir: string): Promise<void>
      saveUploadedFile(fileName: string, dataBase64: string): Promise<string>
      uploadImage(imageBase64: string, mimeType?: string): Promise<string | null>
      listBrowserWindows(sessionId?: string): Promise<Array<{ appId: string; url: string; title: string; label?: string }>>
      showBrowserWindow(appId: string): Promise<void>
      closeBrowserWindow(appId: string): Promise<void>
      userTerminalCreate(sessionId: string, name?: string): Promise<string>
      userTerminalWrite(sessionId: string, terminalId: string, data: string): void
      userTerminalResize(sessionId: string, terminalId: string, cols: number, rows: number): void
      userTerminalClose(sessionId: string, terminalId: string): Promise<void>
      userTerminalList(sessionId: string): Promise<UserTerminalInfo[]>
      onUserTerminalOutput(cb: (sessionId: string, terminalId: string, data: string) => void): () => void
      getDeepSeekBridgeStatus(): Promise<{ windowReady: boolean; bridgeInjected: boolean }>
      openDeepSeekBridge(): Promise<{ ok: boolean; message: string }>
      injectDeepSeekBridge(): Promise<{ ok: boolean; message: string }>
      selectDirectory(defaultPath?: string): Promise<string | null>
      getSessionHistory(id?: string): Promise<HistoryItem[]>
      getSessionTrace(id?: string): Promise<Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; reasoningContent?: string; toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>; toolCallId?: string; toolName?: string; result?: unknown; error?: string; turn: number; timestamp: number }>>
      respondApproval(outcome: 'allowed-once' | 'rejected', requestId: string): Promise<void>
      onAskRequest(cb: (req: AskRequest) => void): () => void
      respondAsk(requestId: string, answer: string): Promise<void>
      cancelAsk(requestId: string): Promise<void>
      run(message: string, attachments?: ContentPart[]): Promise<string>
      supervisorRun(message: string, attachments?: ContentPart[]): Promise<string>
      getSupervisorHistory(): Promise<HistoryItem[]>
      supervisorGetModel(): Promise<string>
      supervisorGetApproval(): Promise<'ask' | 'workdir' | 'never'>
      supervisorSetModel(id: string): Promise<{ ok: boolean; message: string }>
      supervisorSetApproval(policy: 'ask' | 'workdir' | 'never'): Promise<{ ok: boolean; message: string }>
      resend(sessionId: string, userMessageIndex: number, newContent?: string): Promise<string>
      resume(sessionId: string): Promise<string>
      retry(sessionId: string): Promise<string>
      abandon(sessionId: string): Promise<void>
      injectMessage(sessionId: string, message: string): Promise<boolean>
      hasIncompleteTurn(sessionId: string): Promise<boolean>
      hasRetrySnapshot(sessionId: string): Promise<{ reason?: string } | null>
      getApprovalPolicy(): Promise<'ask' | 'workdir' | 'never'>
      setApprovalPolicy(policy: 'ask' | 'workdir' | 'never'): Promise<void>
      onApprovalRequest(cb: (req: ApprovalRequest) => void): () => void
      onToolTrace(cb: (trace: ToolTrace) => void): () => void
      onDelta(cb: (sessionId: string, text: string) => void): () => void
      onReasoning(cb: (sessionId: string, text: string) => void): () => void
      switchModel(id: string): Promise<void>
      getCurrentModelId(): Promise<string>
      stop(): Promise<void>
      speak(text: string): Promise<void>
      transcribeAudio(audioBase64: string, format?: string): Promise<string>
      getTokenStats(): Promise<TokenSnapshot>
      onTokenStats(cb: (sessionId: string, stats: TokenSnapshot) => void): () => void
      selfmodInspect(sessionId?: string): Promise<unknown>
      onClientRunRequest(cb: (req: ClientRunRequest) => void): () => void
      respondClientRun(requestId: string, approved: boolean): Promise<void>
      onClientCode(cb: (payload: { pkgId: string; name: string; code: string }) => void): () => void
      onClientRemove(cb: (pkgId: string) => void): () => void
      onExpertTrace(cb: (trace: ExpertTrace) => void): () => void
      listExperts(): Promise<Expert[]>
      addExpert(role: { id: string; name: string; description: string; systemPrompt: string }): Promise<Expert>
      removeExpert(id: string): Promise<void>
      listMemory(): Promise<MemoryEntry[]>
      removeMemory(id: number): Promise<void>
      getSettings(): Promise<AppSettings>
      setSettings(patch: AppSettingsPatch): Promise<AppSettings>
      getHttpTrace(id?: string): Promise<HttpTraceRecord[]>
      clearHttpTrace(id?: string): Promise<void>
      getHttpTracePath(id?: string): string
      openTraceDir(): Promise<string>
      clipboardWriteText(text: string): void
      clipboardReadText(): string
    }
  }
}

export type ChatItem =
  | { kind: 'user'; content: string; images?: string[]; pending?: boolean; queueId?: string; turnSeq?: number }
  | { kind: 'assistant'; content: string; reasoningContent?: string; turnSeq?: number; turnDuration?: number }
  | { kind: 'tool'; trace: ToolTrace }

/** 会话列表项（含活跃时间 / 是否进行中，用于侧边栏排序：进行中置顶 → 最近活跃时间倒序） */
export interface SessionListItem {
  id: string
  title: string
  workDir: string
  lastActiveAt: number
  busy: boolean
}

/** 全局 UI 共享状态（多窗口桌面系统的跨窗口上下文，与主进程 ui-store / preload 对齐） */
export interface GlobalUiState {
  loggedIn: boolean
  username: string | null
  currentSessionId: string
  sessions: SessionListItem[]
  models: GatewayModel[]
  selectedModel: string
  approvalPolicy: 'ask' | 'workdir' | 'never'
  /** 桌面壳壁纸：CSS backgroundImage 值（预设渐变字符串或 data:image base64）。null = 默认渐变 */
  wallpaper: string | null
}

/** 内置浏览器窗口标签项（agent 自主打开，标签区展示，可手动关闭） */
export interface BrowserWindowItem {
  appId: string
  url: string
  title: string
  label?: string
}

/** 用户手动终端简要信息（会话级隔离，多开多个） */
export interface UserTerminalInfo {
  terminalId: string
  name?: string
  cwd?: string
}

/** 每个会话独立的 UI 状态（支持并行会话：切换会话后，后台会话继续跑，互不串扰） */
export interface SessionUIState {
  items: ChatItem[]
  streaming: string
  streamingReasoning: string
  busy: boolean
  /** 终端面板是否展开（会话级隔离：每个会话各自记住开关状态，切会话互不影响） */
  terminalPanelOpen: boolean
  /** 当前任务开始时间戳（ms）：任务执行中（busy）实时气泡顶部据此跳动显示已消耗耗时 */
  turnStartTs?: number
  /** 是否存在未完成轮次（任务中断/挂起，可「继续执行」）。会话级隔离：每个会话各自记录，避免多会话/后台任务下按钮串扰 */
  incompleteTurn: boolean
}

export const EMPTY_SESSION: SessionUIState = { items: [], streaming: '', streamingReasoning: '', busy: false, terminalPanelOpen: false, incompleteTurn: false }

/** 附件（输入框里已选择的图片/音频/视频/普通文件） */
export interface AttachmentItem {
  /** 唯一标识（用于异步上传后回填状态） */
  id: string
  type: 'image' | 'audio' | 'video' | 'file'
  name: string
  dataUrl: string
  mime: string
  size: number
  /** 图片上传云存储的状态：uploading=上传中，done=已拿到 https 链接，error=上传失败（回退 data URL） */
  uploadStatus?: 'uploading' | 'done' | 'error'
  /** 上传成功后的 https 公网链接（图片识别/多模态优先用此链接） */
  url?: string
}
