import { describe, it, expect } from 'vitest'
import type { Model, ChatMessage } from '@shanhai/llm'
import { Session } from '@shanhai/session'
import { ApprovalService } from '@shanhai/approval'
import { AgentLoop } from '../src/agent'

describe('AgentLoop 历史压缩（token 预算）', () => {
  it('超预算时压缩：保留 system + 生成摘要 + 保留最近原文', async () => {
    const session = new Session()
    // 塞 10 条历史（user/assistant 交替），让历史明显超预算
    for (let i = 0; i < 10; i++) {
      session.append(i % 2 === 0 ? 'user/message' : 'assistant/message', { content: `历史消息第 ${i} 条，内容较长用于占 token` })
    }

    let summarizeCount = 0
    const decideMessages: ChatMessage[][] = []
    const model: Model = {
      complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system')?.content ?? ''
        if (typeof sys === 'string' && sys.includes('摘要器')) {
          summarizeCount++
          return { text: '压缩后的历史摘要' }
        }
        decideMessages.push(messages)
        return { text: '最终回复' }
      },
    }

    // budget=1 必然超预算，触发压缩
    const loop = new AgentLoop(model, [], session, new ApprovalService(), 's1', 1)
    const result = await loop.run('当前问题', { systemPrompt: '你是系统提示词' })
    expect(result).toBe('最终回复')
    // 压缩被触发
    expect(summarizeCount).toBeGreaterThan(0)
    // decide 时：system 保留（系统提示词）+ 摘要 system + 最近原文
    const decided = decideMessages[decideMessages.length - 1]!
    const sysContents = decided.filter((m) => m.role === 'system').map((m) => m.content as string)
    expect(sysContents.some((s) => s.includes('你是系统提示词'))).toBe(true)
    expect(sysContents.some((s) => s.includes('【历史摘要】'))).toBe(true)
    // 消息总数被压缩（远小于 11 条原文）
    expect(decided.length).toBeLessThan(11)
  })

  it('未超预算时不压缩（原文直传）', async () => {
    const session = new Session()
    session.append('user/message', { content: 'hi' })
    const model: Model = {
      complete: async (messages) => {
        // 不该出现「摘要器」system（未触发压缩）
        expect(messages.some((m) => (m.content as string)?.includes('摘要器'))).toBe(false)
        return { text: 'ok' }
      },
    }
    const loop = new AgentLoop(model, [], session, new ApprovalService(), 's1', 100000)
    const result = await loop.run('hello')
    expect(result).toBe('ok')
  })
})
