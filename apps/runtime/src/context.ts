/**
 * RuntimeContext：bootstrap 的共享状态容器。
 *
 * 背景：原 bootstrap() 函数体内部散落 50+ 个共享状态变量（let/const Map/Set/服务实例），
 * 约 100 个闭包方法直接读写这些变量，织成一张强耦合网，导致单文件膨胀、无法拆分。
 *
 * 本文件把所有「数据状态」收敛进一个 RuntimeContext 对象，各职责模块（model-provider /
 * sessions / execution / supervisor / token-stats / prompts / deepseek-bridge）通过
 * createXxxModule(ctx) 接收同一个 ctx 引用，从而打破闭包之间的循环依赖，实现按域拆分。
 *
 * 注意：这里只放「数据状态」，不放「方法」；方法由各模块 factory 返回。
 */
import { Kernel, PluginStore, FileSnapshotStore } from '@shanhai/kernel'
import type { Session, ApprovalPolicy } from '@shanhai/session'
import { ApprovalService } from '@shanhai/approval'
import { AgentLoop } from '@shanhai/agent'
import type { Model, TokenUsage } from '@shanhai/llm'
import type { ToolContract } from '@shanhai/tools'
import { AskService } from '@shanhai/ask'
import { SkillService } from '@shanhai/skills'
import { McpService } from '@shanhai/mcp'
import { MemoryStore } from '@shanhai/memory'
import { FileCredentialStore, AuthService, type GatewayModel, type ModelTier } from '@shanhai/auth'
import type { VoiceService } from '@shanhai/voice'
import type { ComputerUseService } from '@shanhai/computer-use'
import type { BrowserUseService } from '@shanhai/browser-use'
import type { TerminalService } from '@shanhai/terminal'
import { SelfModifyRuntime } from '@shanhai/selfmod'
import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HttpTraceStore } from './http-trace'
import type { ToolTrace, TokenSnapshot, AppSettings, ApprovalOutcome } from './types'

/** 并行会话的工具调用上下文：让全局工具包装层知道「当前工具属于哪个会话」 */
export const sessionContext = new AsyncLocalStorage<string>()

/** 默认会话工作目录（不带点的 ~/shanhai/workspace，区别于 ~/.shanhai 配置目录）。
 *  首次运行由 bootstrap 启动阶段统一创建；所有「默认 cwd」入口复用此常量，避免硬编码散落。 */
export const DEFAULT_WORK_DIR = join(homedir(), 'shanhai', 'workspace')

/** 单个会话的内存元数据（持久化到 sessions/<id>/meta.json；管家超级会话 isSupervisor=true） */
export interface SessionMeta {
  id: string
  title: string
  session: Session
  workDir: string
  /** 最近活跃时间戳（仅「发消息/执行任务」时刷新，切换会话不刷新），用于列表「活跃时间排序」 */
  lastActiveAt: number
  /** 是否为「会话管家」超级会话（固定 id，不显示在用户侧边栏、不可改名/删除） */
  isSupervisor: boolean
  /** 会话级模型 id（持久化到 meta.json；undefined 表示未选择，回退全局默认模型） */
  modelId?: string
  /** 会话级审批策略（安全模式，持久化到 meta.json；undefined 回退 'ask'） */
  approvalPolicy?: ApprovalPolicy
}

/** 单会话 token 累计器（累计 / 本轮 / 上下文占比，UI 底部状态栏展示） */
export interface TokenAccumulator {
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

/** 运行时环境快照（系统提示词里注入的「环境信息」全部来自这里，随每次请求自动采集） */
export interface RuntimeEnvironment {
  osName: string
  platform: string
  arch: string
  time: string
  shell: string
  home: string
  cwd: string
  lang: string
}

/** bootstrap 的共享状态容器（只含数据状态，方法由各域模块 factory 返回） */
export interface RuntimeContext {
  // —— 内核 ——
  kernel: Kernel

  // —— 网关凭证 + 模型列表 ——
  gatewayApiKey: string
  gatewayBaseUrl: string
  /** 会员 JWT（登录后持久化到 config.json，启动时用于重新拉取最新模型列表） */
  memberToken: string
  gatewayModels: GatewayModel[]
  /** 用户自定义模型（OpenAI 兼容端点 + 自有 Key，独立于系统内置模型） */
  customModels: GatewayModel[]
  /** DeepSeek 网页版桥接模型来源（本地免费 LLM 网关，非工具/技能；服务启动成功后才非空） */
  deepseekBridgeModel: GatewayModel | null
  currentModelId: string
  /** 全局默认模型 id（新会话 / 未设置会话模型的会话回退用），随 switchModel 更新并持久化到 config.json */
  defaultModelId: string

  // —— 会话 ——
  sessionsDir: string
  tracesDir: string
  httpTrace: HttpTraceStore
  sessions: Map<string, SessionMeta>
  currentSessionId: string | null
  /** 每会话持久化串行队列：保证每个会话的事件按 append 顺序落盘 */
  sessionWriteChains: Map<string, Promise<unknown>>

