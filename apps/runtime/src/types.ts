import type { Kernel } from '@shanhai/kernel'
import type { Session, ApprovalPolicy } from '@shanhai/session'
import type { Model, ContentPart } from '@shanhai/llm'
import type { GatewayModel, ModelTier, FileCredentialStore } from '@shanhai/auth'
import type { VoiceService } from '@shanhai/voice'
import type { ComputerUseService } from '@shanhai/computer-use'
import type { BrowserUseService } from '@shanhai/browser-use'
import type { TerminalService, TerminalInfo } from '@shanhai/terminal'
import type { MemoryStore } from '@shanhai/memory'
import type { ToolContract } from '@shanhai/tools'
import type { AskRequest } from '@shanhai/ask'
import type { SessionStateSummary } from './supervisor'

/** 工具调用过程事件（推给 UI 展示「思考 → 工具 → 结果」） */
export interface ToolTrace {
  kind: 'tool-call' | 'tool-result'
  /** 所属会话 id（并行会话时 UI 据此路由） */
  sessionId: string
  callId: string
  name: string
  args?: Record<string, unknown>
  result?: unknown
  error?: string
  approvalRequired?: boolean
  approved?: boolean
  /** 本次工具调用对应的「思考」（模型在决定调用该工具前输出的 reasoning），前端工具步骤卡片折叠展示 */
  reasoning?: string
  /** 工具调用开始时间戳（ms）：tool-call 用于前端执行中实时计时 */
  startTs?: number
  /** 工具执行耗时（ms）：tool-result 带上，前端完成后显示固定耗时 */
  durationMs?: number
}

export type ApprovalOutcome = 'allowed-once' | 'rejected'


/** token 用量快照（UI 底部状态栏展示：累计 / 本轮 / 上下文占比） */
export interface TokenSnapshot {
  /** 累计（本次启动以来的所有模型调用） */
  totalPrompt: number
  totalCompletion: number
  total: number
  /** 本轮任务（当前 run 期间） */
  turnPrompt: number
  turnCompletion: number
  turn: number
  /** 当前模型上下文窗口长度（无则 0） */
  contextLength: number
  /** 最近一次请求的 prompt tokens（即已占用的上下文） */
  lastPrompt: number
  /** 上下文窗口占比 0~1（lastPrompt / contextLength，contextLength 为 0 时返回 0） */
  contextUsageRatio: number
  /** 本轮缓存命中 token（prompt_tokens_details.cached_tokens） */
  turnCachedPromptTokens: number
  /** 累计缓存命中 token */
  totalCachedPromptTokens: number
  /** 最近一次请求的缓存命中率 0~1（最近一次缓存命中 token / 最近一次输入 token，无输入则 0） */
  cacheHitRatio: number
  /** 累计执行轮次（当前会话内，一次完整的「用户消息 → 最终回复」任务循环算一轮） */
  turnCount: number
}

/** 通用设置（持久化到 config.json 顶层 settings 字段，跨会话、重启保留） */
export interface AppSettings {
  browser: {
    /** 创建内置浏览器窗口时是否直接显示（false=后台静默创建，不弹窗打扰用户） */
    showOnCreate: boolean
    /** 是否开启「DeepSeek 网页版」桥接对接：关闭后不注册该模型，也不为每个会话预创建默认浏览器窗口 */
    enableWebBridge: boolean
  }
  messageSubmit: {
    /** 任务执行中继续发消息的策略：queue=排队等待当前任务完成，insert=打断当前任务立即执行新消息 */
    mode: 'queue' | 'insert'
  }
  debug: {
    /** 是否记录每次 LLM 请求/响应的原始数据（排查问题用），落盘到 ~/.shanhai/traces/<会话id>.http.log */
    traceLlm: boolean
  }
  voice: {
    /** 任务执行完、输出正文时是否自动语音播报（TTS 走 macOS say） */
    enabled: boolean
  }
  supervisorApproval: {
    /** 是否允许管家接管审批：true 时，管家下发的任务触发的审批由管家决策（决策后弹窗自动关闭）；
     *  false 时无论谁下发都由用户手动审批。用户手动点击始终优先、始终可用。 */
    enabled: boolean
  }
  supervisorAsk: {
    /** 是否允许管家接管提问：true 时，管家下发的任务里会话发起的 ask_user 提问由管家代答（代答后弹窗自动关闭）；
     *  false 时无论谁下发都由用户手动回答。用户手动回答始终优先、始终可用。 */
    enabled: boolean
  }
  compaction: {
    /** 统一压缩模型 id：上下文超限触发 LLM 摘要时用的模型。空串 = 未配置，回退当前会话模型。 */
    modelId: string
  }
}

