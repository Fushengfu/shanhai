import { Kernel, FileSnapshotStore, PluginStore, type DynamicPackage } from '@shanhai/kernel'
import { CORE_SLOTS } from '@shanhai/kernel-modules/client'
import { SelfModifyRuntime } from '@shanhai/selfmod'
import { Session, effectiveApprovalPolicy, effectiveModelId, type ApprovalPolicy, type SessionEvent } from '@shanhai/session'
import { ApprovalService } from '@shanhai/approval'
import { AgentLoop, ModelTriage, Orchestrator, type RoleDefinition, type StepTrace, type SuspendedSnapshot, type TaskPlan } from '@shanhai/agent'
import type { Model, ContentPart, TokenUsage, HttpTrace, HttpTraceCallback, ChatMessage } from '@shanhai/llm'
import { createMockModel, createModelProvider } from '@shanhai/llm'
import { createAtomicTools, createUtilityTools, toolReasoningContext, type ToolContract } from '@shanhai/tools'
import { createAskTools, AskService, ASK_CANCELLED, type AskRequest } from '@shanhai/ask'
import { createSkillTools, SkillService } from '@shanhai/skills'
import { createMcpTools, McpService } from '@shanhai/mcp'
import { MemoryStore } from '@shanhai/memory'
import { FileCredentialStore, AuthService, TokenExpiredError } from '@shanhai/auth'
import type { GatewayModel, ModelTier } from '@shanhai/auth'
import type { VoiceService } from '@shanhai/voice'
import { createComputerUseSkill, createPlatformComputerUseService, type ComputerUseService } from '@shanhai/computer-use'
import { createBrowserUseSkill, createMockBrowserUseService, type BrowserUseService } from '@shanhai/browser-use'
import { createTerminalSkill, createMockTerminalService, type TerminalService, type TerminalInfo } from '@shanhai/terminal'
import { createDeepSeekModel, buildBridgeScript, BRIDGE_READY_CHECK } from '@shanhai/deepseek-bridge'
import { uploadImageToCloud } from '@shanhai/storage'
import { createSupervisorTools, SUPERVISOR_ID, type SessionStateSummary } from './supervisor'
import { promises as fs } from 'node:fs'
import { homedir, hostname as osHostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join, basename, isAbsolute } from 'node:path'
import { exec as execCallback, execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'

const execAsync = promisify(execCallback)
const execFileAsync = promisify(execFileCallback)

/** 并行会话的工具调用上下文：让全局工具包装层知道「当前工具属于哪个会话」 */
const sessionContext = new AsyncLocalStorage<string>()

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

export type { AskRequest } from '@shanhai/ask'

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
}

/** 设置补丁：允许只传某个分组的某个字段（嵌套 Partial），setSettings 据此增量合并 */
export type AppSettingsPatch = {
  browser?: Partial<AppSettings['browser']>
  messageSubmit?: Partial<AppSettings['messageSubmit']>
  debug?: Partial<AppSettings['debug']>
  voice?: Partial<AppSettings['voice']>
  supervisorApproval?: Partial<AppSettings['supervisorApproval']>
  supervisorAsk?: Partial<AppSettings['supervisorAsk']>
}

/** 通用设置默认值 */
export const DEFAULT_SETTINGS: AppSettings = {
  browser: { showOnCreate: true, enableWebBridge: true },
  messageSubmit: { mode: 'queue' },
  debug: { traceLlm: false },
  voice: { enabled: true },
  supervisorApproval: { enabled: false },
  supervisorAsk: { enabled: false },
}

/** 自定义模型输入（OpenAI 兼容或 Anthropic 协议；接口地址 / 密钥 / 模型名均由用户填写） */
export interface CustomModelInput {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** 调用协议：openai（默认）/ anthropic */
  protocol?: 'openai' | 'anthropic'
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
  /** 多专家编排轨迹回调（UI 展示 Triage 拆解 → 专家执行过程） */
  onExpertTrace(cb: (trace: StepTrace) => void): () => void
  /** 列出所有专家（内置 + 自定义），builtin 标记内置（不可删）与自定义（可删） */
  listExperts(): Array<RoleDefinition & { builtin: boolean }>
  /** 新增/更新一个自定义专家（校验 id/name 非空，持久化到 config.json 并刷新 triage 角色列表） */
  registerExpert(role: { id: string; name: string; description: string; systemPrompt: string }): Promise<RoleDefinition & { builtin: boolean }>
  /** 删除一个自定义专家（内置专家不可删除） */
  removeExpert(id: string): Promise<void>
  /** 列出长期记忆（跨会话，配置型 + 经验型） */
  listMemory(): Array<{ id: number; scope: string; key: string; value: unknown; source: string; confidence: number; timestamp: number }>
  /** 删除一条长期记忆（按 id） */
  removeMemory(id: number): void
  /** 语音转文字（STT）：音频 base64 → 文本（优先 LLM 网关 AI 识别，失败降级 macOS Speech） */
  transcribeAudio(audioBase64: string, format?: string): Promise<string>
  /** 当前通用设置（持久化到 config.json，跨会话、重启保留） */
  getSettings(): AppSettings
  /** 更新通用设置（局部 patch，仅改传入字段），持久化并实时同步到相关能力（如浏览器窗口显示） */
  setSettings(patch: AppSettingsPatch): Promise<AppSettings>
  /** 读取指定会话（缺省当前会话）的 HTTP 原始请求/响应记录（请求一条、响应一条，含接口地址与完整原始 body），无记录返回空数组 */
  getHttpTrace(id?: string): Promise<Array<{ ts: number; sessionId: string; model: string; phase: 'request' | 'response'; url: string; method: string; body?: unknown; responseStatus?: number; error?: string }>>
  /** 清空指定会话（缺省当前会话）的 HTTP trace 记录 */
  clearHttpTrace(id?: string): Promise<void>
  /** 返回指定会话（缺省当前会话）的 HTTP trace 文件绝对路径 */
  getHttpTracePath(id?: string): string
  /** 返回所有 LLM/HTTP 日志文件所在目录的绝对路径（供「打开日志目录」用） */
  getTraceDir(): string
}

/** 从本地凭证装配真实网关模型；无凭证则 mock 兜底 */
async function createGatewayModel(onUsage?: (usage: TokenUsage) => void, onTrace?: HttpTraceCallback): Promise<Model> {
  try {
    const raw = await fs.readFile(join(homedir(), '.shanhai', 'config.json'), 'utf8')
    const cfg = JSON.parse(raw) as {
      gateway?: { baseUrl?: string; apiKey?: string; selectedModelId?: string }
    }
    const g = cfg.gateway
    if (g?.baseUrl && g?.apiKey && g?.selectedModelId) {
      return createModelProvider({ apiKey: g.apiKey, baseUrl: g.baseUrl, model: g.selectedModelId, onUsage, onTrace })
    }
  } catch {
    // 无凭证，走 mock
  }
  return createMockModel([{ text: '你好，我是山海智能体。' }])
}

function inferTier(id: string): ModelTier {
  if (/flash|step-3/i.test(id)) return 'value'
  return 'flagship'
}

/** 视觉模型匹配提示词（这些厂商的模型通常支持多模态视觉） */
const VISION_HINTS = ['qwen', 'kimi', 'mimo', 'minimax', 'longcat', 'glm', 'vision', 'vl', 'omni', 'step']

function isVisionModel(id: string): boolean {
  const lower = id.toLowerCase()
  return VISION_HINTS.some((h) => lower.includes(h))
}

/** 判断模型是否支持视觉：优先用接口返回的 supportsVision 字段，缺省时回退 id 猜测 */
function modelSupportsVision(m: GatewayModel | undefined): boolean {
  if (!m) return false
  if (m.supportsVision !== undefined) return m.supportsVision
  return isVisionModel(m.id)
}

/** 用 apiKey 拉取网关完整模型列表（/api/v1/models，各自上游 baseUrl）。apiKey 长期有效，网关禁用的模型不在返回里，可作「当前启用模型白名单」 */
async function fetchGatewayModels(apiKey: string, baseUrl: string): Promise<GatewayModel[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      code?: number
      data?: {
        data?: Array<{
          id: string
          name?: string
          displayName?: string
          baseUrl?: string
          model?: string
          contextLength?: number
          maxTokens?: string | number
          temperature?: string | number
          provider?: string
          sortOrder?: number
          description?: string
          source?: string
        }>
      }
    }
    const list = data.data?.data ?? []
    return list.map((m) => ({
      id: m.id,
      name: m.displayName ?? m.name ?? m.id,
      displayName: m.displayName != null ? String(m.displayName) : undefined,
      model: m.model != null ? String(m.model) : undefined,
      tier: inferTier(m.id),
      apiKey,
      baseUrl: m.baseUrl ?? baseUrl,
      contextLength: typeof m.contextLength === 'number' ? m.contextLength : undefined,
      maxTokens: m.maxTokens != null ? Number(m.maxTokens) : undefined,
      temperature: m.temperature != null ? String(m.temperature) : undefined,
      provider: m.provider != null ? String(m.provider) : undefined,
      sortOrder: typeof m.sortOrder === 'number' ? m.sortOrder : undefined,
      description: m.description != null ? String(m.description) : undefined,
      source: m.source != null ? String(m.source) : undefined,
    }))
  } catch {
    return []
  }
}

// —— config.json 串行写（互斥锁）——
// 所有 config.json 的持久化都走「读 → 改 → 写」三步；若不串行化，多个 void 异步写会基于同一份旧快照落盘，
// 后写者覆盖先写者，导致登录凭证（gateway.apiKey）或设置（settings）偶发丢失（表现为「重启后登录失效 / 设置重置」）。
let configWriteChain: Promise<unknown> = Promise.resolve()

/** 串行化地读-改-写 config.json：mutate 在锁内执行，返回其返回值；读失败不落盘；写入用临时文件 + rename 保证原子性 */
async function withConfigFile<T>(mutate: (cfg: Record<string, unknown>) => T | Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const path = join(homedir(), '.shanhai', 'config.json')
    let cfg: Record<string, unknown> = {}
    try {
      cfg = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
    } catch {
      // 新文件 / 损坏：从空对象开始
    }
    const result = await mutate(cfg)
    const tmp = `${path}.tmp`
    await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
    await fs.rename(tmp, path)
    return result
  }
  const p = configWriteChain.then(run)
  configWriteChain = p.catch(() => undefined)
  return p
}

// —— 设备标识（远程连接多设备用，持久化到 config.json 顶层 deviceId/deviceName）——
let deviceInfo: { deviceId: string; deviceName: string; hostname: string; os: string } | null = null

/** 初始化设备标识：读 config.json 的 deviceId/deviceName，缺失则生成 UUID + 主机名并落盘（串行写，幂等） */
async function ensureDeviceInfo(): Promise<void> {
  if (deviceInfo) return
  const hostname = osHostname()
  const osName = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
  const generatedId = randomUUID()
  await withConfigFile((cfg) => {
    const existingId = typeof cfg.deviceId === 'string' && cfg.deviceId ? cfg.deviceId : ''
    const existingName = typeof cfg.deviceName === 'string' && cfg.deviceName ? cfg.deviceName : ''
    if (!existingId) cfg.deviceId = generatedId
    if (!existingName) cfg.deviceName = hostname
    deviceInfo = {
      deviceId: existingId || generatedId,
      deviceName: existingName || hostname,
      hostname,
      os: osName,
    }
  })
}

/** 持久化选中模型到 config.json（下次打开不再重复选择） */
async function persistSelectedModel(modelId: string): Promise<void> {
  try {
    await withConfigFile((cfg) => {
      const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
      g.selectedModelId = modelId
      cfg.gateway = g
    })
  } catch {
    // 忽略持久化失败
  }
}

/** 持久化上次激活的会话 id 到 config.json 顶层（重启恢复到上次关闭前激活的那个会话） */
async function persistLastActiveSessionId(sessionId: string): Promise<void> {
  try {
    await withConfigFile((cfg) => {
      cfg.lastActiveSessionId = sessionId
    })
  } catch {
    // 忽略持久化失败
  }
}

/** 读取上次激活的会话 id（重启恢复用；无记录或会话已删除时返回 null） */
async function readLastActiveSessionId(): Promise<string | null> {
  try {
    const path = join(homedir(), '.shanhai', 'config.json')
    const raw = await fs.readFile(path, 'utf8')
    const cfg = JSON.parse(raw) as { lastActiveSessionId?: string }
    return typeof cfg.lastActiveSessionId === 'string' ? cfg.lastActiveSessionId : null
  } catch {
    return null
  }
}

/** 持久化用户自定义模型列表（独立于系统内置模型，登录态无关） */
async function persistCustomModels(models: GatewayModel[]): Promise<void> {
  try {
    await withConfigFile((cfg) => {
      const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
      g.customModels = models
      cfg.gateway = g
    })
  } catch {
    // 忽略持久化失败
  }
}

/** 读取用户自定义专家角色（config.json 顶层 customRoles，重启恢复；内置角色不在此列） */
async function readCustomRoles(): Promise<RoleDefinition[]> {
  try {
    const path = join(homedir(), '.shanhai', 'config.json')
    const raw = await fs.readFile(path, 'utf8')
    const cfg = JSON.parse(raw) as { customRoles?: RoleDefinition[] }
    if (!Array.isArray(cfg.customRoles)) return []
    return cfg.customRoles.filter((r) => typeof r?.id === 'string' && r.id.trim() !== '')
  } catch {
    return []
  }
}

/** 持久化用户自定义专家角色到 config.json 顶层 customRoles（权限 600） */
async function persistCustomRoles(roles: RoleDefinition[]): Promise<void> {
  try {
    await withConfigFile((cfg) => {
      cfg.customRoles = roles
    })
  } catch {
    // 忽略持久化失败
  }
}

/** 登录成功后合并保存凭证（更新 memberToken + account + 网关模型凭证，密码不落盘） */
async function persistLoginToken(
  token: string,
  username: string,
  member: { nickname?: string; avatar?: string } | undefined,
  gateway: { apiKey: string; baseUrl: string; selectedModelId: string },
): Promise<void> {
  try {
    await withConfigFile((cfg) => {
      const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
      g.memberToken = token
      g.account = { username, ...(member ?? {}) }
      g.apiKey = gateway.apiKey
      g.baseUrl = gateway.baseUrl
      g.selectedModelId = gateway.selectedModelId
      cfg.gateway = g
    })
  } catch {
    // 忽略持久化失败
  }
}

/** 读取通用设置（config.json 顶层 settings 字段，缺字段回退默认值） */
async function readSettings(): Promise<AppSettings> {
  try {
    const path = join(homedir(), '.shanhai', 'config.json')
    const raw = await fs.readFile(path, 'utf8')
    const cfg = JSON.parse(raw) as { settings?: Partial<AppSettings> }
    const s = cfg.settings
    return {
      browser: {
        showOnCreate: s?.browser?.showOnCreate ?? DEFAULT_SETTINGS.browser.showOnCreate,
        enableWebBridge: s?.browser?.enableWebBridge ?? DEFAULT_SETTINGS.browser.enableWebBridge,
      },
      messageSubmit: { mode: s?.messageSubmit?.mode ?? DEFAULT_SETTINGS.messageSubmit.mode },
      debug: { traceLlm: s?.debug?.traceLlm ?? DEFAULT_SETTINGS.debug.traceLlm },
      voice: { enabled: s?.voice?.enabled ?? DEFAULT_SETTINGS.voice.enabled },
      supervisorApproval: { enabled: s?.supervisorApproval?.enabled ?? DEFAULT_SETTINGS.supervisorApproval.enabled },
      supervisorAsk: { enabled: s?.supervisorAsk?.enabled ?? DEFAULT_SETTINGS.supervisorAsk.enabled },
    }
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      browser: { ...DEFAULT_SETTINGS.browser },
      messageSubmit: { ...DEFAULT_SETTINGS.messageSubmit },
      debug: { ...DEFAULT_SETTINGS.debug },
      voice: { ...DEFAULT_SETTINGS.voice },
      supervisorApproval: { ...DEFAULT_SETTINGS.supervisorApproval },
      supervisorAsk: { ...DEFAULT_SETTINGS.supervisorAsk },
    }
  }
}

/** 持久化通用设置到 config.json 顶层 settings 字段（合并，不影响 gateway 等其它字段） */
async function writeSettings(patch: Partial<AppSettings>): Promise<void> {
  try {
    await withConfigFile((cfg) => {
      const cur = (cfg.settings as Partial<AppSettings> | undefined) ?? {}
      const merged: AppSettings = {
        browser: { ...DEFAULT_SETTINGS.browser, ...(cur.browser ?? {}), ...(patch.browser ?? {}) },
        messageSubmit: { ...DEFAULT_SETTINGS.messageSubmit, ...(cur.messageSubmit ?? {}), ...(patch.messageSubmit ?? {}) },
        debug: { ...DEFAULT_SETTINGS.debug, ...(cur.debug ?? {}), ...(patch.debug ?? {}) },
        voice: { ...DEFAULT_SETTINGS.voice, ...(cur.voice ?? {}), ...(patch.voice ?? {}) },
        supervisorApproval: { ...DEFAULT_SETTINGS.supervisorApproval, ...(cur.supervisorApproval ?? {}), ...(patch.supervisorApproval ?? {}) },
        supervisorAsk: { ...DEFAULT_SETTINGS.supervisorAsk, ...(cur.supervisorAsk ?? {}), ...(patch.supervisorAsk ?? {}) },
      }
      cfg.settings = merged
    })
  } catch {
    // 忽略持久化失败
  }
}

/** 当前正在播放的 say 子进程：新播报来了先打断旧的，避免多条语音叠加播放 */
let activeSay: ChildProcess | null = null

/** 用系统语音引擎播报文本（可被打断 + 超时兜底）。
 *  macOS 走 /usr/bin/say，Windows 走 PowerShell System.Speech SAPI（无外部依赖）。 */