  // —— 运行中的循环（会话 id → loop）——
  runningLoops: Map<string, AgentLoop>
  /** 会话当前任务的发起方（run 开始 set、结束 delete）：审批分流时据此判断「管家下发 or 用户下发」 */
  sessionOrigin: Map<string, 'user' | 'supervisor'>

  // —— 工具过程 + 审批桥 ——
  toolTraceCallbacks: Set<(trace: ToolTrace) => void>
  approvalCallbacks: Set<(req: { id: string; sessionId?: string; toolName: string; args: Record<string, unknown>; riskLevel: string }) => void>
  pendingApprovals: Map<string, { resolve: (outcome: ApprovalOutcome) => void; sessionId?: string; toolName: string; args: Record<string, unknown>; riskLevel: string }>
  approvalResolvedCallbacks: Set<(requestId: string) => void>
  askResolvedCallbacks: Set<(requestId: string) => void>
  approval: ApprovalService

  // —— 能力实例 ——
  computerUse: ComputerUseService
  browserUse: BrowserUseService
  terminalUse: TerminalService
  /** 用户手动终端的会话归属映射（terminalId → sessionId） */
  userTerminalSessionMap: Map<string, string>
  userTerminalOutputCallbacks: Set<(sessionId: string, terminalId: string, data: string) => void>
  voice: VoiceService
  memory: MemoryStore
  /** 通用设置（跨会话、重启保留） */
  currentSettings: AppSettings

  // —— 提问服务 + 记忆持久化 ——
  askService: AskService
  memoryFile: string
  /** 图片描述缓存：同一张图（按 url 去重）在会话内只识别一次 */
  imageDescCache: Map<string, string>
  /** 内置可执行技能目录文本（启动时预热生成，注入系统提示词【内置能力】段） */
  builtinSkillCatalog: string

  // —— 快照回滚 ——
  snapshotDir: string
  snapshotStore: FileSnapshotStore

  // —— 工具 ——
  tools: ToolContract[]
  supervisorLoopTools: ToolContract[]

  // —— 自修改 ——
  clientRunCallbacks: Set<(req: { requestId: string; sessionId: string; pkgId: string; name: string; purpose: string }) => void>
  pendingClientRuns: Map<string, { resolve: (approved: boolean) => void; sessionId?: string }>
  clientRunResolvedCallbacks: Set<(requestId: string) => void>
  pluginAppCallbacks: Set<(payload: { pkgId: string; name: string; permissions?: string[]; entryHtml?: string; icon?: string }) => void>
  clientRemoveCallbacks: Set<(pkgId: string) => void>
  /** 打开插件窗口应用的回调（主进程订阅后调 window-manager openApp，appId = 插件持久化 id） */
  openAppWindowCallbacks: Set<(appId: string) => void>
  /** 关闭插件窗口应用的回调（主进程订阅后调 window-manager closeApp 销毁对应窗口） */
  closeAppWindowCallbacks: Set<(appId: string) => void>
  pluginStore: PluginStore
  selfmod: SelfModifyRuntime

  // —— 技能 + MCP ——
  skillService: SkillService
  mcpService: McpService

  // —— token 统计 ——
  tokenStats: Map<string, TokenAccumulator>
  tokenCallbacks: Set<(sessionId: string, stats: TokenSnapshot) => void>

  // —— 模型 + agent ——
  model: Model
  sessionRef: Session
  deltaCallbacks: Set<(sessionId: string, text: string) => void>
  reasoningCallbacks: Set<(sessionId: string, text: string) => void>
  /** 模型 provider 缓存（按 modelId）：支持「会话管家异步转发」时多个会话各自持有独立 provider */
  modelProviders: Map<string, Model>

  // —— 登录 ——
  credentials: FileCredentialStore
  authService: AuthService
  loggedIn: boolean
  username: string | null
  selectedTier: ModelTier
  modelsChangedCallbacks: Set<() => void>
  authExpiredCallbacks: Set<() => void>

  // —— 并行会话中断 ——
  stoppedSessions: Set<string>

  // —— 管家队列 ——
  /** 管家转发队列：会话 id → 待执行消息列表（queue 模式） */
  supervisorQueue: Map<string, string[]>
  /** 待管家决策队列（审批/提问接管） */
  supervisorWakeQueue: string[]
  supervisorWaking: boolean

  // —— 事件回调 ——
  sessionActivityCallbacks: Set<(sessionId: string, kind: 'start' | 'end') => void>
  currentSessionChangedCallbacks: Set<(sessionId: string) => void>
  supervisorResultCallbacks: Set<(sessionId: string, title: string, result?: string, error?: string) => void>
  userMessageCallbacks: Set<(sessionId: string, message: string, turnSeq: number) => void>
}
