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
  /** 本次审批归属的私信好友会话 id（channelId），用于私信面板切到对应好友 */
  dmChannelId?: string
  /** 本次审批归属的好友 memberId（与 dmChannelId 二选一） */
  dmPeerId?: string
  /** 好友显示名（绝不回显会员 id） */
  dmFromName?: string
}

/** 能力级审批请求（插件跨插件调用 write/destructive 能力；sessionId 标记发起会话，用于会话级 remember 授权） */
export interface CapabilityApprovalRequest {
  requestId: string
  callerPkgId: string
  capability: string
  risk: string
  sessionId?: string
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
/** 凭证三态快照（主进程 member-credentials 广播 credential:status；不含 token 本体） */
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

// —————————————————— 会员实时通讯底座（私信 / 好友）类型（与主进程 member-channel.ts 对齐）——————————————————

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
  /**
   * 【真头像】网关下发的头像 URL。实测该字段常为**空字符串**，主进程 pickStr 会把空串归成 null，
   * 因此这里空串一律表现为 undefined = 「无头像」，界面回落首字占位（不猜图、不显示破图）。
   * ⚠️ 只做显示：不参与任何请求参数、不进消息体、不进日志。
   */
  avatar?: string
}

/** 待处理的好友申请 */
export interface DmFriendRequest {
  requestId: string
  fromMemberId: string
  fromUsername: string
  fromNickname?: string
  /** 【真头像】申请方头像 URL（网关空串 → undefined），仅用于申请列表显示 */
  fromAvatar?: string
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
  /**
   * 【真头像】对端头像 URL（会话列表 peer 对象下发，拿不到时主进程用本地好友表兜底）。
   * 命名与本接口 peerId / peerName 前缀口径一致 —— 线程上只有一个「对方」，用 peer 前缀避免「这是谁的头像」歧义。
   */
  peerAvatar?: string
  messages: DmMessage[]
  unread: number
  lastTs: number
}

/** 未读汇总 */
export interface DmUnread {
  total: number
  byChannel: Record<string, number>
}

/** 【P6】会话级草稿缓存：channelId → 未发送正文（localStorage 持久化，跨窗口/跨重启） */
export interface DmDraftStore {
  [channelId: string]: string
}

/** 会员通道统一返回体 */
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

/** 会员通道业务通知 */
export interface MemberNotice {
  kind: 'friend_request_result' | 'friend_removed' | 'subscribed' | 'gateway_retry'
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
  /** AI 调用本次提问时的思考过程（为什么问你），供 UI 折叠展示背景 */
  reasoning?: string
  /** 交互类型：text=普通提问/填空（默认）、session-picker=会话选择器、model-picker=模型选择器 */
  kind?: 'text' | 'session-picker' | 'model-picker'
  /** 会话选择器数据（kind=session-picker 时提供） */
  sessionOptions?: AskSessionOption[]
  /** 模型选择器数据（kind=model-picker 时提供） */
  modelOptions?: AskModelOption[]
  /** 本次提问归属的私信好友会话 id（channelId），用于私信面板切到对应好友 */
  dmChannelId?: string
  /** 本次提问归属的好友 memberId（与 dmChannelId 二选一） */
  dmPeerId?: string
  /** 好友显示名（绝不回显会员 id） */
  dmFromName?: string
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
  /** 上下文窗口长度（token 数） */
  contextLength?: number
  /** 是否支持视觉（多模态）输入 */
  supportsVision?: boolean
  /** 模型类型：chat=对话（缺省）/ video=视频生成 / image=图片生成 / tts=语音合成（网关下发后透传，用于界面/插件按类型分组） */
  modelType?: string
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
  supervisorApproval: {
    /** 是否允许管家接管审批：true 时管家下发的任务触发的审批由管家决策（决策后弹窗关闭） */
    enabled: boolean
  }
  supervisorAsk: {
    /** 是否允许管家接管提问：true 时管家下发的任务里会话发起的 ask_user 提问由管家代答（代答后弹窗关闭） */
    enabled: boolean
  }
  compaction: {
    /** 统一压缩模型 id：上下文超限触发 LLM 摘要时用的模型。空串 = 未配置，回退当前会话模型。 */
    modelId: string
  }
  /**
   * 界面语言（i18n 期1）。空串 = 从未设置（主进程启动时按系统语言解析成具体值后写回）。
   * 与 runtime / preload 的同名字段一一对应，三处都要有，否则 tsc 报缺字段。
   */
  locale: string
  /** 私信「管家接管」开关：true 时管家可代表用户对好友发消息（含自动回复）。默认 false。 */
  dmAutoReply: boolean
  /** 私信管家接管对外口吻：assistant=AI 助手（默认）/ user=代用户（占位，第一版不实现）。 */
  dmReplyMode: 'assistant' | 'user'
}

