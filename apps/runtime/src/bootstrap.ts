import { Kernel, FileSnapshotStore, PluginStore, type DynamicPackage } from '@shanhai/kernel'
import { CORE_SLOTS } from '@shanhai/kernel-modules/client'
import { SelfModifyRuntime } from '@shanhai/selfmod'
import { Session, type ApprovalPolicy, type SessionEvent } from '@shanhai/session'
import { ApprovalService } from '@shanhai/approval'
import { AgentLoop, type SuspendedSnapshot } from '@shanhai/agent'
import type { Model, ContentPart, TokenUsage, HttpTrace, HttpTraceCallback, ChatMessage } from '@shanhai/llm'
import { createAtomicTools, createUtilityTools, toolReasoningContext, type ToolContract } from '@shanhai/tools'
import { createAskTools, AskService, ASK_CANCELLED, type AskRequest } from '@shanhai/ask'
import { createSkillTools, SkillService } from '@shanhai/skills'
import { createMcpTools, McpService } from '@shanhai/mcp'
import { MemoryStore } from '@shanhai/memory'
import { FileCredentialStore, AuthService } from '@shanhai/auth'
import type { GatewayModel, ModelTier } from '@shanhai/auth'
import type { VoiceService } from '@shanhai/voice'
import { createComputerUseSkill, createPlatformComputerUseService, type ComputerUseService } from '@shanhai/computer-use'
import { createBrowserUseSkill, createMockBrowserUseService, type BrowserUseService } from '@shanhai/browser-use'
import { createTerminalSkill, createMockTerminalService, type TerminalService, type TerminalInfo } from '@shanhai/terminal'
import { uploadImageToCloud } from '@shanhai/storage'
import { createSupervisorTools, SUPERVISOR_ID, type SessionStateSummary } from './supervisor'
import { createSupervisorLedgerTools, ensureSupervisorWorkspace, removeSessionLedger, SUPERVISOR_WORKSPACE } from './supervisor-workspace'
import {
  sessionDirPath,
  writeSessionMetaFile,
  readSessionMetaFile,
  appendSessionEventsFile,
  rewriteSessionEventsFile,
  loadSessionEventsFile,
  rotateSessionEventsFile,
  deleteSessionDir,
  migrateLegacySessionFile,
} from './session-store'
import { promises as fs } from 'node:fs'
import { homedir, hostname as osHostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join, basename, isAbsolute } from 'node:path'
import { DEFAULT_SETTINGS } from './types'
import type {
  ToolTrace,
  ApprovalOutcome,
  TokenSnapshot,
  AppSettings,
  AppSettingsPatch,
  CustomModelInput,
  BootstrapOptions,
  Runtime,
} from './types'

export type { AskRequest } from '@shanhai/ask'
export * from './types'

import { createGatewayModel, modelSupportsVision } from './models'
import { createHttpTraceStore } from './http-trace'
import { DEFAULT_WORK_DIR, sessionContext, type RuntimeContext, type SessionMeta, type TokenAccumulator, type RuntimeEnvironment } from './context'
import { createTokenStatsModule } from './token-stats'
import { createPromptsModule } from './prompts'
import { createDeepSeekBridgeModule } from './deepseek-bridge'
import { createModelProviderModule } from './model-provider'
import { createSessionsModule } from './sessions'
import { createExecutionModule } from './execution'
import { withConfigFile, ensureDeviceInfo, persistSelectedModel, persistLastActiveSessionId, readLastActiveSessionId, readSettings, writeSettings, getDeviceInfoState, setDeviceInfoName } from './config'
import { spawnSay, createSystemVoiceService, gatewayAsrTranscribe } from './voice'

