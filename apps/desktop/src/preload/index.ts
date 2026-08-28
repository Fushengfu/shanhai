import { contextBridge, ipcRenderer, clipboard } from 'electron'

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
}

/** 一张 macOS 系统壁纸的元信息 */
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

/** 应用版本检查/更新结果（主进程 → 渲染层） */
export interface AppUpdateCheckResult {
  success: boolean
  checkedAt: number
  currentVersion: string
  hasUpdate: boolean
  latestVersion?: string
  latestVersionCode?: string
  releaseNotes?: string
  downloadUrl?: string
  forceUpdate?: boolean
  downloadTriggered?: boolean
  message?: string
}

/** 手机端（Android）APK 下载信息 */
export interface MobileApkInfo {
  downloadUrl: string
  version?: string
}

export interface ApprovalRequest {
  id: string
  sessionId?: string
  toolName: string
  args: Record<string, unknown>
  riskLevel: string
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

/** 多模态内容片段（与 llm 包 ContentPart 对应） */
export interface ContentPart {
  type: 'text' | 'image_url' | 'input_audio' | 'input_video'
  text?: string
  image_url?: { url: string }
  input_audio?: { data: string; format: string }
  input_video?: { data: string; format: string }
}

/** token 用量快照（累计 / 本轮 / 上下文占比） */
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
  turnCount: number
}

/** 全局 UI 共享状态（多窗口桌面系统的跨窗口上下文，与主进程 ui-store 对齐） */
export interface SessionUIStatePreload {
  items: Array<
    | { kind: 'user'; content: string; images?: string[]; pending?: boolean; queueId?: string; turnSeq?: number }
    | { kind: 'assistant'; content: string; reasoningContent?: string; turnSeq?: number; turnDuration?: number }
    | { kind: 'tool'; trace: ToolTrace }
  >
  streaming: string
  streamingReasoning: string
  busy: boolean
  terminalPanelOpen: boolean
  turnStartTs?: number
  incompleteTurn: boolean
}

export interface BrowserWindowItemPreload {
  appId: string
  url: string
  title: string
  label?: string
}

export interface RetryPromptPreload {
  sessionId: string
  message: string
}

export interface GlobalUiState {
  loggedIn: boolean
  username: string | null
  currentSessionId: string
  sessions: Array<{ id: string; title: string; workDir: string; lastActiveAt: number; busy: boolean }>
  sessionMap: Record<string, SessionUIStatePreload>
  models: Array<{ id: string; name: string; tier: string; apiKey: string; baseUrl: string; model?: string; protocol?: 'openai' | 'anthropic'; custom?: boolean }>
  selectedModel: string
  approvalPolicy: 'ask' | 'workdir' | 'never'
  tokenStatsBySession: Record<string, TokenSnapshot>
  approvalQueues: Record<string, ApprovalRequest[]>
  askQueues: Record<string, AskRequest[]>
  browserWindows: BrowserWindowItemPreload[]
  retryPrompt: RetryPromptPreload | null
  wallpaper: string | null
}

