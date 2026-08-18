import { Kernel } from '@shanhai/kernel'
import { Session, type SessionEvent } from '@shanhai/session'
import { ApprovalService } from '@shanhai/approval'
import { AgentLoop } from '@shanhai/agent'
import type { Model, ContentPart, TokenUsage } from '@shanhai/llm'
import { createMockModel, DeepSeekProvider } from '@shanhai/llm'
import { atomicTools, type ToolContract } from '@shanhai/tools'
import { MemoryStore } from '@shanhai/memory'
import { FileCredentialStore, AuthService } from '@shanhai/auth'
import type { GatewayModel, ModelTier } from '@shanhai/auth'
import type { VoiceService } from '@shanhai/voice'
import type { ComputerUseService } from '@shanhai/computer-use'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'

const execAsync = promisify(execCallback)

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

  /** 登录状态 */
  loggedIn: boolean
  username: string | null
  /** 账号密码登录（SHA-256），成功后拉取会员模型并切换为真实网关模型 */
  login(username: string, password: string): Promise<{ username: string; nickname?: string }>
  logout(): Promise<void>
  /** 网关模型列表（系统内置 + 用户自定义） */
  listModels(): Promise<GatewayModel[]>
  /** 新增用户自定义模型（OpenAI 兼容端点 + Key），返回落库后的模型 */
  addCustomModel(model: { name: string; baseUrl: string; apiKey: string; model: string }): Promise<GatewayModel>
  /** 编辑用户自定义模型（按 id 更新，保留 id） */
  updateCustomModel(id: string, model: { name: string; baseUrl: string; apiKey: string; model: string }): Promise<GatewayModel>
  /** 删除用户自定义模型 */
  removeCustomModel(id: string): Promise<void>
  /** 当前选中模型（tier 路由） */
  selectedTier: ModelTier

  /** 会话列表（内存多会话，含每会话工作目录） */
  listSessions(): Array<{ id: string; title: string; workDir: string }>
  switchSession(id: string): void
  /** 重命名会话标题 */
  renameSession(id: string, title: string): void
  /** 删除会话（当前会话被删则切到剩余第一个） */
  deleteSession(id: string): Promise<void>
  /** 获取指定会话工作目录（不传 id 用当前会话） */
  getSessionWorkdir(id?: string): string
  /** 修改指定会话工作目录 */
  setSessionWorkdir(id: string, workdir: string): void
  /** 获取指定会话的历史消息（UI 切换会话时加载；不传 id 用当前会话） */
  getSessionHistory(id?: string): Array<{ kind: 'user' | 'assistant' | 'tool'; content?: string; trace?: ToolTrace; attachments?: unknown[] }>
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

  /** 流式增量回调（sessionId 标识来源会话） */
  onDelta(cb: (sessionId: string, text: string) => void): () => void

  /** 当前 token 用量快照（累计 / 本轮 / 上下文占比） */
  getTokenStats(): TokenSnapshot
  /** token 用量变化回调（模型每次返回 usage 时推送） */
  onTokenStats(cb: (stats: TokenSnapshot) => void): () => void

  /** 切换模型（动态更新 provider，后续对话用新模型，并持久化到本地） */
  switchModel(modelId: string): void
  /** 当前选中的模型 id（从本地缓存恢复，重启后仍记住） */
  getCurrentModelId(): string
  /** 中断当前会话的进行中任务（并行会话互不影响） */
  stop(): void

  /** 跑一次任务（端到端 ReAct，支持多模态附件；绑定当前会话，切换会话后后台继续跑） */
  run(message: string, opts?: { maxSteps?: number; attachments?: ContentPart[] }): Promise<string>
}