/** 设置补丁：允许只传某个分组的某个字段（嵌套 Partial），setSettings 据此增量合并 */
export type AppSettingsPatch = {
  browser?: Partial<AppSettings['browser']>
  messageSubmit?: Partial<AppSettings['messageSubmit']>
  debug?: Partial<AppSettings['debug']>
  voice?: Partial<AppSettings['voice']>
  supervisorApproval?: Partial<AppSettings['supervisorApproval']>
  supervisorAsk?: Partial<AppSettings['supervisorAsk']>
  compaction?: Partial<AppSettings['compaction']>
}

/** 通用设置默认值 */
export const DEFAULT_SETTINGS: AppSettings = {
  browser: { showOnCreate: true, enableWebBridge: true },
  messageSubmit: { mode: 'queue' },
  debug: { traceLlm: false },
  voice: { enabled: true },
  supervisorApproval: { enabled: false },
  supervisorAsk: { enabled: false },
  compaction: { modelId: '' },
}

/** 自定义模型输入（OpenAI 兼容或 Anthropic 协议；接口地址 / 密钥 / 模型名均由用户填写） */
export interface CustomModelInput {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** 调用协议：openai（默认）/ anthropic */
  protocol?: 'openai' | 'anthropic'
  /** 上下文窗口长度（token 数），供上下文预算计算 */
  contextLength?: number
  /** 是否支持视觉（多模态）输入 */
  supportsVision?: boolean
}

export interface Runtime {
  kernel: Kernel
  session: Session
  tools: ToolContract[]
  model: Model
  memory: MemoryStore
  credentials: FileCredentialStore
  voice: VoiceService
  computerUse: ComputerUseService
  browserUse: BrowserUseService

  /** 登录状态 */
  loggedIn: boolean
  username: string | null
  /** 账号密码登录（SHA-256），成功后拉取会员模型并切换为真实网关模型 */
  login(username: string, password: string): Promise<{ username: string; nickname?: string }>
  logout(): Promise<void>
  /** 当前会员 JWT（登录后有效，供远程连接走网关 bridge 鉴权；未登录返回空串） */
  getMemberToken(): string
  /** 设备标识信息（远程连接多设备用）：deviceId 首次生成并持久化，deviceName 默认主机名可自定义 */
  getDeviceInfo(): { deviceId: string; deviceName: string; hostname: string; os: string }
  /** 自定义设备显示名（持久化到 config.json） */
  setDeviceName(name: string): Promise<void>
  /** 网关模型列表（系统内置 + 用户自定义） */
  listModels(): Promise<GatewayModel[]>
  /** 用会员 token 重新拉取最新模型列表（网关新增/禁用模型后调用，成功后同步缓存并通知前端） */
  refreshModels(): Promise<GatewayModel[]>
  /** 模型列表变化回调（启动自动刷新 / 手动刷新完成后触发，UI 重取下拉框） */
  onModelsChanged(cb: () => void): () => void
  /** 登录凭证整体失效（token + apiKey 都过期）回调，UI 据此提示重新登录 */
  onAuthExpired(cb: () => void): () => void
  /** 新增用户自定义模型（OpenAI 兼容或 Anthropic 协议 + 自有 Key），返回落库后的模型 */
  addCustomModel(model: CustomModelInput): Promise<GatewayModel>
  /** 编辑用户自定义模型（按 id 更新，保留 id） */
  updateCustomModel(id: string, model: CustomModelInput): Promise<GatewayModel>
  /** 删除用户自定义模型 */
  removeCustomModel(id: string): Promise<void>
  /** 当前选中模型（tier 路由） */
  selectedTier: ModelTier