export async function bootstrap(options: BootstrapOptions = {}): Promise<Runtime> {
  // 初始化设备标识（远程连接多设备用）：读取/生成 deviceId + 设备名，早于任何 getDeviceInfo 调用
  await ensureDeviceInfo()

  // 首次运行兜底：确保默认会话工作目录存在（打包分发后 ~/shanhai/workspace 可能不存在，
  // 否则 run_command 的 spawn(cwd) 与文件工具相对路径会 ENOENT 失败）。统一在此创建一次，覆盖所有入口。
  await fs.mkdir(DEFAULT_WORK_DIR, { recursive: true })

  // —— 状态容器：所有共享数据状态收敛到 ctx，各职责模块（model-provider / sessions / execution / supervisor / token-stats / prompts / deepseek-bridge）通过 ctx 访问 ——
  // 注：ctx.approval / ctx.selfmod / ctx.model / ctx.sessionRef 依赖运行时函数或 await，延后到各自声明处赋值（见下）。
  const ctx = {} as RuntimeContext
  ctx.kernel = new Kernel()
  ctx.gatewayApiKey = ''
  ctx.gatewayBaseUrl = ''
  ctx.memberToken = ''
  ctx.gatewayModels = [] as GatewayModel[]
  ctx.customModels = [] as GatewayModel[]
  ctx.deepseekBridgeModel = null as GatewayModel | null
  ctx.currentModelId = ''
  ctx.defaultModelId = ''
  ctx.sessionsDir = join(homedir(), '.shanhai', 'sessions')
  ctx.tracesDir = join(homedir(), '.shanhai', 'traces')
  ctx.httpTrace = createHttpTraceStore(join(homedir(), '.shanhai', 'traces'))
  ctx.sessions = new Map<string, SessionMeta>()
  ctx.currentSessionId = null as string | null
  ctx.sessionWriteChains = new Map<string, Promise<unknown>>()
  ctx.runningLoops = new Map<string, AgentLoop>()
  ctx.sessionOrigin = new Map<string, 'user' | 'supervisor'>()
  ctx.toolTraceCallbacks = new Set<(trace: ToolTrace) => void>()
  ctx.approvalCallbacks = new Set<(req: { id: string; sessionId?: string; toolName: string; args: Record<string, unknown>; riskLevel: string }) => void>()
  ctx.pendingApprovals = new Map<string, { resolve: (outcome: ApprovalOutcome) => void; sessionId?: string; toolName: string; args: Record<string, unknown>; riskLevel: string }>()
  ctx.approvalResolvedCallbacks = new Set<(requestId: string) => void>()
  ctx.askResolvedCallbacks = new Set<(requestId: string) => void>()
  ctx.computerUse = createPlatformComputerUseService()
  ctx.browserUse = options.browserUse ?? createMockBrowserUseService()
  ctx.terminalUse = options.terminalUse ?? createMockTerminalService()
  ctx.userTerminalSessionMap = new Map<string, string>()
  ctx.userTerminalOutputCallbacks = new Set<(sessionId: string, terminalId: string, data: string) => void>()
  ctx.voice = createSystemVoiceService()
  ctx.memory = new MemoryStore()
  ctx.currentSettings = {
    browser: { showOnCreate: DEFAULT_SETTINGS.browser.showOnCreate, enableWebBridge: DEFAULT_SETTINGS.browser.enableWebBridge },
    messageSubmit: { mode: DEFAULT_SETTINGS.messageSubmit.mode },
    debug: { traceLlm: DEFAULT_SETTINGS.debug.traceLlm },
    voice: { enabled: DEFAULT_SETTINGS.voice.enabled },
    supervisorApproval: { enabled: DEFAULT_SETTINGS.supervisorApproval.enabled },
    supervisorAsk: { enabled: DEFAULT_SETTINGS.supervisorAsk.enabled },
    supervisorClientRun: { enabled: DEFAULT_SETTINGS.supervisorClientRun.enabled },
    compaction: { modelId: DEFAULT_SETTINGS.compaction.modelId },
  } as AppSettings
  ctx.askService = new AskService()
  ctx.memoryFile = join(homedir(), '.shanhai', 'memory.json')
  ctx.imageDescCache = new Map<string, string>()
  ctx.builtinSkillCatalog = ''
  ctx.snapshotDir = join(homedir(), '.shanhai', 'snapshots')
  ctx.snapshotStore = new FileSnapshotStore(join(homedir(), '.shanhai', 'snapshots'))
  ctx.tools = [] as ToolContract[]
  ctx.supervisorLoopTools = [] as ToolContract[]
  ctx.clientRunCallbacks = new Set<(req: { requestId: string; sessionId: string; pkgId: string; name: string; purpose: string }) => void>()
  ctx.pendingClientRuns = new Map<string, { resolve: (approved: boolean) => void; sessionId?: string }>()
  ctx.clientRunResolvedCallbacks = new Set<(requestId: string) => void>()
  ctx.pluginAppCallbacks = new Set<(payload: { pkgId: string; name: string; permissions?: string[]; entryHtml?: string; icon?: string }) => void>()
  ctx.clientRemoveCallbacks = new Set<(pkgId: string) => void>()
  ctx.openAppWindowCallbacks = new Set<(appId: string) => void>()
  ctx.closeAppWindowCallbacks = new Set<(appId: string) => void>()
  ctx.pluginStore = new PluginStore(join(homedir(), '.shanhai', 'plugins'))
  ctx.skillService = new SkillService()
  ctx.mcpService = new McpService()
  ctx.tokenStats = new Map<string, TokenAccumulator>()
  ctx.tokenCallbacks = new Set<(sessionId: string, stats: TokenSnapshot) => void>()
  ctx.deltaCallbacks = new Set<(sessionId: string, text: string) => void>()
  ctx.reasoningCallbacks = new Set<(sessionId: string, text: string) => void>()
  ctx.modelProviders = new Map<string, Model>()
  ctx.credentials = new FileCredentialStore()
  ctx.authService = new AuthService({ baseUrl: 'https://agent.bjctykj.com' })
  ctx.loggedIn = false
  ctx.username = null as string | null
  ctx.selectedTier = 'flagship' as ModelTier
  ctx.modelsChangedCallbacks = new Set<() => void>()
  ctx.authExpiredCallbacks = new Set<() => void>()
  ctx.stoppedSessions = new Set<string>()
  ctx.supervisorQueue = new Map<string, string[]>()
  ctx.supervisorWakeQueue = [] as string[]
  ctx.supervisorWaking = false
  ctx.sessionActivityCallbacks = new Set<(sessionId: string, kind: 'start' | 'end') => void>()
  ctx.currentSessionChangedCallbacks = new Set<(sessionId: string) => void>()
  ctx.supervisorResultCallbacks = new Set<(sessionId: string, title: string, result?: string, error?: string) => void>()
  ctx.userMessageCallbacks = new Set<(sessionId: string, message: string, turnSeq: number) => void>()

  /** 全部模型 = 系统内置 + 用户自定义 + DeepSeek 网页版（自定义标记 custom: true，UI 分组展示） */
  const allModels = (): GatewayModel[] => [...ctx.gatewayModels, ...ctx.customModels, ...(ctx.deepseekBridgeModel ? [ctx.deepseekBridgeModel] : [])]

  // —— sessions 模块（会话 CRUD/持久化/描述/历史/配置/切换/停止）——
  // 注：modelProvider / tokenStats / deepSeekBridge 用 getter 延迟绑定（它们在本模块之后才创建），
  // 运行时访问时才解析，避免与下方模块创建顺序耦合。
  const sessionsModule = createSessionsModule(ctx, {
    getTokenStats: () => tokenStatsModule,
    getModelProvider: () => modelProviderModule,
    getDeepSeekBridge: () => deepSeekBridgeModule,
    allModels,
  })

  // 启动时加载历史会话（聊天记录持久化：重启后历史消息不丢）
  try {
    await fs.mkdir(ctx.sessionsDir, { recursive: true })
    const entries = await fs.readdir(ctx.sessionsDir, { withFileTypes: true })
    const defaultWorkDir = DEFAULT_WORK_DIR
    for (const entry of entries) {
      // 新格式：<会话id>/ 目录（含 meta.json + events.jsonl）
      if (entry.isDirectory()) {
        try {
          const dir = join(ctx.sessionsDir, entry.name)
          const metaFile = await readSessionMetaFile(dir)
          if (!metaFile) continue
          const meta: SessionMeta = {
            id: metaFile.id,
            title: metaFile.title,
            session: new Session(),
            workDir: metaFile.workDir || defaultWorkDir,
            lastActiveAt: typeof metaFile.lastActiveAt === 'number' ? metaFile.lastActiveAt : 0,
            // 管家超级会话按固定 id 识别（持久化文件不含 isSupervisor，id 即身份）
            isSupervisor: metaFile.id === SUPERVISOR_ID,
            modelId: metaFile.modelId,
            approvalPolicy: metaFile.approvalPolicy,
          }
          // 启动即压缩归档超阈值活跃段（日志轮转：历史段 gzip，控制活跃段体积与读放大）
          await rotateSessionEventsFile(dir)
          const events = await loadSessionEventsFile(dir)
          meta.session.restore(events)
          ctx.sessions.set(meta.id, meta)
        } catch {
          // 跳过损坏的会话目录
        }
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        // 旧格式：<会话id>.json 单文件 → 迁移到新格式后删除旧文件（数据逐字节等价）
        const sessionId = entry.name.slice(0, -'.json'.length)
        try {
          const legacy = await migrateLegacySessionFile(ctx.sessionsDir, sessionId, defaultWorkDir)
          if (legacy) {
            const meta: SessionMeta = {
              id: sessionId,
              title: legacy.title,
              session: new Session(),
              workDir: legacy.workDir,
              lastActiveAt: legacy.lastActiveAt,
              isSupervisor: sessionId === SUPERVISOR_ID,
              modelId: legacy.modelId,
              approvalPolicy: legacy.approvalPolicy,
            }
            meta.session.restore(legacy.events)
            ctx.sessions.set(meta.id, meta)
          }
        } catch {
          // 迁移失败跳过
        }
      }
    }
  } catch {
    // 忽略
  }
  // 确保「会话管家」超级会话存在（固定 id，独立于用户会话，不抢占当前会话）
  sessionsModule.ensureSupervisorSession()
  // 用户会话（非管家）列表：管家不参与「当前会话」的激活与排序
  const userSessions = [...ctx.sessions.values()].filter((s) => !s.isSupervisor)
  if (userSessions.length === 0) {
    sessionsModule.newSession('新会话')
  } else {
    // 重启恢复：优先激活「上次关闭前激活的那个会话」（config.json 的 lastActiveSessionId）；
    // 若该会话已不存在（被删除）或是管家会话，回退到第一个用户会话。
    const lastActiveId = await readLastActiveSessionId()
    const lastMeta = lastActiveId ? ctx.sessions.get(lastActiveId) : undefined
    // else 分支保证 userSessions 非空（length===0 已在上方分支处理）
    const firstUser = userSessions[0]!
    ctx.currentSessionId = lastMeta && !lastMeta.isSupervisor ? lastActiveId : firstUser.id
  }

  // —— 运行中的循环（会话 id → loop）——
  // 会话当前任务的发起方（run 开始 set、结束 delete）：审批分流时据此判断「管家下发 or 用户下发」。
  // 用 Map 而非会话级静态标记，因为同一会话这一轮可能用户发、下一轮可能管家发。

  // —— 工具过程 + 审批桥（审批按 requestId 独立 resolve，支持并行会话）——
  // 审批被「管家决策」resolve 后的回调（UI 据此关闭对应弹窗；用户手动/手机端走各自通道，不经过这里）
  // 提问被「管家代答」resolve 后的回调（UI 据此关闭对应弹窗；用户手动/手机端走各自通道，不经过这里）

  ctx.approval = new ApprovalService(async (req) => {
    ctx.approvalCallbacks.forEach((cb) => cb({ id: req.id, sessionId: req.sessionId, toolName: req.toolName, args: req.args, riskLevel: req.riskLevel }))
    // 发起方判定：审批请求产生的会话即发起审批的会话，查其当前任务的发起方（管家下发 or 用户侧）
    const origin = req.sessionId ? (ctx.sessionOrigin.get(req.sessionId) ?? 'user') : 'user'
    console.log('[supervisor-wake] 审批请求产生：', req.id, req.toolName, 'sessionId=', req.sessionId, 'origin=', origin, '开关=', ctx.currentSettings.supervisorApproval.enabled)
    const promise = new Promise<ApprovalOutcome>((resolve) => {
      // 记录发起审批的会话 id：删除会话时按会话拒绝其待审批请求，避免 agent 永久卡在 await
      ctx.pendingApprovals.set(req.id, { resolve, sessionId: req.sessionId, toolName: req.toolName, args: req.args, riskLevel: req.riskLevel })
    })
    // 管家接管：仅当「管家下发 + 开关开启」时唤醒管家决策（非阻塞，弹窗仍显示、用户仍可手动点）；
    // 用户侧（含手机远程）始终只走弹窗手动审批，不唤醒管家。
    if (origin === 'supervisor' && ctx.currentSettings.supervisorApproval.enabled) {
      void executionModule.wakeSupervisorForApproval(req)
    } else {
      console.log('[supervisor-wake] 审批请求不唤醒管家（origin!=supervisor 或开关关闭）')
    }
    return promise
  })

  // 审批策略（安全模式）为「会话级」：每个会话独立的安全模式，持久化到会话 meta.json 的 approvalPolicy 字段。
  // 会话级 policy 直接从 meta.approvalPolicy 读取（见 sessions 模块 sessionApprovalPolicy）。

  // —— 能力实例（提前创建，供工具使用）——
  // 用户手动终端的会话归属映射（terminalId → sessionId）：订阅终端输出时据此路由到对应会话
  // 订阅终端实时输出（含 ANSI）：只转发「用户手动终端」的输出（agent 终端走 run 的哨兵机制，不经此转发）
  ctx.terminalUse.onData((terminalId, data) => {
    const sid = ctx.userTerminalSessionMap.get(terminalId)
    if (!sid) return
    for (const cb of ctx.userTerminalOutputCallbacks) {
      try {
        cb(sid, terminalId, data)
      } catch {
        // 订阅回调异常不阻断终端输出
      }
    }
  })
  // 通用设置（跨会话、重启保留）：启动时从 config.json 恢复，setSettings 时落盘并同步到相关能力
  // 立即恢复为 config.json 持久化的值（含 debug.traceLlm）：必须在 onHttpTrace 等回调定义之前恢复，
  // 否则回调被模型调用触发时读到的仍是默认 false（traceLlm 开关不生效、日志不落盘）
  ctx.currentSettings = await readSettings()
  ctx.browserUse.setShowOnCreate?.(ctx.currentSettings.browser.showOnCreate)

  // 每会话默认创建一个浏览器窗口：会话建立/切换时预创建（appId = 会话 id），
  // 起始页用 chat.deepseek.com。该窗口走共享 partition（登录一次所有会话通用），
  // 既是「DeepSeek 网页版」对话窗口，也供 agent 后续 browser 操作复用。
  // —— DeepSeek 网页版桥接模块（CDP 直连，非工具/技能）：模型来源注册 + 复用当前会话默认窗口 ——
  const deepSeekBridgeModule = createDeepSeekBridgeModule(ctx, () => sessionContext.getStore() ?? ctx.currentSessionId ?? '')
  // 启动时为当前会话预创建默认窗口（当前会话已在恢复历史会话后确定）
  deepSeekBridgeModule.ensureDefaultBrowserWindow(ctx.currentSessionId ?? '')
  // 受「网页版桥接」开关控制：关闭后不注册该模型（模型下拉框不出现「DeepSeek 网页版」）
  if (ctx.currentSettings.browser.enableWebBridge) deepSeekBridgeModule.registerDeepSeekBridgeModel()

  // 向用户提问服务（ask_user 工具阻塞等待用户回答；UI 订阅 onRequest 弹卡片，respond 提交答案）

  // 长期记忆持久化：启动时从 ~/.shanhai/memory.json 恢复（跨会话不丢），remember 后落盘
  try {
    const raw = await fs.readFile(ctx.memoryFile, 'utf8')
    const entries = JSON.parse(raw) as Array<{ scope: never; key: string; value: unknown; source?: never; confidence?: number; sessionId?: string }>
    for (const e of entries) {
      if (e && typeof e.key === 'string') ctx.memory.save(e.scope, e.key, e.value, { source: e.source, confidence: e.confidence, sessionId: e.sessionId })
    }
  } catch {
    // 无记忆文件或损坏，忽略
  }
  const persistMemory = async (): Promise<void> => {
    try {
      await fs.writeFile(ctx.memoryFile, JSON.stringify(ctx.memory.list(), null, 2), { mode: 0o600 })
    } catch {
      // 忽略持久化失败
    }
  }

  // —— computer-use / browser-use 能力缝（实例提前创建；工具不再直接暴露，改为在下方注册为可执行技能）——

  // —— token 统计模块 + prompts 模块（sessionStats/snapshot/onUsage/onHttpTrace/refreshContextLength/currentContextBudget/currentApiKey + promptsModule.buildSystemPrompt/promptsModule.buildMemoryContext/promptsModule.analyzeImageWithVision/promptsModule.getSessionCwd）——
  const tokenStatsModule = createTokenStatsModule(ctx, allModels, () => sessionContext.getStore() ?? ctx.currentSessionId ?? '')
  const promptsModule = createPromptsModule(ctx, {
    getCurrentSid: () => sessionContext.getStore() ?? ctx.currentSessionId ?? '',
    onUsage: tokenStatsModule.onUsage,
    onHttpTrace: tokenStatsModule.onHttpTrace,
  })

  // —— 写文件快照回滚（K4 安全：写前快照，可回滚恢复原文件）——
  // 启动时清理历史快照（上次会话的快照随会话结束已无意义，避免目录无限积累）
  try {
    await fs.rm(ctx.snapshotDir, { recursive: true, force: true })
  } catch {
    // 忽略清理失败
  }
  /** 把相对路径解析到会话工作目录（rollback_file 工具用） */
  const resolveWorkPath = (p: string): string => (isAbsolute(p) ? p : join(promptsModule.getSessionCwd(), p))
  /** 写前快照回调：文件存在时备份，返回快照 id（write_file 覆盖前自动调用） */
  const snapshotFn = async (path: string): Promise<{ snapshotId: string } | undefined> => {
    try {
      return { snapshotId: await ctx.snapshotStore.snapshot(path) }
    } catch {
      return undefined
    }
  }
  // —— 工具包装：落 trace + sessionId 注入。动态注册的自修改工具也走同一包装，保证 trace 一致 ——
  // 管家会话专用工具集（占位声明，稍后在管家工具装配处赋值；plugin_inspect 报告工具清单需按会话区分引用它）
  const wrapTool = (t: ToolContract): ToolContract => ({
    ...t,
    execute: async (args) => {
      const sid = sessionContext.getStore() ?? ctx.currentSessionId ?? ''
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
      ctx.toolTraceCallbacks.forEach((cb) =>
        cb({ kind: 'tool-call', sessionId: sid, callId, name: t.name, args, approvalRequired: t.approvalRequired, approved: false, reasoning, startTs }),
      )
      try {
        const result = await t.execute(effectiveArgs)
        // 结果 trace 带上 args：前端按工具类型渲染摘要（路径/命令）时需要它；durationMs 供前端显示该步耗时
        ctx.toolTraceCallbacks.forEach((cb) => cb({ kind: 'tool-result', sessionId: sid, callId, name: t.name, args, result, durationMs: Date.now() - startTs }))
        return result
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        ctx.toolTraceCallbacks.forEach((cb) => cb({ kind: 'tool-result', sessionId: sid, callId, name: t.name, args, error, durationMs: Date.now() - startTs }))
        throw err
      }
    },
  })

  // —— K5 自修改（plugin_* 工具 + vm 沙箱 + browser 半投递 + round-trip 审批）——

  // 已安装插件持久化仓库（AI 自研应用落盘到 ~/.shanhai/plugins/，跨会话/跨重启留存）
  ctx.selfmod = new SelfModifyRuntime({
    listServices: () => ['session', 'approval', 'agent', 'memory', 'voice', 'computerUse', 'browserUse', 'model', 'credentials'],
    listTools: (sessionId) => (sessionId === SUPERVISOR_ID ? ctx.supervisorLoopTools : ctx.tools).map((t) => t.name),
    listSlots: () => [...CORE_SLOTS],
    onEvent: (name, listener) => ctx.kernel.ctx.on(name, listener),
    requestClientRun: (pkg: DynamicPackage, sessionId: string) =>
      new Promise<boolean>((resolve) => {
        const requestId = `client-run-${Date.now()}-${Math.random().toString(36).slice(2)}`
        ctx.pendingClientRuns.set(requestId, { resolve, sessionId })
        ctx.clientRunCallbacks.forEach((cb) => cb({ requestId, sessionId, pkgId: pkg.id, name: pkg.name, purpose: pkg.purpose }))
        // 管家接管：管家下发的任务里 plugin_run/plugin_test 触发投递确认时，若「管家接管投递」开关开启，唤醒管家决策（非阻塞，弹窗仍显示、用户仍可手动点）
        const origin = sessionId ? (ctx.sessionOrigin.get(sessionId) ?? 'user') : 'user'
        if (origin === 'supervisor' && ctx.currentSettings.supervisorClientRun.enabled) {
          void executionModule.wakeSupervisorForClientRun({ requestId, sessionId, pkgId: pkg.id, name: pkg.name, purpose: pkg.purpose })
        }
      }),
    deliverClient: async (pkg: DynamicPackage) => {
      ctx.pluginAppCallbacks.forEach((cb) => cb({ pkgId: pkg.id, name: pkg.name, permissions: pkg.permissions ?? [], entryHtml: pkg.entryHtml, icon: pkg.icon }))
    },
    removeClient: async (pkgId: string) => {
      ctx.clientRemoveCallbacks.forEach((cb) => cb(pkgId))
    },
    openAppWindow: (appId: string) => {
      ctx.openAppWindowCallbacks.forEach((cb) => cb(appId))
    },
    closeAppWindow: (appId: string) => {
      ctx.closeAppWindowCallbacks.forEach((cb) => cb(appId))
    },
  }, ctx.pluginStore)

  // —— 通用工具（视觉分析 / 快照回滚 / 长期记忆）+ 提问插件（ask_user）——
  // 能力在 runtime 装配，工具定义集中在 @shanhai/tools 的 createUtilityTools 与 @shanhai/ask 的 createAskTools（不散落在 bootstrap）。
  const utilityTools: ToolContract[] = createUtilityTools({
    analyzeImage: promptsModule.analyzeImageWithVision,
    rollbackFile: async (path, snapshotId) => {
      const resolved = resolveWorkPath(path)
      await ctx.snapshotStore.rollback(resolved, snapshotId)
      await ctx.snapshotStore.discard(resolved, snapshotId)
      return { ok: true, path: resolved, rolledBack: true }
    },
    memory: {
      save: (scope, key, value) => {
        const entry = ctx.memory.save(scope as never, key, value, { sessionId: sessionContext.getStore() ?? ctx.currentSessionId ?? '' })
        void persistMemory()
        return entry
      },
      recall: (scope, keyword) => ctx.memory.recall(scope as never, keyword, sessionContext.getStore() ?? ctx.currentSessionId ?? ''),
      list: () => ctx.memory.listBySession(sessionContext.getStore() ?? ctx.currentSessionId ?? ''),
    },
  })
  const askTools: ToolContract[] = createAskTools(ctx.askService, () => sessionContext.getStore() ?? ctx.currentSessionId ?? '')

  // —— 复合技能插件（skill_list / skill_read / skill_run）+ MCP 客户端插件（mcp_list_tools / mcp_call）——
  // 技能与 MCP 都是山海自有能力插件：技能从 ~/.shanhai/skills/<id>/SKILL.md 加载，MCP 配置读 ~/.shanhai/mcp.json。
  // browser-use / computer-use / terminal 作为「可执行技能」注册（不直接暴露为顶层工具），AI 先 skill_read 读手册再 skill_run 执行，均不复用 Taco 的 ~/.taco 资源。
  // 截图上传云存储：走网关后台 API（复用会员 ctx.memberToken），返回 https 公网链接；未登录/失败返回 null（截图工具回退 base64）
  const uploadImage = async (imageBase64: string, mimeType?: string): Promise<string | null> => {
    if (!ctx.memberToken) return null
    return uploadImageToCloud({ imageBase64, token: ctx.memberToken, mimeType })
  }
  ctx.skillService.registerExecutable(createComputerUseSkill(ctx.computerUse, uploadImage))
  ctx.skillService.registerExecutable(createBrowserUseSkill(ctx.browserUse, uploadImage))
  ctx.skillService.registerExecutable(createTerminalSkill(ctx.terminalUse))
  const skillTools: ToolContract[] = createSkillTools(ctx.skillService)
  // 预热技能缓存 + 生成「内置可执行技能目录」注入系统提示词（第三方技能不注入，AI 按需 skill_list 查）
  ctx.builtinSkillCatalog = await ctx.skillService.builtinExecutableCatalog()
  const mcpTools: ToolContract[] = createMcpTools(ctx.mcpService)

  const baseTools = [
    ...createAtomicTools(promptsModule.getSessionCwd, snapshotFn),
    ...utilityTools,
    ...askTools,
    ...skillTools,
    ...mcpTools,
    ...ctx.selfmod.createTools(() => sessionContext.getStore() ?? ctx.currentSessionId ?? ''),
  ]
  ctx.tools.push(...baseTools.map(wrapTool))

  // 注意：已安装插件由主进程在窗口就绪后调用 restoreInstalledPlugins() 恢复
  // （host 半工具/服务 + browser 半 UI 投递都需在渲染进程 ready 后执行，故不在此处 await）。

  // —— 模型 + agent ——
  ctx.model = await createGatewayModel(tokenStatsModule.onUsage, tokenStatsModule.onHttpTrace)
  ctx.sessionRef = ctx.sessions.get(ctx.currentSessionId!)!.session
  // —— model-provider 模块（modelProviderModule.resolveProvider/modelProviderModule.applyModel/凭证恢复/模型列表刷新/登录登出/自定义模型）——
  const modelProviderModule = createModelProviderModule(ctx, {
    allModels,
    tokenStats: tokenStatsModule,
    deepSeekBridge: deepSeekBridgeModule,
    currentWorkDir: sessionsModule.currentWorkDir,
  })
  // 登记初始 gateway provider（ctx.currentModelId 在凭证恢复阶段已设置；空则跳过，后续 modelProviderModule.applyModel 会补登记）
  if (ctx.currentModelId) ctx.modelProviders.set(ctx.currentModelId, ctx.model)
  tokenStatsModule.refreshContextLength()
  // 启动时恢复本地凭证（有 gateway apiKey 则视为已登录，模型调用走 apiKey）
  await modelProviderModule.restoreCredentials()
  // 登录态下后台刷新一次，实时从接口拉取最新模型（不读本地缓存）
  if (ctx.loggedIn) void modelProviderModule.refreshGatewayModels()

  // —— execution 模块（executionModule.runInSession/消息分发/管家调度/续跑重试）——
  const executionModule = createExecutionModule(ctx, {
    sessions: sessionsModule,
    tokenStats: tokenStatsModule,
    prompts: promptsModule,
    modelProvider: modelProviderModule,
    allModels,
    wrapTool,
  })
  // 管家专用工具集：依赖 execution 的 sendMessageToSession + wrapTool + sessions 描述能力
  ctx.supervisorLoopTools = executionModule.buildSupervisorLoopTools()

  // —— 其余能力（并行会话：每个会话独立的中断标记）——

  // 装配底座服务（声明式 inject）
  await ctx.kernel.plugin({
    name: 'session-service',
    provide: ['session'],
    apply: (kc) => kc.provide('session', ctx.sessionRef),
  })
  await ctx.kernel.plugin({
    name: 'approval-service',
    provide: ['approval'],
    apply: (kc) => kc.provide('approval', ctx.approval),
  })
  await ctx.kernel.plugin({
    name: 'agent-service',
    inject: ['session', 'approval'],
    provide: ['agent'],
    apply: (kc) => kc.provide('agent', () => new AgentLoop(ctx.model, ctx.tools, ctx.sessionRef, ctx.approval)),
  })

  // 提问接管：管家下发的任务里会话发起 ask_user 时，若「管家接管提问」开关开启，唤醒管家代答。
  // 仅管家下发的任务触发（ctx.sessionOrigin==='supervisor'）；用户侧始终只走弹窗手动回答，弹窗照常显示、用户始终可手动点。
  ctx.askService.onRequest((req) => {
    const origin = req.sessionId ? (ctx.sessionOrigin.get(req.sessionId) ?? 'user') : 'user'
    if (origin === 'supervisor' && ctx.currentSettings.supervisorAsk.enabled) {
      void executionModule.wakeSupervisorForAsk(req)
    }
  })

  return {
    kernel: ctx.kernel,
    session: ctx.sessionRef,
    tools: ctx.tools,
    model: ctx.model,
    memory: ctx.memory,
    credentials: ctx.credentials,
    voice: ctx.voice,
    computerUse: ctx.computerUse,
    browserUse: ctx.browserUse,

    get loggedIn() {
      return ctx.loggedIn
    },
    get username() {
      return ctx.username
    },
    getMemberToken() {
      return ctx.memberToken
    },
    getDeviceInfo() {
      return getDeviceInfoState() ?? {
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
      setDeviceInfoName(trimmed)
    },
    async login(u, p) {
      return modelProviderModule.login(u, p)
    },
    async register(username, password, nickname, phone, email) {
      return modelProviderModule.register(username, password, nickname, phone, email)
    },
    async logout() {
      return modelProviderModule.logout()
    },
    async listModels() {
      return modelProviderModule.listModels()
    },
    async refreshModels() {
      return modelProviderModule.refreshModels()
    },
    onModelsChanged(cb) {
      ctx.modelsChangedCallbacks.add(cb)
      return () => {
        ctx.modelsChangedCallbacks.delete(cb)
      }
    },
    onAuthExpired(cb) {
      ctx.authExpiredCallbacks.add(cb)
      return () => {
        ctx.authExpiredCallbacks.delete(cb)
      }
    },
    async addCustomModel(input) {
      return modelProviderModule.addCustomModel(input)
    },
    async updateCustomModel(id, input) {
      return modelProviderModule.updateCustomModel(id, input)
    },
    async removeCustomModel(id) {
      return modelProviderModule.removeCustomModel(id)
    },
    selectedTier: ctx.selectedTier,

    listSessions() {
      // 后端不排序，返回原始字段。busy 是「运行态」（内存态）：只有当前进程内正在执行任务的会话才算 busy。
      // 进程重启后 ctx.runningLoops 为空，任何会话都不该显示「处理中」；「未完成轮次（可继续执行）」由 hasIncompleteTurn 单独判断，与 busy 无关。
      // 管家超级会话不暴露给用户侧边栏（由独立 supervisor 窗口承载）。
      return [...ctx.sessions.values()]
        .filter((s) => !s.isSupervisor)
        .map((s) => ({
          id: s.id,
          title: s.title,
          workDir: s.workDir,
          lastActiveAt: s.lastActiveAt,
          busy: ctx.runningLoops.has(s.id),
        }))
    },
    switchSession(id) {
      sessionsModule.switchSessionInternal(id)
    },
    describeSession(sessionId) {
      return sessionsModule.describeSession(sessionId)
    },
    sendMessageToSession(sessionId, message, mode) {
      return executionModule.sendMessageToSession(sessionId, message, mode ?? 'insert')
    },
    runSession(sessionId, message, mode) {
      return executionModule.runSession(sessionId, message, mode ?? 'insert')
    },
    setSessionModel(sessionId, modelId) {
      return sessionsModule.setSessionModelInternal(sessionId, modelId)
    },
    setSessionApprovalPolicy(sessionId, policy) {
      return sessionsModule.setSessionApprovalInternal(sessionId, policy)
    },
    getSupervisorModel() {
      return sessionsModule.getSupervisorModelInternal()
    },
    getSupervisorApprovalPolicy() {
      return sessionsModule.getSupervisorApprovalInternal()
    },
    setSupervisorModel(modelId) {
      return sessionsModule.setSupervisorModelInternal(modelId)
    },
    setSupervisorApprovalPolicy(policy) {
      return sessionsModule.setSupervisorApprovalInternal(policy)
    },
    renameSession(id, title) {
      sessionsModule.renameSessionInternal(id, title)
    },
    async deleteSession(id) {
      await sessionsModule.deleteSessionInternal(id)
    },
    getSessionWorkdir(id) {
      const meta = ctx.sessions.get(id ?? ctx.currentSessionId ?? '')
      return meta?.workDir ?? DEFAULT_WORK_DIR
    },
    setSessionWorkdir(id, workdir) {
      sessionsModule.setSessionWorkdirInternal(id, workdir)
    },
    async saveUploadedFile(fileName, dataBase64) {
      const dir = sessionsModule.currentWorkDir()
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
      const sid = sessionId ?? ctx.currentSessionId ?? ''
      const all = await ctx.browserUse.list()
      // 会话级隔离：只返回该会话（appId 等于 sid 或 sid: 前缀）的窗口
      return all.filter((w) => w.appId === sid || w.appId.startsWith(`${sid}:`))
    },
    async showBrowserWindow(appId) {
      await ctx.browserUse.show(appId)
    },
    async closeBrowserWindow(appId) {
      await ctx.browserUse.close(appId)
    },
    async userTerminalCreate(sessionId, name) {
      const sid = sessionId ?? ctx.currentSessionId ?? ''
      // 传入 `${sid}:default`，create 会把冒号规范化为连字符 → `${sid}-default`（已存在则自动加 -2/-3），
      // 与 agent 终端技能的 terminalId 格式一致，会话级隔离。
      // 打开终端默认在当前会话工作目录（而非用户主目录），让用户直接在项目目录下操作。
      const cwd = ctx.sessions.get(sid)?.workDir ?? DEFAULT_WORK_DIR
      const terminalId = await ctx.terminalUse.create(`${sid}:default`, name, cwd)
      ctx.userTerminalSessionMap.set(terminalId, sid)
      return terminalId
    },
    userTerminalWrite(sessionId, terminalId, data) {
      ctx.terminalUse.write(terminalId, data)
    },
    userTerminalResize(sessionId, terminalId, cols, rows) {
      ctx.terminalUse.resize(terminalId, cols, rows)
    },
    async userTerminalClose(sessionId, terminalId) {
      await ctx.terminalUse.close(terminalId)
      ctx.userTerminalSessionMap.delete(terminalId)
    },
    async userTerminalList(sessionId) {
      const sid = sessionId ?? ctx.currentSessionId ?? ''
      const all = await ctx.terminalUse.list()
      // 会话级隔离：只返回该会话（terminalId 以 `${sid}-` 开头）的终端
      return all.filter((t) => t.terminalId.startsWith(`${sid}-`))
    },
    onUserTerminalOutput(cb) {
      ctx.userTerminalOutputCallbacks.add(cb)
      return () => {
        ctx.userTerminalOutputCallbacks.delete(cb)
      }
    },
    async getDeepSeekBridgeStatus() {
      return deepSeekBridgeModule.getStatus()
    },
    async openDeepSeekBridge() {
      return deepSeekBridgeModule.open()
    },
    async injectDeepSeekBridge() {
      return deepSeekBridgeModule.inject()
    },
    getSessionHistory(id) {
      return sessionsModule.getSessionHistory(id)
    },
    getSessionTrace(id) {
      return sessionsModule.getSessionTrace(id)
    },
    createSession(title, workdir) {
      const id = sessionsModule.newSession(title ?? '新会话', workdir)
      // 新会话未设置会话模型：回退全局默认模型（ctx.defaultModelId 为空则保持现状，未登录时无模型可切）
      if (ctx.defaultModelId) modelProviderModule.applyModel(ctx.defaultModelId)
      // 新会话默认预创建一个浏览器窗口
      deepSeekBridgeModule.ensureDefaultBrowserWindow(id)
      return id
    },
    getHistory() {
      return sessionsModule.getHistory()
    },

    onToolTrace(cb) {
      ctx.toolTraceCallbacks.add(cb)
      return () => ctx.toolTraceCallbacks.delete(cb)
    },
    onApprovalRequest(cb) {
      ctx.approvalCallbacks.add(cb)
      return () => ctx.approvalCallbacks.delete(cb)
    },
    respondApproval(outcome, requestId) {
      const p = ctx.pendingApprovals.get(requestId)
      if (p) {
        p.resolve(outcome)
        ctx.pendingApprovals.delete(requestId)
        // 统一广播「已解决」：桌面端/手机端任一处理审批后，UI 弹窗据此关闭，跨端同步状态
        ctx.approvalResolvedCallbacks.forEach((cb) => cb(requestId))
      }
    },
    listPendingApprovals() {
      // 供手机端连接后恢复弹窗：审批请求是一次性广播事件，客户端若错过（切走/连接前发出）
      // 需要主动查询当前待处理审批，否则看不到弹窗、工具会一直阻塞等待。
      return [...ctx.pendingApprovals.entries()].map(([id, p]) => ({
        id,
        sessionId: p.sessionId,
        toolName: p.toolName,
        args: p.args,
        riskLevel: p.riskLevel,
      }))
    },
    onApprovalResolved(cb) {
      ctx.approvalResolvedCallbacks.add(cb)
      return () => ctx.approvalResolvedCallbacks.delete(cb)
    },
    onAskResolved(cb) {
      ctx.askResolvedCallbacks.add(cb)
      return () => ctx.askResolvedCallbacks.delete(cb)
    },
    onAskRequest(cb) {
      return ctx.askService.onRequest(cb)
    },
    respondAsk(requestId, answer) {
      if (ctx.askService.respond(requestId, answer)) {
        ctx.askResolvedCallbacks.forEach((cb) => cb(requestId))
      }
    },
    cancelAsk(requestId) {
      ctx.askService.cancel(requestId)
      ctx.askResolvedCallbacks.forEach((cb) => cb(requestId))
    },
    listPendingAsks() {
      // 供手机端连接后恢复弹窗（与 listPendingApprovals 同理）
      return ctx.askService.listPending()
    },

    onDelta(cb) {
      ctx.deltaCallbacks.add(cb)
      return () => {
        ctx.deltaCallbacks.delete(cb)
      }
    },

    onReasoning(cb) {
      ctx.reasoningCallbacks.add(cb)
      return () => {
        ctx.reasoningCallbacks.delete(cb)
      }
    },

    onSessionActivity(cb) {
      ctx.sessionActivityCallbacks.add(cb)
      return () => {
        ctx.sessionActivityCallbacks.delete(cb)
      }
    },

    onCurrentSessionChanged(cb) {
      ctx.currentSessionChangedCallbacks.add(cb)
      return () => {
        ctx.currentSessionChangedCallbacks.delete(cb)
      }
    },

    onSupervisorResult(cb) {
      ctx.supervisorResultCallbacks.add(cb)
      return () => {
        ctx.supervisorResultCallbacks.delete(cb)
      }
    },

    onUserMessage(cb) {
      ctx.userMessageCallbacks.add(cb)
      return () => {
        ctx.userMessageCallbacks.delete(cb)
      }
    },

    getTokenStats(sessionId?: string) {
      return tokenStatsModule.snapshot(sessionId)
    },
    onTokenStats(cb) {
      ctx.tokenCallbacks.add(cb)
      return () => {
        ctx.tokenCallbacks.delete(cb)
      }
    },

    switchModel(modelId) {
      modelProviderModule.applyModel(modelId)
      // 全局默认模型随选择更新（新会话 / 无记录会话回退用），持久化到 config.json
      ctx.defaultModelId = modelId
      void persistSelectedModel(modelId)
      // 会话级：写入当前会话 meta.modelId，切回该会话时直接读 meta 恢复
      const meta = ctx.currentSessionId ? ctx.sessions.get(ctx.currentSessionId) : undefined
      if (meta) {
        meta.modelId = modelId
        void sessionsModule.persistSession(meta)
      }
    },
    getCurrentModelId() {
      return modelProviderModule.getCurrentModelId()
    },
    stop() {
      if (ctx.currentSessionId) sessionsModule.stopSessionInternal(ctx.currentSessionId)
    },
    stopSession(sessionId) {
      sessionsModule.stopSessionInternal(sessionId)
    },

    run: async (message, opts) => {
      const sid = ctx.currentSessionId
      if (!sid) throw new Error('没有活动会话')
      return executionModule.runInSession(sid, message, opts)
    },

    runSupervisor: (message, attachments) => executionModule.runSupervisorInternal(message, attachments),

    resend: async (sessionId, userMessageIndex, newContent) => {
      const meta = ctx.sessions.get(sessionId)
      if (!meta) throw new Error(`会话不存在: ${sessionId}`)
      const events = meta.session.list()
      // 会话级模型已在 meta.modelId（截断不影响，无需截断前先读）
      const effModelId = meta.modelId ?? ctx.defaultModelId
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
      // 管家会话：走管家入口（正确切换管家模型 + 管家审批策略 + 管家工具集），避免落到全局 ctx.currentModelId 错用普通会话模型
      if (sessionId === SUPERVISOR_ID) {
        return executionModule.runSupervisorInternal(content, undefined, effModelId)
      }
      // 普通会话：显式用该会话持久化模型，避免依赖全局 ctx.currentModelId（后台/切走时可能不一致）
      return executionModule.runInSession(sessionId, content, undefined, effModelId)
    },

    resume: async (sessionId) => {
      const sid = sessionId
      const meta = ctx.sessions.get(sid)
      if (!meta) throw new Error(`会话不存在: ${sid}`)
      const events = meta.session.list()

      // 找最后一条非注入用户消息（单步记忆检索用）
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

      // 单步 ReAct：断点续跑——回放已执行历史（含完整工具回合），从断点继续，不清空已执行步骤
      ctx.stoppedSessions.delete(sid)
      sessionsModule.touchSession(sid)
      const isSupervisorRun = sid === SUPERVISOR_ID
      const effModelId = meta.modelId ?? ctx.defaultModelId
      const effModel = modelProviderModule.resolveProvider(effModelId)
      const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId))
      const loop = new AgentLoop(
        effModel,
        isSupervisorRun ? ctx.supervisorLoopTools : ctx.tools,
        meta.session,
        ctx.approval,
        sid,
        tokenStatsModule.currentContextBudget(effModelId),
        visionCapable,
        tokenStatsModule.currentApiKey(effModelId),
        modelProviderModule.resolveCompactModel(),
      )
      ctx.runningLoops.set(sid, loop)
      ctx.sessionActivityCallbacks.forEach((cb) => cb(sid, 'start'))
      let suspended = false
      try {
        return await sessionContext.run(sid, () =>
          loop.resumeRun(
            isSupervisorRun ? promptsModule.buildSupervisorSystemPrompt(lastUserContent) : promptsModule.buildSystemPrompt(meta.workDir, promptsModule.buildMemoryContext(lastUserContent, meta.id)),
            (text) => {
              if (ctx.stoppedSessions.has(sid)) throw new Error('__stopped__')
              ctx.deltaCallbacks.forEach((cb) => cb(sid, text))
            },
            (text) => ctx.reasoningCallbacks.forEach((cb) => cb(sid, text)),
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
          ctx.runningLoops.delete(sid)
          ctx.sessionActivityCallbacks.forEach((cb) => cb(sid, 'end'))
        }
        meta.lastActiveAt = Date.now()
        await sessionsModule.persistSession(meta)
        tokenStatsModule.emitTokenStats()
        executionModule.drainSupervisorQueue(sid)
      }
    },

    retrySession: async (sessionId) => {
      const sid = sessionId ?? ctx.currentSessionId
      const meta = ctx.sessions.get(sid)
      if (!meta) throw new Error(`会话不存在: ${sid}`)
      const loop = ctx.runningLoops.get(sid)
      if (loop) {
        try {
          // 用失败节点相同的 messages 快照重新提交请求（保持上下文），继续 ReAct 循环
          const result = await sessionContext.run(sid, () => loop.retry())
          // 重试结束更新活跃时间为结束时间，随后落盘
          meta.lastActiveAt = Date.now()
          await sessionsModule.persistSession(meta)
          tokenStatsModule.emitTokenStats()
          return result
        } finally {
          // retry 成功后不再挂起 → 移除 loop；retry 又失败耗尽 → 仍挂起 → 保留 loop 供再次重试
          if (!loop.isSuspended()) ctx.runningLoops.delete(sid)
        }
      }
      // 无运行中 loop：优先从持久化快照恢复精确重试（重启后仍用失败节点相同的 body 重发），无快照才降级 resume
      const snapshot = sessionsModule.readRetrySnapshot(meta)
      if (snapshot) {
        // 用该会话持久化模型 + 对应工具集（管家会话用 ctx.supervisorLoopTools），避免错用全局 ctx.currentModelId/ctx.tools
        const isSupervisorRun = sid === SUPERVISOR_ID
        const effModelId = meta.modelId ?? ctx.defaultModelId
        const effModel = modelProviderModule.resolveProvider(effModelId)
        const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId))
        const restoredLoop = new AgentLoop(effModel, isSupervisorRun ? ctx.supervisorLoopTools : ctx.tools, meta.session, ctx.approval, sid, tokenStatsModule.currentContextBudget(effModelId), visionCapable, tokenStatsModule.currentApiKey(effModelId), modelProviderModule.resolveCompactModel())
        restoredLoop.restoreSuspended(snapshot)
        ctx.runningLoops.set(sid, restoredLoop)
        try {
          const result = await sessionContext.run(sid, () =>
            restoredLoop.retry(
              (text) => {
                if (ctx.stoppedSessions.has(sid)) throw new Error('__stopped__')
                ctx.deltaCallbacks.forEach((cb) => cb(sid, text))
              },
              (text) => ctx.reasoningCallbacks.forEach((cb) => cb(sid, text)),
            ),
          )
          // 重试结束更新活跃时间为结束时间，随后落盘
          meta.lastActiveAt = Date.now()
          await sessionsModule.persistSession(meta)
          tokenStatsModule.emitTokenStats()
          return result
        } finally {
          if (!restoredLoop.isSuspended()) ctx.runningLoops.delete(sid)
        }
      }
      // 无快照：降级 resume（从最后一条用户消息续跑）
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
      // 会话级模型已在 meta.modelId（截断不影响）
      const effModelId = meta.modelId ?? ctx.defaultModelId
      meta.session.truncate(lastUserIdx)
      if (sid === SUPERVISOR_ID) {
        return executionModule.runSupervisorInternal(content, undefined, effModelId)
      }
      return executionModule.runInSession(sid, content, undefined, effModelId)
    },

    abandonSession: async (sessionId) => {
      const sid = sessionId ?? ctx.currentSessionId
      // 取消重试：清理挂起 loop + 挂起快照（取消后不再走「重试」，改走「继续执行」resume）。
      // 保留 session 未完成状态（不 append turn/end），让「继续执行」入口可用。
      ctx.runningLoops.delete(sid)
      const meta = ctx.sessions.get(sid)
      if (meta) {
        meta.session.removeLast('retry/snapshot')
        await sessionsModule.persistSession(meta)
      }
    },

    hasRetrySnapshot(sessionId) {
      const meta = ctx.sessions.get(sessionId)
      if (!meta) return null
      const snap = sessionsModule.readRetrySnapshot(meta)
      return snap ? { reason: snap.reason } : null
    },

    injectMessage(sessionId, message) {
      const loop = ctx.runningLoops.get(sessionId)
      if (loop) {
        loop.injectUserMessage(message)
        return true
      }
      return false
    },

    hasIncompleteTurn(sessionId) {
      // 运行中的会话不是「未完成轮次」：任务正在执行，不应显示「继续执行」。
      // 否则「手机端下发任务、后台执行」期间，事件日志里 user 消息已追加、assistant/message 尚未落盘，
      // 会被误判为「未完成」，桌面端切到该会话时错误显示「继续执行」按钮。
      // 重试耗尽挂起（suspended）时 loop 仍在 ctx.runningLoops 中，但此时 busy=true 已挡住「继续执行」，
      // 且挂起由 hasRetrySnapshot 的重试弹窗承接，故统一返回 false 不影响挂起交互。
      if (ctx.runningLoops.has(sessionId)) return false
      const meta = ctx.sessions.get(sessionId)
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
      return sessionsModule.sessionApprovalPolicy()
    },

    setApprovalPolicy(policy) {
      const meta = ctx.currentSessionId ? ctx.sessions.get(ctx.currentSessionId) : undefined
      if (!meta) return
      // 会话级：写入当前会话 meta.approvalPolicy（持久化到 meta.json，重启后直接读），
      // 同时写入事件日志 approval/policy，供审批判断 effectiveApprovalPolicy 回放（否则只改 meta 不生效）。
      meta.approvalPolicy = policy
      meta.session.append('approval/policy', { policy })
      ctx.approval.setPolicy(policy)
      void sessionsModule.persistSession(meta)
    },

    selfmodInspect(sessionId) {
      const sid = sessionId ?? ctx.currentSessionId ?? ''
      return ctx.selfmod.inspect(sid)
    },

    restoreInstalledPlugins() {
      return ctx.selfmod.restoreAll()
    },

    invokePluginService(appId, name, args) {
      return ctx.selfmod.invokeService(appId, name, args)
    },

    onClientRunRequest(cb) {
      ctx.clientRunCallbacks.add(cb)
      return () => ctx.clientRunCallbacks.delete(cb)
    },

    respondClientRun(requestId, approved) {
      const p = ctx.pendingClientRuns.get(requestId)
      if (p) {
        p.resolve(approved)
        ctx.pendingClientRuns.delete(requestId)
        // 统一广播「已解决」：桌面端/手机端任一处理投递后，UI 弹窗据此关闭，跨端同步状态
        ctx.clientRunResolvedCallbacks.forEach((cb) => cb(requestId))
      }
    },

    onClientRunResolved(cb) {
      ctx.clientRunResolvedCallbacks.add(cb)
      return () => ctx.clientRunResolvedCallbacks.delete(cb)
    },

    onClientCode(cb) {
      ctx.pluginAppCallbacks.add(cb)
      return () => ctx.pluginAppCallbacks.delete(cb)
    },

    onClientRemove(cb) {
      ctx.clientRemoveCallbacks.add(cb)
      return () => ctx.clientRemoveCallbacks.delete(cb)
    },

    async openPluginApp(appId) {
      // 打开插件窗口应用：主进程订阅 openAppWindowCallbacks 后调 window-manager openApp（复用 app 窗口类型）
      ctx.openAppWindowCallbacks.forEach((cb) => cb(appId))
      return { ok: true }
    },

    onOpenPluginApp(cb) {
      ctx.openAppWindowCallbacks.add(cb)
      return () => ctx.openAppWindowCallbacks.delete(cb)
    },

    async closePluginApp(appId) {
      // 关闭插件窗口应用：主进程订阅 closeAppWindowCallbacks 后调 window-manager closeApp（销毁对应 app 窗口）
      ctx.closeAppWindowCallbacks.forEach((cb) => cb(appId))
      return { ok: true }
    },

    onClosePluginApp(cb) {
      ctx.closeAppWindowCallbacks.add(cb)
      return () => ctx.closeAppWindowCallbacks.delete(cb)
    },

    listMemory(sessionId) {
      return ctx.memory.listBySession(sessionId)
    },

    removeMemory(id) {
      ctx.memory.remove(id)
      void persistMemory()
    },

    async transcribeAudio(audioBase64, _format) {
      if (!audioBase64) return ''
      // 语音识别统一走网关 ASR（对齐 taco，无本地 macOS Speech 降级）。
      // 未登录无 apiKey 时无法识别，直接返回空，由前端提示。
      if (!ctx.loggedIn || !ctx.gatewayApiKey || !ctx.gatewayBaseUrl) return ''
      try {
        const text = await gatewayAsrTranscribe(audioBase64, ctx.gatewayApiKey, ctx.gatewayBaseUrl)
        return text
      } catch (err) {
        console.warn('[STT] 网关 ASR 识别失败:', err instanceof Error ? err.message : err)
        return ''
      }
    },

    getSettings() {
      return { browser: { ...ctx.currentSettings.browser }, messageSubmit: { ...ctx.currentSettings.messageSubmit }, debug: { ...ctx.currentSettings.debug }, voice: { ...ctx.currentSettings.voice }, supervisorApproval: { ...ctx.currentSettings.supervisorApproval }, supervisorAsk: { ...ctx.currentSettings.supervisorAsk }, supervisorClientRun: { ...ctx.currentSettings.supervisorClientRun }, compaction: { ...ctx.currentSettings.compaction } }
    },

    async getHttpTrace(id) {
      const sid = id ?? ctx.currentSessionId ?? ''
      if (!sid) return []
      return ctx.httpTrace.read(sid)
    },

    async clearHttpTrace(id) {
      const sid = id ?? ctx.currentSessionId ?? ''
      if (!sid) return
      try {
        await fs.rm(ctx.httpTrace.path(sid), { force: true })
      } catch {
        // 忽略
      }
    },

    getHttpTracePath(id) {
      return ctx.httpTrace.path(id ?? ctx.currentSessionId ?? '')
    },

    getTraceDir() {
      return ctx.tracesDir
    },

    async setSettings(patch) {
      const prevWebBridge = ctx.currentSettings.browser.enableWebBridge
      // 合并：只更新传入字段，未传入的保持原值
      ctx.currentSettings = {
        browser: { ...ctx.currentSettings.browser, ...(patch.browser ?? {}) },
        messageSubmit: { ...ctx.currentSettings.messageSubmit, ...(patch.messageSubmit ?? {}) },
        debug: { ...ctx.currentSettings.debug, ...(patch.debug ?? {}) },
        voice: { ...ctx.currentSettings.voice, ...(patch.voice ?? {}) },
        supervisorApproval: { ...ctx.currentSettings.supervisorApproval, ...(patch.supervisorApproval ?? {}) },
        supervisorAsk: { ...ctx.currentSettings.supervisorAsk, ...(patch.supervisorAsk ?? {}) },
        supervisorClientRun: { ...ctx.currentSettings.supervisorClientRun, ...(patch.supervisorClientRun ?? {}) },
        compaction: { ...ctx.currentSettings.compaction, ...(patch.compaction ?? {}) },
      }
      // 实时同步到浏览器后端（影响后续新建窗口是否显示，已存在窗口不受影响）
      ctx.browserUse.setShowOnCreate?.(ctx.currentSettings.browser.showOnCreate)
      // 网页版桥接开关变化：同步「模型注册 + 默认窗口」
      if (ctx.currentSettings.browser.enableWebBridge !== prevWebBridge) {
        if (ctx.currentSettings.browser.enableWebBridge) {
          // 开启：注册模型 + 预创建默认窗口
          deepSeekBridgeModule.registerDeepSeekBridgeModel()
          deepSeekBridgeModule.ensureDefaultBrowserWindow(ctx.currentSessionId ?? '')
        } else {
          // 关闭：移除模型 + 若当前正在用该模型则切回默认 + 关闭当前会话默认窗口（避免残留）
          ctx.deepseekBridgeModel = null
          if (ctx.currentModelId === 'deepseek-web') {
            const fallback = ctx.gatewayModels[0] ?? ctx.customModels[0]
            if (fallback) modelProviderModule.applyModel(fallback.id)
            else ctx.currentModelId = ''
          }
          const sid = ctx.currentSessionId
          if (sid) {
            const wins = await ctx.browserUse.list()
            for (const w of wins) {
              if (w.appId === sid) await ctx.browserUse.close(w.appId).catch(() => undefined)
            }
          }
        }
      }
      await writeSettings(ctx.currentSettings)
      return { browser: { ...ctx.currentSettings.browser }, messageSubmit: { ...ctx.currentSettings.messageSubmit }, debug: { ...ctx.currentSettings.debug }, voice: { ...ctx.currentSettings.voice }, supervisorApproval: { ...ctx.currentSettings.supervisorApproval }, supervisorAsk: { ...ctx.currentSettings.supervisorAsk }, supervisorClientRun: { ...ctx.currentSettings.supervisorClientRun }, compaction: { ...ctx.currentSettings.compaction } }
    },
  }
}