function spawnSay(text: string, voice: string, timeoutMs: number): Promise<void> {
  const isWin = process.platform === 'win32'
  const file = isWin ? 'powershell.exe' : '/usr/bin/say'
  const args = isWin
    ? ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${String(text).replace(/'/g, "''")}')`]
    : voice ? ['-v', voice, text] : [text]
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'ignore' })
    activeSay = child
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 已退出 */
      }
      resolve()
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      if (activeSay === child) activeSay = null
      resolve()
    })
    child.on('exit', () => {
      clearTimeout(timer)
      if (activeSay === child) activeSay = null
      resolve()
    })
  })
}

/** 真实语音：TTS 走 macOS say（真实发声），STT 需系统麦克风权限（暂返回空） */
function createSystemVoiceService(): VoiceService {
  return {
    transcribe: async (audio) => {
      // Windows 暂未接入 STT（macOS Speech 识别不可用），直接返回空，不阻断流程
      if (process.platform === 'win32') return ''
      // 真实 STT：音频字节 → 临时文件 → afconvert 转 wav → macOS Speech 识别（失败返回空，不阻断）
      if (audio.byteLength === 0) return ''
      const base = `/tmp/shanhai-voice-${Date.now()}`
      const src = `${base}.webm`
      const wav = `${base}.wav`
      try {
        await fs.writeFile(src, Buffer.from(audio))
        // webm(opus) → wav；失败则用原始文件直接识别（SFSpeechRecognizer 也能读部分容器格式）
        try {
          await execAsync(`afconvert -f WAVE -d LEI16 "${src}" "${wav}"`, { timeout: 15000 })
        } catch {
          return await transcribeAudioFile(src)
        }
        return await transcribeAudioFile(wav)
      } catch {
        return ''
      } finally {
        await fs.rm(src, { force: true }).catch(() => undefined)
        await fs.rm(wav, { force: true }).catch(() => undefined)
      }
    },
    synthesize: async (text) => {
      // macOS：用绝对路径 execFile 调用 say（避免 shell 转义 / PATH 问题），
      // 优先选唯一中文女声 Tingting（婷婷），回退 Yue，再回退任意 zh_CN，找不到则用系统默认语音。
      // Windows：无 say，走 PowerShell System.Speech SAPI（spawnSay 内部分发），跳过语音列表查询。
      const isWin = process.platform === 'win32'
      let voice = ''
      if (!isWin) {
        try {
          const { stdout: list } = await execFileAsync('/usr/bin/say', ['-v', '?'], { timeout: 5000 })
          const lines = list.split('\n').map((l: string) => l.trim())
          const preferred = ['Tingting', 'Yue', 'Sin-ji'].find((c) =>
            lines.some((l) => l.includes('zh_CN') && (l.startsWith(`${c} `) || l.startsWith(`${c}\t`))),
          )
          if (preferred) {
            voice = preferred
          } else {
            const zh = lines.find((l) => l.includes('zh_CN'))
            voice = zh?.match(/^\S+/)?.[0] ?? ''
          }
        } catch {
          /* 查询语音列表失败则用系统默认语音 */
        }
      }
      try {
        // 新播报打断上一条未播完的语音（kill 旧 say 进程），避免多条语音叠加播放
        if (activeSay) {
          try {
            activeSay.kill('SIGTERM')
          } catch {
            /* 已退出 */
          }
          activeSay = null
        }
        // 设 30s 超时：避免语音引擎因音频设备异常卡住导致 speak 永不返回、特效不消失
        await spawnSay(text, voice, 30000)
      } catch (err) {
        // 明确记录失败原因（之前 .catch 静默吞掉，无法定位「没声音」）
        console.error('[voice] say 播报失败:', err instanceof Error ? err.message : String(err))
      }
      return new TextEncoder().encode(text).buffer as ArrayBuffer
    },
  }
}

/** macOS Speech 语音识别脚本：识别音频文件（wav/m4a/aiff）转文字。运行时写入临时文件用 swift 执行。 */
const STT_SWIFT = `
import Speech
import Foundation

guard CommandLine.arguments.count > 1 else { print(""); exit(0) }
let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) ?? SFSpeechRecognizer() else {
    print("")
    exit(0)
}

let request = SFSpeechURLRecognitionRequest(url: url)
request.shouldReportPartialResults = false

let semaphore = DispatchSemaphore(value: 0)
var text = ""

recognizer.recognitionTask(with: request) { result, error in
    if let result = result, result.isFinal {
        text = result.bestTranscription.formattedString
        semaphore.signal()
    } else if error != nil {
        semaphore.signal()
    }
}

_ = semaphore.wait(timeout: .now() + 30)
print(text)
`

/** 用 macOS Speech 识别音频文件转文字（失败返回空串，不阻断） */
async function transcribeAudioFile(path: string): Promise<string> {
  const scriptPath = `/tmp/shanhai-stt-${process.pid}.swift`
  try {
    await fs.writeFile(scriptPath, STT_SWIFT, 'utf8')
    const { stdout } = await execAsync(`swift "${scriptPath}" "${path}"`, { timeout: 35000 })
    return stdout.trim()
  } catch {
    return ''
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => undefined)
  }
}

/** 网关 ASR：PCM(Int16 16kHz) base64 → 文字。
 *  对齐 taco voice.recognize：POST {baseUrl}/audio/asr，模型 stepaudio-2.5-asr，
 *  body { audioData: pcmBase64, language: 'zh', model: 'stepaudio-2.5-asr' }，Accept: text/event-stream。 */
async function gatewayAsrTranscribe(pcmBase64: string, apiKey: string, baseUrl: string): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/audio/asr`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ audioData: pcmBase64, language: 'zh', model: 'stepaudio-2.5-asr' }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`)
    }
    const text = await res.text()
    // 优先 SSE：逐行 data: {type:"transcript.text.delta", delta:"..."} 累加 delta
    let result = ''
    let matched = false
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s || s === 'data: [DONE]') continue
      if (s.startsWith('data: ')) {
        try {
          const obj = JSON.parse(s.slice(6)) as { type?: string; delta?: string }
          if (obj.type === 'transcript.text.delta' && obj.delta) {
            result += obj.delta
            matched = true
          }
        } catch {
          // 忽略非 JSON 行
        }
      }
    }
    if (matched) return result.trim()
    // 非流式 JSON 兜底：{text} 或 {result}
    try {
      const obj = JSON.parse(text) as { text?: string; result?: string }
      if (typeof obj.text === 'string') return obj.text.trim()
      if (typeof obj.result === 'string') return obj.result.trim()
    } catch {
      // 忽略
    }
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** PCM(Int16 16kHz 单声道) base64 → 写临时 WAV 文件，返回路径（供 macOS Speech 降级识别，SFSpeechRecognizer 不认裸 PCM） */
async function pcmBase64ToWavFile(pcmBase64: string): Promise<string> {
  const pcm = Buffer.from(pcmBase64, 'base64')
  const path = `/tmp/shanhai-pcm-${Date.now()}.wav`
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt 块大小
  header.writeUInt16LE(1, 20) // PCM 编码
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(16000, 24) // 采样率
  header.writeUInt32LE(16000 * 2, 28) // 字节率
  header.writeUInt16LE(2, 32) // 块对齐
  header.writeUInt16LE(16, 34) // 位深
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  await fs.writeFile(path, Buffer.concat([header, pcm]))
  return path
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

export async function bootstrap(options: BootstrapOptions = {}): Promise<Runtime> {
  const kernel = new Kernel()

  // 初始化设备标识（远程连接多设备用）：读取/生成 deviceId + 设备名，早于任何 getDeviceInfo 调用
  await ensureDeviceInfo()

  // 网关凭证 + 模型列表（提前声明，供 image_analyze 工具闭包引用，登录部分赋值）
  let gatewayApiKey = ''
  let gatewayBaseUrl = ''
  /** 会员 JWT（登录后持久化到 config.json，启动时用于重新拉取最新模型列表） */
  let memberToken = ''
  let gatewayModels: GatewayModel[] = []
  /** 用户自定义模型（OpenAI 兼容端点 + 自有 Key，独立于系统内置模型） */
  let customModels: GatewayModel[] = []
  /** DeepSeek 网页版桥接模型来源（本地免费 LLM 网关，非工具/技能；服务启动成功后才非空） */
  let deepseekBridgeModel: GatewayModel | null = null
  let currentModelId = ''
  /** 全局默认模型 id（新会话 / 无 model/select 记录的会话回退用），随 switchModel 更新并持久化到 config.json */
  let defaultModelId = ''

  /** 全部模型 = 系统内置 + 用户自定义 + DeepSeek 网页版（自定义标记 custom: true，UI 分组展示） */
  const allModels = (): GatewayModel[] => [...gatewayModels, ...customModels, ...(deepseekBridgeModel ? [deepseekBridgeModel] : [])]

  // —— 会话（多会话，持久化到 ~/.shanhai/sessions/，每个会话独立工作目录）——
  interface SessionMeta {
    id: string
    title: string
    session: Session
    workDir: string
    /** 最近活跃时间戳（仅「发消息/执行任务」时刷新，切换会话不刷新），用于列表「活跃时间排序」 */
    lastActiveAt: number
    /** 是否为「会话管家」超级会话（固定 id，不显示在用户侧边栏、不可改名/删除） */
    isSupervisor: boolean
  }
  const sessionsDir = join(homedir(), '.shanhai', 'sessions')
  /** LLM 请求/响应原始记录目录（排查问题用，独立于会话 JSON，避免污染会话回放与体积膨胀） */
  const tracesDir = join(homedir(), '.shanhai', 'traces')
  const sessions = new Map<string, SessionMeta>()
  let currentSessionId: string | null = null

  /** 落盘的一条 HTTP 原始请求/响应记录（请求一条、响应一条，分开记录） */
  interface HttpTraceRecord extends HttpTrace {
    ts: number
    sessionId: string
    model: string
  }

  /** 会话的 HTTP trace 文件路径（每会话一个文件，会话隔离） */
  const httpTracePath = (sid: string): string => join(tracesDir, `${sid}.http.log`)

  /** 单条 trace 记录中字符串字段（含完整 messages / 原始响应 body）的最大字符数：超出截断，避免 JSON.stringify 超大对象阻塞事件循环（卡顿） */
  const HTTP_TRACE_MAX_BODY_CHARS = 200_000
  /** 单会话 trace 文件大小上限（字节）：超过删除重建（轮转），防止日志无限膨胀导致 appendFile 越来越慢 */
  const HTTP_TRACE_MAX_FILE_BYTES = 50 * 1024 * 1024

  /** 追加一条 HTTP 原始请求/响应记录到会话 trace 文件（格式参考 Taco logger：`[ISO时间] [TAG]\n{pretty JSON}\n`，失败静默，绝不阻断主流程） */
  async function appendHttpTrace(sid: string, model: string, trace: HttpTrace): Promise<void> {
    try {
      await fs.mkdir(tracesDir, { recursive: true })
      const record: HttpTraceRecord = { ts: Date.now(), sessionId: sid, model, ...trace }
      const iso = new Date(record.ts).toISOString()
      const tag = `HTTP-${trace.phase.toUpperCase()}`
      // replacer 截断超长字符串字段：完整 messages / 原始响应体积可能达数 MB，pretty-print 会同步阻塞主进程事件循环
      const body = JSON.stringify(record, (_k, v) => {
        if (typeof v === 'string' && v.length > HTTP_TRACE_MAX_BODY_CHARS) {
          return `${v.slice(0, HTTP_TRACE_MAX_BODY_CHARS)}…（已截断，原始 ${v.length} 字符）`
        }
        return v
      }, 2)
      const line = `[${iso}] [${tag}]\n${body}\n`
      const path = httpTracePath(sid)
      // 文件轮转：超过上限删除重建，防止日志无限增长拖慢后续追加写
      const stat = await fs.stat(path).catch(() => null)
      if (stat && stat.size > HTTP_TRACE_MAX_FILE_BYTES) {
        await fs.rm(path, { force: true })
      }
      await fs.appendFile(path, line, { mode: 0o600 })
    } catch {
      // 忽略 trace 写入失败
    }
  }

  /** 读取指定会话的 HTTP trace：按 `[ISO时间]` 行分隔每条记录（每条 = 一行 `[时间] [TAG]` + pretty JSON 块），损坏记录跳过；无文件返回空数组 */
  async function readHttpTrace(sid: string): Promise<HttpTraceRecord[]> {
    try {
      const raw = await fs.readFile(httpTracePath(sid), 'utf8')
      const out: HttpTraceRecord[] = []
      // 以 `[ISO时间]` 开头的行作为每条记录的分隔点
      const blocks = raw.split(/\n(?=\[\d{4}-\d{2}-\d{2}T)/)
      for (const block of blocks) {
        // 每条记录：第一行是 `[时间] [TAG]`，其后是 pretty JSON（从首个 `{` 行开始）
        const lines = block.split('\n')
        const jsonStart = lines.findIndex((l) => l.trimStart().startsWith('{'))
        if (jsonStart < 0) continue
        const jsonText = lines.slice(jsonStart).join('\n')
        try {
          out.push(JSON.parse(jsonText) as HttpTraceRecord)
        } catch {
          // 跳过损坏记录
        }
      }
      return out
    } catch {
      return []
    }
  }

  async function persistSession(meta: SessionMeta): Promise<void> {
    try {
      await fs.mkdir(sessionsDir, { recursive: true })
      // 只丢弃 assistant/delta（流式增量中间态，最终 assistant/message 已含完整内容，属去冗余而非丢数据）；
      // tool/result、附件 base64 等原始数据一律完整保留，不截断、不降级。
      const events = meta.session.list().filter((e) => e.type !== 'assistant/delta')
      const data = { id: meta.id, title: meta.title, workDir: meta.workDir, lastActiveAt: meta.lastActiveAt, events }
      // 原子写：先写临时文件再 rename 覆盖，避免应用崩溃/强杀时留下 0 字节或截断的会话文件（启动时 JSON.parse 失败被跳过 → 会话「凭空消失」）
      const path = join(sessionsDir, `${meta.id}.json`)
      const tmp = `${path}.tmp`
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
      await fs.rename(tmp, path)
    } catch {
      // 忽略持久化失败
    }
  }

  /** 读取会话的「失败重试挂起快照」（从后往前找最后一条 retry/snapshot；若其后已出现 turn/end 说明任务已完成，快照失效） */
  function readRetrySnapshot(meta: SessionMeta): SuspendedSnapshot | null {
    const events = meta.session.list()
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'turn/end') break
      if (e?.type === 'retry/snapshot') {
        const d = e.data as { messages: unknown[]; step: number; maxSteps: number; atLimit: boolean; reason?: string }
        return {
          messages: d.messages as ChatMessage[],
          step: d.step,
          maxSteps: d.maxSteps,
          atLimit: d.atLimit,
          reason: d.reason,
        }
      }
    }
    return null
  }

  /** 创建新会话（仅创建 + 持久化，不切换 currentSessionId、不写 lastActiveSessionId、不改全局模型），供管家 create_session 工具后台新建 */
  const createSessionInternal = (title?: string, workDir?: string): string => {
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const meta: SessionMeta = { id, title: title?.trim() || '新会话', session: new Session(), workDir: workDir ?? join(homedir(), 'shanhai', 'workspace'), lastActiveAt: Date.now(), isSupervisor: false }
    sessions.set(id, meta)
    void persistSession(meta)
    return id
  }

  const newSession = (title: string, workDir?: string): string => {
    const id = createSessionInternal(title, workDir)
    currentSessionId = id
    void persistLastActiveSessionId(id)
    return id
  }

  /**
   * 确保「会话管家」超级会话存在：固定 id=SUPERVISOR_ID，独立于用户会话。
   * 不抢占 currentSessionId、不写 lastActiveSessionId（管家不是「最近激活的用户会话」）。
   */
  const ensureSupervisorSession = (): void => {
    if (sessions.has(SUPERVISOR_ID)) return
    const meta: SessionMeta = {
      id: SUPERVISOR_ID,
      title: '会话管家',
      session: new Session(),
      workDir: join(homedir(), 'shanhai', 'workspace'),
      lastActiveAt: Date.now(),
      isSupervisor: true,
    }
    sessions.set(SUPERVISOR_ID, meta)
    void persistSession(meta)
  }

  /** 刷新会话活跃时间（仅「执行任务/发消息」时调用；切换会话不调用，保证列表不因点击而重排），并落盘 */
  const touchSession = (id: string): void => {
    const meta = sessions.get(id)
    if (meta) {
      meta.lastActiveAt = Date.now()
      void persistSession(meta)
    }
  }

  function currentWorkDir(): string {
    const meta = currentSessionId ? sessions.get(currentSessionId) : undefined
    return meta?.workDir ?? join(homedir(), 'shanhai', 'workspace')
  }

  // 启动时加载历史会话（聊天记录持久化：重启后历史消息不丢）
  try {
    await fs.mkdir(sessionsDir, { recursive: true })
    const files = await fs.readdir(sessionsDir)
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(join(sessionsDir, f), 'utf8')
        const data = JSON.parse(raw) as { id: string; title: string; workDir?: string; lastActiveAt?: number; events?: SessionEvent[] }
        const meta: SessionMeta = {
          id: data.id,
          title: data.title,
          session: new Session(),
          workDir: data.workDir ?? join(homedir(), 'shanhai', 'workspace'),
          lastActiveAt: typeof data.lastActiveAt === 'number' ? data.lastActiveAt : 0,
          // 管家超级会话按固定 id 识别（持久化文件不含 isSupervisor，id 即身份）
          isSupervisor: data.id === SUPERVISOR_ID,
        }
        if (Array.isArray(data.events)) meta.session.restore(data.events)
        sessions.set(meta.id, meta)
      } catch {
        // 跳过损坏的会话文件
      }
    }
  } catch {
    // 忽略
  }
  // 确保「会话管家」超级会话存在（固定 id，独立于用户会话，不抢占当前会话）
  ensureSupervisorSession()
  // 用户会话（非管家）列表：管家不参与「当前会话」的激活与排序
  const userSessions = [...sessions.values()].filter((s) => !s.isSupervisor)
  if (userSessions.length === 0) {
    newSession('新会话')
  } else {
    // 重启恢复：优先激活「上次关闭前激活的那个会话」（config.json 的 lastActiveSessionId）；
    // 若该会话已不存在（被删除）或是管家会话，回退到第一个用户会话。
    const lastActiveId = await readLastActiveSessionId()
    const lastMeta = lastActiveId ? sessions.get(lastActiveId) : undefined
    // else 分支保证 userSessions 非空（length===0 已在上方分支处理）
    const firstUser = userSessions[0]!
    currentSessionId = lastMeta && !lastMeta.isSupervisor ? lastActiveId : firstUser.id
  }

  // —— 运行中的循环（会话 id → loop）——
  // 提前声明（早于下方 wrapTool）：wrapTool 需据此判断「单步执行时 AgentLoop 已用 LLM callId 持久化工具事件，
  // 多专家编排时工具在专家独立 Session 里执行、主会话缺工具事件，需补持久化到主会话」。
  const runningLoops = new Map<string, AgentLoop>()
  const multiExpertLoops = new Map<string, Map<string, AgentLoop>>()
  // 会话当前任务的发起方（run 开始 set、结束 delete）：审批分流时据此判断「管家下发 or 用户下发」。
  // 用 Map 而非会话级静态标记，因为同一会话这一轮可能用户发、下一轮可能管家发。
  const sessionOrigin = new Map<string, 'user' | 'supervisor'>()

  // —— 工具过程 + 审批桥（审批按 requestId 独立 resolve，支持并行会话）——
  const toolTraceCallbacks = new Set<(trace: ToolTrace) => void>()
  const approvalCallbacks = new Set<(req: { id: string; sessionId?: string; toolName: string; args: Record<string, unknown>; riskLevel: string }) => void>()
  const pendingApprovals = new Map<string, { resolve: (outcome: ApprovalOutcome) => void; sessionId?: string }>()
  // 审批被「管家决策」resolve 后的回调（UI 据此关闭对应弹窗；用户手动/手机端走各自通道，不经过这里）
  const approvalResolvedCallbacks = new Set<(requestId: string) => void>()
  // 提问被「管家代答」resolve 后的回调（UI 据此关闭对应弹窗；用户手动/手机端走各自通道，不经过这里）
  const askResolvedCallbacks = new Set<(requestId: string) => void>()

  const approval = new ApprovalService(async (req) => {
    approvalCallbacks.forEach((cb) => cb({ id: req.id, sessionId: req.sessionId, toolName: req.toolName, args: req.args, riskLevel: req.riskLevel }))
    // 发起方判定：审批请求产生的会话即发起审批的会话，查其当前任务的发起方（管家下发 or 用户侧）
    const origin = req.sessionId ? (sessionOrigin.get(req.sessionId) ?? 'user') : 'user'
    console.log('[supervisor-wake] 审批请求产生：', req.id, req.toolName, 'sessionId=', req.sessionId, 'origin=', origin, '开关=', currentSettings.supervisorApproval.enabled)
    const promise = new Promise<ApprovalOutcome>((resolve) => {
      // 记录发起审批的会话 id：删除会话时按会话拒绝其待审批请求，避免 agent 永久卡在 await
      pendingApprovals.set(req.id, { resolve, sessionId: req.sessionId })
    })
    // 管家接管：仅当「管家下发 + 开关开启」时唤醒管家决策（非阻塞，弹窗仍显示、用户仍可手动点）；
    // 用户侧（含手机远程）始终只走弹窗手动审批，不唤醒管家。
    if (origin === 'supervisor' && currentSettings.supervisorApproval.enabled) {
      void wakeSupervisorForApproval(req)
    } else {
      console.log('[supervisor-wake] 审批请求不唤醒管家（origin!=supervisor 或开关关闭）')
    }
    return promise
  })

  // 审批策略（安全模式）改为「会话级」：每个会话独立的安全模式，通过 approval/policy 事件持久化到会话 JSON。
  // 这里不再维护全局 policy 变量；会话级 policy 由 ApprovalService 从会话事件日志回放（effectiveApprovalPolicy）。
  /** 读取指定会话（缺省当前会话）的审批策略：从事件日志回放，缺省 'ask' */
  const sessionApprovalPolicy = (sid?: string): ApprovalPolicy => {
    const meta = sessions.get(sid ?? currentSessionId ?? '')
    if (!meta) return 'ask'
    return effectiveApprovalPolicy(meta.session.list()) ?? 'ask'
  }

  // —— 能力实例（提前创建，供工具使用）——
  const computerUse = createPlatformComputerUseService()
  const browserUse: BrowserUseService = options.browserUse ?? createMockBrowserUseService()
  const terminalUse: TerminalService = options.terminalUse ?? createMockTerminalService()
  // 用户手动终端的会话归属映射（terminalId → sessionId）：订阅终端输出时据此路由到对应会话
  const userTerminalSessionMap = new Map<string, string>()
  const userTerminalOutputCallbacks = new Set<(sessionId: string, terminalId: string, data: string) => void>()
  // 订阅终端实时输出（含 ANSI）：只转发「用户手动终端」的输出（agent 终端走 run 的哨兵机制，不经此转发）
  terminalUse.onData((terminalId, data) => {
    const sid = userTerminalSessionMap.get(terminalId)
    if (!sid) return
    for (const cb of userTerminalOutputCallbacks) {
      try {
        cb(sid, terminalId, data)
      } catch {
        // 订阅回调异常不阻断终端输出
      }
    }
  })
  const voice = createSystemVoiceService()
  const memory = new MemoryStore()
  // 通用设置（跨会话、重启保留）：启动时从 config.json 恢复，setSettings 时落盘并同步到相关能力
  let currentSettings: AppSettings = {
    browser: { showOnCreate: DEFAULT_SETTINGS.browser.showOnCreate, enableWebBridge: DEFAULT_SETTINGS.browser.enableWebBridge },
    messageSubmit: { mode: DEFAULT_SETTINGS.messageSubmit.mode },
    debug: { traceLlm: DEFAULT_SETTINGS.debug.traceLlm },
    voice: { enabled: DEFAULT_SETTINGS.voice.enabled },
    supervisorApproval: { enabled: DEFAULT_SETTINGS.supervisorApproval.enabled },
    supervisorAsk: { enabled: DEFAULT_SETTINGS.supervisorAsk.enabled },
  }
  // 立即恢复为 config.json 持久化的值（含 debug.traceLlm）：必须在 onHttpTrace 等回调定义之前恢复，
  // 否则回调被模型调用触发时读到的仍是默认 false（traceLlm 开关不生效、日志不落盘）
  currentSettings = await readSettings()
  browserUse.setShowOnCreate?.(currentSettings.browser.showOnCreate)

  // 每会话默认创建一个浏览器窗口：会话建立/切换时预创建（appId = 会话 id），
  // 起始页用 chat.deepseek.com。该窗口走共享 partition（登录一次所有会话通用），
  // 既是「DeepSeek 网页版」对话窗口，也供 agent 后续 browser 操作复用。
  // 后端 stateOf 幂等（已存在则复用，不重复建窗口）。
  // 受「网页版桥接」开关控制：关闭后不再预创建默认窗口（agent 用到 browser 工具时才懒创建）。
  const ensureDefaultBrowserWindow = (sid: string): void => {
    if (!sid) return
    if (!currentSettings.browser.enableWebBridge) return
    // 预创建窗口不显示（后台预加载，避免每次切换会话都弹出一个浏览器窗口干扰用户）；agent 真正操作时才 show
    browserUse.setShowOnCreate?.(false)
    void browserUse
      .create(sid, 'https://chat.deepseek.com')
      .catch(() => {
        // 预创建失败忽略：首次 browser 操作仍会懒创建窗口兜底
      })
      .finally(() => {
        browserUse.setShowOnCreate?.(true)
      })
  }
  // 启动时为当前会话预创建默认窗口（当前会话已在恢复历史会话后确定）
  ensureDefaultBrowserWindow(currentSessionId ?? '')

  // —— DeepSeek 网页版桥接（CDP 直连，非工具/技能）：模型来源注册 + 复用当前会话默认窗口 ——
  // 用「DeepSeek 网页版」模型时，applyModel 按 source='deepseek-bridge' 用 createDeepSeekModel 创建 provider，
  // chat 回调复用「当前会话默认窗口」（appId = 会话 id，共享 partition，登录一次所有会话通用）
  // + 注入桥接脚本 + CDP 直连页面 window.__dsChat（不再有本地 HTTP 服务）。
  // 受「网页版桥接」开关控制：关闭后不注册该模型（模型下拉框不出现「DeepSeek 网页版」）。
  const registerDeepSeekBridgeModel = (): void => {
    if (deepseekBridgeModel) return
    deepseekBridgeModel = {
      id: 'deepseek-web',
      name: 'DeepSeek 网页版',
      displayName: 'DeepSeek 网页版',
      model: 'deepseek-chat',
      tier: 'flagship',
      apiKey: '',
      baseUrl: '',
      protocol: 'openai',
      provider: 'deepseek-bridge',
      source: 'deepseek-bridge',
      custom: false,
    }
  }
  if (currentSettings.browser.enableWebBridge) registerDeepSeekBridgeModel()

  /** 确保「当前会话默认窗口」存在、位于 chat.deepseek.com 且已注入桥接脚本（脚本失效则重注入） */
  const ensureDeepSeekBridgeWindow = async (): Promise<void> => {
    const sid = sessionContext.getStore() ?? currentSessionId ?? ''
    if (!sid) throw new Error('当前无活动会话')
    const wins = await browserUse.list()
    const win = wins.find((w) => w.appId === sid)
    if (!win) {
      // 窗口不存在 → 创建并打开 DeepSeek 网页版（会话级默认窗口走共享 partition，登录一次全通用）
      await browserUse.navigate('https://chat.deepseek.com', sid)
    } else if (!/chat\.deepseek\.com/.test(win.url || '')) {
      // 窗口存在但不在 DeepSeek 页面 → 导航过去（避免在别的页面里找不到输入框）
      await browserUse.navigate('https://chat.deepseek.com', sid)
    }
    // 注入桥接脚本（幂等：已注入则跳过）
    const ready = await browserUse.evaluate(BRIDGE_READY_CHECK, sid).catch(() => false)
    if (!ready) {
      await browserUse.evaluate(buildBridgeScript(), sid)
    }
  }

  /** 与 DeepSeek 网页版对话：复用当前会话默认窗口（共享登录态）+ 注入脚本 + CDP 直连页面 window.__dsChat */
  const deepSeekChat = async (prompt: string, opts: { mode: string; thinking: boolean }): Promise<string> => {
    await ensureDeepSeekBridgeWindow()
    const sid = sessionContext.getStore() ?? currentSessionId ?? ''
    if (!browserUse.chatWithPageBridge) throw new Error('当前后端不支持页面桥接（chatWithPageBridge 未实现）')
    try {
      return await browserUse.chatWithPageBridge(prompt, { mode: opts.mode, thinking: opts.thinking }, sid)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 未登录 / 页面未加载完成时页面里没有输入框，给可操作的引导，而非生硬的内部报错
      if (/no textarea|no send button/i.test(msg)) {
        throw new Error('DeepSeek 网页版尚未就绪：请在本会话弹出的浏览器窗口里登录 chat.deepseek.com 后再试（登录态跨会话通用，只需登录一次）')
      }
      throw err
    }
  }

  // 向用户提问服务（ask_user 工具阻塞等待用户回答；UI 订阅 onRequest 弹卡片，respond 提交答案）
  const askService = new AskService()

  // 长期记忆持久化：启动时从 ~/.shanhai/memory.json 恢复（跨会话不丢），remember 后落盘
  const memoryFile = join(homedir(), '.shanhai', 'memory.json')
  try {
    const raw = await fs.readFile(memoryFile, 'utf8')
    const entries = JSON.parse(raw) as Array<{ scope: never; key: string; value: unknown; source?: never; confidence?: number }>
    for (const e of entries) {
      if (e && typeof e.key === 'string') memory.save(e.scope, e.key, e.value, { source: e.source, confidence: e.confidence })
    }
  } catch {
    // 无记忆文件或损坏，忽略
  }
  const persistMemory = async (): Promise<void> => {
    try {
      await fs.writeFile(memoryFile, JSON.stringify(memory.list(), null, 2), { mode: 0o600 })
    } catch {
      // 忽略持久化失败
    }
  }

  // —— computer-use / browser-use 能力缝（实例提前创建；工具不再直接暴露，改为在下方注册为可执行技能）——

  // —— 图片识别：用视觉模型分析图片（当前模型不支持多模态时降级用）——
  // 图片描述缓存：同一张图（按 url 去重）在会话内只识别一次，避免多轮上下文重复调用视觉模型
  const imageDescCache = new Map<string, string>()
  const analyzeImageWithVision = async (imageUrl: string): Promise<string> => {
    const cached = imageDescCache.get(imageUrl)
    if (cached) return cached
    let visionModels = gatewayModels.filter((m) => modelSupportsVision(m))
    // 启动时只缓存了当前模型，这里兜底拉取完整模型列表（含视觉模型）
    if (visionModels.length === 0 && gatewayApiKey && gatewayBaseUrl) {
      const list = await fetchGatewayModels(gatewayApiKey, gatewayBaseUrl)
      if (list.length > 0) {
        gatewayModels = list
        visionModels = list.filter((m) => modelSupportsVision(m))
      }
    }
    if (visionModels.length === 0 || !gatewayApiKey || !gatewayBaseUrl) return '（无可用视觉模型）'
    // 遍历视觉模型逐个尝试识别（部分模型 502/额度不足，降级到下一个，直到成功）
    const errors: string[] = []
    for (const vm of visionModels) {
      try {
        const provider = createModelProvider({ apiKey: gatewayApiKey, baseUrl: gatewayBaseUrl, model: vm.id, onUsage, onTrace: onHttpTrace })
        const res = await provider.complete([
          {
            role: 'user',
            content: [
              { type: 'text', text: '请详细描述这张图片的内容，包括主体、文字、场景等。' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ])
        if (res.text && res.text.trim()) {
          imageDescCache.set(imageUrl, res.text)
          return res.text
        }
        errors.push(`${vm.id}: 空结果`)
      } catch (err) {
        errors.push(`${vm.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return `（图片识别失败：${errors.join('；')}）`
  }

  // —— 工具（包装：落 trace，sessionId 从 AsyncLocalStorage 上下文取）——
  // 当前会话工作目录：让所有文件/命令工具围绕「会话工作目录」执行
  const getSessionCwd = (): string => {
    const sid = sessionContext.getStore() ?? currentSessionId ?? ''
    return sessions.get(sid)?.workDir ?? join(homedir(), 'shanhai', 'workspace')
  }
  /** 运行时环境快照：系统提示词里注入的「环境信息」全部来自这里，随每次请求自动采集（不写死） */
  interface RuntimeEnvironment {
    osName: string
    platform: string
    arch: string
    time: string
    shell: string
    home: string
    cwd: string
    lang: string
  }

  /**
   * 自动采集当前运行环境快照（时间 / 操作系统 / Shell / 主目录 / 工作目录 / 语言）。
   * 每次构建系统提示词时实时调用，保证环境信息始终是「初始化时自动注入」而非硬编码。
   */
  const collectEnvironment = (cwd: string): RuntimeEnvironment => {
    const osNames: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
    return {
      osName: osNames[process.platform] ?? process.platform,
      platform: process.platform,
      arch: process.arch,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      shell: process.env.SHELL ?? process.env.ComSpec ?? 'unknown',
      home: homedir(),
      cwd,
      lang: 'zh-CN',
    }
  }

  /**
   * 系统提示词：告诉模型「当前环境」（时间 / 工作目录 / Shell / 系统类型 / 语言）+ 工具调用约束。
   * 环境信息由 collectEnvironment 自动注入，文件/命令操作都锚定到当前工作目录。
   */
  /** 内置可执行技能目录文本（启动时预热生成；第三方技能不注入，AI 按需 skill_list 查） */
  let builtinSkillCatalog = ''
  const buildSystemPrompt = (cwd: string, memoryContext?: string): string => {
    const env = collectEnvironment(cwd)
    return [
      '你是「山海」，一个运行在用户电脑上的桌面端 AI 智能体助手。你可以读取文件、编写代码、执行命令、列出目录来帮助用户完成任务。',
      '',
      '【当前环境】',
      `- 操作系统：${env.osName}（${env.platform}/${env.arch}）`,
      `- 当前时间：${env.time}`,
      `- Shell：${env.shell}`,
      `- 用户主目录：${env.home}`,
      `- 当前工作目录：${env.cwd}`,
      `- 语言：${env.lang}（优先用中文回复）`,
      '',
      '【工具使用规则】',
      '1. 所有文件操作（read_file / write_file / edit_file / list_dir）和命令执行（run_command）都必须围绕「当前工作目录」进行。',
      '2. 文件路径既可以是绝对路径，也可以是相对于当前工作目录的相对路径；优先使用相对路径，把操作范围限制在工作目录内。',
      '3. 需要了解项目结构时，用 list_dir 以树形列出目录。',
      `4. 执行命令时注意当前是 ${env.osName} 系统，使用对应的命令语法（如 macOS/Linux 用 ls、cat，Windows 用 dir、type）。`,
      '5. 执行有风险的操作（写文件、运行命令）前会请求用户确认，请把要做的改动讲清楚再调用工具。',
      '6. 内置可执行技能（见下方【内置能力】）用 skill_read 读手册、skill_run 执行脚本；不在内置清单里的第三方技能，在需要时用 skill_list 查询。',
      '7. 需要用户协助做选择、确认或补充信息时，用 ask_user 工具向用户提问：可提供 options 让用户单选/多选，或让用户自由输入；调用后必须等待用户回答，再基于回答继续执行。',
      '8. 输出「目录树 / 文件树 / 框线图 / 表格 / 缩进层级」等需要等宽对齐的结构化内容时，必须用 Markdown 代码块（``` 包裹）输出，不要作为普通段落输出，否则换行会被折叠、对齐错乱甚至溢出。',
      '',
      '【合规与安全（必须严格遵守）】',
      '1. 你生成的所有内容必须符合中华人民共和国法律法规，践行社会主义核心价值观。',
      '2. 严禁输出任何违背国家法律法规、危害国家安全、泄露国家秘密、破坏国家统一和领土完整的内容。',
      '3. 严禁输出煽动民族仇恨、破坏民族团结、宣扬分裂主义或极端主义的内容。',
      '4. 严禁传播色情、暴力、恐怖、赌博、毒品等违法有害信息，严禁生成或协助获取任何违法违规工具、方法。',
      '5. 涉及政治敏感、历史争议、领土主权等话题时，严格遵循国家官方口径，不发表不当言论、不传播不实信息。',
      '6. 用户若提出违法违规要求，必须明确拒绝并说明理由，不得以任何方式直接或变相满足。',
      '',
      '【自我升级能力】',
      '你可以改造和扩展自己，不必每次都只靠读写文件。先用 plugin_inspect 查看当前可挂载的 UI 插槽、可用工具、已注册服务与已安装插件；再用 plugin_define 定义新插件（host 半 code 是进程内源码、client 半 client 是界面 UI 源码），plugin_run 临时运行、plugin_stop / plugin_undefine 撤回。',
      '要「沉淀一个可长期使用的新能力」走完整闭环：plugin_define 定义 → plugin_test 自测（临时运行并撤回，验证无误）→ plugin_install 安装进内核（落盘 ~/.shanhai/plugins/，跨会话/跨重启留存，之后 AI 和用户都能持续使用）→ plugin_uninstall 卸载。已安装插件重启后自动加载，无需重复安装。',
      'UI 插槽分两类：覆盖型（shell.sidebar / shell.header / shell.chat / shell.composer / shell.statusbar / shell.welcome / shell.panels / shell.overlays / dynamic-extension，后注册整体替换该区块）；追加型（composer.below 输入框下方 / composer.actions 输入框工具栏 / header.actions 顶栏右侧 / chat.below 消息流下方，追加显示互不覆盖）。想「加一个按钮/小组件」时优先用追加型插槽，client 代码必须用 React.createElement 写（不能写 JSX）。',
      '当用户要求「新增一个能力」「改造界面某个区块」「给自己加个工具」「在某处加个按钮」时，优先用这套 plugin_* 工具自我实现，而不是只写死代码或空谈。',
      '多专家方面：用 role_list 查看可用专家，用 role_define 新增/更新自定义专家（id 用短英文、name 中文名、description 一句话职责、systemPrompt 专属人设），让复杂任务能被拆解并指派给更合适的专家。',
      ...(builtinSkillCatalog ? ['', '【内置能力】', builtinSkillCatalog] : []),
      memoryContext,
    ]
      .filter(Boolean)
      .join('\n')
  }

  /** 构建长期记忆上下文：配置型全量注入 + 经验型按当前消息关键词召回（注入系统提示词） */
  const buildMemoryContext = (message: string): string | undefined => {
    const config = memory.list().filter((e) => e.scope !== 'task_experience' && e.scope !== 'session')
    const experience = memory.recall('task_experience', message).slice(0, 5)
    const all = [...config, ...experience]
    if (all.length === 0) return undefined
    const lines = all.map((e) => `- [${e.scope}] ${e.key}: ${typeof e.value === 'string' ? e.value : JSON.stringify(e.value)}`)
    return `\n\n【长期记忆】\n${lines.join('\n')}`
  }
  // —— 写文件快照回滚（K4 安全：写前快照，可回滚恢复原文件）——
  const snapshotDir = join(homedir(), '.shanhai', 'snapshots')
  const snapshotStore = new FileSnapshotStore(snapshotDir)
  // 启动时清理历史快照（上次会话的快照随会话结束已无意义，避免目录无限积累）
  try {
    await fs.rm(snapshotDir, { recursive: true, force: true })
  } catch {
    // 忽略清理失败
  }
  /** 把相对路径解析到会话工作目录（rollback_file 工具用） */
  const resolveWorkPath = (p: string): string => (isAbsolute(p) ? p : join(getSessionCwd(), p))
  /** 写前快照回调：文件存在时备份，返回快照 id（write_file 覆盖前自动调用） */
  const snapshotFn = async (path: string): Promise<{ snapshotId: string } | undefined> => {
    try {
      return { snapshotId: await snapshotStore.snapshot(path) }
    } catch {
      return undefined
    }
  }
  // —— 专家角色注册表（多专家编排用）：内置 4 个 + 用户/智能体自定义 ——
  // 在此提前初始化（tools 组装之前），使 role_list / role_define 工具与 triage 共用同一份可变角色数据。
  const BUILTIN_ROLES: RoleDefinition[] = [
    { id: 'general', name: '通用助手', description: '日常问答、对话、信息整理', systemPrompt: '', toolSet: [], skillSet: [] },
    { id: 'code', name: '代码专家', description: '读写代码、执行命令、排查 bug', systemPrompt: '你是「代码专家」，专注于读写代码、执行 shell 命令、排查 bug，输出严谨并给出行号与根因。', toolSet: [], skillSet: [] },
    { id: 'writer', name: '写作专家', description: '撰写文档、文案润色', systemPrompt: '你是「写作专家」，专注于撰写文档、润色文字、结构化表达。', toolSet: [], skillSet: [] },
    { id: 'analyst', name: '分析专家', description: '数据分析、信息提取与总结', systemPrompt: '你是「分析专家」，专注于数据分析、信息提取与总结，结论条理清晰。', toolSet: [], skillSet: [] },
  ]
  const roleRegistry = new Map<string, RoleDefinition>()
  for (const r of BUILTIN_ROLES) roleRegistry.set(r.id, r)
  // 恢复用户自定义专家（config.json，重启不丢；仅补充不存在于内置的 id，内置同名 id 优先）
  for (const r of await readCustomRoles()) {
    if (!roleRegistry.has(r.id)) roleRegistry.set(r.id, r)
  }

  // —— 工具包装：落 trace + sessionId 注入。动态注册的自修改工具也走同一包装，保证 trace 一致 ——
  const tools: ToolContract[] = []
  // 管家会话专用工具集（占位声明，稍后在管家工具装配处赋值；plugin_inspect 报告工具清单需按会话区分引用它）
  let supervisorLoopTools: ToolContract[] = []
  const wrapTool = (t: ToolContract): ToolContract => ({
    ...t,
    execute: async (args) => {
      const sid = sessionContext.getStore() ?? currentSessionId ?? ''
      const callId = `${t.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const startTs = Date.now()
      // 本次工具调用对应的「思考」：agent 层用 toolReasoningContext.run 注入，这里读出并落到 trace
      const reasoning = toolReasoningContext.getStore()
      // 可执行技能（skill_run）：browser-use 的窗口 appId 注入会话前缀（会话级隔离窗口）。
      // agent 传短名时拼接为「会话id:短名」；若 appId 已是完整标识（等于会话 id 或含会话前缀，如 create 的返回值），
      // 直接复用，避免二次拼接导致窗口错位；否则按短名拼接会话前缀（默认短名 default）。
      let effectiveArgs = args
      if (t.name === 'skill_run' && args.skillId === 'browser-use') {
        const params = args.params && typeof args.params === 'object' ? (args.params as Record<string, unknown>) : {}
        const raw = typeof params.appId === 'string' ? params.appId : ''
        const appId = raw && (raw === sid || raw.startsWith(`${sid}:`)) ? raw : `${sid}:${raw || 'default'}`
        effectiveArgs = { ...args, params: { ...params, appId } }
      }
      // 可执行技能（skill_run）：terminal 的 terminalId 注入会话前缀（会话级隔离终端，同 browser appId 逻辑）。
      if (t.name === 'skill_run' && args.skillId === 'terminal') {
        const params = args.params && typeof args.params === 'object' ? (args.params as Record<string, unknown>) : {}
        const raw = typeof params.terminalId === 'string' ? params.terminalId : ''
        const terminalId = raw && (raw === sid || raw.startsWith(`${sid}:`)) ? raw : `${sid}:${raw || 'default'}`
        effectiveArgs = { ...args, params: { ...params, terminalId } }
      }
      toolTraceCallbacks.forEach((cb) =>
        cb({ kind: 'tool-call', sessionId: sid, callId, name: t.name, args, approvalRequired: t.approvalRequired, approved: false, reasoning, startTs }),
      )
      // 多专家编排下，工具在专家独立 Session 里执行（AgentLoop 只 append 到 expertSession，多专家结束后不持久化），
      // 主会话 session 缺工具事件，任务结束后 UI 用 getSessionHistory 重建消息流时会丢失工具步骤。
      // 因此：非单步执行（runningLoops 未挂载该会话，即多专家等场景）时，把工具事件补 append 到主会话，保证工具步骤可重建。
      // 单步执行时 AgentLoop 已用「LLM 返回的 callId」append 到主会话，这里不重复 append（wrapTool 自造 callId 仅用于实时 trace）。
      const persistMeta = runningLoops.has(sid) ? undefined : sessions.get(sid)
      if (persistMeta && !persistMeta.isSupervisor) {
        persistMeta.session.append('tool/call', { callId, name: t.name, args, reasoningContent: reasoning })
      }
      try {
        const result = await t.execute(effectiveArgs)
        // 结果 trace 带上 args：前端按工具类型渲染摘要（路径/命令）时需要它；durationMs 供前端显示该步耗时
        toolTraceCallbacks.forEach((cb) => cb({ kind: 'tool-result', sessionId: sid, callId, name: t.name, args, result, durationMs: Date.now() - startTs }))
        if (persistMeta && !persistMeta.isSupervisor) persistMeta.session.append('tool/result', { callId, name: t.name, result })
        return result
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        toolTraceCallbacks.forEach((cb) => cb({ kind: 'tool-result', sessionId: sid, callId, name: t.name, args, error, durationMs: Date.now() - startTs }))
        if (persistMeta && !persistMeta.isSupervisor) persistMeta.session.append('tool/result', { callId, name: t.name, error })
        throw err
      }
    },
  })

  // —— K5 自修改（plugin_* 工具 + vm 沙箱 + browser 半投递 + round-trip 审批）——
  const clientRunCallbacks = new Set<(req: { requestId: string; sessionId: string; pkgId: string; name: string; purpose: string }) => void>()
  const pendingClientRuns = new Map<string, { resolve: (approved: boolean) => void; sessionId?: string }>()
  const clientCodeCallbacks = new Set<(payload: { pkgId: string; name: string; code: string }) => void>()
  const clientRemoveCallbacks = new Set<(pkgId: string) => void>()

  // 已安装插件持久化仓库（AI 自研应用落盘到 ~/.shanhai/plugins/，跨会话/跨重启留存）
  const pluginStore = new PluginStore(join(homedir(), '.shanhai', 'plugins'))
  const selfmod = new SelfModifyRuntime({
    listServices: () => ['session', 'approval', 'agent', 'memory', 'voice', 'computerUse', 'browserUse', 'model', 'credentials'],
    listTools: (sessionId) => (sessionId === SUPERVISOR_ID ? supervisorLoopTools : tools).map((t) => t.name),
    listSlots: () => [...CORE_SLOTS],
    registerTool: (rawTool) => {
      const wrapped = wrapTool(rawTool)
      tools.push(wrapped)
      return () => {
        const idx = tools.indexOf(wrapped)
        if (idx >= 0) tools.splice(idx, 1)
      }
    },
    onEvent: (name, listener) => kernel.ctx.on(name, listener),
    requestClientRun: (pkg: DynamicPackage, sessionId: string) =>
      new Promise<boolean>((resolve) => {
        const requestId = `client-run-${Date.now()}-${Math.random().toString(36).slice(2)}`
        pendingClientRuns.set(requestId, { resolve, sessionId })
        clientRunCallbacks.forEach((cb) => cb({ requestId, sessionId, pkgId: pkg.id, name: pkg.name, purpose: pkg.purpose }))
      }),
    deliverClient: async (pkg: DynamicPackage) => {
      clientCodeCallbacks.forEach((cb) => cb({ pkgId: pkg.id, name: pkg.name, code: pkg.client ?? '' }))
    },
    removeClient: async (pkgId: string) => {
      clientRemoveCallbacks.forEach((cb) => cb(pkgId))
    },
  }, pluginStore)

  // —— 通用工具（视觉分析 / 快照回滚 / 长期记忆）+ 提问插件（ask_user）——
  // 能力在 runtime 装配，工具定义集中在 @shanhai/tools 的 createUtilityTools 与 @shanhai/ask 的 createAskTools（不散落在 bootstrap）。
  const utilityTools: ToolContract[] = createUtilityTools({
    analyzeImage: analyzeImageWithVision,
    rollbackFile: async (path, snapshotId) => {
      const resolved = resolveWorkPath(path)
      await snapshotStore.rollback(resolved, snapshotId)
      await snapshotStore.discard(resolved, snapshotId)
      return { ok: true, path: resolved, rolledBack: true }
    },
    memory: {
      save: (scope, key, value) => {
        const entry = memory.save(scope as never, key, value)
        void persistMemory()
        return entry
      },
      recall: (scope, keyword) => memory.recall(scope as never, keyword),
      list: () => memory.list(),
    },
  })
  const askTools: ToolContract[] = createAskTools(askService, () => sessionContext.getStore() ?? currentSessionId ?? '')

  // —— 复合技能插件（skill_list / skill_read / skill_run）+ MCP 客户端插件（mcp_list_tools / mcp_call）——
  // 技能与 MCP 都是山海自有能力插件：技能从 ~/.shanhai/skills/<id>/SKILL.md 加载，MCP 配置读 ~/.shanhai/mcp.json。
  // browser-use / computer-use / terminal 作为「可执行技能」注册（不直接暴露为顶层工具），AI 先 skill_read 读手册再 skill_run 执行，均不复用 Taco 的 ~/.taco 资源。
  const skillService = new SkillService()
  // 截图上传云存储：走网关后台 API（复用会员 memberToken），返回 https 公网链接；未登录/失败返回 null（截图工具回退 base64）
  const uploadImage = async (imageBase64: string, mimeType?: string): Promise<string | null> => {
    if (!memberToken) return null
    return uploadImageToCloud({ imageBase64, token: memberToken, mimeType })
  }
  skillService.registerExecutable(createComputerUseSkill(computerUse, uploadImage))
  skillService.registerExecutable(createBrowserUseSkill(browserUse, uploadImage))
  skillService.registerExecutable(createTerminalSkill(terminalUse))
  const skillTools: ToolContract[] = createSkillTools(skillService)
  // 预热技能缓存 + 生成「内置可执行技能目录」注入系统提示词（第三方技能不注入，AI 按需 skill_list 查）
  builtinSkillCatalog = await skillService.builtinExecutableCatalog()
  const mcpService = new McpService()
  const mcpTools: ToolContract[] = createMcpTools(mcpService)

  // —— 专家角色工具（role_list / role_define）：让智能体在会话中查看 / 新增自定义专家 ——
  const roleTools: ToolContract[] = [
    {
      name: 'role_list',
      description:
        '查看当前系统可用的所有专家角色（内置 + 自定义），含 id/名称/职责。多专家编排会把复杂任务拆解并指派给这些专家，用此工具了解可指派哪些专家。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      riskLevel: 'readonly',
      execute: async () => [...roleRegistry.values()].map((r) => ({ id: r.id, name: r.name, description: r.description })),
    },
    {
      name: 'role_define',
      description:
        '新增或更新一个自定义专家角色，供多专家编排指派（复杂任务拆解后路由到最合适的专家）。' +
        'id 用短英文标识（如 security、frontend、data）；name 中文名；description 一句话职责；systemPrompt 是该专家执行时的专属人设。' +
        '内置专家（general/code/writer/analyst）不可覆盖。定义后立即生效，后续复杂任务即可被拆解指派到该专家。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '专家唯一 id（短英文，如 security）' },
          name: { type: 'string', description: '专家中文名' },
          description: { type: 'string', description: '一句话职责说明' },
          systemPrompt: { type: 'string', description: '专家专属人设（可选，注入该专家执行时的 systemPrompt）' },
        },
        required: ['id', 'name', 'description'],
      },
      riskLevel: 'reversible',
      execute: async (args) => {
        const id = String(args.id ?? '').trim()
        const name = String(args.name ?? '').trim()
        if (!id) throw new Error('role_define 缺少 id')
        if (!name) throw new Error('role_define 缺少 name')
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('专家 id 只能包含字母、数字、下划线、连字符')
        if (BUILTIN_ROLES.some((b) => b.id === id)) throw new Error(`内置专家 "${id}" 不可覆盖，请换一个 id`)
        const def: RoleDefinition = {
          id,
          name,
          description: String(args.description ?? '').trim(),
          systemPrompt: String(args.systemPrompt ?? '').trim(),
          toolSet: [],
          skillSet: [],
        }
        roleRegistry.set(id, def)
        await persistCustomRoles([...roleRegistry.values()].filter((r) => !BUILTIN_ROLES.some((b) => b.id === r.id)))
        return { id: def.id, name: def.name, description: def.description, defined: true }
      },
    },
  ]

  const baseTools = [
    ...createAtomicTools(getSessionCwd, snapshotFn),
    ...utilityTools,
    ...askTools,
    ...skillTools,
    ...mcpTools,
    ...roleTools,
    ...selfmod.createTools(() => sessionContext.getStore() ?? currentSessionId ?? ''),
  ]
  tools.push(...baseTools.map(wrapTool))

  // 注意：已安装插件由主进程在窗口就绪后调用 restoreInstalledPlugins() 恢复
  // （host 半工具/服务 + browser 半 UI 投递都需在渲染进程 ready 后执行，故不在此处 await）。

  // —— token 统计（累计 / 本轮 / 上下文占比，UI 底部状态栏展示；会话级隔离：每个会话独立累计，互不串扰）——
  interface TokenAccumulator {
    totalPrompt: number
    totalCompletion: number
    total: number
    turnPrompt: number
    turnCompletion: number
    turn: number
    contextLength: number
    lastPrompt: number
    /** 最近一次请求命中的缓存 token（用于「最近一次缓存命中率」，避免被 ReAct 首轮冷启动稀释） */
    lastCachedPromptTokens: number
    turnCachedPromptTokens: number
    totalCachedPromptTokens: number
  }
  const tokenStats = new Map<string, TokenAccumulator>()
  const tokenCallbacks = new Set<(sessionId: string, stats: TokenSnapshot) => void>()

  /** 获取（或初始化）指定会话的 token 累计器；累计值（总入/总出/总 token/累计缓存命中）从会话事件日志里的 usage/record 恢复，重启后不归零 */
  const sessionStats = (sid: string): TokenAccumulator => {
    let s = tokenStats.get(sid)
    if (!s) {
      s = { totalPrompt: 0, totalCompletion: 0, total: 0, turnPrompt: 0, turnCompletion: 0, turn: 0, contextLength: 0, lastPrompt: 0, lastCachedPromptTokens: 0, turnCachedPromptTokens: 0, totalCachedPromptTokens: 0 }
      // 持久化恢复：usage/record 已随事件日志落盘，遍历累加恢复——
      // 1) 累计值（总入/总出/总 token/累计缓存命中）：累加全部 usage/record；
      // 2) 最近一次（lastPrompt/lastCachedPromptTokens）：取最后一条 usage/record，恢复缓存命中率与上下文占比；
      // 3) 本轮（turnPrompt/turnCompletion/turn/turnCachedPromptTokens）：取最后一个 turn/start 之后的 usage/record 累加，恢复本轮输入输出。
      // 这样「缓存命中 / 本轮输入输出 / 上下文占比」重启后都显示最后一次的状态，不再归零。
      const meta = sessions.get(sid)
      if (meta) {
        const events = meta.session.list()
        // 最后一个 turn/start 的下标作为「本轮」起点（之前轮次的 usage 不计入本轮）
        let turnStartIdx = -1
        for (let i = 0; i < events.length; i++) {
          if (events[i]?.type === 'turn/start') turnStartIdx = i
        }
        let lastUsage: { promptTokens?: number; cachedPromptTokens?: number } | null = null
        let turnPrompt = 0
        let turnCompletion = 0
        let turn = 0
        let turnCached = 0
        for (let i = 0; i < events.length; i++) {
          const e = events[i]
          if (e?.type !== 'usage/record') continue
          const d = e.data as { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedPromptTokens?: number }
          s.totalPrompt += d.promptTokens ?? 0
          s.totalCompletion += d.completionTokens ?? 0
          s.total += d.totalTokens ?? 0
          s.totalCachedPromptTokens += d.cachedPromptTokens ?? 0
          lastUsage = d
          if (i > turnStartIdx) {
            turnPrompt += d.promptTokens ?? 0
            turnCompletion += d.completionTokens ?? 0
            turn += d.totalTokens ?? 0
            turnCached += d.cachedPromptTokens ?? 0
          }
        }
        s.turnPrompt = turnPrompt
        s.turnCompletion = turnCompletion
        s.turn = turn
        s.turnCachedPromptTokens = turnCached
        if (lastUsage) {
          s.lastPrompt = lastUsage.promptTokens ?? 0
          s.lastCachedPromptTokens = lastUsage.cachedPromptTokens ?? 0
        }
      }
      tokenStats.set(sid, s)
    }
    return s
  }

  /** 指定会话累计完成的任务循环轮次（一次完整的「用户消息 → 最终回复」= 一轮，从事件日志统计，重启后自动恢复） */
  const countCompletedTurns = (sid?: string): number => {
    const meta = sessions.get(sid ?? currentSessionId ?? '')
    if (!meta) return 0
    return meta.session.list().filter((e) => e.type === 'turn/end').length
  }

  const snapshot = (sid?: string): TokenSnapshot => {
    const target = sid ?? currentSessionId ?? ''
    const s = sessionStats(target)
    // contextLength 兜底：supervisor 会话用管家模型（会话日志回放），其余用全局当前模型（切模型/登录后写入当前会话，未写入时用模型属性兜底）
    const fallbackModelId = target === SUPERVISOR_ID
      ? ((sessions.get(SUPERVISOR_ID) ? effectiveModelId(sessions.get(SUPERVISOR_ID)!.session.list()) : undefined) ?? defaultModelId)
      : currentModelId
    const ctxLen = s.contextLength > 0 ? s.contextLength : allModels().find((m) => m.id === fallbackModelId)?.contextLength ?? 0
    return {
      totalPrompt: s.totalPrompt,
      totalCompletion: s.totalCompletion,
      total: s.total,
      turnPrompt: s.turnPrompt,
      turnCompletion: s.turnCompletion,
      turn: s.turn,
      contextLength: ctxLen,
      lastPrompt: s.lastPrompt,
      contextUsageRatio: ctxLen > 0 ? s.lastPrompt / ctxLen : 0,
      turnCachedPromptTokens: s.turnCachedPromptTokens,
      totalCachedPromptTokens: s.totalCachedPromptTokens,
      cacheHitRatio: s.lastPrompt > 0 ? s.lastCachedPromptTokens / s.lastPrompt : 0,
      turnCount: countCompletedTurns(target),
    }
  }

  const emitTokenStats = (sid?: string): void => {
    const target = sid ?? currentSessionId ?? ''
    const s = snapshot(target)
    tokenCallbacks.forEach((cb) => cb(target, s))
  }

  /** 每次模型返回 usage 时累计（流式末尾 / 一次性 complete 均触发），按发起会话隔离 */
  const onUsage = (usage: TokenUsage): void => {
    const sid = sessionContext.getStore() ?? currentSessionId ?? ''
    const s = sessionStats(sid)
    const cached = usage.cachedPromptTokens ?? 0
    s.totalPrompt += usage.promptTokens
    s.totalCompletion += usage.completionTokens
    s.total += usage.totalTokens
    s.turnPrompt += usage.promptTokens
    s.turnCompletion += usage.completionTokens
    s.turn += usage.totalTokens
    s.lastPrompt = usage.promptTokens
    s.lastCachedPromptTokens = cached
    s.turnCachedPromptTokens += cached
    s.totalCachedPromptTokens += cached
    emitTokenStats(sid)
  }

  /** 每次模型 HTTP 调用回传原始请求/响应（排查问题用）：请求一条、响应一条，写会话隔离的日志文件 */
  const onHttpTrace = (trace: HttpTrace): void => {
    if (!currentSettings.debug.traceLlm) return
    const sid = sessionContext.getStore() ?? currentSessionId ?? ''
    if (!sid) return
    void appendHttpTrace(sid, currentModelId, trace)
  }

  /** 刷新当前模型的上下文窗口长度（模型切换/登录后调用），写入当前会话 */
  const refreshContextLength = (): void => {
    const m = allModels().find((m) => m.id === currentModelId)
    const s = sessionStats(currentSessionId ?? '')
    s.contextLength = m?.contextLength ?? 0
    emitTokenStats()
  }

  // —— 模型 + agent ——
  let model = await createGatewayModel(onUsage, onHttpTrace)
  let sessionRef = sessions.get(currentSessionId!)!.session
  const deltaCallbacks = new Set<(sessionId: string, text: string) => void>()
  const reasoningCallbacks = new Set<(sessionId: string, text: string) => void>()
  // 模型 provider 缓存（按 modelId）：支持「会话管家异步转发」时多个会话各自持有独立 provider，互不串模型。
  // 全局 model / currentModelId 仍表示「当前激活会话」的模型；后台异步任务用 resolveProvider(modelId) 取各自 provider。
  const modelProviders = new Map<string, Model>()
  const resolveProvider = (modelId: string): Model => {
    const cached = modelProviders.get(modelId)
    if (cached) return cached
    const target = allModels().find((m) => m.id === modelId)
    let provider = model
    if (target?.source === 'deepseek-bridge') {
      provider = createDeepSeekModel({ chat: deepSeekChat, getWorkspace: currentWorkDir })
    } else if (target?.baseUrl) {
      provider = createModelProvider({ apiKey: target.apiKey, baseUrl: target.baseUrl, model: target.model ?? target.id, protocol: target.protocol, maxTokens: target.maxTokens, onUsage, onTrace: onHttpTrace })
    }
    modelProviders.set(modelId, provider)
    return provider
  }
  // 登记初始 gateway provider（currentModelId 在凭证恢复阶段已设置；空则跳过，后续 applyModel 会补登记）
  if (currentModelId) modelProviders.set(currentModelId, model)
  refreshContextLength()

  /** 统一应用模型：更新当前模型 id + 切换 provider（DeepSeek 网页版走 CDP 直连；其余有 baseUrl 才换 provider）+ 刷新上下文窗口长度 */
  const applyModel = (modelId: string): void => {
    currentModelId = modelId
    model = resolveProvider(modelId)
    refreshContextLength()
  }

  // —— 登录 ——
  const credentials = new FileCredentialStore()
  const authService = new AuthService({ baseUrl: 'https://agent.bjctykj.com' })
  // 启动时恢复本地凭证（有 gateway apiKey 则视为已登录，模型调用走 apiKey）
  let loggedIn = false
  let username: string | null = null
  let selectedTier: ModelTier = 'flagship'
  try {
    const raw = await fs.readFile(join(homedir(), '.shanhai', 'config.json'), 'utf8')
    const cfg = JSON.parse(raw) as {
      gateway?: {
        apiKey?: string
        baseUrl?: string
        memberToken?: string
        selectedModelId?: string
        account?: { username?: string; nickname?: string }
        models?: GatewayModel[]
        customModels?: GatewayModel[]
        approvalPolicy?: ApprovalPolicy
      }
      settings?: Partial<AppSettings>
    }
    const g = cfg.gateway
    if (g?.apiKey) {
      loggedIn = true
      username = g.account?.nickname ?? g.account?.username ?? null
      gatewayApiKey = g.apiKey
      gatewayBaseUrl = g.baseUrl ?? ''
      memberToken = g.memberToken ?? ''
      // 网关内置模型列表不缓存到本地：内存 gatewayModels 保持空，登录态下由下方 refreshGatewayModels 实时从接口拉取并缓存到内存
    }
    // 无论登录态，恢复用户上次选中的模型（登录后优先沿用）；同时作为全局默认模型（新会话 / 无记录会话回退用）
    if (g?.selectedModelId) {
      currentModelId = g.selectedModelId
      defaultModelId = g.selectedModelId
    }
    // 恢复用户自定义模型（标记 custom: true，登录态无关）
    if (Array.isArray(g?.customModels)) {
      customModels = g.customModels.map((m) => ({ ...m, custom: true }))
    }
    // 审批策略（安全模式）已是会话级：从各会话事件日志回放（approval/policy 事件），无需从 config.json 全局恢复
    // 通用设置已在上面（能力实例创建后）用 readSettings() 恢复，这里无需重复
  } catch {
    // 无凭证，未登录
  }

  // —— 模型列表刷新（登录态下启动自动拉取最新 + 手动刷新，解决「网关新增/禁用模型缓存不更新」）——
  const modelsChangedCallbacks = new Set<() => void>()
  /** 登录凭证整体失效（token + apiKey 都过期）回调：UI 据此提示用户重新登录，而非静默失败 */
  const authExpiredCallbacks = new Set<() => void>()

  /** 应用一份新的网关模型列表：仅更新内存（不落盘），并通知前端 */
  const applyGatewayModels = async (models: GatewayModel[]): Promise<void> => {
    if (!Array.isArray(models) || models.length === 0) return
    gatewayModels = models
    modelsChangedCallbacks.forEach((cb) => cb())
    refreshContextLength()
  }

  /** token 失效时用长期有效的 apiKey 兜底刷新：拿「当前启用模型白名单」剔除已禁用 + 补齐新增 */
  const refreshModelsViaApiKey = async (): Promise<GatewayModel[]> => {
    if (!gatewayApiKey || !gatewayBaseUrl) return gatewayModels
    const upstream = await fetchGatewayModels(gatewayApiKey, gatewayBaseUrl)
    if (upstream.length === 0) return gatewayModels
    const enabledIds = new Set(upstream.map((m) => m.id))
    // 1) 剔除旧缓存里已被网关禁用/删除的模型
    const kept = gatewayModels.filter((m) => enabledIds.has(m.id))
    // 2) 补齐新增模型：统一用网关 apiKey + 统一入口 baseUrl（不能用上游地址）
    const keptIds = new Set(kept.map((m) => m.id))
    const added = upstream
      .filter((m) => !keptIds.has(m.id))
      .map((m) => ({ ...m, tier: inferTier(m.id), apiKey: gatewayApiKey, baseUrl: gatewayBaseUrl }))
    if (kept.length > 0 || added.length > 0) {
      await applyGatewayModels([...kept, ...added])
    }
    return gatewayModels
  }

  /** 用会员 token 重新拉取最新模型列表并应用；token 失效时用 apiKey 兜底刷新；其他异常保留旧列表 */
  const refreshGatewayModels = async (): Promise<GatewayModel[]> => {
    // 无会员 token（老版本登录 / token 缺失）：用长期有效的 apiKey 兜底拉取「启用模型白名单」
    if (!memberToken) return refreshModelsViaApiKey()
    try {
      const models = await authService.fetchModels(memberToken)
      if (Array.isArray(models) && models.length > 0) {
        // 当前选中模型若已不在最新列表里，保持现状不强制切换（避免打断用户）
        await applyGatewayModels(models.map((m) => ({ ...m, tier: inferTier(m.id) })))
      }
    } catch (err) {
      // token 失效（401/invalid token）→ apiKey 兜底刷新；其他网络/网关异常 → 保留旧缓存
      if (err instanceof TokenExpiredError || /invalid token|expired|unauthorized/i.test(String(err))) {
        await refreshModelsViaApiKey()
        // apiKey 兜底后仍无任何可用模型 → 登录凭证整体失效（token + apiKey 都过期），通知前端提示重新登录
        if (gatewayModels.length === 0) {
          authExpiredCallbacks.forEach((cb) => cb())
        }
      }
    }
    return gatewayModels
  }

  // 登录态下后台刷新一次，实时从接口拉取最新模型（不读本地缓存）
  if (loggedIn) void refreshGatewayModels()

  // —— 其余能力（并行会话：每个会话独立的中断标记）——
  const stoppedSessions = new Set<string>()

  // 装配底座服务（声明式 inject）
  await kernel.plugin({
    name: 'session-service',
    provide: ['session'],
    apply: (ctx) => ctx.provide('session', sessionRef),
  })
  await kernel.plugin({
    name: 'approval-service',
    provide: ['approval'],
    apply: (ctx) => ctx.provide('approval', approval),
  })
  await kernel.plugin({
    name: 'agent-service',
    inject: ['session', 'approval'],
    provide: ['agent'],
    apply: (ctx) => ctx.provide('agent', () => new AgentLoop(model, tools, sessionRef, approval)),
  })

  // —— 多专家编排（Triage 拆解 → 路由专家 → 依赖调度 → 汇总）——
  // 专家角色来自 roleRegistry（内置 + 自定义，见上方初始化），triage 每次 route 前用 setRoles 同步最新角色。
  const roleNameById = (): Map<string, string> => new Map([...roleRegistry.values()].map((r) => [r.id, r.name]))
  const triage = new ModelTriage(model, [...roleRegistry.values()])

  /** 当前模型的上下文窗口大小（token 数）。压缩触发阈值在 AgentLoop 内按窗口的 60% 计算，参考 Taco 的做法：
   *  判断依据用接口返回的真实 usage.total_tokens（非本地估算），窗口大小用模型配置的 contextLength。 */
  const currentContextBudget = (modelId?: string): number | undefined => {
    // 用 allModels（系统内置 + 用户自定义），确保自定义模型也能按 contextLength 触发压缩
    const m = allModels().find((x) => x.id === (modelId ?? currentModelId))
    if (m?.contextLength && m.contextLength > 0) return m.contextLength
    return undefined
  }
  /** 当前模型的 apiKey：user_id 确定性派生用（区分不同账号/服务商的前缀缓存）。网关模型用网关 key，自定义模型用各自 key。 */
  const currentApiKey = (modelId?: string): string => allModels().find((x) => x.id === (modelId ?? currentModelId))?.apiKey ?? gatewayApiKey ?? ''
  // 专家执行轨迹回调（UI 展示多专家协作过程）
  const expertTraceCallbacks = new Set<(trace: StepTrace) => void>()

  /** 构造专家池：每个角色一个 AgentLoop（独立 Session 记录执行过程，审批路由到主会话）。modelId 缺省用当前全局模型。 */
  const buildExpertAgents = (sid: string, visionCapable: boolean, modelId?: string, approvalSession?: Session): Map<string, AgentLoop> => {
    const effModelId = modelId ?? currentModelId
    const effModel = modelId ? resolveProvider(modelId) : model
    const map = new Map<string, AgentLoop>()
    for (const role of roleRegistry.values()) {
      const expertSession = new Session()
      map.set(
        role.id,
        new AgentLoop(effModel, tools, expertSession, approval, sid, currentContextBudget(effModelId), visionCapable, currentApiKey(effModelId), role.id, approvalSession),
      )
    }
    return map
  }

  /** 管家会话专用工具集（已在 tools 声明处占位声明，见上方）。此处装配赋值，runInSession 据此走管家分支。 */
  /** 管家转发队列：会话 id → 待执行消息列表（queue 模式，目标会话 busy 时排队，任务结束后由 drainSupervisorQueue 自动执行） */
  const supervisorQueue = new Map<string, string[]>()
  /** 待管家决策队列（审批/提问接管）：管家忙时不再 injectUserMessage（注入到即将结束的 loop 会悬空，导致会话永久挂起），
   *  改为串行队列，每个决策 prompt 由独立的 runSupervisorInternal 处理，处理完再取下一条。 */
  const supervisorWakeQueue: string[] = []
  let supervisorWaking = false

  // —— 会话活动 / 激活会话 / 管家结果回传事件（主进程 ui-store 订阅，同步 UI 状态）——
  /** 会话开始/结束执行（runningLoops / multiExpertLoops 挂载与清理时广播），主进程据此刷新「处理中」与消息流 */
  const sessionActivityCallbacks = new Set<(sessionId: string, kind: 'start' | 'end') => void>()
  /** 激活会话切换（switchSessionInternal 里 currentSessionId 变化时广播），主进程据此同步聊天窗口当前会话 */
  const currentSessionChangedCallbacks = new Set<(sessionId: string) => void>()
  /** 管家异步下发的目标会话任务完成后回传正文结果（append 到管家会话 + 广播给管家窗口） */
  const supervisorResultCallbacks = new Set<(sessionId: string, title: string, result?: string, error?: string) => void>()
  /** 管家向目标会话下发任务时实时广播 user 消息（供目标会话 UI 立即显示用户气泡，无需等执行结束重建 items） */
  const userMessageCallbacks = new Set<(sessionId: string, message: string, turnSeq: number) => void>()

  /** 专家专属 systemPrompt（含环境信息 + 长期记忆 + 角色人设），由 Orchestrator 在每步注入 */
  const buildExpertSystemPrompts = (workDir: string, message: string): Map<string, string> => {
    const base = buildSystemPrompt(workDir, buildMemoryContext(message))
    const map = new Map<string, string>()
    for (const role of roleRegistry.values()) {
      map.set(role.id, role.systemPrompt ? `${base}\n\n${role.systemPrompt}` : base)
    }
    return map
  }

  /**
   * 在指定会话内跑一次任务（run / resend / resume 共用）。
   * 图片降级 + ReAct 循环 + 中断处理 + 落盘。
   */
  const runInSession = async (
    sid: string,
    message: string,
    opts?: { maxSteps?: number; attachments?: ContentPart[] },
    modelIdOverride?: string,
    origin: 'user' | 'supervisor' = 'user',
  ): Promise<string> => {
    const meta = sessions.get(sid)
    if (!meta) throw new Error(`会话不存在: ${sid}`)
    const targetSession = meta.session
    // 管家超级会话：跳过 Triage 多专家路由，单步 ReAct + 管家工具集（管家是「主 Agent」，不是被拆解的任务）
    const isSupervisorRun = sid === SUPERVISOR_ID
    // 模型隔离：异步转发（管家给别的会话下发任务）时传 modelIdOverride，用目标会话自己的 provider，不污染全局 currentModelId
    const effModelId = modelIdOverride ?? currentModelId
    const effModel = modelIdOverride ? resolveProvider(modelIdOverride) : model
    stoppedSessions.delete(sid)
    // 记录本轮任务发起方（审批分流用）：管家会话自身不标记（管家工具免审批，不会触发审批）
    if (!isSupervisorRun) sessionOrigin.set(sid, origin)
    // 发消息即视为活跃，刷新活跃时间（列表排序用）
    touchSession(sid)
    // 发消息立即 busy：start 广播提前到 triage 拆解/图片降级之前，避免「管家下发→triage LLM 往返」期间发送按钮状态延迟、耗时起点不准
    sessionActivityCallbacks.forEach((cb) => cb(sid, 'start'))
    // 本轮任务开始时清零 turn 统计（会话级），模型每次返回 usage 时重新累计
    const statAcc = sessionStats(sid)
    statAcc.turnPrompt = 0
    statAcc.turnCompletion = 0
    statAcc.turn = 0
    statAcc.turnCachedPromptTokens = 0
    emitTokenStats(sid)
    // 图片降级：当前模型不支持视觉时，先用视觉模型把图片转成文字描述，再发给当前模型。
    // 关键：降级只影响「发给模型的内容」（modelContent），落盘的 user/message 仍保留原始文本 + 原始图片附件，
    // 这样重启后历史记录里的图片能恢复显示，而不是变成【图片】描述文字。
    let modelContent: string | undefined
    // 当前模型是否支持视觉（含自定义模型）：true 时图片以多模态形式直接喂给模型「看」，无需降级。
    // 注意：必须用 allModels() 查找（含自定义模型 + 网关模型），不能用 gatewayModels.find（自定义模型会漏、被误判为不支持视觉）。
    const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId))
    if (opts?.attachments && opts.attachments.length > 0 && !visionCapable) {
      const parts: string[] = []
      for (const p of opts.attachments) {
        if (p.type === 'image_url') {
          parts.push(`【图片】${await analyzeImageWithVision(p.image_url.url)}`)
        }
      }
      const desc = parts.filter(Boolean).join('\n')
      modelContent = message ? `${message}\n\n${desc}` : desc
    }
    // —— 多专家编排入口：Triage 拆解（复杂任务拆多步路由专家，简单任务单步走现有 ReAct）——
    // 拆解失败（模型/网络/解析异常）自动退化为单步，绝不阻断主流程
    // 每次路由前同步最新专家列表（内置 + 自定义），让新增的专家能被拆解指派到
    triage.setRoles([...roleRegistry.values()])
    if (!isSupervisorRun)
    try {
      const plan = await sessionContext.run(sid, () => triage.route(message))
      if (plan.steps.length > 1) {
        // 多步编排：先落盘用户消息（专家用独立 Session，主会话手动记录用户消息 + 最终回复）
        targetSession.append('user/message', { content: message, attachments: (opts?.attachments ?? []) as unknown[] })
        targetSession.append('turn/start', { turn: 1, mode: 'multi' })
        // 持久化拆解计划：断点续跑（继续执行）时据此恢复依赖图，跳过已完成步骤、只重跑未完成步骤
        targetSession.append('orchestrator/plan', { plan })
        const expertAgents = buildExpertAgents(sid, visionCapable, effModelId, targetSession)
        // 注册多专家 loop，供插入模式向所有专家注入消息（各专家在下一步模型调用前消费注入消息）
        multiExpertLoops.set(sid, expertAgents)
        // 累积多专家编排的思考内容，落盘到 assistant/message（否则多专家思考只存在于实时流、重启/重建后丢失）
        let expertReasoning = ''
        try {
          const orchestrator = new Orchestrator(triage, expertAgents, {
            sessionId: sid,
            expertNames: roleNameById(),
            expertSystemPrompts: buildExpertSystemPrompts(meta.workDir, message),
            onStep: (trace) => {
              // 轮次序号 = 会话内 user 消息序号（本轮 user/message 已 append，其数量即本轮序号）
              const turnSeq = targetSession.list().filter((e) => e.type === 'user/message').length
              // 持久化每步状态：断点续跑时据此恢复已完成步骤的结果（作为后续步骤依赖上下文）
              targetSession.append('orchestrator/step', { stepId: trace.stepId, expertId: trace.expertId, title: trace.title, status: trace.status, result: trace.result, error: trace.error })
              expertTraceCallbacks.forEach((cb) => cb({ ...trace, turnSeq }))
            },
            onDelta: (text) => {
              if (stoppedSessions.has(sid)) throw new Error('__stopped__')
              deltaCallbacks.forEach((cb) => cb(sid, text))
            },
            onReasoning: (text) => {
              expertReasoning += text
              reasoningCallbacks.forEach((cb) => cb(sid, text))
            },
            summarize: async (task, steps, onDelta) => {
              // 用主模型（triage 同款旗舰模型）把各专家结果汇总成一段直接回答用户问题的最终结果
              const parts = steps.map((s, i) => `${i + 1}. [${s.expert}] ${s.title}\n${s.result}`).join('\n\n')
              const systemPrompt =
                '你是「山海」的结果汇总器。下面是一次多专家协作任务中各位专家的执行结果，以及用户最初的问题。请把它们汇总成一段连贯、简洁、直接回答用户问题的最终结果：只输出最终答案本身，不要罗列专家名、不要复述执行过程、不要加分节标题（除非用户明确要求）。'
              const userPrompt = `【用户的问题】\n${task}\n\n【各专家执行结果】\n${parts}`
              const messages = [
                { role: 'system' as const, content: systemPrompt },
                { role: 'user' as const, content: userPrompt },
              ]
              let full = ''
              try {
                if (model.stream) {
                  for await (const chunk of model.stream(messages, [])) {
                    if (stoppedSessions.has(sid)) throw new Error('__stopped__')
                    if (chunk.text) {
                      full += chunk.text
                      onDelta(chunk.text)
                    }
                  }
                } else {
                  const res = await model.complete(messages, [])
                  full = res.text ?? ''
                  if (full) onDelta(full)
                }
              } catch (err) {
                // 用户停止 / 重试耗尽：向上抛，由外层按中断/重试处理；其余汇总失败回退拼接（不阻断任务）
                if (err instanceof Error && (err.message === '__stopped__' || err.message.startsWith('__retry_exhausted__'))) throw err
                console.error('[orchestrator] 汇总失败，回退拼接:', err instanceof Error ? err.message : err)
                return ''
              }
              return full
            },
          })
          const result = await sessionContext.run(sid, () => orchestrator.run(message))
          targetSession.append('assistant/message', { content: result.text, reasoningContent: expertReasoning || undefined })
          targetSession.append('turn/end', { turn: 1, text: result.text })
          return result.text
        } finally {
          multiExpertLoops.delete(sid)
          sessionOrigin.delete(sid)
          sessionActivityCallbacks.forEach((cb) => cb(sid, 'end'))
          // 多专家任务结束（成功/中断/重试耗尽）更新活跃时间为结束时间，并落盘主会话消息
          meta.lastActiveAt = Date.now()
          await persistSession(meta)
        }
      }
    } catch (err) {
      // 用户点「停止」：多专家编排中断，直接返回「已中断」（不退化单步继续跑）
      if (err instanceof Error && err.message === '__stopped__') {
        return '（已中断，历史已保留，可点击「继续执行」续跑）'
      }
      // 重试耗尽（网络/余额不足等基础设施故障）：向上传播，前端弹窗让用户选择重试/取消（不退化单步继续跑）
      if (err instanceof Error && err.message.startsWith('__retry_exhausted__')) {
        throw err
      }
      // Triage 拆解异常：退化单步
      console.error('[orchestrator] Triage 拆解异常，退化单步:', err instanceof Error ? err.message : err)
    }
    const loop = new AgentLoop(effModel, isSupervisorRun ? supervisorLoopTools : tools, targetSession, approval, sid, currentContextBudget(effModelId), visionCapable, currentApiKey(effModelId))
    runningLoops.set(sid, loop)
    let suspended = false
    try {
      return await sessionContext.run(sid, () =>
        loop.run(message, {
          ...opts,
          // 系统提示词告知当前工作目录：让模型知道文件/命令操作的锚点，并约束工具调用围绕工作目录
          systemPrompt: isSupervisorRun ? buildSupervisorSystemPrompt() : buildSystemPrompt(meta.workDir, buildMemoryContext(message)),
          attachments: opts?.attachments,
          modelContent,
          onDelta: (text) => {
            if (stoppedSessions.has(sid)) throw new Error('__stopped__')
            deltaCallbacks.forEach((cb) => cb(sid, text))
          },
          onReasoning: (text) => {
            reasoningCallbacks.forEach((cb) => cb(sid, text))
          },
        }),
      )
    } catch (err) {
      if (err instanceof Error && err.message === '__stopped__') {
        return '（已中断，历史已保留，可点击「继续执行」续跑）'
      }
      // 重试耗尽：任务挂起，保留 loop 引用（供 retrySession 用相同 body 重试），不要 delete。
      // 管家会话例外：审批/提问决策是短任务，失败时挂起无意义（用户不会 retry 一个审批决策），
      // 且 suspended 会让 runningLoops 残留 SUPERVISOR_ID、又因 !suspended 不触发 drainSupervisorWake，
      // 使串行队列断裂、后续审批/提问永远不被处理（目标会话永久挂起）。故管家失败不挂起，清理 loop 让队列继续。
      if (err instanceof Error && err.message.startsWith('__retry_exhausted__')) {
        suspended = !isSupervisorRun
      }
      throw err
    } finally {
      // 挂起时保留 loop（供 retry）；否则移除（任务结束/中断后，插入模式回退为队列）
      if (!suspended) {
        runningLoops.delete(sid)
        sessionActivityCallbacks.forEach((cb) => cb(sid, 'end'))
      }
      sessionOrigin.delete(sid)
      // 任务结束（成功/失败/中断/重试耗尽）更新活跃时间为结束时间（列表排序用），随后立即落盘
      meta.lastActiveAt = Date.now()
      // 会话事件（用户消息/助手回复/工具过程）已追加到 session，立即落盘，重启不丢
      await persistSession(meta)
      // 刷新底部状态栏（累计轮次随 turn/end 变化，成功/失败/中断后都要同步）
      emitTokenStats()
      // 管家转发队列：目标会话任务结束后，自动执行排队的下一条消息（queue 模式）
      drainSupervisorQueue(sid)
      // 管家 loop 结束后，串行消费待管家决策队列（审批/提问接管）下一条
      if (sid === SUPERVISOR_ID && !suspended) {
        console.log('[supervisor-wake] 管家 loop 结束（finally），触发 drain，suspended=', suspended)
        void drainSupervisorWake()
      } else if (sid === SUPERVISOR_ID) {
        console.log('[supervisor-wake] 管家 loop 结束但 suspended=true，不触发 drain')
      }
    }
  }

  // —— 会话管家（主 Agent）：状态查询 + 消息转发 + 会话配置 ——

  /** 管家专用系统提示词：定位为「主 Agent」，可查看/转发/配置所有用户会话 */
  const buildSupervisorSystemPrompt = (): string =>
    [
      '你是「会话管家」，山海多会话系统的主 Agent。你负责准确理解用户意图、把任务精准调度给合适的会话，并监控各会话状态，而不是替某个会话执行具体的编码/文件任务。',
      '你的能力：',
      '1. 用 list_sessions 查看所有会话及其状态（标题、工作目录、当前需求、最近需求 recentRequests、是否忙、已执行步数、上下文占用、是否激活）。',
      '2. 用 inspect_session 深入查看某个会话的详情。',
      '3. 用 list_models 查看可选模型。',
      '4. 用 switch_session 切换管家当前聚焦的会话（仅管家视角，不影响用户聊天窗口显示的会话）。',
      '5. 用 send_message / inject_message 把需求转发给指定会话执行（等同用户手动切过去发消息）。',
      '6. 用 set_session_model 切换某个会话使用的模型，用 set_session_approval 配置其安全模式。',
      '7. 用 create_session 新建会话、rename_session 重命名会话、set_session_workdir 设置会话工作目录、delete_session 删除会话。',
      '8. 用 choose_session 弹出会话选择器让用户选目标会话、choose_model 弹出模型选择器让用户选模型（阻塞等待用户选择，选中后拿到 id 再继续）。',
      '9. 用 ask_user 向用户提问：需要用户单选/多选、确认或补充信息时，可提供 options 让用户点选（multiple 为 true 时多选），或让用户自由输入；调用后必须等待用户回答再继续。',
      '10. 用插件类工具沉淀与扩展管家自身能力：plugin_inspect 查看可挂载 UI 插槽/可用工具/已注册服务/已安装插件；plugin_define 定义新插件（host 半是进程内源码、client 半是界面 UI 源码）；plugin_run 临时运行、plugin_stop / plugin_undefine 撤回；要长期沉淀走 plugin_define → plugin_test 自测 → plugin_install 安装进内核（落盘 ~/.shanhai/plugins/，跨会话/跨重启留存）→ plugin_uninstall 卸载。已安装插件重启后自动加载。',
      '【调度决策流程】收到用户消息后，必须严格按以下五步执行，一步都不能省：',
      '第一步 解析需求：把用户这条消息拆解成 1..N 个独立需求。判据：每个需求是一个「可以独立交给某个会话完成的任务单元」。一条消息含多个相互独立需求时必须拆开逐个处理；只含一个需求则 N=1。',
      '第二步 匹配会话：对每个需求，用 list_sessions 查看所有会话的 title（职责）、workDir（工作目录）、recentRequests（最近在做什么）、currentRequest（当前在做什么）、busy 状态，判断该需求应交由哪个会话。综合会话标题体现的职责、工作目录、历史与当前需求来判断：能唯一确定 → 记下目标会话 id；不能唯一确定（有多个候选 / 无匹配 / 拿不准）→ 标记为「待确认」。',
      '第三步 求助确认（不明确时强制，禁止臆测）：',
      '  - 需求本身表述不清（缺「做什么 / 对哪个项目或目录 / 要什么结果」等关键信息）→ 先用 ask_user 追问清楚，禁止猜测后直接下发。',
      '  - 需求明确但目标会话不明确 → 先 list_sessions 拿候选，再用 choose_session 弹选择器让用户选；候选为空则 ask_user 询问用户想用哪个会话或是否新建。',
      '  - 一条消息含多个需求，部分明确部分不明确 → 明确的部分可先下发，不明确的部分单独求助，不能因一条不明确就整体卡住或整体瞎猜。',
      '第四步 执行下发：对每个已明确的需求，用 send_message 把需求内容原样、完整地转发给目标会话（不要删减、不要替它做、不要把不同需求合并成一条），并逐一汇报「需求 X → 会话「标题」」的映射，让用户可核对。',
      '第五步 汇报：用简洁清单向用户汇报：哪些需求已下发到哪个会话、哪些需求已求助待确认，做到每个需求都有明确去向，不留任何「我以为」。',
      '【求助用户的形式】（务必遵守）：',
      '- 需要用户做「选择」（选目标会话 / 选模型）→ 用 choose_session / choose_model 弹选择器，禁止用纯文本反问。',
      '- 需要用户「补充信息 / 确认 / 回答开放问题」→ 用 ask_user 弹提问卡片（能枚举选项就给 options，multiple 按需多选；开放问题让用户自由输入）。',
      '- 情况复杂、需要用户理解多步背景或给出详细说明 → 用回复正文详细说明情况并明确列出需要用户回答的问题，可同时配合 ask_user 收集关键确认项。',
      '- 拿不准时宁可多问一次，绝不擅自替用户做决定（尤其涉及「把需求交给哪个会话、删除会话、切换模型」这类有歧义或不可逆的操作）。',
      '工作原则：',
      '- 用户问「有哪些会话在干活」「某个会话做到哪了」时，先 list_sessions / inspect_session 查询，如实汇报，不要编造。',
      '- 用户说「给会话X新增需求Y」时，用 send_message 转发，并说明转发结果。',
      '- 当用户要你操作某个会话或切换某个模型、但没有明确说是哪个时，先 list_sessions / list_models 拿到候选，再用 choose_session / choose_model 弹出选择器让用户选，拿到选择结果后再执行，禁止凭空猜测目标会话或模型。',
      '- 【强制】需要用户做任何选择、确认或补充信息时，必须调用 choose_session / choose_model / ask_user 弹出弹窗让用户选择或回答，禁止用纯文本反问用户；拿不准选哪个就先 list_sessions / list_models 拿候选再弹。',
      '- 配置类操作（切模型/改安全模式/改工作目录/重命名）先说明再执行，执行完汇报。',
      '- delete_session 是危险且不可恢复的操作：执行前必须向用户复述目标会话 id 与标题，得到明确确认后才能删除。',
      '- 你只做会话调度与监控，不替目标会话执行具体任务（具体任务由目标会话的 Agent 完成）。',
    ].join('\n')

  /** 描述单个会话的完整状态（管家 list_sessions / inspect_session 用） */
  const describeSession = (sid: string): SessionStateSummary | null => {
    const meta = sessions.get(sid)
    if (!meta || meta.isSupervisor) return null
    const events = meta.session.list()
    // 当前需求 = 最后一条非注入用户消息；同时收集最近若干条非注入用户消息（供管家判断会话职责）
    let currentRequest = ''
    let lastUserIdx = -1
    const userRequests: string[] = []
    for (const e of events) {
      if (e?.type === 'user/message') {
        const d = e.data as { content?: string; injected?: boolean }
        if (!d.injected) {
          const text = (d.content ?? '').trim()
          if (text) userRequests.push(text)
        }
      }
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'user/message') {
        const d = e.data as { content?: string; injected?: boolean }
        if (!d.injected) {
          currentRequest = d.content ?? ''
          lastUserIdx = i
          break
        }
      }
    }
    // 最近 3 条非注入用户消息（从旧到新），每条截断到 120 字，避免上下文膨胀
    const recentRequests = userRequests.slice(-3).map((t) => (t.length > 120 ? t.slice(0, 120) + '…' : t))
    // 已执行步数 = 最后一个 turn/start 之后的 tool/call 数量
    let turnStartIdx = -1
    for (let i = 0; i < events.length; i++) {
      if (events[i]?.type === 'turn/start') turnStartIdx = i
    }
    let stepCount = 0
    for (let i = turnStartIdx + 1; i < events.length; i++) {
      if (events[i]?.type === 'tool/call') stepCount++
    }
    // 未完成轮次：最后一条非注入 user 之后无 assistant/message 或 turn/end
    let hasIncompleteTurn = false
    if (lastUserIdx >= 0) {
      let done = false
      for (let i = lastUserIdx + 1; i < events.length; i++) {
        const t = events[i]?.type
        if (t === 'assistant/message' || t === 'turn/end') {
          done = true
          break
        }
      }
      hasIncompleteTurn = !done
    }
    const modelId = effectiveModelId(events) ?? defaultModelId
    const modelDef = allModels().find((m) => m.id === modelId)
    const snap = snapshot(sid)
    return {
      id: meta.id,
      title: meta.title,
      workDir: meta.workDir,
      busy: runningLoops.has(sid) || (multiExpertLoops.get(sid)?.size ?? 0) > 0,
      active: currentSessionId === sid,
      modelId,
      modelName: modelDef?.displayName ?? modelDef?.name ?? modelId,
      approvalPolicy: effectiveApprovalPolicy(events) ?? 'ask',
      currentRequest,
      recentRequests,
      stepCount,
      contextLength: snap.contextLength,
      lastPrompt: snap.lastPrompt,
      contextUsageRatio: snap.contextUsageRatio,
      turnCount: snap.turnCount,
      hasIncompleteTurn,
      hasRetrySnapshot: readRetrySnapshot(meta) !== null,
      expertCount: multiExpertLoops.get(sid)?.size ?? 0,
      lastActiveAt: meta.lastActiveAt,
    }
  }

  /** 切换指定会话使用的模型（写事件日志持久化；目标会话是当前全局会话时立即生效） */
  const setSessionModelInternal = (sid: string, modelId: string): { ok: boolean; message: string } => {
    const meta = sessions.get(sid)
    if (!meta || meta.isSupervisor) return { ok: false, message: `会话不存在: ${sid}` }
    if (!allModels().some((m) => m.id === modelId)) return { ok: false, message: `模型不存在: ${modelId}（用 list_models 查看可用模型）` }
    meta.session.append('model/select', { modelId })
    void persistSession(meta)
    if (currentSessionId === sid) applyModel(modelId)
    return { ok: true, message: `已将会话「${meta.title}」(${sid}) 的模型切换为 ${modelId}` }
  }

  /** 配置指定会话的安全模式（写事件日志持久化；目标会话是当前全局会话时立即生效） */
  const setSessionApprovalInternal = (sid: string, policy: ApprovalPolicy): { ok: boolean; message: string } => {
    const meta = sessions.get(sid)
    if (!meta || meta.isSupervisor) return { ok: false, message: `会话不存在: ${sid}` }
    meta.session.append('approval/policy', { policy })
    void persistSession(meta)
    if (currentSessionId === sid) approval.setPolicy(policy)
    return { ok: true, message: `已将会话「${meta.title}」(${sid}) 的安全模式设为 ${policy}` }
  }

  /** 重命名指定会话（管家会话不可重命名），供管家 rename_session 工具与用户 renameSession 共用 */
  const renameSessionInternal = (sid: string, title: string): { ok: boolean; message: string } => {
    const meta = sessions.get(sid)
    if (!meta || meta.isSupervisor) return { ok: false, message: `会话不存在: ${sid}` }
    const trimmed = title.trim()
    if (!trimmed) return { ok: false, message: '会话标题不能为空' }
    meta.title = trimmed
    void persistSession(meta)
    return { ok: true, message: `已将会话重命名为「${trimmed}」(${sid})` }
  }

  /** 设置指定会话的工作目录（管家会话不可修改），供管家 set_session_workdir 工具与用户 setSessionWorkdir 共用 */
  const setSessionWorkdirInternal = (sid: string, workdir: string): { ok: boolean; message: string } => {
    const meta = sessions.get(sid)
    if (!meta || meta.isSupervisor) return { ok: false, message: `会话不存在: ${sid}` }
    const trimmed = workdir.trim()
    if (!trimmed) return { ok: false, message: '工作目录不能为空' }
    meta.workDir = trimmed
    void persistSession(meta)
    return { ok: true, message: `已将会话「${meta.title}」(${sid}) 的工作目录设为 ${trimmed}` }
  }

  /** 删除指定会话（管家会话不可删除），供管家 delete_session 工具与用户 deleteSession 共用 */
  const deleteSessionInternal = async (sid: string): Promise<{ ok: boolean; message: string }> => {
    const meta = sessions.get(sid)
    if (!meta || meta.isSupervisor) return { ok: false, message: `会话不存在: ${sid}` }
    const title = meta.title
    // 删除前拒绝该会话所有待审批请求，避免 agent 永久卡在 await
    for (const [requestId, p] of pendingApprovals) {
      if (p.sessionId === sid) {
        p.resolve('rejected')
        pendingApprovals.delete(requestId)
      }
    }
    // 同样拒绝该会话待确认的 browser 半投递（round-trip 审批）
    for (const [requestId, p] of pendingClientRuns) {
      if (p.sessionId === sid) {
        p.resolve(false)
        pendingClientRuns.delete(requestId)
      }
    }
    // 取消该会话待回答的提问（避免 agent 永久卡在等待用户回答）
    askService.cancelSession(sid)
    sessions.delete(sid)
    await fs.rm(join(sessionsDir, `${sid}.json`), { force: true }).catch(() => undefined)
    // 清理该会话的 HTTP trace 日志（LLM 原始请求/响应，可能很大），避免删除会话后残留大文件
    await fs.rm(httpTracePath(sid), { force: true }).catch(() => undefined)
    // 当前会话被删：切到剩余第一个「用户会话」（跳过管家）；无剩余则新建一个空会话
    if (currentSessionId === sid) {
      const next = [...sessions.values()].find((s) => !s.isSupervisor)
      if (next) {
        currentSessionId = next.id
        sessionRef = next.session
        // 同步更新 config.json 的 lastActiveSessionId，避免残留指向已删会话的死 id
        void persistLastActiveSessionId(next.id)
      } else {
        newSession('新会话')
      }
    }
    return { ok: true, message: `已删除会话「${title}」(${sid})` }
  }

  /** 管家自己的模型 id：优先 supervisor 会话的 model/select 记录，缺省回退全局默认模型 */
  const getSupervisorModelInternal = (): string => {
    const meta = sessions.get(SUPERVISOR_ID)
    return (meta ? effectiveModelId(meta.session.list()) : undefined) ?? defaultModelId
  }

  /** 管家自己的安全模式：从 supervisor 会话事件日志回放，缺省 'ask' */
  const getSupervisorApprovalInternal = (): ApprovalPolicy => sessionApprovalPolicy(SUPERVISOR_ID)

  /** 切换管家自己的模型：只向 supervisor 会话写 model/select 事件，不碰全局默认模型、不碰其他会话 */
  const setSupervisorModelInternal = (modelId: string): { ok: boolean; message: string } => {
    const meta = sessions.get(SUPERVISOR_ID)
    if (!meta) return { ok: false, message: '管家会话不存在' }
    if (!allModels().some((m) => m.id === modelId)) return { ok: false, message: `模型不存在: ${modelId}（用 list_models 查看可用模型）` }
    meta.session.append('model/select', { modelId })
    void persistSession(meta)
    return { ok: true, message: `管家模型已切换为 ${modelId}` }
  }

  /** 配置管家自己的安全模式：只向 supervisor 会话写 approval/policy 事件，不碰全局、不碰其他会话 */
  const setSupervisorApprovalInternal = (policy: ApprovalPolicy): { ok: boolean; message: string } => {
    const meta = sessions.get(SUPERVISOR_ID)
    if (!meta) return { ok: false, message: '管家会话不存在' }
    meta.session.append('approval/policy', { policy })
    void persistSession(meta)
    return { ok: true, message: `管家安全模式已设为 ${policy}` }
  }

  /** 切换激活会话（等同用户在侧边栏点击切换，改变聊天窗口当前显示的会话），供管家 switch_session 工具与用户 switchSession 共用 */
  const switchSessionInternal = (id: string): { ok: boolean; message: string } => {
    const target = sessions.get(id)
    if (!target || target.isSupervisor) return { ok: false, message: `会话不存在: ${id}` }
    currentSessionId = id
    sessionRef = target.session
    void persistLastActiveSessionId(id)
    approval.setPolicy(effectiveApprovalPolicy(target.session.list()) ?? 'ask')
    const sidModel = effectiveModelId(target.session.list())
    if (sidModel) {
      applyModel(sidModel)
    } else if (defaultModelId) {
      applyModel(defaultModelId)
    }
    emitTokenStats(id)
    ensureDefaultBrowserWindow(id)
    currentSessionChangedCallbacks.forEach((cb) => cb(id))
    return { ok: true, message: `已激活会话「${target.title}」(${id})` }
  }

  /** 管家聚焦会话（switch_session 工具的目标）：管家是独立主 Agent，切换聚焦会话不抢占用户正在查看的聊天窗口，
   * 故不碰 currentSessionId、不广播、不 applyModel。当前 send_message 等工具显式传 sessionId，聚焦仅作语义确认。 */
  const switchSupervisorFocus = (id: string): { ok: boolean; message: string } => {
    const target = sessions.get(id)
    if (!target || target.isSupervisor) return { ok: false, message: `会话不存在: ${id}` }
    return { ok: true, message: `管家已聚焦会话「${target.title}」(${id})（不影响用户聊天窗口当前会话）` }
  }

  /** 中断指定会话的进行中任务（按 sessionId 精确停止，不改变 currentSessionId）。
   *  手机远程控制 / 管家跨会话停止用；用户本窗口停止走 stop() → 同一实现。 */
  const stopSessionInternal = (sid: string): void => {
    if (!sid) return
    stoppedSessions.add(sid)
    // 主动中止运行中的 AgentLoop：让 loop 在下一轮循环 / 流式 chunk / 工具执行前检查 aborted 标志尽快退出。
    runningLoops.get(sid)?.abort()
    const experts = multiExpertLoops.get(sid)
    if (experts) {
      for (const loop of experts.values()) loop.abort()
    }
    // 中断审批挂起：reject 该会话所有待审批请求，避免工具永久卡在 await 审批
    for (const [requestId, p] of pendingApprovals) {
      if (p.sessionId === sid) {
        p.resolve('rejected')
        pendingApprovals.delete(requestId)
      }
    }
    // 同样中断 browser 半投递（round-trip 审批）挂起
    for (const [requestId, p] of pendingClientRuns) {
      if (p.sessionId === sid) {
        p.resolve(false)
        pendingClientRuns.delete(requestId)
      }
    }
  }

  /**
   * 向指定会话转发消息（等同用户手动切过去发消息）。
   * 短任务（注入 / 排队）同步返回；长任务（空闲会话执行）异步执行，不阻塞管家，
   * 用目标会话自己的 model provider（modelIdOverride 隔离，不污染全局 currentModelId），完成后通过事件回传正文结果。
   * 目标状态分派：空闲→异步执行；busy+insert→注入不打断；busy+queue→排队等待。
   */
  /** 向指定会话分发消息的公共实现：空闲→异步执行（长任务不阻塞调用方），busy+insert→注入不打断，busy+queue→排队。
   *  onDone 在空闲异步执行结束后回调（管家用它回传结果到管家窗口；手机远程控制传空操作，靠 onSessionActivity('end') 获取结果）。 */
  function dispatchToSession(
    sid: string,
    message: string,
    mode: 'insert' | 'queue',
    onDone: (sid: string, title: string, result?: string, error?: string) => void,
    origin: 'user' | 'supervisor' = 'user',
  ): Promise<{ ok: boolean; message: string; result?: string }> {
    const meta = sessions.get(sid)
    if (!meta || meta.isSupervisor) return Promise.resolve({ ok: false, message: `会话不存在: ${sid}` })
    const content = message.trim()
    if (!content) return Promise.resolve({ ok: false, message: '消息内容不能为空' })

    const busy = runningLoops.has(sid) || (multiExpertLoops.get(sid)?.size ?? 0) > 0
    if (busy && mode === 'insert') {
      // 插入模式：注入不打断（等同 injectMessage）
      const loop = runningLoops.get(sid)
      if (loop) {
        loop.injectUserMessage(content)
        return Promise.resolve({ ok: true, message: `已向会话「${meta.title}」(${sid}) 追加需求（不打断当前任务）` })
      }
      const experts = multiExpertLoops.get(sid)
      if (experts && experts.size > 0) {
        for (const expert of experts.values()) expert.injectUserMessage(content)
        return Promise.resolve({ ok: true, message: `已向会话「${meta.title}」(${sid}) 追加需求（多专家，不打断当前任务）` })
      }
      return Promise.resolve({ ok: false, message: '注入失败：未找到运行中的任务' })
    }
    if (busy && mode === 'queue') {
      const q = supervisorQueue.get(sid) ?? []
      q.push(content)
      supervisorQueue.set(sid, q)
      return Promise.resolve({ ok: true, message: `会话「${meta.title}」(${sid}) 正在执行，需求已排队（当前任务结束后自动执行）` })
    }

    // 空闲：长任务异步执行（不阻塞调用方），用目标会话自己的 provider 隔离模型，完成后回调 onDone
    const title = meta.title
    const targetModelId = effectiveModelId(meta.session.list()) ?? defaultModelId
    // 实时同步 user 消息到目标会话 UI：外部下发不经过渲染进程本地 push（区别于用户手动输入），
    // 需由事件驱动立即显示用户气泡，否则要等执行结束 onSessionActivity('end') 重建 items 才出现。
    const turnSeq = meta.session.list().filter((e) => e.type === 'user/message' && !(e.data as { injected?: boolean }).injected).length + 1
    userMessageCallbacks.forEach((cb) => cb(sid, content, turnSeq))
    void (async () => {
      try {
        const result = await runInSession(sid, content, undefined, targetModelId, origin)
        onDone(sid, title, result)
      } catch (err) {
        onDone(sid, title, undefined, err instanceof Error ? err.message : String(err))
      }
    })()
    return Promise.resolve({ ok: true, message: `已向会话「${title}」(${sid}) 下发任务，将异步执行` })
  }

  /** 向指定会话转发消息（管家工具用）：执行完成后通过 notifySupervisorResult 把正文结果回传管家窗口。
   *  origin 固定为 'supervisor'：管家下发的任务触发的审批可被管家接管（受开关控制）。 */
  function sendMessageToSession(sid: string, message: string, mode: 'insert' | 'queue'): Promise<{ ok: boolean; message: string; result?: string }> {
    return dispatchToSession(sid, message, mode, (sid, title, result, error) => notifySupervisorResult(sid, title, result, error), 'supervisor')
  }

  /** 向指定会话执行任务（手机远程控制用）：等同用户手动切到该会话发消息，但不回传管家结果（避免污染管家历史）。
   *  手机端靠 onSessionActivity('end') + getSessionHistory 获取执行结果。origin 默认 'user'（远程是用户侧操作，审批由用户在手机端点）。 */
  function runSession(sid: string, message: string, mode: 'insert' | 'queue' = 'insert'): Promise<{ ok: boolean; message: string; result?: string }> {
    return dispatchToSession(sid, message, mode, () => {}, 'user')
  }

  /** 目标会话异步任务完成后，把正文结果回传管家：持久化到管家会话历史 + 广播事件通知管家窗口实时展示 */
  const notifySupervisorResult = (sid: string, title: string, result?: string, error?: string): void => {
    const text = error
      ? `⚠️ 会话「${title}」(${sid}) 执行失败：${error}`
      : `✅ 会话「${title}」(${sid}) 执行完成：\n\n${result ?? '（无正文输出）'}`
    const supMeta = sessions.get(SUPERVISOR_ID)
    // 持久化到管家会话历史（管家下次对话能读到这条结果）
    supMeta?.session.append('assistant/message', { content: text })
    if (supMeta) void persistSession(supMeta)
    supervisorResultCallbacks.forEach((cb) => cb(sid, title, result, error))
  }

  /** 目标会话任务结束后，自动执行其排队中的下一条消息（queue 模式）。function 声明提升，供 runInSession finally 调用。 */
  function drainSupervisorQueue(sid: string): void {
    const queued = supervisorQueue.get(sid)
    if (!queued || queued.length === 0) return
    const next = queued.shift()
    if (next) void sendMessageToSession(sid, next, 'queue')
  }

  // 装配管家工具集：只保留「管家专属工具 + ask_user + 插件类工具（plugin_*）」，
  // 不注入 read_file/write_file/run_command/skill_run/mcp_call/role_define 等执行类工具，
  // 避免管家越界直接执行文件/命令/浏览器/插件等操作（管家职责是「监控+调度」，具体执行由目标会话 Agent 完成）。
  const SUPERVISOR_ALLOWED_BASE_TOOL_NAMES = new Set([
    'ask_user',
    'plugin_inspect',
    'plugin_define',
    'plugin_run',
    'plugin_stop',
    'plugin_undefine',
    'plugin_test',
    'plugin_install',
    'plugin_uninstall',
  ])
  supervisorLoopTools = [
    ...tools.filter((t) => SUPERVISOR_ALLOWED_BASE_TOOL_NAMES.has(t.name)),
    ...createSupervisorTools({
      listSessions: () =>
        [...sessions.values()]
          .filter((s) => !s.isSupervisor)
          .map((s) => describeSession(s.id))
          .filter((s): s is SessionStateSummary => s !== null),
      inspectSession: (sid) => describeSession(sid),
      listModels: () => allModels().map((m) => ({ id: m.id, name: m.displayName ?? m.name ?? m.id })),
      sendMessage: (sid, message, mode) => sendMessageToSession(sid, message, mode),
      switchSession: (sid) => switchSupervisorFocus(sid),
      setSessionModel: (sid, modelId) => setSessionModelInternal(sid, modelId),
      setSessionApproval: (sid, policy) => setSessionApprovalInternal(sid, policy),
      createSession: (title, workdir) => {
        const id = createSessionInternal(title, workdir)
        const created = sessions.get(id)
        return { ok: true, message: `已创建会话「${created?.title ?? '新会话'}」(${id})`, sessionId: id }
      },
      renameSession: (sid, title) => renameSessionInternal(sid, title),
      deleteSession: (sid) => deleteSessionInternal(sid),
      setSessionWorkdir: (sid, workdir) => setSessionWorkdirInternal(sid, workdir),
      askSessionPicker: (question) =>
        askService
          .ask(question, {
            kind: 'session-picker',
            sessionOptions: [...sessions.values()]
              .filter((s) => !s.isSupervisor)
              .map((s) => describeSession(s.id))
              .filter((s): s is SessionStateSummary => s !== null)
              .map((s) => ({
                id: s.id,
                title: s.title,
                busy: s.busy,
                active: s.active,
                modelName: s.modelName,
                workDir: s.workDir,
                contextUsageRatio: s.contextUsageRatio,
                currentRequest: s.currentRequest,
              })),
            sessionId: SUPERVISOR_ID,
          })
          .then((answer) => (answer === ASK_CANCELLED ? '' : answer)),
      askModelPicker: (question) =>
        askService
          .ask(question, {
            kind: 'model-picker',
            modelOptions: allModels().map((m) => ({ id: m.id, name: m.displayName ?? m.name ?? m.id })),
            sessionId: SUPERVISOR_ID,
          })
          .then((answer) => (answer === ASK_CANCELLED ? '' : answer)),
      resolveApproval: (requestId, outcome) => {
        const p = pendingApprovals.get(requestId)
        if (!p) {
          console.log('[supervisor-wake] resolve_approval 未命中：', requestId, 'pendingApprovals 现存=', [...pendingApprovals.keys()].join(','))
          return { ok: false, message: `审批请求不存在或已处理: ${requestId}` }
        }
        p.resolve(outcome)
        pendingApprovals.delete(requestId)
        console.log('[supervisor-wake] resolve_approval 已决策：', requestId, outcome)
        // 广播：UI 据此关闭对应弹窗（管家决策 = 替用户授权，决策后弹窗消失）
        approvalResolvedCallbacks.forEach((cb) => cb(requestId))
        return { ok: true, message: `已${outcome === 'rejected' ? '拒绝' : '批准'}审批请求 ${requestId}` }
      },
      answerAsk: (requestId, answer) => {
        const resolved = askService.respond(requestId, answer)
        if (!resolved) return { ok: false, message: `提问请求不存在或已处理: ${requestId}` }
        // 广播：UI 据此关闭对应弹窗（管家代答 = 替用户回答，代答后弹窗消失）
        askResolvedCallbacks.forEach((cb) => cb(requestId))
        return { ok: true, message: `已代答提问 ${requestId}` }
      },
    }).map(wrapTool),
  ]

  /** 管家执行入口：临时切管家会话模型/审批策略，单步 ReAct + 管家工具集，执行完还原 */
  const runSupervisorInternal = async (message: string, attachments?: ContentPart[], modelIdOverride?: string): Promise<string> => {
    const supMeta = sessions.get(SUPERVISOR_ID)
    // modelIdOverride：resend/retry 等在截断后调用时，截断可能已删掉 model/select 事件，需显式传入截断前读到的持久化模型
    const supModel = modelIdOverride ?? (supMeta ? effectiveModelId(supMeta.session.list()) : undefined)
    const targetModelId = supModel ?? defaultModelId
    const savedModelId = currentModelId
    if (targetModelId) applyModel(targetModelId)
    approval.setPolicy(sessionApprovalPolicy(SUPERVISOR_ID))
    try {
      return await runInSession(SUPERVISOR_ID, message, attachments ? { attachments } : undefined)
    } finally {
      // 还原用户上下文（模型 + 审批策略）
      if (savedModelId) applyModel(savedModelId)
      approval.setPolicy(sessionApprovalPolicy())
    }
  }

  /** 串行消费待管家决策队列：管家空闲时逐条取出审批/提问 prompt，用独立 runSupervisorInternal 处理。
   *  每个决策一个独立 loop，处理完（runInSession finally 会再次 drain）再取下一条，杜绝注入悬空导致的会话永久挂起。 */
  async function drainSupervisorWake(): Promise<void> {
    if (supervisorWaking) {
      console.log('[supervisor-wake] drain 跳过：已有 drain 在跑（supervisorWaking=true），queue=', supervisorWakeQueue.length)
      return
    }
    // 管家正忙（runningLoops 里有管家 loop）：不启动新 loop，避免 set 覆盖；等管家结束（runInSession finally）再 drain
    if (runningLoops.has(SUPERVISOR_ID)) {
      console.log('[supervisor-wake] drain 跳过：管家正忙（runningLoops 有 SUPERVISOR_ID），queue=', supervisorWakeQueue.length)
      return
    }
    supervisorWaking = true
    console.log('[supervisor-wake] drain 启动，queue=', supervisorWakeQueue.length)
    try {
      while (supervisorWakeQueue.length > 0 && !runningLoops.has(SUPERVISOR_ID)) {
        const prompt = supervisorWakeQueue.shift()!
        console.log('[supervisor-wake] 取出 prompt 开始处理，剩余 queue=', supervisorWakeQueue.length)
        try {
          await runSupervisorInternal(prompt)
          console.log('[supervisor-wake] prompt 处理完成')
        } catch (err) {
          // 单个决策失败（如管家 LLM 调用失败）不中断整条队列，继续处理下一个审批/提问。
          // 失败的那个审批/提问请求仍挂在 pendingApprovals / pending 里（弹窗照常显示），用户可手动决策兜底。
          console.error('[supervisor-wake] 管家决策处理失败，继续处理队列下一条:', err instanceof Error ? err.message : err)
        }
      }
      console.log('[supervisor-wake] while 退出：queue=', supervisorWakeQueue.length, 'runningLoops.has=', runningLoops.has(SUPERVISOR_ID))
    } finally {
      supervisorWaking = false
      console.log('[supervisor-wake] drain 结束，supervisorWaking=false')
    }
  }

  /** 唤醒管家决策审批：把审批请求注入管家会话，触发管家跑一轮，由管家调用 resolve_approval 工具决策。
   *  管家空闲则异步执行；管家正忙则注入（在下一轮模型调用前生效，不打断当前管家动作）。 */
  function wakeSupervisorForApproval(req: { id: string; sessionId?: string; toolName: string; args: Record<string, unknown>; riskLevel: string }): void {
    const sid = req.sessionId ?? ''
    const title = sid ? (sessions.get(sid)?.title ?? sid) : sid
    const prompt =
      `【审批请求】会话「${title}」请求执行工具 ${req.toolName}（风险等级 ${req.riskLevel}）。\n` +
      `参数：${JSON.stringify(req.args)}\n\n` +
      `请判断是否批准该操作，并调用 resolve_approval 工具决策：requestId="${req.id}"，outcome 取 allowed-once（批准）或 rejected（拒绝）。` +
      `若风险过高或参数可疑请拒绝；不要替该会话执行具体操作。`
    supervisorWakeQueue.push(prompt)
    // 实时广播到管家窗口：审批请求 prompt 立即显示为管家窗口的 user 气泡（否则要等决策结束 onSessionActivity('end') 重建 items 才出现）
    const supMeta = sessions.get(SUPERVISOR_ID)
    const turnSeq = supMeta ? supMeta.session.list().filter((e) => e.type === 'user/message' && !(e.data as { injected?: boolean }).injected).length + 1 : 1
    userMessageCallbacks.forEach((cb) => cb(SUPERVISOR_ID, prompt, turnSeq))
    console.log('[supervisor-wake] 审批请求入队：', req.id, req.toolName, 'queue=', supervisorWakeQueue.length, 'supervisorWaking=', supervisorWaking, 'runningLoops.has=', runningLoops.has(SUPERVISOR_ID))
    void drainSupervisorWake()
  }

  /** 唤醒管家代答提问：把提问注入管家会话，触发管家跑一轮，由管家调用 answer_ask 工具代答。
   *  管家空闲则异步执行；管家正忙则注入（在下一轮模型调用前生效，不打断当前管家动作）。 */
  function wakeSupervisorForAsk(req: AskRequest): void {
    const sid = req.sessionId ?? ''
    const title = sid ? (sessions.get(sid)?.title ?? sid) : sid
    const optionsText = req.options && req.options.length > 0 ? `\n可选项：${req.options.map((o) => `「${o}」`).join(' / ')}` : ''
    const prompt =
      `【提问请求】会话「${title}」向你提问：${req.question}${optionsText}\n\n` +
      `请以用户视角判断并回答该问题，调用 answer_ask 工具代答：requestId="${req.id}"，answer 填你的回答。` +
      `有可选项时从可选项里选一个最合适的作为 answer；无选项时给出简短明确的文字回答。不要替该会话执行具体操作。`
    supervisorWakeQueue.push(prompt)
    // 实时广播到管家窗口：提问请求 prompt 立即显示为管家窗口的 user 气泡（否则要等决策结束 onSessionActivity('end') 重建 items 才出现）
    const supMeta = sessions.get(SUPERVISOR_ID)
    const turnSeq = supMeta ? supMeta.session.list().filter((e) => e.type === 'user/message' && !(e.data as { injected?: boolean }).injected).length + 1 : 1
    userMessageCallbacks.forEach((cb) => cb(SUPERVISOR_ID, prompt, turnSeq))
    console.log('[supervisor-wake] 提问请求入队：', req.id, 'queue=', supervisorWakeQueue.length, 'supervisorWaking=', supervisorWaking, 'runningLoops.has=', runningLoops.has(SUPERVISOR_ID))
    void drainSupervisorWake()
  }

  // 提问接管：管家下发的任务里会话发起 ask_user 时，若「管家接管提问」开关开启，唤醒管家代答。
  // 仅管家下发的任务触发（sessionOrigin==='supervisor'）；用户侧始终只走弹窗手动回答，弹窗照常显示、用户始终可手动点。
  askService.onRequest((req) => {
    const origin = req.sessionId ? (sessionOrigin.get(req.sessionId) ?? 'user') : 'user'
    if (origin === 'supervisor' && currentSettings.supervisorAsk.enabled) {
      void wakeSupervisorForAsk(req)
    }
  })

  return {
    kernel,
    session: sessionRef,
    tools,
    model,
    memory,
    credentials,
    voice,
    computerUse,
    browserUse,

    loggedIn,
    username,
    getMemberToken() {
      return memberToken
    },
    getDeviceInfo() {
      return deviceInfo ?? {
        deviceId: '',
        deviceName: osHostname(),
        hostname: osHostname(),
        os: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',
      }
    },
    async setDeviceName(name) {
      const trimmed = name.trim()
      if (!trimmed) return
      await withConfigFile((cfg) => {
        cfg.deviceName = trimmed
      })
      if (deviceInfo) deviceInfo.deviceName = trimmed
    },
    async login(u, p) {
      const s = await authService.login(u, p)
      loggedIn = true
      username = s.nickname ?? s.username
      memberToken = s.token
      // 拉取会员模型列表（含 apiKey + baseUrl），登录后切换到真实网关模型（不再是 mock）
      const models = await authService.fetchModels(s.token)
      const first = models[0]
      if (first) {
        gatewayModels = models.map((m) => ({ ...m, tier: inferTier(m.id) }))
        gatewayApiKey = first.apiKey
        gatewayBaseUrl = first.baseUrl
        const cached = currentModelId
        // 默认模型：优先用户上次选择 → 项目主力 deepseek-v4-flash → 列表第一个
        const target =
          gatewayModels.find((m) => m.id === cached) ??
          gatewayModels.find((m) => m.id === 'deepseek-v4-flash') ??
          gatewayModels[0]
        if (target) {
          applyModel(target.id)
          defaultModelId = target.id
        }
      }
      refreshContextLength()
      await persistLoginToken(s.token, s.username, { nickname: s.nickname, avatar: s.avatar }, {
        apiKey: gatewayApiKey,
        baseUrl: gatewayBaseUrl,
        selectedModelId: currentModelId,
      })
      return { username: s.nickname ?? s.username, nickname: s.nickname }
    },
    async logout() {
      loggedIn = false
      username = null
      gatewayApiKey = ''
      gatewayBaseUrl = ''
      memberToken = ''
      gatewayModels = []
      // 只清除登录凭证字段，保留用户自定义模型 + 选中模型偏好
      try {
        await withConfigFile((cfg) => {
          const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
          delete g.memberToken
          delete g.apiKey
          delete g.baseUrl
          delete g.account
          delete g.models
          cfg.gateway = g
        })
      } catch {
        // 忽略持久化失败
      }
      // 恢复模型：当前选中模型若仍可用（自定义模型或 DeepSeek 网页版，均不依赖登录），则继续用；否则回退 mock
      const target = allModels().find((m) => m.id === currentModelId)
      if (target?.source === 'deepseek-bridge') {
        model = createDeepSeekModel({ chat: deepSeekChat, getWorkspace: currentWorkDir })
      } else if (target?.baseUrl) {
        model = createModelProvider({ apiKey: target.apiKey, baseUrl: target.baseUrl, model: target.model ?? target.id, protocol: target.protocol, maxTokens: target.maxTokens, onUsage, onTrace: onHttpTrace })
      } else {
        model = await createGatewayModel(onUsage, onHttpTrace)
      }
      // 退出登录后网关模型全部失效，清空全局默认模型（重新登录后重新设置）
      defaultModelId = ''
      refreshContextLength()
    },
    async listModels() {
      // 系统内置 + 用户自定义（自定义 custom: true，UI 分组展示）
      return allModels()
    },
    async refreshModels() {
      return refreshGatewayModels()
    },
    onModelsChanged(cb) {
      modelsChangedCallbacks.add(cb)
      return () => {
        modelsChangedCallbacks.delete(cb)
      }
    },
    onAuthExpired(cb) {
      authExpiredCallbacks.add(cb)
      return () => {
        authExpiredCallbacks.delete(cb)
      }
    },
    async addCustomModel(input) {
      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const custom: GatewayModel = {
        id,
        name: input.name || input.model,
        model: input.model,
        tier: 'flagship',
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        protocol: input.protocol,
        custom: true,
      }
      customModels = [...customModels, custom]
      await persistCustomModels(customModels)
      return custom
    },
    async updateCustomModel(id, input) {
      const existing = customModels.find((m) => m.id === id)
      if (!existing) throw new Error(`自定义模型不存在: ${id}`)
      const updated: GatewayModel = {
        id: existing.id,
        name: input.name || input.model,
        model: input.model,
        tier: existing.tier,
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        protocol: input.protocol,
        contextLength: existing.contextLength,
        maxTokens: existing.maxTokens,
        temperature: existing.temperature,
        supportsVision: existing.supportsVision,
        supportsReasoning: existing.supportsReasoning,
        provider: existing.provider,
        sortOrder: existing.sortOrder,
        description: existing.description,
        source: existing.source,
        custom: true,
      }
      customModels = customModels.map((m) => (m.id === id ? updated : m))
      // 若正在使用该模型，同步更新 provider
      if (currentModelId === id && updated.baseUrl) {
        model = createModelProvider({ apiKey: updated.apiKey, baseUrl: updated.baseUrl, model: updated.model ?? updated.id, protocol: updated.protocol, maxTokens: updated.maxTokens, onUsage, onTrace: onHttpTrace })
      }
      await persistCustomModels(customModels)
      return updated
    },
    async removeCustomModel(id) {
      customModels = customModels.filter((m) => m.id !== id)
      if (currentModelId === id) {
        currentModelId = ''
        model = await createGatewayModel(onUsage, onHttpTrace)
      }
      refreshContextLength()
      await persistCustomModels(customModels)
    },
    selectedTier,

    listSessions() {
      // 后端不排序，返回原始字段。busy 是「运行态」（内存态）：只有当前进程内正在执行任务的会话才算 busy。
      // 进程重启后 runningLoops 为空，任何会话都不该显示「处理中」；「未完成轮次（可继续执行）」由 hasIncompleteTurn 单独判断，与 busy 无关。
      // 管家超级会话不暴露给用户侧边栏（由独立 supervisor 窗口承载）。
      return [...sessions.values()]
        .filter((s) => !s.isSupervisor)
        .map((s) => ({
          id: s.id,
          title: s.title,
          workDir: s.workDir,
          lastActiveAt: s.lastActiveAt,
          busy: runningLoops.has(s.id),
        }))
    },
    switchSession(id) {
      switchSessionInternal(id)
    },
    describeSession(sessionId) {
      return describeSession(sessionId)
    },
    sendMessageToSession(sessionId, message, mode) {
      return sendMessageToSession(sessionId, message, mode ?? 'insert')
    },
    runSession(sessionId, message, mode) {
      return runSession(sessionId, message, mode ?? 'insert')
    },
    setSessionModel(sessionId, modelId) {
      return setSessionModelInternal(sessionId, modelId)
    },
    setSessionApprovalPolicy(sessionId, policy) {
      return setSessionApprovalInternal(sessionId, policy)
    },
    getSupervisorModel() {
      return getSupervisorModelInternal()
    },
    getSupervisorApprovalPolicy() {
      return getSupervisorApprovalInternal()
    },
    setSupervisorModel(modelId) {
      return setSupervisorModelInternal(modelId)
    },
    setSupervisorApprovalPolicy(policy) {
      return setSupervisorApprovalInternal(policy)
    },
    renameSession(id, title) {
      renameSessionInternal(id, title)
    },
    async deleteSession(id) {
      await deleteSessionInternal(id)
    },
    getSessionWorkdir(id) {
      const meta = sessions.get(id ?? currentSessionId ?? '')
      return meta?.workDir ?? join(homedir(), 'shanhai', 'workspace')
    },
    setSessionWorkdir(id, workdir) {
      setSessionWorkdirInternal(id, workdir)
    },
    async saveUploadedFile(fileName, dataBase64) {
      const dir = currentWorkDir()
      await fs.mkdir(dir, { recursive: true })
      // 防路径穿越：只取文件名（丢弃任何路径部分），加时间戳前缀避免重名覆盖
      const safeName = `${Date.now()}-${basename(fileName || 'file')}`
      const target = join(dir, safeName)
      await fs.writeFile(target, Buffer.from(dataBase64, 'base64'))
      return target
    },
    async uploadImage(imageBase64, mimeType) {
      return uploadImage(imageBase64, mimeType)
    },
    async listBrowserWindows(sessionId) {
      const sid = sessionId ?? currentSessionId ?? ''
      const all = await browserUse.list()
      // 会话级隔离：只返回该会话（appId 等于 sid 或 sid: 前缀）的窗口
      return all.filter((w) => w.appId === sid || w.appId.startsWith(`${sid}:`))
    },
    async showBrowserWindow(appId) {
      await browserUse.show(appId)
    },
    async closeBrowserWindow(appId) {
      await browserUse.close(appId)
    },
    async userTerminalCreate(sessionId, name) {
      const sid = sessionId ?? currentSessionId ?? ''
      // 传入 `${sid}:default`，create 会把冒号规范化为连字符 → `${sid}-default`（已存在则自动加 -2/-3），
      // 与 agent 终端技能的 terminalId 格式一致，会话级隔离。
      // 打开终端默认在当前会话工作目录（而非用户主目录），让用户直接在项目目录下操作。
      const cwd = sessions.get(sid)?.workDir ?? join(homedir(), 'shanhai', 'workspace')
      const terminalId = await terminalUse.create(`${sid}:default`, name, cwd)
      userTerminalSessionMap.set(terminalId, sid)
      return terminalId
    },
    userTerminalWrite(sessionId, terminalId, data) {
      terminalUse.write(terminalId, data)
    },
    userTerminalResize(sessionId, terminalId, cols, rows) {
      terminalUse.resize(terminalId, cols, rows)
    },
    async userTerminalClose(sessionId, terminalId) {
      await terminalUse.close(terminalId)
      userTerminalSessionMap.delete(terminalId)
    },
    async userTerminalList(sessionId) {
      const sid = sessionId ?? currentSessionId ?? ''
      const all = await terminalUse.list()
      // 会话级隔离：只返回该会话（terminalId 以 `${sid}-` 开头）的终端
      return all.filter((t) => t.terminalId.startsWith(`${sid}-`))
    },
    onUserTerminalOutput(cb) {
      userTerminalOutputCallbacks.add(cb)
      return () => {
        userTerminalOutputCallbacks.delete(cb)
      }
    },
    async getDeepSeekBridgeStatus() {
      try {
        const sid = currentSessionId ?? ''
        if (!sid) return { windowReady: false, bridgeInjected: false }
        const wins = await browserUse.list()
        const windowReady = wins.some((w) => w.appId === sid)
        let bridgeInjected = false
        if (windowReady) {
          bridgeInjected = Boolean(await browserUse.evaluate(BRIDGE_READY_CHECK, sid).catch(() => false))
        }
        return { windowReady, bridgeInjected }
      } catch {
        return { windowReady: false, bridgeInjected: false }
      }
    },
    async openDeepSeekBridge() {
      try {
        await ensureDeepSeekBridgeWindow()
        return { ok: true, message: '已打开当前会话的 DeepSeek 页面并注入桥接脚本，请在该窗口登录 chat.deepseek.com（登录态跨会话通用）' }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
    async injectDeepSeekBridge() {
      try {
        await ensureDeepSeekBridgeWindow()
        return { ok: true, message: '桥接脚本已注入当前会话的 DeepSeek 页面，请保持页面打开' }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
    getSessionHistory(id) {
      const target = sessions.get(id ?? currentSessionId ?? '')
      if (!target) return []
      const out: Array<{ kind: 'user' | 'assistant' | 'tool'; content?: string; reasoningContent?: string; trace?: ToolTrace; attachments?: unknown[]; turnSeq?: number; turnDuration?: number }> = []
      let userSeq = 0
      let turnStartTs = 0
      const toolStartMap = new Map<string, number>()
      for (const e of target.session.list()) {
        if (e.type === 'user/message') {
          const d = e.data as { content: string; attachments?: unknown[]; injected?: boolean }
          // 插入模式注入的消息（injected）不显示为独立用户气泡：跳过，追加需求由最终回答正文体现。
          // 它不产生新的轮次，也不计入 turnSeq / turnStartTs（该轮耗时仍从原始 user 消息起算）。
          if (d.injected) continue
          userSeq += 1
          turnStartTs = e.timestamp
          out.push({ kind: 'user', content: d.content, attachments: d.attachments, turnSeq: userSeq })
        } else if (e.type === 'assistant/message') {
          const d = e.data as { content: string; reasoningContent?: string }
          // 该轮任务耗时 = 用户消息 → 最终回答（中间可能含多轮工具调用）的间隔
          const turnDuration = turnStartTs > 0 ? e.timestamp - turnStartTs : undefined
          out.push({ kind: 'assistant', content: d.content, reasoningContent: d.reasoningContent, turnSeq: userSeq, turnDuration })
        } else if (e.type === 'tool/call') {
          const d = e.data as { callId: string; name: string; args: Record<string, unknown>; reasoningContent?: string }
          toolStartMap.set(d.callId, e.timestamp)
          out.push({ kind: 'tool', trace: { kind: 'tool-call', sessionId: target.id, callId: d.callId, name: d.name, args: d.args, reasoning: d.reasoningContent, startTs: e.timestamp } })
        } else if (e.type === 'tool/result') {
          const d = e.data as { callId: string; name: string; result?: unknown; error?: string }
          const startTs = toolStartMap.get(d.callId)
          const durationMs = startTs != null && startTs > 0 ? e.timestamp - startTs : undefined
          out.push({ kind: 'tool', trace: { kind: 'tool-result', sessionId: target.id, callId: d.callId, name: d.name, result: d.result, error: d.error, durationMs } })
        }
      }
      return out
    },
    getSessionTrace(id) {
      const target = sessions.get(id ?? currentSessionId ?? '')
      if (!target) return []
      const out: Array<{
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
      }> = []
      let turn = 0
      for (const e of target.session.list()) {
        if (e.type === 'turn/start') {
          turn = (e.data as { turn: number }).turn
        } else if (e.type === 'user/message') {
          const d = e.data as { content: string; attachments?: unknown[] }
          out.push({ role: 'user', content: d.content, turn, timestamp: e.timestamp })
        } else if (e.type === 'assistant/message') {
          const d = e.data as { content: string; reasoningContent?: string }
          out.push({ role: 'assistant', content: d.content, reasoningContent: d.reasoningContent, turn, timestamp: e.timestamp })
        } else if (e.type === 'tool/call') {
          const d = e.data as { callId: string; name: string; args: Record<string, unknown>; reasoningContent?: string }
          out.push({ role: 'assistant', content: '', reasoningContent: d.reasoningContent, toolCalls: [{ id: d.callId, name: d.name, args: d.args }], turn, timestamp: e.timestamp })
        } else if (e.type === 'tool/result') {
          const d = e.data as { callId: string; name: string; result?: unknown; error?: string }
          const text = d.error ?? (typeof d.result === 'string' ? d.result : JSON.stringify(d.result ?? ''))
          out.push({ role: 'tool', content: text, toolCallId: d.callId, toolName: d.name, result: d.result, error: d.error, turn, timestamp: e.timestamp })
        }
        // assistant/delta 是流式中间态（最终内容在 assistant/message），approval/* 为审批痕迹，轨迹面板聚焦消息痕迹
      }
      return out
    },
    createSession(title, workdir) {
      const id = newSession(title ?? '新会话', workdir)
      // 新会话无 model/select 记录：回退全局默认模型（defaultModelId 为空则保持现状，未登录时无模型可切）
      if (defaultModelId) applyModel(defaultModelId)
      // 新会话默认预创建一个浏览器窗口
      ensureDefaultBrowserWindow(id)
      return id
    },
    getHistory() {
      const target = sessions.get(currentSessionId ?? '')
      if (!target) return []
      const out: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; toolName?: string }> = []
      for (const e of target.session.list()) {
        if (e.type === 'user/message') {
          out.push({ role: 'user', content: (e.data as { content: string }).content })
        } else if (e.type === 'assistant/message') {
          out.push({ role: 'assistant', content: (e.data as { content: string }).content })
        } else if (e.type === 'tool/call') {
          out.push({ role: 'tool', content: '', toolName: (e.data as { name: string }).name })
        } else if (e.type === 'tool/result') {
          const d = e.data as { result?: unknown; error?: string }
          out.push({ role: 'tool', content: JSON.stringify(d.result ?? d.error ?? '') })
        }
      }
      return out
    },

    onToolTrace(cb) {
      toolTraceCallbacks.add(cb)
      return () => toolTraceCallbacks.delete(cb)
    },
    onApprovalRequest(cb) {
      approvalCallbacks.add(cb)
      return () => approvalCallbacks.delete(cb)
    },
    respondApproval(outcome, requestId) {
      const p = pendingApprovals.get(requestId)
      if (p) {
        p.resolve(outcome)
        pendingApprovals.delete(requestId)
      }
    },
    onApprovalResolved(cb) {
      approvalResolvedCallbacks.add(cb)
      return () => approvalResolvedCallbacks.delete(cb)
    },
    onAskResolved(cb) {
      askResolvedCallbacks.add(cb)
      return () => askResolvedCallbacks.delete(cb)
    },
    onAskRequest(cb) {
      return askService.onRequest(cb)
    },
    respondAsk(requestId, answer) {
      askService.respond(requestId, answer)
    },
    cancelAsk(requestId) {
      askService.cancel(requestId)
    },

    onDelta(cb) {
      deltaCallbacks.add(cb)
      return () => {
        deltaCallbacks.delete(cb)
      }
    },

    onReasoning(cb) {
      reasoningCallbacks.add(cb)
      return () => {
        reasoningCallbacks.delete(cb)
      }
    },

    onSessionActivity(cb) {
      sessionActivityCallbacks.add(cb)
      return () => {
        sessionActivityCallbacks.delete(cb)
      }
    },

    onCurrentSessionChanged(cb) {
      currentSessionChangedCallbacks.add(cb)
      return () => {
        currentSessionChangedCallbacks.delete(cb)
      }
    },

    onSupervisorResult(cb) {
      supervisorResultCallbacks.add(cb)
      return () => {
        supervisorResultCallbacks.delete(cb)
      }
    },

    onUserMessage(cb) {
      userMessageCallbacks.add(cb)
      return () => {
        userMessageCallbacks.delete(cb)
      }
    },

    getTokenStats(sessionId?: string) {
      return snapshot(sessionId)
    },
    onTokenStats(cb) {
      tokenCallbacks.add(cb)
      return () => {
        tokenCallbacks.delete(cb)
      }
    },

    switchModel(modelId) {
      applyModel(modelId)
      // 全局默认模型随选择更新（新会话 / 无记录会话回退用），持久化到 config.json
      defaultModelId = modelId
      void persistSelectedModel(modelId)
      // 会话级：向当前会话事件日志追加 model/select 事件，切回该会话时回放恢复（对齐 approval/policy 模式）
      const meta = currentSessionId ? sessions.get(currentSessionId) : undefined
      if (meta) {
        meta.session.append('model/select', { modelId })
        void persistSession(meta)
      }
    },
    getCurrentModelId() {
      return currentModelId
    },
    stop() {
      if (currentSessionId) stopSessionInternal(currentSessionId)
    },
    stopSession(sessionId) {
      stopSessionInternal(sessionId)
    },

    run: async (message, opts) => {
      const sid = currentSessionId
      if (!sid) throw new Error('没有活动会话')
      return runInSession(sid, message, opts)
    },

    runSupervisor: (message, attachments) => runSupervisorInternal(message, attachments),

    resend: async (sessionId, userMessageIndex, newContent) => {
      const meta = sessions.get(sessionId)
      if (!meta) throw new Error(`会话不存在: ${sessionId}`)
      const events = meta.session.list()
      // 截断前先取该会话持久化模型（model/select 可能位于被截断区，须先读取；管家会话模型同样持久化在其会话日志里）
      const effModelId = effectiveModelId(events) ?? defaultModelId
      // 定位第 userMessageIndex 条用户消息（0 起），拿到原内容
      let userCount = 0
      let targetIdx = -1
      let originalContent = ''
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e?.type === 'user/message') {
          const d = e.data as { content: string; injected?: boolean }
          // 跳过注入消息（injected）：它们不显示为用户气泡、不计入 userMessageIndex 序号，
          // 否则与前端 getSessionHistory（同样跳过 injected）的序号错位，导致截断到错误的节点。
          if (d.injected) continue
          if (userCount === userMessageIndex) {
            targetIdx = i
            originalContent = d.content
            break
          }
          userCount++
        }
      }
      if (targetIdx < 0) throw new Error(`用户消息不存在: #${userMessageIndex}`)
      const content = newContent !== undefined ? newContent : originalContent
      // 截断到该用户消息之前（丢弃它及其后的回复/工具过程），重新生成
      meta.session.truncate(targetIdx)
      // 管家会话：走管家入口（正确切换管家模型 + 管家审批策略 + 管家工具集），避免落到全局 currentModelId 错用普通会话模型
      if (sessionId === SUPERVISOR_ID) {
        return runSupervisorInternal(content, undefined, effModelId)
      }
      // 普通会话：显式用该会话持久化模型，避免依赖全局 currentModelId（后台/切走时可能不一致）
      return runInSession(sessionId, content, undefined, effModelId)
    },

    resume: async (sessionId) => {
      const sid = sessionId
      const meta = sessions.get(sid)
      if (!meta) throw new Error(`会话不存在: ${sid}`)
      const events = meta.session.list()

      // 判断最后一个未完成轮次是「单步 ReAct」还是「多专家编排」：多专家专家 Session 不持久化，无法恢复编排进度，降级重新拆解
      let lastTurnMode: 'single' | 'multi' = 'single'
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'turn/start') {
          lastTurnMode = (events[i]!.data as { mode?: 'single' | 'multi' }).mode ?? 'single'
          break
        }
      }
      // 找最后一条非注入用户消息（多专家降级截断用 + 单步记忆检索用）
      let lastUserIdx = -1
      let lastUserContent = ''
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'user/message') {
          const d = events[i]!.data as { injected?: boolean; content: string }
          // 跳过注入消息（injected）：它们不产生独立轮次，不是可继续的「用户消息」
          if (d.injected) continue
          lastUserIdx = i
          lastUserContent = d.content
          break
        }
      }
      if (lastUserIdx < 0) throw new Error('没有可继续的消息')

      // 多专家编排：断点续跑——回放 plan + 已完成步骤结果，跳过已完成步骤、只重跑未完成步骤
      if (lastTurnMode === 'multi') {
        // 1. 从会话日志回放拆解计划 + 已完成步骤结果
        let plan: TaskPlan | null = null
        const completedResults = new Map<string, string>()
        const completedSteps = new Set<string>()
        let lastCompletedIdx = -1
        for (let i = 0; i < events.length; i++) {
          const e = events[i]
          if (e?.type === 'orchestrator/plan') {
            plan = (e.data as { plan: TaskPlan }).plan
            lastCompletedIdx = i
          } else if (e?.type === 'orchestrator/step') {
            const d = e.data as { stepId: string; status: 'started' | 'completed' | 'failed'; result?: string }
            if (d.status === 'completed') {
              completedSteps.add(d.stepId)
              if (d.result != null) completedResults.set(d.stepId, d.result)
              lastCompletedIdx = i
            }
          }
        }
        // 无计划（异常，如旧版本日志）：降级为重新拆解执行
        if (!plan || lastCompletedIdx < 0) {
          meta.session.truncate(lastUserIdx)
          return runInSession(sid, lastUserContent)
        }
        // 2. 截断主会话日志到最后一个 completed step 之后（清掉未完成 step 的 started + 部分工具事件）
        meta.session.truncate(lastCompletedIdx + 1)

        // 3. 重建专家 + Orchestrator，从 plan + 已完成结果继续（跳过已完成步骤）
        stoppedSessions.delete(sid)
        touchSession(sid)
        const effModelId = effectiveModelId(events) ?? defaultModelId
        const effModel = resolveProvider(effModelId)
        const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId))
        const expertAgents = buildExpertAgents(sid, visionCapable, effModelId, meta.session)
        multiExpertLoops.set(sid, expertAgents)
        sessionActivityCallbacks.forEach((cb) => cb(sid, 'start'))
        let expertReasoning = ''
        try {
          const orchestrator = new Orchestrator(triage, expertAgents, {
            sessionId: sid,
            expertNames: roleNameById(),
            expertSystemPrompts: buildExpertSystemPrompts(meta.workDir, lastUserContent),
            onStep: (trace) => {
              const turnSeq = meta.session.list().filter((e) => e.type === 'user/message').length
              meta.session.append('orchestrator/step', { stepId: trace.stepId, expertId: trace.expertId, title: trace.title, status: trace.status, result: trace.result, error: trace.error })
              expertTraceCallbacks.forEach((cb) => cb({ ...trace, turnSeq }))
            },
            onDelta: (text) => {
              if (stoppedSessions.has(sid)) throw new Error('__stopped__')
              deltaCallbacks.forEach((cb) => cb(sid, text))
            },
            onReasoning: (text) => {
              expertReasoning += text
              reasoningCallbacks.forEach((cb) => cb(sid, text))
            },
            summarize: async (task, steps, onDelta) => {
              const parts = steps.map((s, i) => `${i + 1}. [${s.expert}] ${s.title}\n${s.result}`).join('\n\n')
              const systemPrompt =
                '你是「山海」的结果汇总器。下面是一次多专家协作任务中各位专家的执行结果，以及用户最初的问题。请把它们汇总成一段连贯、简洁、直接回答用户问题的最终结果：只输出最终答案本身，不要罗列专家名、不要复述执行过程、不要加分节标题（除非用户明确要求）。'
              const userPrompt = `【用户的问题】\n${task}\n\n【各专家执行结果】\n${parts}`
              const messages = [
                { role: 'system' as const, content: systemPrompt },
                { role: 'user' as const, content: userPrompt },
              ]
              let full = ''
              try {
                if (effModel.stream) {
                  for await (const chunk of effModel.stream(messages, [])) {
                    if (stoppedSessions.has(sid)) throw new Error('__stopped__')
                    if (chunk.text) {
                      full += chunk.text
                      onDelta(chunk.text)
                    }
                  }
                } else {
                  const res = await effModel.complete(messages, [])
                  full = res.text ?? ''
                  if (full) onDelta(full)
                }
              } catch (err) {
                if (err instanceof Error && (err.message === '__stopped__' || err.message.startsWith('__retry_exhausted__'))) throw err
                console.error('[orchestrator] 汇总失败，回退拼接:', err instanceof Error ? err.message : err)
                return ''
              }
              return full
            },
          })
          const result = await sessionContext.run(sid, () => orchestrator.resume(lastUserContent, plan, completedResults, completedSteps))
          meta.session.append('assistant/message', { content: result.text, reasoningContent: expertReasoning || undefined })
          meta.session.append('turn/end', { turn: 1, text: result.text })
          return result.text
        } catch (err) {
          // 用户再次停止：返回中断（历史仍保留，可再次续跑）
          if (err instanceof Error && err.message === '__stopped__') {
            return '（已中断，历史已保留，可点击「继续执行」续跑）'
          }
          // 重试耗尽：向上传播，前端弹窗让用户选择重试/取消
          throw err
        } finally {
          multiExpertLoops.delete(sid)
          sessionActivityCallbacks.forEach((cb) => cb(sid, 'end'))
          meta.lastActiveAt = Date.now()
          await persistSession(meta)
          emitTokenStats()
          drainSupervisorQueue(sid)
        }
      }

      // 单步 ReAct：断点续跑——回放已执行历史（含完整工具回合），从断点继续，不清空已执行步骤
      stoppedSessions.delete(sid)
      touchSession(sid)
      const isSupervisorRun = sid === SUPERVISOR_ID
      const effModelId = effectiveModelId(events) ?? defaultModelId
      const effModel = resolveProvider(effModelId)
      const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId))
      const loop = new AgentLoop(
        effModel,
        isSupervisorRun ? supervisorLoopTools : tools,
        meta.session,
        approval,
        sid,
        currentContextBudget(effModelId),
        visionCapable,
        currentApiKey(effModelId),
      )
      runningLoops.set(sid, loop)
      sessionActivityCallbacks.forEach((cb) => cb(sid, 'start'))
      let suspended = false
      try {
        return await sessionContext.run(sid, () =>
          loop.resumeRun(
            isSupervisorRun ? buildSupervisorSystemPrompt() : buildSystemPrompt(meta.workDir, buildMemoryContext(lastUserContent)),
            (text) => {
              if (stoppedSessions.has(sid)) throw new Error('__stopped__')
              deltaCallbacks.forEach((cb) => cb(sid, text))
            },
            (text) => reasoningCallbacks.forEach((cb) => cb(sid, text)),
          ),
        )
      } catch (err) {
        // 用户再次停止：返回中断（历史仍保留，可再次续跑）
        if (err instanceof Error && err.message === '__stopped__') {
          return '（已中断，历史已保留，可点击「继续执行」续跑）'
        }
        // 重试耗尽：挂起，保留 loop 供重试弹窗 retry
        if (err instanceof Error && err.message.startsWith('__retry_exhausted__')) {
          suspended = true
        }
        throw err
      } finally {
        if (!suspended) {
          runningLoops.delete(sid)
          sessionActivityCallbacks.forEach((cb) => cb(sid, 'end'))
        }
        meta.lastActiveAt = Date.now()
        await persistSession(meta)
        emitTokenStats()
        drainSupervisorQueue(sid)
      }
    },

    retrySession: async (sessionId) => {
      const sid = sessionId ?? currentSessionId
      const meta = sessions.get(sid)
      if (!meta) throw new Error(`会话不存在: ${sid}`)
      const loop = runningLoops.get(sid)
      if (loop) {
        try {
          // 用失败节点相同的 messages 快照重新提交请求（保持上下文），继续 ReAct 循环
          const result = await sessionContext.run(sid, () => loop.retry())
          // 重试结束更新活跃时间为结束时间，随后落盘
          meta.lastActiveAt = Date.now()
          await persistSession(meta)
          emitTokenStats()
          return result
        } finally {
          // retry 成功后不再挂起 → 移除 loop；retry 又失败耗尽 → 仍挂起 → 保留 loop 供再次重试
          if (!loop.isSuspended()) runningLoops.delete(sid)
        }
      }
      // 无运行中 loop：优先从持久化快照恢复精确重试（重启后仍用失败节点相同的 body 重发），无快照才降级 resume
      const snapshot = readRetrySnapshot(meta)
      if (snapshot) {
        // 用该会话持久化模型 + 对应工具集（管家会话用 supervisorLoopTools），避免错用全局 currentModelId/tools
        const isSupervisorRun = sid === SUPERVISOR_ID
        const effModelId = effectiveModelId(meta.session.list()) ?? defaultModelId
        const effModel = resolveProvider(effModelId)
        const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId))
        const restoredLoop = new AgentLoop(effModel, isSupervisorRun ? supervisorLoopTools : tools, meta.session, approval, sid, currentContextBudget(effModelId), visionCapable, currentApiKey(effModelId))
        restoredLoop.restoreSuspended(snapshot)
        runningLoops.set(sid, restoredLoop)
        try {
          const result = await sessionContext.run(sid, () =>
            restoredLoop.retry(
              (text) => {
                if (stoppedSessions.has(sid)) throw new Error('__stopped__')
                deltaCallbacks.forEach((cb) => cb(sid, text))
              },
              (text) => reasoningCallbacks.forEach((cb) => cb(sid, text)),
            ),
          )
          // 重试结束更新活跃时间为结束时间，随后落盘
          meta.lastActiveAt = Date.now()
          await persistSession(meta)
          emitTokenStats()
          return result
        } finally {
          if (!restoredLoop.isSuspended()) runningLoops.delete(sid)
        }
      }
      // 无快照：多专家/拆解阶段失败，降级 resume（从最后一条用户消息续跑，重新拆解执行）
      const events = meta.session.list()
      let lastUserIdx = -1
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'user/message') {
          const d = events[i]!.data as { injected?: boolean }
          if (d.injected) continue
          lastUserIdx = i
          break
        }
      }
      if (lastUserIdx < 0) throw new Error('没有可继续的消息')
      const content = (events[lastUserIdx]!.data as { content: string }).content
      // 截断前取该会话持久化模型（model/select 可能位于被截断区）
      const effModelId = effectiveModelId(events) ?? defaultModelId
      meta.session.truncate(lastUserIdx)
      if (sid === SUPERVISOR_ID) {
        return runSupervisorInternal(content, undefined, effModelId)
      }
      return runInSession(sid, content, undefined, effModelId)
    },

    abandonSession: async (sessionId) => {
      const sid = sessionId ?? currentSessionId
      // 取消重试：清理挂起 loop + 挂起快照（取消后不再走「重试」，改走「继续执行」resume）。
      // 保留 session 未完成状态（不 append turn/end），让「继续执行」入口可用。
      runningLoops.delete(sid)
      multiExpertLoops.delete(sid)
      const meta = sessions.get(sid)
      if (meta) {
        meta.session.removeLast('retry/snapshot')
        await persistSession(meta)
      }
    },

    hasRetrySnapshot(sessionId) {
      const meta = sessions.get(sessionId)
      if (!meta) return null
      const snap = readRetrySnapshot(meta)
      return snap ? { reason: snap.reason } : null
    },

    injectMessage(sessionId, message) {
      const loop = runningLoops.get(sessionId)
      if (loop) {
        loop.injectUserMessage(message)
        return true
      }
      // 多专家编排：向所有专家注入（各自在下一步模型调用前消费），消息不丢失
      const experts = multiExpertLoops.get(sessionId)
      if (experts && experts.size > 0) {
        for (const expert of experts.values()) expert.injectUserMessage(message)
        return true
      }
      return false
    },

    hasIncompleteTurn(sessionId) {
      const meta = sessions.get(sessionId)
      if (!meta) return false
      const events = meta.session.list()
      let lastUserIdx = -1
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'user/message') {
          const d = events[i]!.data as { injected?: boolean }
          // 跳过注入消息（injected）：它们不产生独立轮次，不作为「未完成轮次」的判据
          if (d.injected) continue
          lastUserIdx = i
          break
        }
      }
      if (lastUserIdx < 0) return false
      // 该用户消息之后若已有 assistant/message 或 turn/end，说明本轮已完成
      for (let i = lastUserIdx + 1; i < events.length; i++) {
        const t = events[i]?.type
        if (t === 'assistant/message' || t === 'turn/end') return false
      }
      return true
    },

    getApprovalPolicy() {
      return sessionApprovalPolicy()
    },

    setApprovalPolicy(policy) {
      const meta = currentSessionId ? sessions.get(currentSessionId) : undefined
      if (!meta) return
      // 会话级：向当前会话事件日志追加 approval/policy 事件（持久化到会话 JSON，重启后回放恢复）
      meta.session.append('approval/policy', { policy })
      approval.setPolicy(policy)
      void persistSession(meta)
    },

    selfmodInspect(sessionId) {
      const sid = sessionId ?? currentSessionId ?? ''
      return selfmod.inspect(sid)
    },

    restoreInstalledPlugins() {
      return selfmod.restoreAll()
    },

    onClientRunRequest(cb) {
      clientRunCallbacks.add(cb)
      return () => clientRunCallbacks.delete(cb)
    },

    respondClientRun(requestId, approved) {
      const p = pendingClientRuns.get(requestId)
      if (p) {
        p.resolve(approved)
        pendingClientRuns.delete(requestId)
      }
    },

    onClientCode(cb) {
      clientCodeCallbacks.add(cb)
      return () => clientCodeCallbacks.delete(cb)
    },

    onClientRemove(cb) {
      clientRemoveCallbacks.add(cb)
      return () => clientRemoveCallbacks.delete(cb)
    },

    onExpertTrace(cb) {
      expertTraceCallbacks.add(cb)
      return () => expertTraceCallbacks.delete(cb)
    },

    listExperts() {
      return [...roleRegistry.values()].map((r) => ({ ...r, builtin: BUILTIN_ROLES.some((b) => b.id === r.id) }))
    },

    async registerExpert(role) {
      const id = (role.id ?? '').trim()
      const name = (role.name ?? '').trim()
      if (!id) throw new Error('专家 id 不能为空')
      if (!name) throw new Error('专家名称不能为空')
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('专家 id 只能包含字母、数字、下划线、连字符')
      if (BUILTIN_ROLES.some((b) => b.id === id)) throw new Error(`内置专家 "${id}" 不可覆盖，请换一个 id`)
      const def: RoleDefinition = {
        id,
        name,
        description: (role.description ?? '').trim(),
        systemPrompt: (role.systemPrompt ?? '').trim(),
        toolSet: [],
        skillSet: [],
      }
      roleRegistry.set(id, def)
      await persistCustomRoles([...roleRegistry.values()].filter((r) => !BUILTIN_ROLES.some((b) => b.id === r.id)))
      triage.setRoles([...roleRegistry.values()])
      return { ...def, builtin: false }
    },

    async removeExpert(id) {
      if (BUILTIN_ROLES.some((b) => b.id === id)) throw new Error(`内置专家 "${id}" 不可删除`)
      if (!roleRegistry.has(id)) return
      roleRegistry.delete(id)
      await persistCustomRoles([...roleRegistry.values()].filter((r) => !BUILTIN_ROLES.some((b) => b.id === r.id)))
      triage.setRoles([...roleRegistry.values()])
    },

    listMemory() {
      return memory.list()
    },

    removeMemory(id) {
      memory.remove(id)
      void persistMemory()
    },

    async transcribeAudio(audioBase64, _format) {
      if (!audioBase64) return ''
      // ① 优先网关 ASR 端点（参考 taco voice.recognize：POST {baseUrl}/audio/asr，模型 stepaudio-2.5-asr，audioData 为 PCM base64）。
      //    未登录无 apiKey 时跳过，直接降级 macOS Speech。
      if (loggedIn && gatewayApiKey && gatewayBaseUrl) {
        try {
          const text = await gatewayAsrTranscribe(audioBase64, gatewayApiKey, gatewayBaseUrl)
          if (text) return text
        } catch (err) {
          // 网关 ASR 失败（网络/模型不支持）→ 降级 macOS Speech
          console.warn('[STT] 网关 ASR 识别失败，降级 macOS Speech:', err instanceof Error ? err.message : err)
        }
      }
      // ② 降级 macOS Speech（本地 SFSpeechRecognizer）：PCM(Int16) base64 → WAV → 识别
      try {
        const wavPath = await pcmBase64ToWavFile(audioBase64)
        const text = await transcribeAudioFile(wavPath)
        await fs.rm(wavPath, { force: true }).catch(() => undefined)
        return text
      } catch {
        return ''
      }
    },

    getSettings() {
      return { browser: { ...currentSettings.browser }, messageSubmit: { ...currentSettings.messageSubmit }, debug: { ...currentSettings.debug }, voice: { ...currentSettings.voice }, supervisorApproval: { ...currentSettings.supervisorApproval }, supervisorAsk: { ...currentSettings.supervisorAsk } }
    },

    async getHttpTrace(id) {
      const sid = id ?? currentSessionId ?? ''
      if (!sid) return []
      return readHttpTrace(sid)
    },

    async clearHttpTrace(id) {
      const sid = id ?? currentSessionId ?? ''
      if (!sid) return
      try {
        await fs.rm(httpTracePath(sid), { force: true })
      } catch {
        // 忽略
      }
    },

    getHttpTracePath(id) {
      return httpTracePath(id ?? currentSessionId ?? '')
    },

    getTraceDir() {
      return tracesDir
    },

    async setSettings(patch) {
      const prevWebBridge = currentSettings.browser.enableWebBridge
      // 合并：只更新传入字段，未传入的保持原值
      currentSettings = {
        browser: { ...currentSettings.browser, ...(patch.browser ?? {}) },
        messageSubmit: { ...currentSettings.messageSubmit, ...(patch.messageSubmit ?? {}) },
        debug: { ...currentSettings.debug, ...(patch.debug ?? {}) },
        voice: { ...currentSettings.voice, ...(patch.voice ?? {}) },
        supervisorApproval: { ...currentSettings.supervisorApproval, ...(patch.supervisorApproval ?? {}) },
        supervisorAsk: { ...currentSettings.supervisorAsk, ...(patch.supervisorAsk ?? {}) },
      }
      // 实时同步到浏览器后端（影响后续新建窗口是否显示，已存在窗口不受影响）
      browserUse.setShowOnCreate?.(currentSettings.browser.showOnCreate)
      // 网页版桥接开关变化：同步「模型注册 + 默认窗口」
      if (currentSettings.browser.enableWebBridge !== prevWebBridge) {
        if (currentSettings.browser.enableWebBridge) {
          // 开启：注册模型 + 预创建默认窗口
          registerDeepSeekBridgeModel()
          ensureDefaultBrowserWindow(currentSessionId ?? '')
        } else {
          // 关闭：移除模型 + 若当前正在用该模型则切回默认 + 关闭当前会话默认窗口（避免残留）
          deepseekBridgeModel = null
          if (currentModelId === 'deepseek-web') {
            const fallback = gatewayModels[0] ?? customModels[0]
            if (fallback) applyModel(fallback.id)
            else currentModelId = ''
          }
          const sid = currentSessionId
          if (sid) {
            const wins = await browserUse.list()
            for (const w of wins) {
              if (w.appId === sid) await browserUse.close(w.appId).catch(() => undefined)
            }
          }
        }
      }
      await writeSettings(currentSettings)
      return { browser: { ...currentSettings.browser }, messageSubmit: { ...currentSettings.messageSubmit }, debug: { ...currentSettings.debug }, voice: { ...currentSettings.voice }, supervisorApproval: { ...currentSettings.supervisorApproval }, supervisorAsk: { ...currentSettings.supervisorAsk } }
    },
  }
}
