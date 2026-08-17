import { describe, it, expect } from 'vitest'
import type { Model, StreamChunk } from '@shanhai/llm'
import { createMockModel } from '@shanhai/llm'
import type { ToolContract } from '@shanhai/tools'
import { Session } from '@shanhai/session'
import { ApprovalService } from '@shanhai/approval'
import { AgentLoop } from '../src/agent'

function echoTool(): ToolContract {
  return {
    name: 'echo',
    description: 'echo',
    inputSchema: {},
    riskLevel: 'readonly',
    execute: async (args) => ({ echoed: args.text }),
  }
}

function streamingModel(text: string): Model {
  return {
    complete: async () => ({ text }),
    stream: async function* (): AsyncIterable<StreamChunk> {
      for (const ch of text) yield { text: ch }
    },
  }
}

describe('AgentLoop（ReAct）', () => {
  it('纯文本：直接返回并落 turn 事件', async () => {
    const session = new Session()
    const loop = new AgentLoop(createMockModel([{ text: 'hi' }]), [], session, new ApprovalService())
    const result = await loop.run('hello')
    expect(result).toBe('hi')
    expect(session.list().map((e) => e.type)).toContain('turn/end')
  })

  it('流式：逐 delta 落 assistant/delta 事件', async () => {
    const session = new Session()
    const loop = new AgentLoop(streamingModel('abc'), [], session, new ApprovalService())
    const result = await loop.run('hello')
    expect(result).toBe('abc')
    const deltas = session.list().filter((e) => e.type === 'assistant/delta')
    expect(deltas.map((e) => (e.data as { text: string }).text).join('')).toBe('abc')
  })

  it('工具调用：先 toolCall 后文本，工具被执行并回喂', async () => {
    const session = new Session()
    const model = createMockModel([
      { toolCall: { id: 'c1', name: 'echo', args: { text: 'ping' } } },
      { text: 'done' },
    ])
    const loop = new AgentLoop(model, [echoTool()], session, new ApprovalService())
    const result = await loop.run('do echo')
    expect(result).toBe('done')
    const types = session.list().map((e) => e.type)
    expect(types).toContain('tool/call')
    expect(types).toContain('tool/result')
  })

  it('超 maxSteps 抛错（不收敛）', async () => {
    const session = new Session()
    const model = createMockModel([{ toolCall: { name: 'echo', args: {} } }])
    const loop = new AgentLoop(model, [echoTool()], session, new ApprovalService())
    await expect(loop.run('x', { maxSteps: 3 })).rejects.toThrow('did not converge')
  })
})
