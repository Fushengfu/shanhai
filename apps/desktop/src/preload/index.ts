import { contextBridge, ipcRenderer, clipboard } from 'electron'
// 本机技能 / MCP 只读清单的共用形状（主进程产出、preload 桥、渲染层消费三处同源）
import type { McpServerListResult, McpToolCountResult, SkillListResult } from '../shared/account-services'
// 技能市场（第三方市场搜索 / 详情审计 / 安装）的共用形状：主进程产出、本桥、渲染层消费三处同源
import type { SkillInstallProgress, SkillInstallResult, SkillMarketSearchResult, SkillPreview, SkillUninstallResult } from '../shared/skills-market'
// MCP 管理（编辑 / 启停）的共用形状：与主进程 main/mcp-config.ts 同源
import type { McpManageListResult, McpManageResult, McpServerPatch } from '../shared/mcp-manage'

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
/** 凭证三态快照（与 main/member-credentials.ts 的 CredentialSnapshot 对齐；不含 token 本体） */
export interface CredentialSnapshot {
  state: 'anonymous' | 'valid' | 'renewing' | 'expired' | 'unknown'
  username: string | null
  expiresAt: number | null
  ttlSeconds: number | null
  remainingMs: number | null
  expiresAtSource: 'config' | 'jwt' | 'none'
  renewalActive: boolean
  lastRotatedAt: number | null
  lastErrorCode: string | null
  lastError: string | null
  failureCount: number
  updatedAt: number
  /** 主进程算好的人类可读文案（界面直接展示，避免两端各写一套判定） */
  text?: string
}

export interface RelayStatus {
  enabled: boolean
  connected: boolean
  url: string
  username: string | null
  clientCount: number
  error: string | null
  authFailed: boolean
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
  /** 失败阶段（success=false 时有值）：check=检查/网络，download=下载，verify=校验，install=安装 */
  failureStage?: 'check' | 'download' | 'verify' | 'install'
}

/** 安装包下载进度阶段 */
export type UpdateDownloadPhase = 'pending' | 'downloading' | 'verifying' | 'completed' | 'failed' | 'cancelled'

/** 安装包下载进度（主进程 → 渲染层，广播到所有内容窗口） */
export interface AppUpdateDownloadProgress {
  phase: UpdateDownloadPhase
  fileName: string
  receivedBytes: number
  /** 服务端未返回 Content-Length 时为 0 */
  totalBytes: number
  /** 0-100；总量未知时为 -1（渲染层显示不确定态进度条） */
  percent: number
  bytesPerSecond: number
  savePath: string
  latestVersion?: string
  message?: string
  updatedAt: number
}

/** 手机端（Android）APK 下载信息 */
export interface MobileApkInfo {
  downloadUrl: string
  version?: string
}

/** 插件市场条目（渲染层） */
export interface MarketPluginPreload {
  id: string
  name: string
  purpose: string
  version?: string
  author?: string
  hasUI?: boolean
  categories?: string[]
  iconUrl?: string
  fileSha256?: string
  fileSize?: number
  installed?: boolean
}