/** 从本地凭证装配真实网关模型；无凭证则 mock 兜底 */
async function createGatewayModel(onUsage?: (usage: TokenUsage) => void): Promise<Model> {
  try {
    const raw = await fs.readFile(join(homedir(), '.shanhai', 'config.json'), 'utf8')
    const cfg = JSON.parse(raw) as {
      gateway?: { baseUrl?: string; apiKey?: string; selectedModelId?: string }
    }
    const g = cfg.gateway
    if (g?.baseUrl && g?.apiKey && g?.selectedModelId) {
      return new DeepSeekProvider({ apiKey: g.apiKey, baseUrl: g.baseUrl, model: g.selectedModelId, onUsage })
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

/** 用 apiKey 拉取网关完整模型列表（/api/v1/models，13 个模型，各自 baseUrl） */
async function fetchGatewayModels(apiKey: string, baseUrl: string): Promise<GatewayModel[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      code?: number
      data?: { data?: Array<{ id: string; displayName?: string; baseUrl?: string; model?: string }> }
    }
    const list = data.data?.data ?? []
    return list.map((m) => ({
      id: m.id,
      name: m.displayName ?? m.id,
      tier: inferTier(m.id),
      apiKey,
      baseUrl: m.baseUrl ?? baseUrl,
    }))
  } catch {
    return []
  }
}

/** 持久化选中模型到 config.json（下次打开不再重复选择） */
async function persistSelectedModel(modelId: string): Promise<void> {
  try {
    const path = join(homedir(), '.shanhai', 'config.json')
    const raw = await fs.readFile(path, 'utf8')
    const cfg = JSON.parse(raw) as { gateway?: { selectedModelId?: string } }
    if (cfg.gateway) cfg.gateway.selectedModelId = modelId
    await fs.writeFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  } catch {
    // 忽略持久化失败
  }
}

/** 持久化用户自定义模型列表（独立于系统内置模型，登录态无关） */
async function persistCustomModels(models: GatewayModel[]): Promise<void> {
  try {
    const path = join(homedir(), '.shanhai', 'config.json')
    let cfg: Record<string, unknown> = {}
    try {
      cfg = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
    } catch {
      // 新文件
    }
    const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
    g.customModels = models
    cfg.gateway = g
    await fs.writeFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  } catch {
    // 忽略持久化失败
  }
}

/** 登录成功后合并保存凭证（更新 memberToken + account + 网关模型凭证，密码不落盘） */
async function persistLoginToken(
  token: string,
  username: string,
  member: { nickname?: string; avatar?: string } | undefined,
  gateway: { apiKey: string; baseUrl: string; selectedModelId: string; models: GatewayModel[] },
): Promise<void> {
  try {
    const path = join(homedir(), '.shanhai', 'config.json')
    let cfg: Record<string, unknown> = {}
    try {
      cfg = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
    } catch {
      // 新文件
    }
    const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
    g.memberToken = token
    g.account = { username, ...(member ?? {}) }
    g.apiKey = gateway.apiKey
    g.baseUrl = gateway.baseUrl
    g.selectedModelId = gateway.selectedModelId
    g.models = gateway.models
    cfg.gateway = g
    await fs.writeFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  } catch {
    // 忽略持久化失败
  }
}

/** 真实语音：TTS 走 macOS say（真实发声），STT 需系统麦克风权限（暂返回空） */
function createSystemVoiceService(): VoiceService {
  return {
    transcribe: async () => '',
    synthesize: async (text) => {
      await execAsync(`say ${JSON.stringify(text)}`).catch(() => undefined)
      return new TextEncoder().encode(text).buffer as ArrayBuffer
    },
  }
}

/** 真实 computer-use：截图走 macOS screencapture，键鼠走 System Events */
function createSystemComputerUseService(): ComputerUseService {
  return {
    screenshot: async () => {
      const tmp = `/tmp/shanhai-shot-${Date.now()}.png`
      await execAsync(`screencapture -x "${tmp}"`)
      const buf = await fs.readFile(tmp)
      await fs.rm(tmp, { force: true })
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    },
    clickAt: async (x, y) => {
      await execAsync(`osascript -e 'tell application "System Events" to click at {${x}, ${y}}'`).catch(() => undefined)
    },
    typeText: async (text) => {
      await execAsync(`osascript -e 'tell application "System Events" to keystroke ${JSON.stringify(text)}'`).catch(() => undefined)
    },
    pressKey: async (key) => {
      await execAsync(`osascript -e 'tell application "System Events" to key code ${keyCode(key)}'`).catch(() => undefined)
    },
  }
}

function keyCode(key: string): number {
  const map: Record<string, number> = { enter: 36, return: 36, space: 49, tab: 48, escape: 53, esc: 53, left: 123, right: 124, up: 126, down: 125 }
  return map[key.toLowerCase()] ?? 0
}

/**
 * host 装配：用内核装配底座服务 + 能力插件。
 * 暴露登录 / 会话 / 模型 / 工具过程 / 审批 等产品能力。
 */
export async function bootstrap(): Promise<Runtime> {
  const kernel = new Kernel()

  // 网关凭证 + 模型列表（提前声明，供 image_analyze 工具闭包引用，登录部分赋值）
  let gatewayApiKey = ''
  let gatewayBaseUrl = ''
  let gatewayModels: GatewayModel[] = []
  /** 用户自定义模型（OpenAI 兼容端点 + 自有 Key，独立于系统内置模型） */
  let customModels: GatewayModel[] = []
  let currentModelId = ''

  /** 全部模型 = 系统内置 + 用户自定义（自定义标记 custom: true，UI 分组展示） */
  const allModels = (): GatewayModel[] => [...gatewayModels, ...customModels]

  // —— 会话（多会话，持久化到 ~/.shanhai/sessions/，每个会话独立工作目录）——
  interface SessionMeta {
    id: string
    title: string
    session: Session
    workDir: string
  }
  const sessionsDir = join(homedir(), '.shanhai', 'sessions')
  const sessions = new Map<string, SessionMeta>()
  let currentSessionId: string | null = null

  async function persistSession(meta: SessionMeta): Promise<void> {
    try {
      await fs.mkdir(sessionsDir, { recursive: true })
      const data = { id: meta.id, title: meta.title, workDir: meta.workDir, events: meta.session.list() }
      await fs.writeFile(join(sessionsDir, `${meta.id}.json`), JSON.stringify(data, null, 2), { mode: 0o600 })
    } catch {
      // 忽略持久化失败
    }
  }

  const newSession = (title: string, workDir?: string): string => {
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const meta: SessionMeta = { id, title, session: new Session(), workDir: workDir ?? join(homedir(), 'shanhai', 'workspace') }
    sessions.set(id, meta)
    currentSessionId = id
    void persistSession(meta)
    return id
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
        const data = JSON.parse(raw) as { id: string; title: string; workDir?: string; events?: SessionEvent[] }
        const meta: SessionMeta = {
          id: data.id,
          title: data.title,
          session: new Session(),
          workDir: data.workDir ?? join(homedir(), 'shanhai', 'workspace'),
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
  if (sessions.size === 0) {
    newSession('新会话')
  } else {
    currentSessionId = sessions.values().next().value!.id
  }

  // —— 工具过程 + 审批桥（审批按 requestId 独立 resolve，支持并行会话）——
  const toolTraceCallbacks = new Set<(trace: ToolTrace) => void>()
  const approvalCallbacks = new Set<(req: { id: string; sessionId?: string; toolName: string; args: Record<string, unknown>; riskLevel: string }) => void>()
  const pendingApprovals = new Map<string, { resolve: (outcome: ApprovalOutcome) => void }>()

  const approval = new ApprovalService(async (req) => {
    approvalCallbacks.forEach((cb) => cb({ id: req.id, sessionId: req.sessionId, toolName: req.toolName, args: req.args, riskLevel: req.riskLevel }))
    return new Promise<ApprovalOutcome>((resolve) => {
      pendingApprovals.set(req.id, { resolve })
    })
  })

  // —— 能力实例（提前创建，供工具使用）——
  const computerUse = createSystemComputerUseService()
  const voice = createSystemVoiceService()
  const memory = new MemoryStore()

  // —— computer-use 工具（操作电脑：截图/点击/输入/按键，形成视觉闭环）——
  const computerTools: ToolContract[] = [
    {
      name: 'computer_screenshot',
      description: '截取当前屏幕并返回截图（base64）。用于查看桌面/窗口当前状态，可配合 image_analyze 分析后再操作。',
      inputSchema: { type: 'object', properties: {} },
      riskLevel: 'readonly',
      execute: async () => {
        const buf = await computerUse.screenshot()
        return { imageBase64: Buffer.from(buf).toString('base64') }
      },
    },
    {
      name: 'computer_click',
      description: '在屏幕指定坐标 (x, y) 点击鼠标。',
      inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
      riskLevel: 'irreversible',
      approvalRequired: true,
      execute: async (args) => {
        await computerUse.clickAt(Number(args.x), Number(args.y))
        return { ok: true }
      },
    },
    {
      name: 'computer_type',
      description: '在当前焦点处输入文字。',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      riskLevel: 'irreversible',
      approvalRequired: true,
      execute: async (args) => {
        await computerUse.typeText(String(args.text))
        return { ok: true }
      },
    },
    {
      name: 'computer_key',
      description: '按下键盘按键（如 enter、tab、space、escape 等）。',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      riskLevel: 'irreversible',
      approvalRequired: true,
      execute: async (args) => {
        await computerUse.pressKey(String(args.key))
        return { ok: true }
      },
    },
  ]

  // —— 图片识别：用视觉模型分析图片（当前模型不支持多模态时降级用）——
  const analyzeImageWithVision = async (imageUrl: string): Promise<string> => {
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
        const provider = new DeepSeekProvider({ apiKey: gatewayApiKey, baseUrl: gatewayBaseUrl, model: vm.id, onUsage })
        const res = await provider.complete([
          {
            role: 'user',
            content: [
              { type: 'text', text: '请详细描述这张图片的内容，包括主体、文字、场景等。' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ])
        if (res.text && res.text.trim()) return res.text
        errors.push(`${vm.id}: 空结果`)
      } catch (err) {
        errors.push(`${vm.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return `（图片识别失败：${errors.join('；')}）`
  }

  // —— 图片识别工具（模型不支持多模态时，AI 调它用视觉模型分析图片）——
  const imageAnalyzeTool: ToolContract = {
    name: 'image_analyze',
    description: '分析图片内容并返回文字描述。当需要理解图片内容、但当前模型无法直接查看图片时使用。',
    inputSchema: {
      type: 'object',
      properties: { imageUrl: { type: 'string', description: '图片的 URL 或 data: URL' } },
      required: ['imageUrl'],
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const imageUrl = String(args.imageUrl ?? '')
      if (!imageUrl) return '（未提供图片）'
      return analyzeImageWithVision(imageUrl)
    },
  }

  // —— 工具（包装：落 trace，sessionId 从 AsyncLocalStorage 上下文取）——
  const baseTools = [...atomicTools(), imageAnalyzeTool, ...computerTools]
  const tools: ToolContract[] = baseTools.map((t) => ({
    ...t,
    execute: async (args) => {
      const sid = sessionContext.getStore() ?? currentSessionId ?? ''
      const callId = `${t.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      toolTraceCallbacks.forEach((cb) =>
        cb({ kind: 'tool-call', sessionId: sid, callId, name: t.name, args, approvalRequired: t.approvalRequired, approved: false }),
      )
      try {
        const result = await t.execute(args)
        toolTraceCallbacks.forEach((cb) => cb({ kind: 'tool-result', sessionId: sid, callId, name: t.name, result }))
        return result
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        toolTraceCallbacks.forEach((cb) => cb({ kind: 'tool-result', sessionId: sid, callId, name: t.name, error }))
        throw err
      }
    },
  }))

  // —— token 统计（累计 / 本轮 / 上下文占比，UI 底部状态栏展示）——
  const tokenStats = {
    totalPrompt: 0,
    totalCompletion: 0,
    total: 0,
    turnPrompt: 0,
    turnCompletion: 0,
    turn: 0,
    contextLength: 0,
    lastPrompt: 0,
  }
  const tokenCallbacks = new Set<(stats: TokenSnapshot) => void>()

  const snapshot = (): TokenSnapshot => ({
    totalPrompt: tokenStats.totalPrompt,
    totalCompletion: tokenStats.totalCompletion,
    total: tokenStats.total,
    turnPrompt: tokenStats.turnPrompt,
    turnCompletion: tokenStats.turnCompletion,
    turn: tokenStats.turn,
    contextLength: tokenStats.contextLength,
    lastPrompt: tokenStats.lastPrompt,
    contextUsageRatio: tokenStats.contextLength > 0 ? tokenStats.lastPrompt / tokenStats.contextLength : 0,
  })

  const emitTokenStats = (): void => {
    const s = snapshot()
    tokenCallbacks.forEach((cb) => cb(s))
  }

  /** 每次模型返回 usage 时累计（流式末尾 / 一次性 complete 均触发） */
  const onUsage = (usage: TokenUsage): void => {
    tokenStats.totalPrompt += usage.promptTokens
    tokenStats.totalCompletion += usage.completionTokens
    tokenStats.total += usage.totalTokens
    tokenStats.turnPrompt += usage.promptTokens
    tokenStats.turnCompletion += usage.completionTokens
    tokenStats.turn += usage.totalTokens
    tokenStats.lastPrompt = usage.promptTokens
    emitTokenStats()
  }

  /** 刷新当前模型的上下文窗口长度（模型切换/登录后调用） */
  const refreshContextLength = (): void => {
    const m = allModels().find((m) => m.id === currentModelId)
    tokenStats.contextLength = m?.contextLength ?? 0
    emitTokenStats()
  }

  // —— 模型 + agent ——
  let model = await createGatewayModel(onUsage)
  let sessionRef = sessions.get(currentSessionId!)!.session
  const deltaCallbacks = new Set<(sessionId: string, text: string) => void>()
  refreshContextLength()

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
      gateway?: { apiKey?: string; baseUrl?: string; selectedModelId?: string; account?: { username?: string; nickname?: string }; models?: GatewayModel[]; customModels?: GatewayModel[] }
    }
    const g = cfg.gateway
    if (g?.apiKey) {
      loggedIn = true
      username = g.account?.nickname ?? g.account?.username ?? null
      gatewayApiKey = g.apiKey
      gatewayBaseUrl = g.baseUrl ?? ''
      // 恢复缓存的模型列表（登录时已存），否则用当前模型兜底保证下拉有内容
      gatewayModels = Array.isArray(g.models) && g.models.length > 0
        ? g.models
        : g.selectedModelId
          ? [{ id: g.selectedModelId, name: g.selectedModelId, tier: selectedTier, apiKey: g.apiKey, baseUrl: g.baseUrl ?? '' }]
          : []
    }
    // 无论登录态，恢复用户上次选中的模型（登录后优先沿用）
    if (g?.selectedModelId) currentModelId = g.selectedModelId
    // 恢复用户自定义模型（标记 custom: true，登录态无关）
    if (Array.isArray(g?.customModels)) {
      customModels = g.customModels.map((m) => ({ ...m, custom: true }))
    }
  } catch {
    // 无凭证，未登录
  }

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

  return {
    kernel,
    session: sessionRef,
    tools,
    model,
    memory,
    credentials,
    voice,
    computerUse,

    loggedIn,
    username,
    async login(u, p) {
      const s = await authService.login(u, p)
      loggedIn = true
      username = s.nickname ?? s.username
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
          currentModelId = target.id
          model = new DeepSeekProvider({ apiKey: gatewayApiKey, baseUrl: gatewayBaseUrl, model: currentModelId, onUsage })
        }
      }
      refreshContextLength()
      await persistLoginToken(s.token, s.username, { nickname: s.nickname, avatar: s.avatar }, {
        apiKey: gatewayApiKey,
        baseUrl: gatewayBaseUrl,
        selectedModelId: currentModelId,
        models: gatewayModels,
      })
      return { username: s.nickname ?? s.username, nickname: s.nickname }
    },
    async logout() {
      loggedIn = false
      username = null
      gatewayApiKey = ''
      gatewayBaseUrl = ''
      gatewayModels = []
      // 只清除登录凭证字段，保留用户自定义模型 + 选中模型偏好
      try {
        const path = join(homedir(), '.shanhai', 'config.json')
        let cfg: Record<string, unknown> = {}
        try {
          cfg = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
        } catch {
          // 新文件
        }
        const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
        delete g.memberToken
        delete g.apiKey
        delete g.baseUrl
        delete g.account
        delete g.models
        cfg.gateway = g
        await fs.writeFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 })
      } catch {
        // 忽略持久化失败
      }
      // 恢复模型：优先当前选中的自定义模型（不依赖登录），否则回退 mock
      const customTarget = customModels.find((m) => m.id === currentModelId)
      if (customTarget?.apiKey && customTarget?.baseUrl) {
        model = new DeepSeekProvider({ apiKey: customTarget.apiKey, baseUrl: customTarget.baseUrl, model: customTarget.model ?? customTarget.id, onUsage })
      } else {
        model = await createGatewayModel(onUsage)
      }
      refreshContextLength()
    },
    async listModels() {
      // 系统内置 + 用户自定义（自定义 custom: true，UI 分组展示）
      return allModels()
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
      if (currentModelId === id && updated.apiKey && updated.baseUrl) {
        model = new DeepSeekProvider({ apiKey: updated.apiKey, baseUrl: updated.baseUrl, model: updated.model ?? updated.id, onUsage })
      }
      await persistCustomModels(customModels)
      return updated
    },
    async removeCustomModel(id) {
      customModels = customModels.filter((m) => m.id !== id)
      if (currentModelId === id) {
        currentModelId = ''
        model = await createGatewayModel(onUsage)
      }
      refreshContextLength()
      await persistCustomModels(customModels)
    },
    selectedTier,

    listSessions() {
      return [...sessions.values()].map((s) => ({ id: s.id, title: s.title, workDir: s.workDir }))
    },
    switchSession(id) {
      const target = sessions.get(id)
      if (target) {
        currentSessionId = id
        sessionRef = target.session
      }
    },
    renameSession(id, title) {
      const meta = sessions.get(id)
      if (!meta) return
      const trimmed = title.trim()
      if (!trimmed) return
      meta.title = trimmed
      void persistSession(meta)
    },
    async deleteSession(id) {
      const meta = sessions.get(id)
      if (!meta) return
      sessions.delete(id)
      await fs.rm(join(sessionsDir, `${id}.json`), { force: true }).catch(() => undefined)
      // 当前会话被删：切到剩余第一个；无剩余则新建一个空会话
      if (currentSessionId === id) {
        const next = sessions.values().next().value as SessionMeta | undefined
        if (next) {
          currentSessionId = next.id
          sessionRef = next.session
        } else {
          newSession('新会话')
        }
      }
    },
    getSessionWorkdir(id) {
      const meta = sessions.get(id ?? currentSessionId ?? '')
      return meta?.workDir ?? join(homedir(), 'shanhai', 'workspace')
    },
    setSessionWorkdir(id, workdir) {
      const meta = sessions.get(id)
      if (!meta) return
      const trimmed = workdir.trim()
      if (!trimmed) return
      meta.workDir = trimmed
      void persistSession(meta)
    },
    getSessionHistory(id) {
      const target = sessions.get(id ?? currentSessionId ?? '')
      if (!target) return []
      const out: Array<{ kind: 'user' | 'assistant' | 'tool'; content?: string; trace?: ToolTrace; attachments?: unknown[] }> = []
      for (const e of target.session.list()) {
        if (e.type === 'user/message') {
          const d = e.data as { content: string; attachments?: unknown[] }
          out.push({ kind: 'user', content: d.content, attachments: d.attachments })
        } else if (e.type === 'assistant/message') {
          out.push({ kind: 'assistant', content: (e.data as { content: string }).content })
        } else if (e.type === 'tool/call') {
          const d = e.data as { callId: string; name: string; args: Record<string, unknown> }
          out.push({ kind: 'tool', trace: { kind: 'tool-call', sessionId: target.id, callId: d.callId, name: d.name, args: d.args } })
        } else if (e.type === 'tool/result') {
          const d = e.data as { callId: string; name: string; result?: unknown; error?: string }
          out.push({ kind: 'tool', trace: { kind: 'tool-result', sessionId: target.id, callId: d.callId, name: d.name, result: d.result, error: d.error } })
        }
      }
      return out
    },
    createSession(title, workdir) {
      return newSession(title ?? '新会话', workdir)
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

    onDelta(cb) {
      deltaCallbacks.add(cb)
      return () => {
        deltaCallbacks.delete(cb)
      }
    },

    getTokenStats() {
      return snapshot()
    },
    onTokenStats(cb) {
      tokenCallbacks.add(cb)
      return () => {
        tokenCallbacks.delete(cb)
      }
    },

    switchModel(modelId) {
      currentModelId = modelId
      // 从系统/自定义模型中找到目标，用其 apiKey + baseUrl + model 参数（自定义模型用自有 Key）
      const target = allModels().find((m) => m.id === modelId)
      if (target?.apiKey && target?.baseUrl) {
        model = new DeepSeekProvider({ apiKey: target.apiKey, baseUrl: target.baseUrl, model: target.model ?? target.id, onUsage })
      }
      refreshContextLength()
      // 持久化选中模型到 config.json（下次打开不再重复选择）
      void persistSelectedModel(modelId)
    },
    getCurrentModelId() {
      return currentModelId
    },
    stop() {
      if (currentSessionId) stoppedSessions.add(currentSessionId)
    },

    run: async (message, opts) => {
      const sid = currentSessionId
      if (!sid) throw new Error('没有活动会话')
      const meta = sessions.get(sid)
      if (!meta) throw new Error(`会话不存在: ${sid}`)
      const targetSession = meta.session
      stoppedSessions.delete(sid)
      // 本轮任务开始时清零 turn 统计，模型每次返回 usage 时重新累计
      tokenStats.turnPrompt = 0
      tokenStats.turnCompletion = 0
      tokenStats.turn = 0
      emitTokenStats()
      let finalMessage = message
      let finalAttachments = opts?.attachments
      // 图片降级：当前模型不支持视觉时，先用视觉模型把图片转成文字描述，再发给当前模型
      const currentModelMeta = gatewayModels.find((m) => m.id === currentModelId)
      if (finalAttachments && finalAttachments.length > 0 && !modelSupportsVision(currentModelMeta)) {
        const parts: string[] = []
        for (const p of finalAttachments) {
          if (p.type === 'image_url') {
            parts.push(`【图片】${await analyzeImageWithVision(p.image_url.url)}`)
          }
        }
        const desc = parts.filter(Boolean).join('\n')
        finalMessage = message ? `${message}\n\n${desc}` : desc
        finalAttachments = undefined
      }
      const loop = new AgentLoop(model, tools, targetSession, approval, sid)
      try {
        return await sessionContext.run(sid, () =>
          loop.run(finalMessage, {
            ...opts,
            attachments: finalAttachments,
            onDelta: (text) => {
              if (stoppedSessions.has(sid)) throw new Error('__stopped__')
              deltaCallbacks.forEach((cb) => cb(sid, text))
            },
          }),
        )
      } catch (err) {
        if (err instanceof Error && err.message === '__stopped__') {
          return '（已中断，历史已保留，可继续输入以续跑）'
        }
        throw err
      } finally {
        // 会话事件（用户消息/助手回复/工具过程）已追加到 session，立即落盘，重启不丢
        await persistSession(meta)
      }
    },
  }
}