/** 设置补丁：允许只传某个分组的某个字段（嵌套 Partial） */
export type AppSettingsPatch = {
  browser?: Partial<AppSettings['browser']>
  messageSubmit?: Partial<AppSettings['messageSubmit']>
  debug?: Partial<AppSettings['debug']>
  voice?: Partial<AppSettings['voice']>
  supervisorApproval?: Partial<AppSettings['supervisorApproval']>
  supervisorAsk?: Partial<AppSettings['supervisorAsk']>
  compaction?: Partial<AppSettings['compaction']>
  locale?: string
  dmAutoReply?: boolean
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
      windowType: 'desktop' | 'dock' | 'chat' | 'app' | 'supervisor' | 'supervisor-bubble' | 'app-menu'
      /** 运行平台（process.platform：darwin/win32/linux） */
      platform: string
      /** app 类型窗口的应用 id，非 app 窗口为 undefined */
      windowAppId?: string
      /** 打开（或聚焦）一个插件应用窗口 */
      openApp(appId: string): Promise<boolean>
      /** 关闭一个插件应用窗口 */
      closeApp(appId: string): Promise<void>
      /** 查询动态插件窗口应用（appId = 插件持久化 id），返回 { appId, name, icon? } 或 null */
      getPluginApp(appId: string): Promise<{ appId: string; name: string; icon?: string } | null>
      /** 列出所有已安装的动态插件窗口应用（供桌面壳 Dock 渲染应用图标） */
      listPluginApps(): Promise<Array<{ appId: string; name: string; icon?: string }>>
      /** 读取插件的图标 data URL（主进程读 manifest.icon 文件转 base64）；无 icon / 读取失败返回 null */
      getPluginIcon(appId: string): Promise<string | null>
      /** 订阅动态插件窗口应用清单变化（安装/卸载时主进程广播完整清单） */
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
      /** 【任务187】打开/关闭「应用菜单」专用置顶浮层窗口（主进程是唯一写者：同时切可见态与 appMenuOpen） */
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
      /** 切换主题（亮/暗）：通知主进程广播给所有窗口 */
      setTheme(theme: 'light' | 'dark'): void
      /** 订阅主题变更（主进程广播 ui:theme），返回取消订阅函数 */
      onThemeChange(cb: (theme: 'light' | 'dark') => void): () => void
      /** 订阅语言变更（主进程广播 ui:locale），返回取消订阅函数 */
      onLocaleChange(cb: (locale: string) => void): () => void
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
      /** 订阅网关中继状态变化（连接成功/失败/401 失效时主进程推送），返回取消订阅函数 */
      onRelayStatus(cb: (status: RelayStatus) => void): () => void
      getCredentialStatus(): Promise<CredentialSnapshot>
      onCredentialStatus(cb: (snap: CredentialSnapshot) => void): () => void
      // —— 会员实时通讯底座（私信 / 好友）：内置侧专用，凭证只在主进程 ——
      /** 查询会员通道状态（连接中/离线/凭证失效/本账号 memberId） */
      memberStatus(): Promise<MemberChannelStatus>
      /** 手动重连会员通道（失败态的「重试」按钮） */
      memberRetry(): Promise<MemberChannelStatus>
      /** 主动向网关（HTTP）刷新好友列表 + 待处理申请 + 红点数 */
      memberRefreshFriends(): Promise<MemberResult>
      /** 拉取好友 + 待处理申请 + 红点数快照（权威来自 HTTP） */
      memberFriends(): Promise<{ friends: DmFriend[]; requests: DmFriendRequest[]; requestCount: number }>
      /** 拉取私信会话列表（本地缓存，按最近活跃倒序） */
      memberThreads(): Promise<DmThread[]>
      /** 主动从网关 HTTP 拉会话列表（含每会话未读） */
      memberPullThreads(): Promise<DmThread[]>
      /** 未读汇总（总数 + 按通道） */
      memberUnread(): Promise<DmUnread>
      /** 会员检索：只支持用户名精确匹配（定稿：不做邀请码入口） */
      memberSearch(username: string): Promise<MemberResult & { members: DmFriend[]; notFound?: boolean }>
      /** 发起好友申请（HTTP，带申请附言） */
      memberRequestFriend(input: { targetMemberId: string; message?: string }): Promise<MemberResult>
      /** 同意好友申请（HTTP） */
      memberAcceptFriend(targetMemberId: string): Promise<MemberResult>
      /** 拒绝好友申请（HTTP） */
      memberRejectFriend(targetMemberId: string): Promise<MemberResult>
      /** 删除好友（HTTP；历史保留但需重新加好友才能再发） */
      memberDeleteFriend(memberId: string): Promise<MemberResult>
      /** 订阅某私信通道（ws subscribe + HTTP 拉一页历史），返回合并后的会话 */
      memberSubscribe(channelId: string): Promise<DmThread | null>
      /** 让主进程算出与某好友的 1v1 channelId（本账号 memberId 只在主进程可见） */
      memberChannelId(peerMemberId: string): Promise<string | null>
      /** 取消订阅某私信通道 */
      memberUnsubscribe(channelId: string): Promise<void>
      /** 分页拉取历史（HTTP 权威，失败退回本地缓存并带 error） */
      memberHistory(input: { channelId: string; page?: number; pageSize?: number }): Promise<{ messages: DmMessage[]; hasMore: boolean; total: number; page: number; error: string | null }>
      /** 发送私信。【任务109】fromUserShare=消息卡片分享标记（主进程据此走 sendDmFromAgent 安全门） */
      memberSend(input: { peerMemberId?: string; channelId?: string; text: string; peerName?: string; fromUserShare?: boolean }): Promise<MemberResult & { msgId?: string; channelId?: string; reason?: string; filterKind?: 'secret' | 'path' | 'addr' | 'error' }>
      /** 标记某通道已读（HTTP 上报；任一设备读过即已读） */
      memberMarkRead(channelId: string): Promise<MemberResult>
      /** 【红线】把某条私信引用到指定会话的输入框（只写输入框，不自动发送） */
      memberQuoteToSession(input: { sessionId: string; channelId: string; msgId: string }): Promise<MemberResult>
      /** 订阅会员通道状态变化（member:status） */
      onMemberStatus(cb: (status: MemberChannelStatus) => void): () => void
      /** 订阅私信消息（member:message） */
      onMemberMessage(cb: (msg: DmMessage) => void): () => void
      /** 订阅好友/申请列表变化（member:friends 广播，含红点数 requestCount） */
      onMemberFriends(cb: (snapshot: { friends: DmFriend[]; requests: DmFriendRequest[]; requestCount: number; ts: number }) => void): () => void
      /** 订阅「历史已合并」事件（member:history） */
      onMemberHistory(cb: (payload: { channelId: string; messages: DmMessage[]; hasMore: boolean; total: number }) => void): () => void
      /** 订阅「打开指定会话」指令（点系统通知直达对应私信会话） */
      onMemberOpenThread(cb: (payload: { channelId: string; ts: number }) => void): () => void
      /** 订阅「切换面板分区」指令（点好友申请通知直达好友分区） */
      onMemberOpenTab(cb: (payload: { tab: 'dm' | 'friends'; ts: number }) => void): () => void
      /** 订阅「好友消息进管家」自动接管事件（member:dm:auto-route，仅管家窗口订阅处理） */
      onDmAutoRoute(cb: (payload: { from: string; fromName: string; content: string; channelId: string; ts: number }) => void): () => void
      /** 订阅未读汇总变化（member:unread） */
      onMemberUnread(cb: (unread: DmUnread) => void): () => void
      /** 订阅会员通道错误（member:error，按真实原因分类） */
      onMemberError(cb: (err: MemberErrorPayload) => void): () => void
      /** 订阅会员通道业务通知（member:notice） */
      onMemberNotice(cb: (notice: MemberNotice) => void): () => void
      /** 订阅「把私信引用到本会话输入框」事件（仅聊天窗口收到） */
      onDmQuoteToSession(cb: (payload: DmQuotePayload) => void): () => void
      /** 获取当前应用版本号 */
      getVersion(): Promise<string>
      /** 手动检查更新（弹窗引导下载/安装） */
      checkUpdate(): Promise<AppUpdateCheckResult>
      /** 获取最近一次版本检查结果 */
      getUpdateStatus(): Promise<AppUpdateCheckResult | null>
      /** 订阅自动检查发现新版本时的推送（主进程广播到所有窗口） */
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
      listMarketPlugins(params?: { keyword?: string; category?: string; hasUI?: boolean | ''; page?: number; pageSize?: number }): Promise<{ ok: boolean; plugins: Array<{ id: string; name: string; purpose: string; version?: string; author?: string; hasUI?: boolean; categories?: string[]; iconUrl?: string; fileSha256?: string; fileSize?: number; installed?: boolean }>; total: number; error?: string }>
      /** 插件市场：下载并安装指定插件（下载 zip → X-SHA256 校验 → 解包还原 → 激活 + Dock 刷新） */
      installMarketPlugin(pluginId: string): Promise<{ ok: boolean; id?: string; name?: string; message?: string }>
      /** 插件市场：打包本地自研插件并提交到市场（网关 APIKey 鉴权） */
      submitPluginToMarket(pluginDirOrId: string, categories?: string[]): Promise<{ ok: boolean; message: string; zipPath?: string; data?: unknown }>
      /** 插件市场：列出「我已安装」插件（含自研标记 + 网关提交状态） */
      listMyPlugins(): Promise<{ ok: boolean; plugins: Array<{ id: string; name: string; purpose?: string; version?: string; selfMade: boolean; installed: boolean; submitted: boolean; gatewayVersion?: string; gatewayStatus?: string; hasApproved?: boolean }>; mineError?: string }>
      /** 插件市场：卸载已安装插件（撤销运行 + 删除 ~/.shanhai/plugins/<id>/ 目录，不可恢复） */
      uninstallMarketPlugin(pluginId: string): Promise<{ ok: boolean; message: string }>
      /** 读取全局 UI 共享状态快照，返回 { rev, state } 信封 */
      getUiState(): Promise<UiStateEnvelope>
      /** 订阅全局 UI 共享状态变化（推送 { rev, state } 信封） */
      onUiState(cb: (payload: UiStateEnvelope) => void): () => void
      /** 更新全局 UI 共享状态（字段级 patch） */
      patchUiState(patch: Partial<GlobalUiState>): Promise<void>
      status(): Promise<{ loggedIn: boolean; username: string | null }>
      login(u: string, p: string): Promise<{ username: string; nickname?: string }>
      register(u: string, p: string, nickname?: string, phone?: string, email?: string): Promise<{ username: string; nickname?: string }>
      logout(): Promise<void>
      listModels(): Promise<GatewayModel[]>
      refreshModels(): Promise<GatewayModel[]>
      onModelsChanged(cb: () => void): () => void
      addCustomModel(model: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic'; contextLength?: number; supportsVision?: boolean }): Promise<GatewayModel>
      updateCustomModel(id: string, model: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic'; contextLength?: number; supportsVision?: boolean }): Promise<GatewayModel>
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
      /** 通用文件上传到云存储（私信附件用）：主进程复用既有 runtime.uploadFile，返回公网直链；失败返回 null（调用方必须给可见提示） */
      uploadFile(dataBase64: string, mimeType?: string, fileName?: string): Promise<string | null>
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
      respondCapabilityApproval(requestId: string, approved: boolean, rememberForSession?: boolean): Promise<void>
      onAskRequest(cb: (req: AskRequest) => void): () => void
      respondAsk(requestId: string, answer: string): Promise<void>
      cancelAsk(requestId: string): Promise<void>
      run(message: string, attachments?: ContentPart[]): Promise<string>
      supervisorRun(message: string, attachments?: ContentPart[], dmContext?: { channelId?: string; peerMemberId?: string; fromName?: string }): Promise<string>
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
      getApprovalPolicy(sid?: string): Promise<'ask' | 'workdir' | 'never'>
      setApprovalPolicy(policy: 'ask' | 'workdir' | 'never'): Promise<void>
      onApprovalRequest(cb: (req: ApprovalRequest) => void): () => void
      onToolTrace(cb: (trace: ToolTrace) => void): () => void
      onDelta(cb: (sessionId: string, text: string) => void): () => void
      onReasoning(cb: (sessionId: string, text: string) => void): () => void
      switchModel(id: string): Promise<void>
      getCurrentModelId(): Promise<string>
      /** 停止执行；不传 sessionId = 停当前激活会话，传了 = 按 id 精确停（管家窗口传 'supervisor'）。
       * ★任务194 ⑦-②：回传成/败与原因（与 preload 的声明同步改；参数形态与通道名未动）。 */
      stop(sessionId?: string): Promise<{ ok: boolean; sessionId?: string; explicit?: boolean; reason?: string }>
      speak(text: string): Promise<void>
      transcribeAudio(audioBase64: string, format?: string): Promise<string>
      getTokenStats(sessionId?: string): Promise<TokenSnapshot>
      onTokenStats(cb: (sessionId: string, stats: TokenSnapshot) => void): () => void
      selfmodInspect(sessionId?: string): Promise<unknown>
      onClientRunRequest(cb: (req: ClientRunRequest) => void): () => void
      respondClientRun(requestId: string, approved: boolean): Promise<void>
      onClientRunResolved(cb: (requestId: string) => void): () => void
      onClientCode(cb: (payload: { pkgId: string; name: string; permissions?: string[]; entryHtml?: string; icon?: string }) => void): () => void
      onClientRemove(cb: (pkgId: string) => void): () => void
      listMemory(sessionId: string): Promise<MemoryEntry[]>
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

/** ui:state / ui:getState 信封：rev 为单调递增版本号（渲染进程据此丢弃过期快照），state 为按窗口过滤后的快照 */
export interface UiStateEnvelope {
  rev: number
  state: GlobalUiState
}

/** 全局 UI 共享状态（多窗口桌面系统的跨窗口上下文，与主进程 ui-store / preload 对齐） */
export interface GlobalUiState {
  loggedIn: boolean
  username: string | null
  /** 登录弹窗是否打开（跨窗口共享：Dock 点击「登录」后聊天窗口据此弹出登录框） */
  loginOpen: boolean
  /** 应用菜单面板是否打开（跨窗口共享：Dock 点击「应用菜单」入口后，桌面壳窗口据此在顶部弹出应用列表） */
  appMenuOpen: boolean
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