/** 「我已安装」插件条目（渲染层，含自研标记与网关提交状态） */
export interface MyPluginPreload {
  id: string
  name: string
  purpose?: string
  /** 本地版本：自研工程 package.json version 优先，否则已安装 manifest version */
  version?: string
  /** 是否自研（plugins-workspace 下存在同 id 工程） */
  selfMade: boolean
  /** 是否已安装 */
  installed: boolean
  /** 网关是否有该 plugin_id 的提交记录 */
  submitted: boolean
  /** 网关最新版本 */
  gatewayVersion?: string
  /** 网关最新状态 */
  gatewayStatus?: string
  /** 网关是否有已审批版本 */
  hasApproved?: boolean
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

/** ui:state / ui:getState 信封：rev 为单调递增版本号（渲染进程据此丢弃过期快照），state 为按窗口过滤后的快照 */
export interface UiStateEnvelope {
  rev: number
  state: GlobalUiState
}

export interface ShanhaiBridge {
  /** 当前窗口类型（desktop/chat/app/supervisor），由主进程 additionalArguments 注入、preload 读 process.argv 得到 */
  windowType: 'desktop' | 'dock' | 'chat' | 'app' | 'supervisor' | 'supervisor-bubble' | 'app-menu'
  /** 运行平台（process.platform：darwin/win32/linux），渲染层据此做平台差异化（如 Windows 窗口圆角） */
  platform: string
  /** app 类型窗口的应用 id（terminal/trace/memory/settings/models），非 app 窗口为 undefined */
  windowAppId?: string
  /**
   * 【任务223】本 app 窗口要展示的「目标会话」（主进程 additionalArguments 注入；非 app 窗口/未指定为 undefined）。
   * 不指定时窗口内回落到 ui-store 的 currentSessionId（= 与本改动前完全一致）。
   */
  windowAppSessionId?: string
  /** 打开（或聚焦）一个插件应用窗口。sessionId 可选：指定则该 app 窗口展示该会话的数据（任务223） */
  openApp(appId: string, sessionId?: string): Promise<boolean>
  /** 关闭一个插件应用窗口 */
  closeApp(appId: string): Promise<void>
  /** 查询动态插件窗口应用（appId = 插件持久化 id），返回 { appId, name, icon? } 或 null */
  getPluginApp(appId: string): Promise<{ appId: string; name: string; icon?: string } | null>
  /** 列出所有已安装的动态插件窗口应用（appId = 插件持久化 id），供桌面壳 Dock 渲染应用图标 */
  listPluginApps(): Promise<Array<{ appId: string; name: string; icon?: string }>>
  /** 读取插件的图标 data URL（主进程读 manifest.icon 文件转 base64）；无 icon / 读取失败返回 null，渲染层降级占位图标 */
  getPluginIcon(appId: string): Promise<string | null>
  /** 订阅动态插件窗口应用清单变化（安装/卸载时主进程广播完整清单，Dock 据此增删图标） */
  onPluginAppsChanged(cb: (apps: Array<{ appId: string; name: string; icon?: string }>) => void): () => void
  /** 列出 Dock 上手动固定的插件应用（安装不自动上 Dock，需手动从桌面拖拽添加） */
  listDockPlugins(): Promise<Array<{ appId: string; name: string; icon?: string }>>
  /** 订阅 Dock 固定插件清单变化（拖拽添加/移除时主进程广播最新清单） */
  onDockPluginsChanged(cb: (apps: Array<{ appId: string; name: string; icon?: string }>) => void): () => void
  /** 开始一次「从桌面拖插件到 Dock」（mousedown 时触发，fire-and-forget） */
  beginPluginDrag(appId: string): void
  /** 取消拖拽（用户在非 Dock 区域释放，fire-and-forget） */
  cancelPluginDrag(): void
  /** 完成拖拽（用户在 Dock 上释放），返回最新 Dock 固定插件清单 */
  completePluginDrag(): Promise<Array<{ appId: string; name: string; icon?: string }>>
  /** 订阅「拖拽开始」（Dock 据此进入可接受状态） */
  onPluginDragStart(cb: (appId: string) => void): () => void
  /** 订阅「拖拽结束」（成功/取消都会触发，Dock 据此退出可接受状态） */
  onPluginDragEnd(cb: () => void): () => void
  /** 获取 Dock 窗口顶部距桌面壳底部的距离（应用菜单面板据此定位在 Dock 上方） */
  getDockTop(): Promise<number>
  /**
   * 【任务187】打开/关闭「应用菜单」专用置顶浮层窗口（方案 P）。
   * 开/关的唯一写者在主进程：它同时切窗口可见态并写回共享状态 appMenuOpen，
   * 渲染层（Dock 入口 / 面板遮罩）都只调这一个方法，不再各写一半状态。
   */
  setAppMenu(open: boolean): Promise<boolean>
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
  /** 订阅语言变更（主进程广播 ui:locale），返回取消订阅函数。i18n 期1，与 onThemeChange 同形态 */
  onLocaleChange(cb: (locale: string) => void): () => void
  /** 读取全局 UI 共享状态快照（当前会话/会话列表/模型/登录态/审批策略），返回 { rev, state } 信封 */
  getUiState(): Promise<UiStateEnvelope>
  /** 订阅全局 UI 共享状态变化（主进程 store 变化时推送 { rev, state } 信封） */
  onUiState(cb: (payload: UiStateEnvelope) => void): () => void
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
  /** 凭证三态快照（未登录 / 已登录有效 / 已登录但过期） */
  getCredentialStatus(): Promise<CredentialSnapshot>
  /** 订阅凭证状态变化（续签成功 / 失败 / 判失效时主进程广播 credential:status） */
  onCredentialStatus(cb: (snap: CredentialSnapshot) => void): () => void
  /** 订阅网关中继状态变化（连接成功/失败/401 失效时主进程推送），返回取消订阅函数 */
  onRelayStatus(cb: (status: RelayStatus) => void): () => void
  // —— 会员实时通讯底座（私信 / 好友）：内置侧专用，凭证只在主进程 ——
  /** 查询会员通道状态（连接中/离线/凭证失效/本账号 memberId） */
  memberStatus(): Promise<MemberChannelStatus>
  /** 手动重连会员通道（失败态的「重试」按钮） */
  memberRetry(): Promise<MemberChannelStatus>
  /** 主动向网关（HTTP）刷新好友列表 + 待处理申请 + 红点数 */
  memberRefreshFriends(): Promise<MemberResult>
  /** 拉取好友 + 待处理申请 + 红点数快照（本地缓存，权威来自 HTTP） */
  memberFriends(): Promise<{ friends: DmFriend[]; requests: DmFriendRequest[]; requestCount: number }>
  /** 拉取私信会话列表（本地缓存，按最近活跃倒序） */
  memberThreads(): Promise<DmThread[]>
  /** 主动从网关 HTTP 拉会话列表（含每会话未读），返回合并后的会话 */
  memberPullThreads(): Promise<DmThread[]>
  /** 未读汇总（总数 + 按通道） */
  memberUnread(): Promise<DmUnread>
  /** 会员检索：只支持用户名精确匹配（定稿：不做邀请码入口，防会员枚举） */
  memberSearch(username: string): Promise<MemberResult & { members: DmFriend[]; notFound?: boolean }>
  /** 发起好友申请（HTTP POST /friends/request，带申请附言） */
  memberRequestFriend(input: { targetMemberId: string; message?: string }): Promise<MemberResult>
  /** 同意好友申请（HTTP；双向确认后才有私信通道） */
  memberAcceptFriend(targetMemberId: string): Promise<MemberResult>
  /** 拒绝好友申请（HTTP） */
  memberRejectFriend(targetMemberId: string): Promise<MemberResult>
  /** 删除好友（HTTP；定稿：硬删双向解除，历史保留但需重新加好友才能再发） */
  memberDeleteFriend(memberId: string): Promise<MemberResult>
  /** 订阅某私信通道（打开会话时调用）：ws subscribe + HTTP 拉一页历史，返回合并后的会话 */
  memberSubscribe(channelId: string): Promise<DmThread | null>
  /** 让主进程算出与某好友的 1v1 channelId（本账号 memberId 只在主进程可见） */
  memberChannelId(peerMemberId: string): Promise<string | null>
  /** 取消订阅某私信通道（切走/关闭时调用） */
  memberUnsubscribe(channelId: string): Promise<void>
  /** 分页拉取历史（HTTP 权威，before=时间戳游标；失败退回本地缓存并带 error） */
  memberHistory(input: { channelId: string; page?: number; pageSize?: number }): Promise<{ messages: DmMessage[]; hasMore: boolean; total: number; page: number; error: string | null }>
  /**
   * 发送私信（好友前提 / DM_MAX_CONTENT_BYTES 字节上限 / 按会员限流 由主进程预检并如实返回原因）。
   * 【任务109】fromUserShare：消息卡片「分享到好友」的用户主动动作标记 —— 主进程据此改走
   * sendDmFromAgent（出站敏感过滤照过、但不受「管家接管」开关约束）。★不是新增方法，只是可选入参。
   */
  memberSend(input: { peerMemberId?: string; channelId?: string; text: string; peerName?: string; fromUserShare?: boolean }): Promise<MemberResult & { msgId?: string; channelId?: string; reason?: string; filterKind?: 'secret' | 'path' | 'addr' | 'error' }>
  /** 标记某通道已读（HTTP 上报，多设备按会员维度共享：任一设备读过即已读） */
  memberMarkRead(channelId: string): Promise<MemberResult>
  /**
   * 【红线】把某条私信引用到指定会话的输入框：只写输入框，不自动发送、不进任何 Agent 上下文，
   * 必须由本地用户在私信面板显式点击触发。
   */
  memberQuoteToSession(input: { sessionId: string; channelId: string; msgId: string }): Promise<MemberResult>
  /** 订阅会员通道状态变化（member:status 广播） */
  onMemberStatus(cb: (status: MemberChannelStatus) => void): () => void
  /** 订阅私信消息（member:message，仅投递给已订阅该通道的窗口） */
  onMemberMessage(cb: (msg: DmMessage) => void): () => void
  /** 订阅好友/申请列表变化（member:friends 广播，含红点数 requestCount） */
  onMemberFriends(cb: (snapshot: { friends: DmFriend[]; requests: DmFriendRequest[]; requestCount: number; ts: number }) => void): () => void
  /** 订阅「历史已合并」事件（member:history，HTTP 拉取后定向推给订阅了该通道的窗口） */
  onMemberHistory(cb: (payload: { channelId: string; messages: DmMessage[]; hasMore: boolean; total: number }) => void): () => void
  /** 订阅「打开指定会话」指令（点系统通知直达对应私信会话） */
  onMemberOpenThread(cb: (payload: { channelId: string; ts: number }) => void): () => void
  /** 订阅「切换面板分区」指令（点好友申请通知直达好友分区） */
  onMemberOpenTab(cb: (payload: { tab: 'dm' | 'friends'; ts: number }) => void): () => void
  /** 订阅「好友消息进管家」自动接管事件（member:dm:auto-route，仅管家窗口订阅处理） */
  onDmAutoRoute(cb: (payload: { from: string; fromName: string; content: string; channelId: string; ts: number }) => void): () => void
  /** 订阅未读汇总变化（member:unread 广播） */
  onMemberUnread(cb: (unread: DmUnread) => void): () => void
  /** 订阅会员通道错误提示（member:error，按真实原因分类，不统一成「连不上服务器」） */
  onMemberError(cb: (err: MemberErrorPayload) => void): () => void
  /** 订阅会员通道业务通知（member:notice：申请受理/被删好友/通道接入等） */
  onMemberNotice(cb: (notice: MemberNotice) => void): () => void
  /** 订阅「把私信引用到本会话输入框」事件（聊天窗口 / 管家窗口按会话类型二选收到），返回取消订阅函数 */
  onDmQuoteToSession(cb: (payload: DmQuotePayload) => void): () => void
  /** 获取当前应用版本号（package.json version） */
  getVersion(): Promise<string>
  /** 手动检查更新（弹窗引导下载/安装），返回检查结果 */
  checkUpdate(): Promise<AppUpdateCheckResult>
  /** 获取最近一次版本检查结果（自动检查或手动检查） */
  getUpdateStatus(): Promise<AppUpdateCheckResult | null>
  /** 订阅主进程自动检查发现新版本时的推送（现广播到所有窗口），返回取消订阅函数 */
  onUpdateAvailable(cb: (result: AppUpdateCheckResult) => void): () => void
  /** 订阅安装包下载进度（主进程广播 app:update-download-progress），返回取消订阅函数 */
  onUpdateDownloadProgress(cb: (progress: AppUpdateDownloadProgress) => void): () => void
  /** 拉取最近一次下载进度快照（中途新开的窗口据此立刻显示正在进行的下载） */
  getUpdateDownloadProgress(): Promise<AppUpdateDownloadProgress | null>
  /** 取消正在进行的安装包下载，返回是否成功发起取消 */
  cancelUpdateDownload(): Promise<boolean>
  /** 获取手机端（Android）APK 下载信息（下载地址 + 版本号），失败返回 null */
  getMobileApkInfo(packageName: string): Promise<MobileApkInfo | null>
  /** 插件市场：拉取公开插件列表（接口未就绪时返回 ok=false + error） */
  listMarketPlugins(params?: { keyword?: string; category?: string; hasUI?: boolean | ''; page?: number; pageSize?: number }): Promise<{ ok: boolean; plugins: MarketPluginPreload[]; total: number; error?: string }>
  /** 插件市场：下载并安装指定插件（下载 zip → X-SHA256 校验 → 解包还原 → 激活 + Dock 刷新） */
  installMarketPlugin(pluginId: string): Promise<{ ok: boolean; id?: string; name?: string; message?: string }>
  /** 插件市场：打包本地自研插件并提交到市场（网关 APIKey 鉴权） */
  submitPluginToMarket(pluginDirOrId: string, categories?: string[]): Promise<{ ok: boolean; message: string; zipPath?: string; data?: unknown }>
  /** 插件市场：列出「我已安装」插件（含自研标记 + 网关提交状态） */
  listMyPlugins(): Promise<{ ok: boolean; plugins: MyPluginPreload[]; mineError?: string }>
  /** 插件市场：卸载已安装插件（撤销运行 + 删除 ~/.shanhai/plugins/<id>/ 目录，不可恢复） */
  uninstallMarketPlugin(pluginId: string): Promise<{ ok: boolean; message: string }>
  // 认证
  status(): Promise<{ loggedIn: boolean; username: string | null; avatar: string | null }>
  login(username: string, password: string): Promise<{ username: string; nickname?: string; avatar?: string }>
  register(username: string, password: string, nickname?: string, phone?: string, email?: string): Promise<{ username: string; nickname?: string; avatar?: string }>
  logout(): Promise<void>
  listModels(): Promise<Array<{ id: string; name: string; tier: string; apiKey: string; baseUrl: string; model?: string; protocol?: 'openai' | 'anthropic'; custom?: boolean; modelType?: string }>>
  refreshModels(): Promise<Array<{ id: string; name: string; tier: string; apiKey: string; baseUrl: string; model?: string; protocol?: 'openai' | 'anthropic'; custom?: boolean; modelType?: string }>>
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
  /**
   * 通用文件上传到云存储（私信附件用）：复用主进程既有的 runtime.uploadFile →
   * packages/storage 的 doCloudUpload（会员 JWT 换凭证 → 七牛直传，含跨区域自愈与 hash 去重）。
   * 此前只暴露了 uploadImage（只收图片），文档类附件没有出口 —— 这是本期唯一批准新增的主进程能力。
   * 返回公网直链；未登录 / 网关异常 / 超时一律返回 null（**调用方必须把 null 翻成可见提示，不许静默**）。
   */
  uploadFile(dataBase64: string, mimeType?: string, fileName?: string): Promise<string | null>
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
  // 能力级审批（插件调 write/destructive 能力）：允许/拒绝
  respondCapabilityApproval(requestId: string, approved: boolean, rememberForSession?: boolean): Promise<void>
  // AI 向用户提问（单选/多选/填空/选择器）
  onAskRequest(cb: (req: AskRequest) => void): () => void
  respondAsk(requestId: string, answer: string): Promise<void>
  cancelAsk(requestId: string): Promise<void>
  // 工具过程
  onToolTrace(cb: (trace: ToolTrace) => void): () => void
  // 聊天
  run(message: string, attachments?: ContentPart[]): Promise<string>
  // 会话管家（主 Agent，独立 supervisor 窗口）
  supervisorRun(message: string, attachments?: ContentPart[], dmContext?: { channelId?: string; peerMemberId?: string; fromName?: string }): Promise<string>
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
  // 审批策略（安全模式）—— 会话级：传 sid 读该会话 meta.approvalPolicy，缺省读当前会话
  getApprovalPolicy(sid?: string): Promise<'ask' | 'workdir' | 'never'>
  setApprovalPolicy(policy: 'ask' | 'workdir' | 'never'): Promise<void>
  // 模型 / 中断 / 语音 / 电脑
  switchModel(id: string): Promise<void>
  getCurrentModelId(): Promise<string>
  /** 停止执行；不传 sessionId = 停「当前激活会话」（聊天窗口），传了 = 按 id 精确停（管家窗口传 'supervisor'）。
   * ★任务194 ⑦-②：回传成/败与原因（旧声明 Promise<void> ⇒ 渲染层拿不到成败）。
   * 只改返回类型标注，参数形态与通道名一字未动（不新增 IPC 通道）。 */
  stop(sessionId?: string): Promise<{ ok: boolean; sessionId?: string; explicit?: boolean; reason?: string }>
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
  onClientCode(cb: (payload: { pkgId: string; name: string; permissions?: string[]; entryHtml?: string; icon?: string }) => void): () => void
  onClientRemove(cb: (pkgId: string) => void): () => void
  listMemory(sessionId: string): Promise<MemoryEntry[]>
  removeMemory(id: number): Promise<void>
  /** 【任务257】编辑单条记忆的正文（只改 value；id/scope/key/session/created 不可变）。失败回 { ok:false, error }，不静默 */
  updateMemory(id: number, value: unknown): Promise<{ ok: boolean; error?: string }>
  /** 【任务257】记忆落盘状态（写失败可见）：ok=false / failures>0 时面板显示横幅 */
  memoryStatus(): Promise<MemoryStatus>
  // 本机技能 / MCP（账号悬停弹窗的只读展示；MCP 配置里的 env 等敏感字段不下发）
  listSkills(): Promise<SkillListResult>
  listMcpServers(): Promise<McpServerListResult>
  listMcpToolCounts(): Promise<McpToolCountResult>
  // 技能市场（第三方市场，公网访问 + 落盘安装）
  /** 搜索技能市场（两源合并去重，按下载量倒序）。单源失败不整体失败，两源都失败才回 error */
  searchSkillMarket(query: string, source?: 'all' | 'clawhub' | 'skillhub', category?: string): Promise<SkillMarketSearchResult>
  /** 拉取某技能的 SKILL.md + 安全审计预览（返回 { error } 表示失败，不回抛异常） */
  previewSkillMarket(source: 'clawhub' | 'skillhub', slug: string): Promise<SkillPreview | { error: string }>
  /** 安装技能到 ~/.shanhai/skills/<id>/（高危等级须带 confirmRisk=true，否则回 needConfirm 且不下载任何内容） */
  installSkillFromMarket(payload: { source: 'clawhub' | 'skillhub'; slug: string; confirmRisk?: boolean }): Promise<SkillInstallResult>
  /** 订阅安装进度（仅发起安装的那个窗口能收到），返回取消订阅函数 */
  onSkillInstallProgress(cb: (p: SkillInstallProgress) => void): () => void
  /**
   * 卸载一个**用户技能**（删除 ~/.shanhai/skills/<id>/ 整个目录）。
   * 破坏性操作：主进程侧做 id 合法性 / 只能删 user 技能 / 路径夹取四道校验，
   * 任何一步不过只回 { ok:false, error }，**不删任何东西**；内置技能一律拒绝。
   */
  uninstallSkill(id: string): Promise<SkillUninstallResult>
  // MCP 管理（编辑 / 启停；会写 ~/.shanhai/mcp.json）
  /** 列出 MCP 服务（启用 + 停用），env 只给键名 + 掩码，**原始值不下发** */
  listMcpManaged(): Promise<McpManageListResult>
  /** 保存某个 MCP 服务的 command / args / env（env 里 value=null 表示保持原值） */
  saveMcpServer(patch: McpServerPatch): Promise<McpManageResult>
  /** 启用 / 停用某个 MCP 服务（停用 = 移到 disabledServers 段，AI 侧不可见） */
  setMcpServerEnabled(id: string, enabled: boolean): Promise<McpManageResult>
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
  sessionId?: string
  /** 【任务257】首次创建时间（ms） */
  created?: number
  /** 【任务257】最近一次写入时间（ms）；与 created 不同才在界面区分显示 */
  updated?: number
}

/** 【任务257】记忆落盘状态（写失败可见）：ok=false ⇒ 存储处于失败态；failures 为累计失败次数（只增不减） */
export interface MemoryStatus {
  ok: boolean
  error?: string
  failures: number
  /** 未被认定为山海记忆的 .md（只登记、永不删除） */
  unknownFiles: Array<{ file: string; reason: string }>
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
  /**
   * 界面语言（i18n 期1）。空串 = 从未设置；主进程启动时按系统语言解析成具体值写回。
   * 【口径】这里只声明到 preload 实际透出的字段（与 runtime 的 AppSettings 是子集关系），
   * 新增字段必须三处同步：runtime/types.ts、preload/index.ts、renderer/types.ts。
   */
  locale: string
  /** 私信管家接管对外口吻：assistant=AI 助手（默认）/ user=代用户（占位，第一版不实现）。 */
  dmReplyMode: 'assistant' | 'user'
}

/** 设置补丁：允许只传某个分组的某个字段（嵌套 Partial） */
export type AppSettingsPatch = {
  browser?: Partial<AppSettings['browser']>
  messageSubmit?: Partial<AppSettings['messageSubmit']>
  debug?: Partial<AppSettings['debug']>
  voice?: Partial<AppSettings['voice']>
  locale?: string
  dmReplyMode?: string
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

// —————————————————— 会员实时通讯底座（私信 / 好友）类型 ——————————————————
// 与主进程 apps/desktop/src/main/member-channel.ts 对齐（三处同构声明：main / preload / renderer types）。

/** 会员通道状态 */
export interface MemberChannelStatus {
  enabled: boolean
  connected: boolean
  /** 能否收发：connected 且已知本账号 memberId */
  ready: boolean
  url: string
  username: string | null
  memberId: string | null
  error: string | null
  authFailed: boolean
  subscribedChannels: string[]
  updatedAt: number
}

/** 好友条目 */
export interface DmFriend {
  memberId: string
  username: string
  nickname?: string
  online?: boolean
}

/** 待处理的好友申请 */
export interface DmFriendRequest {
  requestId: string
  fromMemberId: string
  fromUsername: string
  fromNickname?: string
  /** 对方申请时写的附言（定稿载荷 requestMsg） */
  message?: string
  ts: number
}

/** 一条私信 */
export interface DmMessage {
  msgId: string
  channelId: string
  from: string
  fromName: string
  to?: string
  text: string
  ts: number
  mine: boolean
  /** 逐条已读回执网关未实现，保持 false（UI 不谎报「已读」） */
  read?: boolean
  /**
   * 网关 messageId（契约 v1 去重键）。网关按 memberID 投递给该会员所有活跃连接，
   * 自己发的消息自己的其它设备也会收到：本地乐观气泡 serverId 留空，回声到达后回填。
   */
  serverId?: string
  /** 本地乐观气泡：已提交网关、尚未认领到 messageId */
  pending?: boolean
  failed?: string | null
  /** 消息来源：本轮恒为 'dm'（将来插件接入同一条通道时只是多一个枚举值） */
  origin?: 'dm' | string
}

/** 私信会话线程 */
export interface DmThread {
  channelId: string
  peerId: string
  peerName: string
  messages: DmMessage[]
  unread: number
  lastTs: number
}

/** 未读汇总 */
export interface DmUnread {
  total: number
  byChannel: Record<string, number>
}

/** 统一返回体 */
export interface MemberResult {
  ok: boolean
  message: string
}

/** 会员通道错误载荷（按真实原因分类） */
export interface MemberErrorPayload {
  code: string
  message: string
  channelId: string | null
}

/** 会员通道业务通知（申请受理 / 被删好友 / 通道接入等） */
export interface MemberNotice {
  kind: 'friend_request_result' | 'friend_removed' | 'subscribed'
  ok?: boolean
  peer: string
  message: string
  ts: number
}

/** 「把某条私信引用到会话输入框」事件载荷（仅聊天窗口收到） */
export interface DmQuotePayload {
  sessionId: string
  channelId: string
  msgId: string
  /** 来源展示名（渲染层引用卡片用，不拼进正文） */
  fromName: string
  /** 来源会员 id */
  fromMemberId: string
  /** 私信原文（不含任何拼接前缀；追加进输入框的就是它） */
  text: string
  /** 私信自身时间 */
  ts: number
  /** 本次投递时间 */
  at: number
}

/** 从 additionalArguments 读取窗口类型/应用 id（主进程注入，sandbox 下 process.argv 仍含这些值） */
function readArg(prefix: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : undefined
}
const windowType: 'desktop' | 'dock' | 'chat' | 'app' | 'supervisor' | 'supervisor-bubble' | 'app-menu' = (readArg('--shanhai-window-type=') as 'desktop' | 'dock' | 'chat' | 'app' | 'supervisor' | 'supervisor-bubble' | 'app-menu') ?? 'chat'
const windowAppId: string | undefined = readArg('--shanhai-app-id=')
/** 【任务223】app 窗口的目标会话（主进程注入；未指定为 undefined → 窗口内回落 currentSessionId） */
const windowAppSessionId: string | undefined = readArg('--shanhai-app-session-id=')

const bridge: ShanhaiBridge = {
  windowType,
  platform: process.platform,
  windowAppId,
  windowAppSessionId,
  openApp: (appId, sessionId) => ipcRenderer.invoke('window:openApp', appId, sessionId),
  closeApp: (appId) => ipcRenderer.invoke('window:closeApp', appId),
  getPluginApp: (appId) => ipcRenderer.invoke('plugin-app:get', appId),
  listPluginApps: () => ipcRenderer.invoke('plugin-app:list'),
  getPluginIcon: (appId) => ipcRenderer.invoke('plugin-app:icon', appId),
  onPluginAppsChanged: (cb) => {
    const listener = (_e: unknown, apps: Array<{ appId: string; name: string; icon?: string }>) => cb(apps)
    ipcRenderer.on('plugin-apps:changed', listener)
    return () => ipcRenderer.removeListener('plugin-apps:changed', listener)
  },
  listDockPlugins: () => ipcRenderer.invoke('dock-plugin:list'),
  onDockPluginsChanged: (cb) => {
    const listener = (_e: unknown, apps: Array<{ appId: string; name: string; icon?: string }>) => cb(apps)
    ipcRenderer.on('dock-plugins:changed', listener)
    return () => ipcRenderer.removeListener('dock-plugins:changed', listener)
  },
  beginPluginDrag: (appId) => ipcRenderer.send('dock-plugin:drag-start', appId),
  cancelPluginDrag: () => ipcRenderer.send('dock-plugin:drag-cancel'),
  completePluginDrag: () => ipcRenderer.invoke('dock-plugin:drag-complete'),
  onPluginDragStart: (cb) => {
    const listener = (_e: unknown, appId: string) => cb(appId)
    ipcRenderer.on('dock-plugin-drag:start', listener)
    return () => ipcRenderer.removeListener('dock-plugin-drag:start', listener)
  },
  onPluginDragEnd: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('dock-plugin-drag:end', listener)
    return () => ipcRenderer.removeListener('dock-plugin-drag:end', listener)
  },
  getDockTop: () => ipcRenderer.invoke('window:getDockTop'),
  setAppMenu: (open) => ipcRenderer.invoke('window:setAppMenu', open),
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
  onLocaleChange: (cb) => {
    const listener = (_e: unknown, locale: string) => cb(locale)
    ipcRenderer.on('ui:locale', listener)
    return () => ipcRenderer.removeListener('ui:locale', listener)
  },
  getUiState: () => ipcRenderer.invoke('ui:getState'),
  onUiState: (cb) => {
    const listener = (_e: unknown, payload: UiStateEnvelope) => cb(payload)
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
  getCredentialStatus: () => ipcRenderer.invoke('auth:credentialStatus'),
  onCredentialStatus: (cb) => {
    const listener = (_e: unknown, snap: CredentialSnapshot) => cb(snap)
    ipcRenderer.on('credential:status', listener)
    return () => ipcRenderer.removeListener('credential:status', listener)
  },
  onRelayStatus: (cb) => {
    const listener = (_e: unknown, status: RelayStatus) => cb(status)
    ipcRenderer.on('relay:status', listener)
    return () => ipcRenderer.removeListener('relay:status', listener)
  },
  // —— 会员实时通讯底座（私信 / 好友）：内置侧专用（插件物理拿不到本桥，见 window-manager 的 plugin.cjs 分支）——
  memberStatus: () => ipcRenderer.invoke('member:status'),
  memberRetry: () => ipcRenderer.invoke('member:retry'),
  memberRefreshFriends: () => ipcRenderer.invoke('member:freshFriends'),
  memberFriends: () => ipcRenderer.invoke('member:friends'),
  memberThreads: () => ipcRenderer.invoke('member:threads'),
  memberPullThreads: () => ipcRenderer.invoke('member:pullThreads'),
  memberUnread: () => ipcRenderer.invoke('member:unread'),
  memberSearch: (username) => ipcRenderer.invoke('member:search', username),
  memberRequestFriend: (input) => ipcRenderer.invoke('member:requestFriend', input),
  memberAcceptFriend: (targetMemberId) => ipcRenderer.invoke('member:acceptFriend', targetMemberId),
  memberRejectFriend: (targetMemberId) => ipcRenderer.invoke('member:rejectFriend', targetMemberId),
  memberDeleteFriend: (memberId) => ipcRenderer.invoke('member:deleteFriend', memberId),
  memberSubscribe: (channelId) => ipcRenderer.invoke('member:subscribe', channelId),
  memberChannelId: (peerMemberId) => ipcRenderer.invoke('member:channelId', peerMemberId),
  memberUnsubscribe: (channelId) => ipcRenderer.invoke('member:unsubscribe', channelId),
  memberHistory: (input) => ipcRenderer.invoke('member:history', input),
  memberSend: (input) => ipcRenderer.invoke('member:send', input),
  memberMarkRead: (channelId) => ipcRenderer.invoke('member:markRead', channelId),
  memberQuoteToSession: (input) => ipcRenderer.invoke('member:quoteToSession', input),
  onMemberStatus: (cb) => {
    const listener = (_e: unknown, status: MemberChannelStatus) => cb(status)
    ipcRenderer.on('member:status', listener)
    return () => ipcRenderer.removeListener('member:status', listener)
  },
  onMemberMessage: (cb) => {
    const listener = (_e: unknown, msg: DmMessage) => cb(msg)
    ipcRenderer.on('member:message', listener)
    return () => ipcRenderer.removeListener('member:message', listener)
  },
  onMemberFriends: (cb) => {
    const listener = (_e: unknown, snapshot: { friends: DmFriend[]; requests: DmFriendRequest[]; requestCount: number; ts: number }) => cb(snapshot)
    ipcRenderer.on('member:friends', listener)
    return () => ipcRenderer.removeListener('member:friends', listener)
  },
  onMemberHistory: (cb) => {
    const listener = (_e: unknown, payload: { channelId: string; messages: DmMessage[]; hasMore: boolean; total: number }) => cb(payload)
    ipcRenderer.on('member:history', listener)
    return () => ipcRenderer.removeListener('member:history', listener)
  },
  onMemberOpenThread: (cb) => {
    const listener = (_e: unknown, payload: { channelId: string; ts: number }) => cb(payload)
    ipcRenderer.on('member:open-thread', listener)
    return () => ipcRenderer.removeListener('member:open-thread', listener)
  },
  onMemberOpenTab: (cb) => {
    const listener = (_e: unknown, payload: { tab: 'dm' | 'friends'; ts: number }) => cb(payload)
    ipcRenderer.on('member:open-tab', listener)
    return () => ipcRenderer.removeListener('member:open-tab', listener)
  },
  onMemberUnread: (cb) => {
    const listener = (_e: unknown, unread: DmUnread) => cb(unread)
    ipcRenderer.on('member:unread', listener)
    return () => ipcRenderer.removeListener('member:unread', listener)
  },
  onDmAutoRoute: (cb) => {
    const listener = (_e: unknown, payload: { from: string; fromName: string; content: string; channelId: string; ts: number }) => cb(payload)
    ipcRenderer.on('member:dm:auto-route', listener)
    return () => ipcRenderer.removeListener('member:dm:auto-route', listener)
  },
  onMemberError: (cb) => {
    const listener = (_e: unknown, err: MemberErrorPayload) => cb(err)
    ipcRenderer.on('member:error', listener)
    return () => ipcRenderer.removeListener('member:error', listener)
  },
  onMemberNotice: (cb) => {
    const listener = (_e: unknown, notice: MemberNotice) => cb(notice)
    ipcRenderer.on('member:notice', listener)
    return () => ipcRenderer.removeListener('member:notice', listener)
  },
  onDmQuoteToSession: (cb) => {
    const listener = (_e: unknown, payload: DmQuotePayload) => cb(payload)
    ipcRenderer.on('dm:quote-to-session', listener)
    return () => ipcRenderer.removeListener('dm:quote-to-session', listener)
  },
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  getUpdateStatus: () => ipcRenderer.invoke('app:get-update-status'),
  onUpdateAvailable: (cb) => {
    const listener = (_e: unknown, result: AppUpdateCheckResult) => cb(result)
    ipcRenderer.on('app:update-available', listener)
    return () => ipcRenderer.removeListener('app:update-available', listener)
  },
  onUpdateDownloadProgress: (cb) => {
    const listener = (_e: unknown, progress: AppUpdateDownloadProgress) => cb(progress)
    ipcRenderer.on('app:update-download-progress', listener)
    return () => ipcRenderer.removeListener('app:update-download-progress', listener)
  },
  getUpdateDownloadProgress: () => ipcRenderer.invoke('app:get-update-download-progress'),
  cancelUpdateDownload: () => ipcRenderer.invoke('app:cancel-update-download'),
  getMobileApkInfo: (packageName) => ipcRenderer.invoke('mobile:get-apk-info', packageName),
  listMarketPlugins: (params) => ipcRenderer.invoke('market:list', params),
  installMarketPlugin: (pluginId) => ipcRenderer.invoke('market:install', pluginId),
  submitPluginToMarket: (pluginDirOrId, categories) => ipcRenderer.invoke('market:submit', pluginDirOrId, categories),
  listMyPlugins: () => ipcRenderer.invoke('market:mine'),
  uninstallMarketPlugin: (pluginId) => ipcRenderer.invoke('market:uninstall', pluginId),
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
  uploadFile: (dataBase64, mimeType, fileName) => ipcRenderer.invoke('file:upload', dataBase64, mimeType, fileName),
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
  respondCapabilityApproval: (requestId, approved, rememberForSession) => ipcRenderer.invoke('capability-approval:respond', requestId, approved, rememberForSession),
  run: (message, attachments) => ipcRenderer.invoke('chat:run', message, attachments),
  supervisorRun: (message, attachments, dmContext) => ipcRenderer.invoke('supervisor:run', message, attachments, dmContext),
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
  getApprovalPolicy: (sid) => ipcRenderer.invoke('approval:getPolicy', sid),
  setApprovalPolicy: (policy) => ipcRenderer.invoke('approval:setPolicy', policy),
  switchModel: (id) => ipcRenderer.invoke('model:switch', id),
  getCurrentModelId: () => ipcRenderer.invoke('model:current'),
  stop: (sessionId?: string) => ipcRenderer.invoke('chat:stop', sessionId),
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
    const listener = (_e: unknown, payload: { pkgId: string; name: string; permissions?: string[]; entryHtml?: string; icon?: string }) => cb(payload)
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
  updateMemory: (id, value) => ipcRenderer.invoke('memory:update', id, value),
  memoryStatus: () => ipcRenderer.invoke('memory:status'),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  listMcpServers: () => ipcRenderer.invoke('mcp:servers'),
  listMcpToolCounts: () => ipcRenderer.invoke('mcp:tool-counts'),
  searchSkillMarket: (query, source, category) => ipcRenderer.invoke('skills:market-search', query, source, category),
  previewSkillMarket: (source, slug) => ipcRenderer.invoke('skills:market-preview', source, slug),
  installSkillFromMarket: (payload) => ipcRenderer.invoke('skills:market-install', payload),
  onSkillInstallProgress: (cb) => {
    const listener = (_e: unknown, p: SkillInstallProgress) => cb(p)
    ipcRenderer.on('skills:market-progress', listener)
    return () => ipcRenderer.removeListener('skills:market-progress', listener)
  },
  uninstallSkill: (id) => ipcRenderer.invoke('skills:uninstall', id),
  listMcpManaged: () => ipcRenderer.invoke('mcp:manage-list'),
  saveMcpServer: (patch) => ipcRenderer.invoke('mcp:manage-save', patch),
  setMcpServerEnabled: (id, enabled) => ipcRenderer.invoke('mcp:manage-set-enabled', id, enabled),
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
