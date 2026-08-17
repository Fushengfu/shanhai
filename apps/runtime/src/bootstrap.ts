import { Kernel } from '@shanhai/kernel'
import { Session } from '@shanhai/session'
import { ApprovalService } from '@shanhai/approval'
import { AgentLoop } from '@shanhai/agent'
import type { Model } from '@shanhai/llm'
import { createMockModel, DeepSeekProvider } from '@shanhai/llm'
import { atomicTools, type ToolContract } from '@shanhai/tools'
import { MemoryStore } from '@shanhai/memory'
import { FileCredentialStore } from '@shanhai/auth'
import { createMockVoiceService, type VoiceService } from '@shanhai/voice'
import { createMockComputerUseService, type ComputerUseService } from '@shanhai/computer-use'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Runtime {
  kernel: Kernel
  session: Session
  tools: ToolContract[]
  model: Model
  agent: AgentLoop
  memory: MemoryStore
  credentials: FileCredentialStore
  voice: VoiceService
  computerUse: ComputerUseService
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
 * host 装配：用内核装配底座服务 + 能力插件（声明式 inject）。
 *
 * 这是「内核收编」的最小闭环：能力插件全部以内核插件形态注册，
 * 依赖通过 inject 声明，内核负责时序（依赖缺失挂起 pending）。
 */
export async function bootstrap(): Promise<Runtime> {
  const kernel = new Kernel()

  // 底座能力实例（先实例化，再以内核插件形态装配）
  const session = new Session()
  const approval = new ApprovalService()
  const tools = atomicTools()
  const model = await createGatewayModel()
  const memory = new MemoryStore()
  const credentials = new FileCredentialStore()
  const voice = createMockVoiceService()
  const computerUse = createMockComputerUseService()
  const agent = new AgentLoop(model, tools, session, approval)

  // 装配底座服务（声明式 inject：agent 依赖 session/approval/tools）
  await kernel.plugin({
    name: 'session-service',
    provide: ['session'],
    apply: (ctx) => {
      ctx.provide('session', session)
    },
  })
  await kernel.plugin({
    name: 'approval-service',
    provide: ['approval'],
    apply: (ctx) => {
      ctx.provide('approval', approval)
    },
  })
  await kernel.plugin({
    name: 'agent-service',
    inject: ['session', 'approval'],
    provide: ['agent'],
    apply: (ctx) => {
      ctx.provide('agent', agent)
    },
  })

  return {
    kernel,
    session,
    tools,
    model,
    agent,
    memory,
    credentials,
    voice,
    computerUse,
    run: (message, opts) => agent.run(message, opts),
  }
}