export interface ShanhaiBridge {
  /** 当前窗口类型（desktop/chat/app/supervisor），由主进程 additionalArguments 注入、preload 读 process.argv 得到 */
  windowType: 'desktop' | 'dock' | 'chat' | 'app' | 'supervisor' | 'supervisor-bubble'
  /** 运行平台（process.platform：darwin/win32/linux），渲染层据此做平台差异化（如 Windows 窗口圆角） */
  platform: string
  /** app 类型窗口的应用 id（terminal/trace/memory/settings/models），非 app 窗口为 undefined */
  windowAppId?: string
  /** 打开（或聚焦）一个插件应用窗口 */
  openApp(appId: string): Promise<boolean>
  /** 关闭一个插件应用窗口 */
  closeApp(appId: string): Promise<void>
  /** 查询动态插件窗口应用（appId = 插件持久化 id），返回 { appId, name, clientCode, icon? } 或 null */
  getPluginApp(appId: string): Promise<{ appId: string; name: string; clientCode: string; icon?: string } | null>
  /** 列出所有已安装的动态插件窗口应用（appId = 插件持久化 id），供桌面壳 Dock 渲染应用图标 */
  listPluginApps(): Promise<Array<{ appId: string; name: string; clientCode: string; icon?: string }>>
  /** 订阅动态插件窗口应用清单变化（安装/卸载时主进程广播完整清单，Dock 据此增删图标） */
  onPluginAppsChanged(cb: (apps: Array<{ appId: string; name: string; clientCode: string; icon?: string }>) => void): () => void
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
  /** 退出到桌面：隐藏所有山海窗口回到系统界面，应用后台运行（托盘/快捷键恢复） */
  exitToDesktop(): Promise<void>
  /** 切换主题（亮/暗）：通知主进程广播给所有窗口（聊天窗口是唯一写者） */
  setTheme(theme: 'light' | 'dark'): void
  /** 订阅主题变更（主进程广播 ui:theme），返回取消订阅函数 */
  onThemeChange(cb: (theme: 'light' | 'dark') => void): () => void
  /** 读取全局 UI 共享状态快照（当前会话/会话列表/模型/登录态/审批策略） */
  getUiState(): Promise<GlobalUiState>
  /** 订阅全局 UI 共享状态变化（主进程 store 变化时推送最新快照） */
  onUiState(cb: (state: GlobalUiState) => void): () => void
  /** 更新全局 UI 共享状态（字段级 patch，窗口动作后调用） */
  patchUiState(patch: Partial<GlobalUiState>): Promise<void>
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
  /** 刷新局域网配对码（默认常开后，5 分钟过期的配对码需要刷新） */
  refreshRemoteCode(): Promise<RemoteStatus>
  /** 开启网关中继（外网可达），桌面端作为 Host 连网关 */
  relayEnable(url?: string): Promise<RelayStatus>
  /** 关闭网关中继 */
  relayDisable(): Promise<RelayStatus>
  /** 查询网关中继状态 */
  relayStatus(): Promise<RelayStatus>
  /** 获取当前应用版本号（package.json version） */
  getVersion(): Promise<string>
  /** 手动检查更新（弹窗引导下载/安装），返回检查结果 */
  checkUpdate(): Promise<AppUpdateCheckResult>
  /** 获取最近一次版本检查结果（自动检查或手动检查） */
  getUpdateStatus(): Promise<AppUpdateCheckResult | null>
  /** 订阅主进程自动检查发现新版本时的推送，返回取消订阅函数 */
  onUpdateAvailable(cb: (result: AppUpdateCheckResult) => void): () => void
  /** 获取手机端（Android）APK 下载信息（下载地址 + 版本号），失败返回 null */
  getMobileApkInfo(packageName: string): Promise<MobileApkInfo | null>
  // 认证
  status(): Promise<{ loggedIn: boolean; username: string | null }>
  login(username: string, password: string): Promise<{ username: string; nickname?: string }>
  register(username: string, password: string, nickname?: string, phone?: string, email?: string): Promise<{ username: string; nickname?: string }>
  logout(): Promise<void>
  listModels(): Promise<Array<{ id: string; name: string; tier: string; apiKey: string; baseUrl: string; model?: string; protocol?: 'openai' | 'anthropic'; custom?: boolean }>>
  refreshModels(): Promise<Array<{ id: string; name: string; tier: string; apiKey: string; baseUrl: string; model?: string; protocol?: 'openai' | 'anthropic'; custom?: boolean }>>
  onModelsChanged(cb: () => void): () => void
  addCustomModel(model: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic'; contextLength?: number; supportsVision?: boolean }): Promise<{ id: string; name: string; tier: string; apiKey: string; baseUrl: string; model?: string; protocol?: 'openai' | 'anthropic'; custom?: boolean; contextLength?: number; supportsVision?: boolean }>
  updateCustomModel(id: string, model: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic'; contextLength?: number; supportsVision?: boolean }): Promise<{ id: string; name: string; tier: string; apiKey: string; baseUrl: string; model?: string; protocol?: 'openai' | 'anthropic'; custom?: boolean; contextLength?: number; supportsVision?: boolean }>
  removeCustomModel(id: string): Promise<void>
  // 会话
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
  // 用户手动终端（会话级隔离，多开多个）
  userTerminalCreate(sessionId: string, name?: string): Promise<string>
  userTerminalWrite(sessionId: string, terminalId: string, data: string): void
  userTerminalResize(sessionId: string, terminalId: string, cols: number, rows: number): void
  userTerminalClose(sessionId: string, terminalId: string): Promise<void>
  userTerminalList(sessionId: string): Promise<UserTerminalInfo[]>
  onUserTerminalOutput(cb: (sessionId: string, terminalId: string, data: string) => void): () => void
  // DeepSeek 网页版桥接（CDP 直连）
  getDeepSeekBridgeStatus(): Promise<{ windowReady: boolean; bridgeInjected: boolean }>
  openDeepSeekBridge(): Promise<{ ok: boolean; message: string }>
  injectDeepSeekBridge(): Promise<{ ok: boolean; message: string }>
  selectDirectory(defaultPath?: string): Promise<string | null>
  getSessionHistory(id?: string): Promise<Array<{ kind: 'user' | 'assistant' | 'tool'; content?: string; reasoningContent?: string; trace?: ToolTrace; attachments?: unknown[]; turnSeq?: number; turnDuration?: number }>>
  getSessionTrace(id?: string): Promise<Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; reasoningContent?: string; toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>; toolCallId?: string; toolName?: string; result?: unknown; error?: string; turn: number; timestamp: number }>>
  // 审批
  onApprovalRequest(cb: (req: ApprovalRequest) => void): () => void
  respondApproval(outcome: 'allowed-once' | 'rejected', requestId: string): Promise<void>
  // AI 向用户提问（单选/多选/填空/选择器）
  onAskRequest(cb: (req: AskRequest) => void): () => void
  respondAsk(requestId: string, answer: string): Promise<void>
  cancelAsk(requestId: string): Promise<void>
  // 工具过程
  onToolTrace(cb: (trace: ToolTrace) => void): () => void
  // 聊天
  run(message: string, attachments?: ContentPart[]): Promise<string>
  // 会话管家（主 Agent，独立 supervisor 窗口）
  supervisorRun(message: string, attachments?: ContentPart[]): Promise<string>
  getSupervisorHistory(): Promise<Array<{ kind: 'user' | 'assistant' | 'tool'; content?: string; reasoningContent?: string; trace?: ToolTrace; attachments?: unknown[]; turnSeq?: number; turnDuration?: number }>>
  /** 管家自己的模型 id（supervisor 会话级，独立于其他会话与全局默认） */
  supervisorGetModel(): Promise<string>
  /** 管家自己的安全模式（supervisor 会话级） */
  supervisorGetApproval(): Promise<'ask' | 'workdir' | 'never'>
  /** 切换管家自己的模型（只影响 supervisor 会话，不碰其他会话/全局默认） */
  supervisorSetModel(id: string): Promise<{ ok: boolean; message: string }>
  /** 配置管家自己的安全模式（只影响 supervisor 会话） */
  supervisorSetApproval(policy: 'ask' | 'workdir' | 'never'): Promise<{ ok: boolean; message: string }>
  resend(sessionId: string, userMessageIndex: number, newContent?: string): Promise<string>
  resume(sessionId: string): Promise<string>
  retry(sessionId: string): Promise<string>
  abandon(sessionId: string): Promise<void>
  injectMessage(sessionId: string, message: string): Promise<boolean>
  hasIncompleteTurn(sessionId: string): Promise<boolean>
  hasRetrySnapshot(sessionId: string): Promise<{ reason?: string } | null>
  onDelta(cb: (sessionId: string, text: string) => void): () => void
  onReasoning(cb: (sessionId: string, text: string) => void): () => void
  // 审批策略（安全模式）
  getApprovalPolicy(): Promise<'ask' | 'workdir' | 'never'>
  setApprovalPolicy(policy: 'ask' | 'workdir' | 'never'): Promise<void>
  // 模型 / 中断 / 语音 / 电脑
  switchModel(id: string): Promise<void>
  getCurrentModelId(): Promise<string>
  stop(): Promise<void>
  speak(text: string): Promise<void>
  transcribeAudio(audioBase64: string, format?: string): Promise<string>
  // token 用量（会话级）
  getTokenStats(sessionId?: string): Promise<TokenSnapshot>
  onTokenStats(cb: (sessionId: string, stats: TokenSnapshot) => void): () => void
  // 自修改（K5）
  selfmodInspect(sessionId?: string): Promise<unknown>
  onClientRunRequest(cb: (req: { requestId: string; sessionId: string; pkgId: string; name: string; purpose: string }) => void): () => void
  respondClientRun(requestId: string, approved: boolean): Promise<void>
  onClientRunResolved(cb: (requestId: string) => void): () => void
  onClientCode(cb: (payload: { pkgId: string; name: string; code: string }) => void): () => void
  onClientRemove(cb: (pkgId: string) => void): () => void
  listMemory(sessionId: string): Promise<MemoryEntry[]>
  removeMemory(id: number): Promise<void>
  // 通用设置
  getSettings(): Promise<AppSettings>
  setSettings(patch: AppSettingsPatch): Promise<AppSettings>
  // HTTP 原始请求/响应记录（排查问题用，含接口地址与完整 body）
  getHttpTrace(id?: string): Promise<HttpTraceRecord[]>
  clearHttpTrace(id?: string): Promise<void>
  getHttpTracePath(id?: string): string
  // 打开日志文件所在目录（在系统文件管理器中展示，返回目录路径）
  openTraceDir(): Promise<string>
  // 剪贴板读写（走 Electron clipboard 模块，file:// 下 navigator.clipboard 可能不可用，故经 preload 暴露）
  clipboardWriteText(text: string): void
  clipboardReadText(): string
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

/** 用户手动终端简要信息（会话级隔离） */
export interface UserTerminalInfo {
  terminalId: string
  name?: string
  cwd?: string
}

/** 通用设置（与 runtime 的 AppSettings 对应） */
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
  phase: 'request' | 'response'
  url: string
  method: string
  body?: unknown
  responseStatus?: number
  error?: string
}

/** 从 additionalArguments 读取窗口类型/应用 id（主进程注入，sandbox 下 process.argv 仍含这些值） */
function readArg(prefix: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : undefined
}
const windowType: 'desktop' | 'dock' | 'chat' | 'app' | 'supervisor' | 'supervisor-bubble' = (readArg('--shanhai-window-type=') as 'desktop' | 'dock' | 'chat' | 'app' | 'supervisor' | 'supervisor-bubble') ?? 'chat'
const windowAppId: string | undefined = readArg('--shanhai-app-id=')

const bridge: ShanhaiBridge = {
  windowType,
  platform: process.platform,
  windowAppId,
  openApp: (appId) => ipcRenderer.invoke('window:openApp', appId),
  closeApp: (appId) => ipcRenderer.invoke('window:closeApp', appId),
  getPluginApp: (appId) => ipcRenderer.invoke('plugin-app:get', appId),
  listPluginApps: () => ipcRenderer.invoke('plugin-app:list'),
  onPluginAppsChanged: (cb) => {
    const listener = (_e: unknown, apps: Array<{ appId: string; name: string; clientCode: string }>) => cb(apps)
    ipcRenderer.on('plugin-apps:changed', listener)
    return () => ipcRenderer.removeListener('plugin-apps:changed', listener)
  },
  restoreAboveDesktop: () => ipcRenderer.send('window:restoreAboveDesktop'),
  hideChatWindow: () => ipcRenderer.invoke('window:hideChat'),
  hideSelf: () => ipcRenderer.invoke('window:hideSelf'),
  hideSupervisorToBubble: () => ipcRenderer.invoke('supervisor:hideToBubble'),
  showSupervisorFromBubble: () => ipcRenderer.invoke('supervisor:showFromBubble'),
  moveSupervisorBubble: (dx, dy) => ipcRenderer.send('supervisor:moveBubble', dx, dy),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  resizeDock: (width, height) => ipcRenderer.send('window:resizeDock', width, height),
  exitToDesktop: () => ipcRenderer.invoke('window:hideToDesktop'),
  setTheme: (theme) => ipcRenderer.send('theme:set', theme),
  onThemeChange: (cb) => {
    const listener = (_e: unknown, theme: 'light' | 'dark') => cb(theme)
    ipcRenderer.on('ui:theme', listener)
    return () => ipcRenderer.removeListener('ui:theme', listener)
  },
  getUiState: () => ipcRenderer.invoke('ui:getState'),
  onUiState: (cb) => {
    const listener = (_e: unknown, state: GlobalUiState) => cb(state)
    ipcRenderer.on('ui:state', listener)
    return () => ipcRenderer.removeListener('ui:state', listener)
  },
  patchUiState: (patch) => ipcRenderer.invoke('ui:patch', patch),
  getWallpaper: () => ipcRenderer.invoke('wallpaper:get'),
  setWallpaper: (wallpaper) => ipcRenderer.invoke('wallpaper:set', wallpaper),
  listSystemWallpapers: () => ipcRenderer.invoke('wallpaper:listSystem'),
  applySystemWallpaper: (sourcePath) => ipcRenderer.invoke('wallpaper:applySystem', sourcePath),
  remoteEnable: (port) => ipcRenderer.invoke('remote:enable', port),
  remoteDisable: () => ipcRenderer.invoke('remote:disable'),
  remoteStatus: () => ipcRenderer.invoke('remote:status'),
  refreshRemoteCode: () => ipcRenderer.invoke('remote:refreshCode'),
  relayEnable: (url) => ipcRenderer.invoke('remote:relayEnable', url),
  relayDisable: () => ipcRenderer.invoke('remote:relayDisable'),
  relayStatus: () => ipcRenderer.invoke('remote:relayStatus'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  getUpdateStatus: () => ipcRenderer.invoke('app:get-update-status'),
  onUpdateAvailable: (cb) => {
    const listener = (_e: unknown, result: AppUpdateCheckResult) => cb(result)
    ipcRenderer.on('app:update-available', listener)
    return () => ipcRenderer.removeListener('app:update-available', listener)
  },
  getMobileApkInfo: (packageName) => ipcRenderer.invoke('mobile:get-apk-info', packageName),
  status: () => ipcRenderer.invoke('auth:status'),
  login: (u, p) => ipcRenderer.invoke('auth:login', u, p),
  register: (u, p, nickname, phone, email) => ipcRenderer.invoke('auth:register', u, p, nickname, phone, email),
  logout: () => ipcRenderer.invoke('auth:logout'),
  listModels: () => ipcRenderer.invoke('auth:listModels'),
  refreshModels: () => ipcRenderer.invoke('auth:refreshModels'),
  onModelsChanged: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('models:changed', listener)
    return () => ipcRenderer.removeListener('models:changed', listener)
  },
  addCustomModel: (model) => ipcRenderer.invoke('model:addCustom', model),
  updateCustomModel: (id, model) => ipcRenderer.invoke('model:updateCustom', id, model),
  removeCustomModel: (id) => ipcRenderer.invoke('model:removeCustom', id),
  listSessions: () => ipcRenderer.invoke('session:list'),
  createSession: (title, workdir) => ipcRenderer.invoke('session:create', title, workdir),
  switchSession: (id) => ipcRenderer.invoke('session:switch', id),
  renameSession: (id, title) => ipcRenderer.invoke('session:rename', id, title),
  deleteSession: (id) => ipcRenderer.invoke('session:delete', id),
  getSessionWorkdir: (id) => ipcRenderer.invoke('session:workdir', id),
  setSessionWorkdir: (id, workdir) => ipcRenderer.invoke('session:setWorkdir', id, workdir),
  saveUploadedFile: (fileName, dataBase64) => ipcRenderer.invoke('file:saveUpload', fileName, dataBase64),
  uploadImage: (imageBase64, mimeType) => ipcRenderer.invoke('image:upload', imageBase64, mimeType),
  listBrowserWindows: (sessionId) => ipcRenderer.invoke('browser:list', sessionId),
  showBrowserWindow: (appId) => ipcRenderer.invoke('browser:show', appId),
  closeBrowserWindow: (appId) => ipcRenderer.invoke('browser:close', appId),
  userTerminalCreate: (sessionId, name) => ipcRenderer.invoke('userTerminal:create', sessionId, name),
  userTerminalWrite: (sessionId, terminalId, data) => ipcRenderer.send('userTerminal:write', sessionId, terminalId, data),
  userTerminalResize: (sessionId, terminalId, cols, rows) => ipcRenderer.send('userTerminal:resize', sessionId, terminalId, cols, rows),
  userTerminalClose: (sessionId, terminalId) => ipcRenderer.invoke('userTerminal:close', sessionId, terminalId),
  userTerminalList: (sessionId) => ipcRenderer.invoke('userTerminal:list', sessionId),
  onUserTerminalOutput: (cb) => {
    const listener = (_e: unknown, sessionId: string, terminalId: string, data: string) => cb(sessionId, terminalId, data)
    ipcRenderer.on('user-terminal:output', listener)
    return () => ipcRenderer.removeListener('user-terminal:output', listener)
  },
  getDeepSeekBridgeStatus: () => ipcRenderer.invoke('deepseek-bridge:status'),
  openDeepSeekBridge: () => ipcRenderer.invoke('deepseek-bridge:open'),
  injectDeepSeekBridge: () => ipcRenderer.invoke('deepseek-bridge:inject'),
  selectDirectory: (defaultPath) => ipcRenderer.invoke('dialog:selectDirectory', defaultPath),
  getSessionHistory: (id) => ipcRenderer.invoke('session:history', id),
  getSessionTrace: (id) => ipcRenderer.invoke('session:trace', id),
  respondApproval: (outcome, requestId) => ipcRenderer.invoke('approval:respond', outcome, requestId),
  run: (message, attachments) => ipcRenderer.invoke('chat:run', message, attachments),
  supervisorRun: (message, attachments) => ipcRenderer.invoke('supervisor:run', message, attachments),
  getSupervisorHistory: () => ipcRenderer.invoke('supervisor:history'),
  supervisorGetModel: () => ipcRenderer.invoke('supervisor:getModel'),
  supervisorGetApproval: () => ipcRenderer.invoke('supervisor:getApproval'),
  supervisorSetModel: (id) => ipcRenderer.invoke('supervisor:setModel', id),
  supervisorSetApproval: (policy) => ipcRenderer.invoke('supervisor:setApproval', policy),
  resend: (sessionId, userMessageIndex, newContent) => ipcRenderer.invoke('chat:resend', sessionId, userMessageIndex, newContent),
  resume: (sessionId) => ipcRenderer.invoke('chat:resume', sessionId),
  retry: (sessionId) => ipcRenderer.invoke('chat:retry', sessionId),
  abandon: (sessionId) => ipcRenderer.invoke('chat:abandon', sessionId),
  injectMessage: (sessionId, message) => ipcRenderer.invoke('chat:inject', sessionId, message),
  hasIncompleteTurn: (sessionId) => ipcRenderer.invoke('session:incomplete', sessionId),
  hasRetrySnapshot: (sessionId) => ipcRenderer.invoke('session:retry-snapshot', sessionId),
  getApprovalPolicy: () => ipcRenderer.invoke('approval:getPolicy'),
  setApprovalPolicy: (policy) => ipcRenderer.invoke('approval:setPolicy', policy),
  switchModel: (id) => ipcRenderer.invoke('model:switch', id),
  getCurrentModelId: () => ipcRenderer.invoke('model:current'),
  stop: () => ipcRenderer.invoke('chat:stop'),
  speak: (text) => ipcRenderer.invoke('voice:speak', text),
  transcribeAudio: (audioBase64, format) => ipcRenderer.invoke('voice:transcribe', audioBase64, format),
  getTokenStats: (sessionId) => ipcRenderer.invoke('token:stats', sessionId),
  onTokenStats: (cb) => {
    const listener = (_e: unknown, sessionId: string, stats: TokenSnapshot) => cb(sessionId, stats)
    ipcRenderer.on('token:stats', listener)
    return () => ipcRenderer.removeListener('token:stats', listener)
  },
  onApprovalRequest: (cb) => {
    const listener = (_e: unknown, req: ApprovalRequest) => cb(req)
    ipcRenderer.on('approval:request', listener)
    return () => ipcRenderer.removeListener('approval:request', listener)
  },
  onAskRequest: (cb) => {
    const listener = (_e: unknown, req: AskRequest) => cb(req)
    ipcRenderer.on('ask:request', listener)
    return () => ipcRenderer.removeListener('ask:request', listener)
  },
  respondAsk: (requestId, answer) => ipcRenderer.invoke('ask:respond', requestId, answer),
  cancelAsk: (requestId) => ipcRenderer.invoke('ask:cancel', requestId),
  onToolTrace: (cb) => {
    const listener = (_e: unknown, trace: ToolTrace) => cb(trace)
    ipcRenderer.on('tool:trace', listener)
    return () => ipcRenderer.removeListener('tool:trace', listener)
  },
  onDelta: (cb) => {
    const listener = (_e: unknown, sessionId: string, text: string) => cb(sessionId, text)
    ipcRenderer.on('chat:delta', listener)
    return () => ipcRenderer.removeListener('chat:delta', listener)
  },
  onReasoning: (cb) => {
    const listener = (_e: unknown, sessionId: string, text: string) => cb(sessionId, text)
    ipcRenderer.on('chat:reasoning', listener)
    return () => ipcRenderer.removeListener('chat:reasoning', listener)
  },
  selfmodInspect: (sessionId) => ipcRenderer.invoke('selfmod:inspect', sessionId),
  respondClientRun: (requestId, approved) => ipcRenderer.invoke('selfmod:respond', requestId, approved),
  onClientRunRequest: (cb) => {
    const listener = (_e: unknown, req: { requestId: string; sessionId: string; pkgId: string; name: string; purpose: string }) => cb(req)
    ipcRenderer.on('selfmod:client-run-request', listener)
    return () => ipcRenderer.removeListener('selfmod:client-run-request', listener)
  },
  onClientRunResolved: (cb) => {
    const listener = (_e: unknown, requestId: string) => cb(requestId)
    ipcRenderer.on('selfmod:client-run-resolved', listener)
    return () => ipcRenderer.removeListener('selfmod:client-run-resolved', listener)
  },
  onClientCode: (cb) => {
    const listener = (_e: unknown, payload: { pkgId: string; name: string; code: string }) => cb(payload)
    ipcRenderer.on('selfmod:client-code', listener)
    return () => ipcRenderer.removeListener('selfmod:client-code', listener)
  },
  onClientRemove: (cb) => {
    const listener = (_e: unknown, pkgId: string) => cb(pkgId)
    ipcRenderer.on('selfmod:client-remove', listener)
    return () => ipcRenderer.removeListener('selfmod:client-remove', listener)
  },
  listMemory: (sessionId) => ipcRenderer.invoke('memory:list', sessionId),
  removeMemory: (id) => ipcRenderer.invoke('memory:remove', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getHttpTrace: (id) => ipcRenderer.invoke('trace:http-list', id),
  clearHttpTrace: (id) => ipcRenderer.invoke('trace:http-clear', id),
  getHttpTracePath: (id) => ipcRenderer.sendSync('trace:http-path', id),
  openTraceDir: () => ipcRenderer.invoke('trace:open-dir'),
  clipboardWriteText: (text) => clipboard.writeText(text),
  clipboardReadText: () => clipboard.readText(),
}

contextBridge.exposeInMainWorld('shanhai', bridge)