  /** 会话列表（内存多会话，含每会话工作目录、活跃时间、是否进行中；排序规则「进行中置顶 → 最近活跃时间倒序」由前端负责） */
  listSessions(): Array<{ id: string; title: string; workDir: string; lastActiveAt: number; busy: boolean }>
  switchSession(id: string): void
  /** 描述指定会话的完整状态（管家工具用）：模型/审批策略/当前需求/已执行步数/上下文占用等 */
  describeSession(sessionId: string): SessionStateSummary | null
  /** 向指定会话转发消息（管家工具用），mode=insert 追加 / queue 排队 */
  sendMessageToSession(sessionId: string, message: string, mode?: 'insert' | 'queue'): Promise<{ ok: boolean; message: string; result?: string }>
  /** 向指定会话执行任务（手机远程控制用），等同用户手动切到该会话发消息，但不回传管家结果（避免污染管家历史） */
  runSession(sessionId: string, message: string, mode?: 'insert' | 'queue'): Promise<{ ok: boolean; message: string; result?: string }>
  /** 切换指定会话使用的模型（管家工具用，写事件日志持久化） */
  setSessionModel(sessionId: string, modelId: string): { ok: boolean; message: string }
  /** 配置指定会话的安全模式（管家工具用，写事件日志持久化） */
  setSessionApprovalPolicy(sessionId: string, policy: ApprovalPolicy): { ok: boolean; message: string }
  /** 管家自己的模型 id（supervisor 会话级，独立于其他会话与全局默认） */
  getSupervisorModel(): string
  /** 管家自己的安全模式（supervisor 会话级，独立于其他会话与全局） */
  getSupervisorApprovalPolicy(): ApprovalPolicy
  /** 切换管家自己的模型（只作用于 supervisor 会话，不碰全局默认模型、不碰其他会话） */
  setSupervisorModel(modelId: string): { ok: boolean; message: string }
  /** 配置管家自己的安全模式（只作用于 supervisor 会话） */
  setSupervisorApprovalPolicy(policy: ApprovalPolicy): { ok: boolean; message: string }
  /** 跑一次管家会话任务（独立 supervisor 窗口用，单步 ReAct + 管家工具集） */
  runSupervisor(message: string, attachments?: ContentPart[]): Promise<string>
  /** 重命名会话标题 */
  renameSession(id: string, title: string): void
  /** 删除会话（当前会话被删则切到剩余第一个） */
  deleteSession(id: string): Promise<void>
  /** 获取指定会话工作目录（不传 id 用当前会话） */
  getSessionWorkdir(id?: string): string
  /** 修改指定会话工作目录 */
  setSessionWorkdir(id: string, workdir: string): void
  /** 把用户上传的普通文件（非媒体）保存到当前会话工作目录，返回绝对路径（供 read_file 等工具读取） */
  saveUploadedFile(fileName: string, dataBase64: string): Promise<string>
  /** 把图片 base64（不含 data: 前缀）上传到云存储，返回 https 公网链接；未登录/失败返回 null（回退 data URL） */
  uploadImage(imageBase64: string, mimeType?: string): Promise<string | null>
  /** 列出指定会话（缺省当前会话）打开的浏览器窗口（会话级隔离） */
  listBrowserWindows(sessionId?: string): Promise<Array<{ appId: string; url: string; title: string }>>
  /** 显示并聚焦指定浏览器窗口（用户点击标签恢复窗口） */
  showBrowserWindow(appId: string): Promise<void>
  /** 关闭指定浏览器窗口（appId 为 list 返回的完整标识） */
  closeBrowserWindow(appId: string): Promise<void>
  /** 创建用户手动终端（会话级隔离），返回该会话内的完整终端标识（含会话前缀） */
  userTerminalCreate(sessionId: string, name?: string): Promise<string>
  /** 用户手动终端原始写入（交互式输入，支持 vim/top/密码输入等） */
  userTerminalWrite(sessionId: string, terminalId: string, data: string): void
  /** 用户手动终端调整窗口尺寸（行列，xterm 尺寸变化时调用） */
  userTerminalResize(sessionId: string, terminalId: string, cols: number, rows: number): void
  /** 关闭指定用户手动终端（terminalId 为 userTerminalCreate / userTerminalList 返回的完整标识） */
  userTerminalClose(sessionId: string, terminalId: string): Promise<void>
  /** 列出指定会话的用户手动终端（会话级隔离） */
  userTerminalList(sessionId: string): Promise<TerminalInfo[]>
  /** 订阅用户手动终端的实时输出（含 ANSI 转义序列，带 sessionId + terminalId 路由） */
  onUserTerminalOutput(cb: (sessionId: string, terminalId: string, data: string) => void): () => void
  /** DeepSeek 网页版桥接状态（专用浏览器窗口是否已创建 / 桥接脚本是否已注入） */
  getDeepSeekBridgeStatus(): Promise<{ windowReady: boolean; bridgeInjected: boolean }>
  /** 打开 DeepSeek 页面（固定 appId 走共享 partition）并注入桥接脚本，返回是否成功与提示 */
  openDeepSeekBridge(): Promise<{ ok: boolean; message: string }>
  /** 仅注入桥接脚本（DeepSeek 页面已打开时用），返回是否成功与提示 */
  injectDeepSeekBridge(): Promise<{ ok: boolean; message: string }>
  /** 获取指定会话的历史消息（UI 切换会话时加载；不传 id 用当前会话） */
  getSessionHistory(id?: string): Array<{ kind: 'user' | 'assistant' | 'tool'; content?: string; reasoningContent?: string; trace?: ToolTrace; attachments?: unknown[]; turnSeq?: number; turnDuration?: number }>
  /** 获取指定会话的完整执行痕迹（请求大模型的消息角色 + 工具调用 + 元数据，供轨迹面板查看） */
  getSessionTrace(id?: string): Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    reasoningContent?: string
    toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
    toolCallId?: string
    toolName?: string
    result?: unknown
    error?: string
    turn: number
    timestamp: number
  }>
  /** 新建会话（可指定工作目录），返回会话 id */
  createSession(title?: string, workdir?: string): string
  /** 当前会话的历史消息（用于 UI 切换会话时回放） */
  getHistory(): Array<{ role: 'user' | 'assistant' | 'tool'; content: string; toolName?: string }>

  /** 工具调用过程回调（UI 展示，trace 带 sessionId） */
  onToolTrace(cb: (trace: ToolTrace) => void): () => void
  /** 审批请求回调（UI 弹卡片，req 带 sessionId） */
  onApprovalRequest(cb: (req: { id: string; sessionId?: string; toolName: string; args: Record<string, unknown>; riskLevel: string }) => void): () => void
  /** UI 应答审批（requestId 定位具体审批请求，支持并行会话） */
  respondApproval(outcome: ApprovalOutcome, requestId: string): void
  /** 审批被管家决策 resolve 后回调（requestId 定位，UI 据此关闭对应弹窗） */
  onApprovalResolved(cb: (requestId: string) => void): () => void
  /** 提问被管家代答 resolve 后回调（requestId 定位，UI 据此关闭对应弹窗） */
  onAskResolved(cb: (requestId: string) => void): () => void
  /** AI 向用户提问请求回调（UI 弹交互式卡片，req 带 sessionId，会话级隔离） */
  onAskRequest(cb: (req: AskRequest) => void): () => void
  /** UI 提交用户回答（requestId 定位具体提问，支持并行会话） */
  respondAsk(requestId: string, answer: string): void
  /** UI 取消回答/选择（requestId 定位具体提问，resolve 为取消标记） */
  cancelAsk(requestId: string): void

  /** 流式增量回调（sessionId 标识来源会话） */
  onDelta(cb: (sessionId: string, text: string) => void): () => void
  /** 流式思考增量回调（推理模型 reasoning_content，UI 实时渲染「思考过程」） */
  onReasoning(cb: (sessionId: string, text: string) => void): () => void
  /** 会话开始/结束执行（供 UI 刷新「处理中」状态与消息流） */
  onSessionActivity(cb: (sessionId: string, kind: 'start' | 'end') => void): () => void
  /** 激活会话切换（供 UI 同步当前会话高亮） */
  onCurrentSessionChanged(cb: (sessionId: string) => void): () => void
  /** 管家异步下发的目标会话任务完成后回传正文结果（供管家窗口实时展示） */
  onSupervisorResult(cb: (sessionId: string, title: string, result?: string, error?: string) => void): () => void
  /** 管家向目标会话下发任务时实时广播 user 消息（供目标会话 UI 立即显示用户气泡） */
  onUserMessage(cb: (sessionId: string, message: string, turnSeq: number) => void): () => void

  /** 当前 token 用量快照（累计 / 本轮 / 上下文占比 / 缓存命中，会话级；不传 id 用当前激活会话） */
  getTokenStats(sessionId?: string): TokenSnapshot
  /** token 用量变化回调（模型每次返回 usage 时推送，带 sessionId 标识所属会话） */
  onTokenStats(cb: (sessionId: string, stats: TokenSnapshot) => void): () => void

  /** 切换模型（动态更新 provider，后续对话用新模型，并持久化到本地） */
  switchModel(modelId: string): void
  /** 当前选中的模型 id（从本地缓存恢复，重启后仍记住） */
  getCurrentModelId(): string
  /** 中断当前会话的进行中任务（并行会话互不影响） */
  stop(): void
  /** 中断指定会话的进行中任务（手机远程控制按 sessionId 精确停止，不改变当前激活会话） */
  stopSession(sessionId: string): void

  /** 跑一次任务（端到端 ReAct，支持多模态附件；绑定当前会话，切换会话后后台继续跑） */
  run(message: string, opts?: { maxSteps?: number; attachments?: ContentPart[] }): Promise<string>

  /**
   * 重新发送某条用户消息（参考 DSH / taco 的 resendFromExisting）：
   * 截断到该用户消息之前，重新生成回复。newContent 传了则用新内容（编辑后重发）。
   * userMessageIndex 为该会话内用户消息的序号（0 起）。
   */
  resend(sessionId: string, userMessageIndex: number, newContent?: string): Promise<string>
  /** 继续执行：把最后一条用户消息重新生成（断点恢复 / 中断后续跑） */
  resume(sessionId: string): Promise<string>
  /** 失败重试：用失败节点相同的 messages 快照重新提交请求（保持上下文，不重新开始、不重新回放历史） */
  retrySession(sessionId: string): Promise<string>
  /** 取消重试：清理挂起 loop（取消后不再走「重试」，改走「继续执行」），但保留 session 未完成状态（「继续执行」入口可用） */
  abandonSession(sessionId: string): Promise<void>
  /** 查询指定会话是否有「失败重试挂起快照」（重启后前端据此恢复「重试/取消」弹窗）；无则返回 null */
  hasRetrySnapshot(sessionId: string): { reason?: string } | null
  /**
   * 插入消息（插入模式）：任务执行中向正在运行的 AgentLoop 注入一条用户消息，不中断当前任务。
   * 消息在下一个模型调用前以 user 形式追加到上下文。返回是否成功注入（无运行中任务则 false，前端回退队列）。
   */
  injectMessage(sessionId: string, message: string): boolean
  /** 会话是否存在「未完成的消息」（最后一条用户消息之后没有 assistant/message 或 turn/end） */
  hasIncompleteTurn(sessionId: string): boolean
  /** 当前审批策略（安全模式） */
  getApprovalPolicy(): ApprovalPolicy
  /** 切换审批策略（安全模式），并持久化到本地 */
  setApprovalPolicy(policy: ApprovalPolicy): void

  /** 自修改（K5）：查看当前会话的动态插件包 / 服务 / 工具 / UI 插槽表面 */
  selfmodInspect(sessionId?: string): unknown
  /** 自修改：恢复已安装插件（AI 自研应用跨会话/跨重启留存），返回恢复数量。由主进程在窗口就绪后调用 */
  restoreInstalledPlugins(): Promise<number>
  /** 自修改：browser 半投递前的 round-trip 审批请求回调（UI 弹卡片） */
  onClientRunRequest(cb: (req: { requestId: string; sessionId: string; pkgId: string; name: string; purpose: string }) => void): () => void
  /** UI 应答 browser 半投递审批（approved=true 投递，false 拒绝） */
  respondClientRun(requestId: string, approved: boolean): void
  /** browser 半代码投递回调（UI 收到后 slots 注册渲染） */
  onClientCode(cb: (payload: { pkgId: string; name: string; code: string }) => void): () => void
  /** browser 半卸载回调（UI 移除组件） */
  onClientRemove(cb: (pkgId: string) => void): () => void
  /** 列出长期记忆（按会话隔离，仅返回当前会话的记忆） */
  listMemory(sessionId: string): Array<{ id: number; scope: string; key: string; value: unknown; source: string; confidence: number; timestamp: number; sessionId?: string }>
  /** 删除一条长期记忆（按 id） */
  removeMemory(id: number): void
  /** 语音转文字（STT）：音频 base64 → 文本（优先 LLM 网关 AI 识别，失败降级 macOS Speech） */
  transcribeAudio(audioBase64: string, format?: string): Promise<string>
  /** 当前通用设置（持久化到 config.json，跨会话、重启保留） */
  getSettings(): AppSettings
  /** 更新通用设置（局部 patch，仅改传入字段），持久化并实时同步到相关能力（如浏览器窗口显示） */
  setSettings(patch: AppSettingsPatch): Promise<AppSettings>
  /** 读取指定会话（缺省当前会话）的 HTTP 原始请求/响应记录（请求一条、响应一条，含接口地址与完整原始 body），无记录返回空数组 */
  getHttpTrace(id?: string): Promise<Array<{ ts: number; sessionId: string; phase: 'request' | 'response'; url: string; method: string; body?: unknown; responseStatus?: number; error?: string }>>
  /** 清空指定会话（缺省当前会话）的 HTTP trace 记录 */
  clearHttpTrace(id?: string): Promise<void>
  /** 返回指定会话（缺省当前会话）的 HTTP trace 文件绝对路径 */
  getHttpTracePath(id?: string): string
  /** 返回所有 LLM/HTTP 日志文件所在目录的绝对路径（供「打开日志目录」用） */
  getTraceDir(): string
}

/**
 * host 装配：用内核装配底座服务 + 能力插件。
 * 暴露登录 / 会话 / 模型 / 工具过程 / 审批 等产品能力。
 */
export interface BootstrapOptions {
  /** 浏览器后端（桌面端注入 Electron 内置浏览器；CLI 模式缺省走 mock） */
  browserUse?: BrowserUseService
  /** 终端后端（桌面端注入 node-pty 持久 shell；CLI 模式缺省走 mock） */
  terminalUse?: TerminalService
}
