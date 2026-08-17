import { Kernel } from '@shanhai/kernel'
import { Session } from '@shanhai/session'
import { ApprovalService } from '@shanhai/approval'
import { AgentLoop } from '@shanhai/agent'
import type { Model, ContentPart } from '@shanhai/llm'
import { createMockModel, DeepSeekProvider } from '@shanhai/llm'
import { atomicTools, type ToolContract } from '@shanhai/tools'
import { MemoryStore } from '@shanhai/memory'
import { FileCredentialStore, AuthService } from '@shanhai/auth'
import type { GatewayModel, ModelTier } from '@shanhai/auth'
import { createMockVoiceService, type VoiceService } from '@shanhai/voice'
import { createMockComputerUseService, type ComputerUseService } from '@shanhai/computer-use'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(execCallback)

/** 工具调用过程事件（推给 UI 展示「思考 → 工具 → 结果」） */
export interface ToolTrace {
  kind: 'tool-call' | 'tool-result'
  callId: string
  name: string
  args?: Record<string, unknown>
  result?: unknown
  error?: string
  approvalRequired?: boolean
  approved?: boolean
}

export type ApprovalOutcome = 'allowed-once' | 'rejected'

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
  /** 账号密码登录（SHA-256） */
  login(username: string, password: string): Promise<{ username: string }>
  logout(): Promise<void>
  /** 网关模型列表（登录后） */
  listModels(): Promise<GatewayModel[]>
  /** 当前选中模型（tier 路由） */
  selectedTier: ModelTier

  /** 会话列表（内存多会话） */
  listSessions(): Array<{ id: string; title: string }>
  switchSession(id: string): void

  /** 工具调用过程回调（UI 展示） */
  onToolTrace(cb: (trace: ToolTrace) => void): () => void
  /** 审批请求回调（UI 弹卡片） */
  onApprovalRequest(cb: (req: { id: string; toolName: string; args: Record<string, unknown>; riskLevel: string }) => void): () => void
  /** UI 应答审批 */
  respondApproval(outcome: ApprovalOutcome): void

  /** 流式增量回调 */
  onDelta(cb: (text: string) => void): () => void

  /** 切换模型（动态更新 provider，后续对话用新模型，并持久化到本地） */
  switchModel(modelId: string): void
  /** 当前选中的模型 id（从本地缓存恢复，重启后仍记住） */
  getCurrentModelId(): string
  /** 中断当前任务 */
  stop(): void

  /** 跑一次任务（端到端 ReAct，支持多模态附件） */
  run(message: string, opts?: { maxSteps?: number; attachments?: ContentPart[] }): Promise<string>
}

