import { Kernel } from '@shanhai/kernel'
import { Session } from '@shanhai/session'
import { ApprovalService } from '@shanhai/approval'
import { AgentLoop } from '@shanhai/agent'
import type { Model } from '@shanhai/llm'
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

  /** 跑一次任务（端到端 ReAct） */
  run(message: string, opts?: { maxSteps?: number }): Promise<string>
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

/**
 * host 装配：用内核装配底座服务 + 能力插件。
 * 暴露登录 / 会话 / 模型 / 工具过程 / 审批 等产品能力。
 */
export async function bootstrap(): Promise<Runtime> {
  const kernel = new Kernel()

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

  // —— 工具（包装：落 trace）——
  const baseTools = atomicTools()
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
  const model = await createGatewayModel()
  let sessionRef = sessions.get(currentSessionId!)!.session
  const deltaCallbacks = new Set<(text: string) => void>()

  // —— 登录 ——
  const credentials = new FileCredentialStore()
  const authService = new AuthService({ baseUrl: 'https://agent.bjctykj.com' })
  // 启动时恢复本地凭证（有 gateway apiKey 则视为已登录，模型调用走 apiKey）
  let loggedIn = false
  let username: string | null = null
  try {
    const raw = await fs.readFile(join(homedir(), '.shanhai', 'config.json'), 'utf8')
    const cfg = JSON.parse(raw) as { gateway?: { apiKey?: string; account?: { username?: string } } }
    if (cfg.gateway?.apiKey) {
      loggedIn = true
      username = cfg.gateway.account?.username ?? null
    }
  } catch {
    // 无凭证，未登录
  }
  let gatewayModels: GatewayModel[] = []
  let selectedTier: ModelTier = 'flagship'

  // —— 其余能力 ——
  const memory = new MemoryStore()
  const voice = createMockVoiceService()
  const computerUse = createMockComputerUseService()

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
      if (gatewayModels.length === 0) {
        const cred = await credentials.load()
        if (cred?.token) {
          gatewayModels = await authService.fetchModels(cred.token)
        }
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

    run: (message, opts) => {
      const loop = new AgentLoop(model, tools, sessionRef, approval)
      return loop.run(message, {
        ...opts,
        onDelta: (text) => {
          deltaCallbacks.forEach((cb) => cb(text))
        },
      })
    },
  }
}
