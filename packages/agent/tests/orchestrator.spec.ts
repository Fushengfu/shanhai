import { describe, it, expect } from 'vitest'
import { createMockModel } from '@shanhai/llm'
import { Session } from '@shanhai/session'
import { ApprovalService } from '@shanhai/approval'
import { AgentLoop } from '../src/agent'
import { ModelTriage } from '../src/triage'
import { Orchestrator } from '../src/orchestrator'
import type { RoleDefinition } from '../src/contract'

const ROLES: RoleDefinition[] = [
  { id: 'general', name: '通用助手', description: '通用', systemPrompt: '', toolSet: [], skillSet: [] },
  { id: 'code', name: '代码专家', description: '代码', systemPrompt: '', toolSet: [], skillSet: [] },
]

function textAgent(text: string): AgentLoop {
  return new AgentLoop(createMockModel([{ text }]), [], new Session(), new ApprovalService())
}

describe('ModelTriage（模型拆解）', () => {
  it('拆解多步 JSON，识别专家与依赖', async () => {
    const model = createMockModel([
      { text: '{"steps":[{"id":"s1","expertId":"code","title":"读代码","deps":[]},{"id":"s2","expertId":"code","title":"改代码","deps":["s1"]}]}' },
    ])
    const plan = await new ModelTriage(model, ROLES).route('读代码然后改')
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]!.expertId).toBe('code')
    expect(plan.steps[1]!.deps).toContain('s1')
  })

  it('markdown 围栏包裹的 JSON 也能解析', async () => {
    const model = createMockModel([
      { text: '```json\n{"steps":[{"id":"s1","expertId":"general","title":"hi","deps":[]}]}\n```' },
    ])
    const plan = await new ModelTriage(model, ROLES).route('hi')
    expect(plan.steps).toHaveLength(1)
  })

  it('非法 JSON 退化为单步 general（不阻断主流程）', async () => {
    const model = createMockModel([{ text: '这不是 JSON' }])
    const plan = await new ModelTriage(model, ROLES).route('hi')
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]!.expertId).toBe('general')
  })

  it('未知专家 id 归一化为 general', async () => {
    const model = createMockModel([
      { text: '{"steps":[{"id":"s1","expertId":"nobody","title":"x","deps":[]}]}' },
    ])
    const plan = await new ModelTriage(model, ROLES).route('x')
    expect(plan.steps[0]!.expertId).toBe('general')
  })
})

describe('Orchestrator（多专家调度）', () => {
  it('按依赖串行调度，轨迹 started→completed 顺序正确', async () => {
    const triage = new ModelTriage(
      createMockModel([
        { text: '{"steps":[{"id":"s1","expertId":"general","title":"第一步","deps":[]},{"id":"s2","expertId":"general","title":"第二步","deps":["s1"]}]}' },
      ]),
      ROLES,
    )
    const agents = new Map<string, AgentLoop>()
    agents.set('general', textAgent('结果A'))
    const traces: string[] = []
    const orch = new Orchestrator(triage, agents, {
      sessionId: 's1',
      expertNames: new Map([['general', '通用助手']]),
      onStep: (t) => traces.push(`${t.status}:${t.title}`),
    })
    const result = await orch.run('任务')
    expect(result.status).toBe('completed')
    expect(result.text).toContain('第一步')
    const s1c = traces.indexOf('completed:第一步')
    const s2s = traces.indexOf('started:第二步')
    expect(s1c).toBeGreaterThanOrEqual(0)
    expect(s2s).toBeGreaterThan(s1c)
  })

  it('轨迹带 sessionId，专家 systemPrompt 被注入', async () => {
    const triage = new ModelTriage(
      createMockModel([
        { text: '{"steps":[{"id":"s1","expertId":"code","title":"写代码","deps":[]}]}' },
      ]),
      ROLES,
    )
    const captured: string[] = []
    const model = {
      complete: async (messages: Array<{ role: string; content: string }>) => {
        captured.push(messages.find((m) => m.role === 'system')?.content ?? '')
        return { text: 'ok' }
      },
    }
    const agents = new Map<string, AgentLoop>()
    agents.set('code', new AgentLoop(model, [], new Session(), new ApprovalService()))
    const traceIds: string[] = []
    const orch = new Orchestrator(triage, agents, {
      sessionId: 'sess-1',
      expertNames: new Map([['code', '代码专家']]),
      expertSystemPrompts: new Map([['code', '你是代码专家']]),
      onStep: (t) => traceIds.push(t.sessionId ?? ''),
    })
    await orch.run('写个函数')
    expect(captured[0]).toContain('你是代码专家')
    expect(traceIds[0]).toBe('sess-1')
  })

  it('单步失败不中断整条链，后续步骤仍执行', async () => {
    const triage = new ModelTriage(
      createMockModel([
        { text: '{"steps":[{"id":"s1","expertId":"general","title":"会失败","deps":[]},{"id":"s2","expertId":"general","title":"继续","deps":["s1"]}]}' },
      ]),
      ROLES,
    )
    const failing = new AgentLoop(
      {
        complete: async () => {
          throw new Error('boom')
        },
      },
      [],
      new Session(),
      new ApprovalService(),
    )
    const agents = new Map<string, AgentLoop>()
    agents.set('general', failing)
    const orch = new Orchestrator(triage, agents, { sessionId: 's1' })
    const result = await orch.run('任务')
    expect(result.status).toBe('completed')
    expect(result.text).toContain('会失败')
    expect(result.text).toContain('继续')
  })
})