/** 从本地凭证装配真实网关模型；无凭证则 mock 兜底 */
async function createGatewayModel(): Promise<Model> {
  try {
    const raw = await fs.readFile(join(homedir(), '.shanhai', 'config.json'), 'utf8')
    const cfg = JSON.parse(raw) as {
      gateway?: { baseUrl?: string; apiKey?: string; selectedModelId?: string }
    }
    const g = cfg.gateway
    if (g?.baseUrl && g?.apiKey && g?.selectedModelId) {
      return new DeepSeekProvider({ apiKey: g.apiKey, baseUrl: g.baseUrl, model: g.selectedModelId })
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
  let currentModelId = ''

  // —— 会话（多会话，内存态）——
  const sessions = new Map<string, { id: string; title: string; session: Session }>()
  let currentSessionId: string | null = null
  const newSession = (title: string): string => {
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sessions.set(id, { id, title, session: new Session() })
    currentSessionId = id
    return id
  }
  newSession('新会话')

  // —— 工具过程 + 审批桥 ——
  const toolTraceCallbacks = new Set<(trace: ToolTrace) => void>()
  const approvalCallbacks = new Set<(req: { id: string; toolName: string; args: Record<string, unknown>; riskLevel: string }) => void>()
  let pendingApproval: { id: string; resolve: (outcome: ApprovalOutcome) => void } | null = null

  const approval = new ApprovalService(async (req) => {
    approvalCallbacks.forEach((cb) => cb({ id: req.id, toolName: req.toolName, args: req.args, riskLevel: req.riskLevel }))
    return new Promise<ApprovalOutcome>((resolve) => {
      pendingApproval = { id: req.id, resolve }
    })
  })

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
      const visionModel = gatewayModels.find((m) => isVisionModel(m.id))
      if (!visionModel) return '（无可用视觉模型）'
      try {
        const provider = new DeepSeekProvider({ apiKey: gatewayApiKey, baseUrl: gatewayBaseUrl, model: visionModel.id })
        const res = await provider.complete([
          {
            role: 'user',
            content: [
              { type: 'text', text: '请详细描述这张图片的内容，包括主体、文字、场景等。' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ])
        return res.text ?? '（未能识别图片）'
      } catch (err) {
        return `（图片识别失败：${err instanceof Error ? err.message : String(err)}）`
      }
    },
  }

  // —— 工具（包装：落 trace）——
  const baseTools = [...atomicTools(), imageAnalyzeTool]
  const tools: ToolContract[] = baseTools.map((t) => ({
    ...t,
    execute: async (args) => {
      const callId = `${t.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      toolTraceCallbacks.forEach((cb) =>
        cb({ kind: 'tool-call', callId, name: t.name, args, approvalRequired: t.approvalRequired, approved: false }),
      )
      try {
        const result = await t.execute(args)
        toolTraceCallbacks.forEach((cb) => cb({ kind: 'tool-result', callId, name: t.name, result }))
        return result
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        toolTraceCallbacks.forEach((cb) => cb({ kind: 'tool-result', callId, name: t.name, error }))
        throw err
      }
    },
  }))

  // —— 模型 + agent ——
  let model = await createGatewayModel()
  let sessionRef = sessions.get(currentSessionId!)!.session
  const deltaCallbacks = new Set<(text: string) => void>()

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
      gateway?: { apiKey?: string; baseUrl?: string; selectedModelId?: string; account?: { username?: string } }
    }
    const g = cfg.gateway
    if (g?.apiKey) {
      loggedIn = true
      username = g.account?.username ?? null
      gatewayApiKey = g.apiKey
      gatewayBaseUrl = g.baseUrl ?? ''
      currentModelId = g.selectedModelId ?? ''
      // 构造当前模型（网关模型列表拉不到时兜底，保证模型下拉有内容）
      if (g.selectedModelId) {
        gatewayModels = [{ id: g.selectedModelId, name: g.selectedModelId, tier: selectedTier, apiKey: g.apiKey, baseUrl: g.baseUrl ?? '' }]
      }
    }
  } catch {
    // 无凭证，未登录
  }

  // —— 其余能力（真实能力）——
  const memory = new MemoryStore()
  const voice = createSystemVoiceService()
  const computerUse = createSystemComputerUseService()
  let stopped = false

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
      username = s.username
      await credentials.save({ username: s.username, token: s.token })
      return { username: s.username }
    },
    async logout() {
      loggedIn = false
      username = null
      await credentials.clear()
    },
    async listModels() {
      // 用 apiKey 拉取网关完整模型列表（13 个模型，各自 baseUrl），失败则回退到当前模型
      if (gatewayApiKey && gatewayBaseUrl) {
        const list = await fetchGatewayModels(gatewayApiKey, gatewayBaseUrl)
        if (list.length > 0) gatewayModels = list
      }
      return gatewayModels
    },
    selectedTier,

    listSessions() {
      return [...sessions.values()].map((s) => ({ id: s.id, title: s.title }))
    },
    switchSession(id) {
      const target = sessions.get(id)
      if (target) {
        currentSessionId = id
        sessionRef = target.session
      }
    },

    onToolTrace(cb) {
      toolTraceCallbacks.add(cb)
      return () => toolTraceCallbacks.delete(cb)
    },
    onApprovalRequest(cb) {
      approvalCallbacks.add(cb)
      return () => approvalCallbacks.delete(cb)
    },
    respondApproval(outcome) {
      if (pendingApproval) {
        pendingApproval.resolve(outcome)
        pendingApproval = null
      }
    },

    onDelta(cb) {
      deltaCallbacks.add(cb)
      return () => {
        deltaCallbacks.delete(cb)
      }
    },

    switchModel(modelId) {
      currentModelId = modelId
      // 通过网关转发到对应模型（保持网关 baseUrl，只改 model 参数）
      if (gatewayApiKey && gatewayBaseUrl) {
        model = new DeepSeekProvider({ apiKey: gatewayApiKey, baseUrl: gatewayBaseUrl, model: modelId })
      }
      // 持久化选中模型到 config.json（下次打开不再重复选择）
      void persistSelectedModel(modelId)
    },
    getCurrentModelId() {
      return currentModelId
    },
    stop() {
      stopped = true
    },

    run: async (message, opts) => {
      stopped = false
      const loop = new AgentLoop(model, tools, sessionRef, approval)
      try {
        return await loop.run(message, {
          ...opts,
          onDelta: (text) => {
            if (stopped) throw new Error('__stopped__')
            deltaCallbacks.forEach((cb) => cb(text))
          },
        })
      } catch (err) {
        if (err instanceof Error && err.message === '__stopped__') {
          return '（已中断，历史已保留，可继续输入以续跑）'
        }
        throw err
      }
    },
  }
}
