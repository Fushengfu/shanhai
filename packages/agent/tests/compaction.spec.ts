import { describe, it, expect } from 'vitest'
import type { Model, ChatMessage } from '@shanhai/llm'
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
    execute: async () => ({}),
  }
}

describe('AgentLoop 历史压缩（用接口真实 usage 判断，非本地估算）', () => {
  it('接口返回的真实 usage.total_tokens 超阈值时压缩：保留 system + 生成摘要 + 保留最近原文', async () => {
    const session = new Session()
    // 塞 10 条历史（user/assistant 交替），让压缩时有足够内容
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
        if (decideMessages.length === 1) {
          // 第一次 decide：返回 toolCall，并模拟接口返回「超阈值」的真实 usage
          return {
            toolCall: { id: 'c1', name: 'echo', args: {} },
            usage: { promptTokens: 70000, completionTokens: 10, totalTokens: 70010 },
          }
        }
        return { text: '最终回复', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
      },
    }

    // budget = 上下文窗口大小 100000；阈值 = 60000；第一次 usage.totalTokens=70010 超阈值 → 第二轮触发压缩
    const loop = new AgentLoop(model, [echoTool()], session, new ApprovalService(), 's1', 100000)
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

  it('真实 usage 未超阈值时不压缩（原文直传）', async () => {
    const session = new Session()
    session.append('user/message', { content: 'hi' })
    const model: Model = {
      complete: async (messages) => {
        // 不该出现「摘要器」system（未触发压缩）
        expect(messages.some((m) => (m.content as string)?.includes('摘要器'))).toBe(false)
        return { text: 'ok', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } }
      },
    }
    const loop = new AgentLoop(model, [], session, new ApprovalService(), 's1', 100000)
    const result = await loop.run('hello')
    expect(result).toBe('ok')
  })

  it('模型不返回 usage 时不压缩（无真实用量则安全跳过，绝不本地估算）', async () => {
    const session = new Session()
    for (let i = 0; i < 10; i++) {
      session.append(i % 2 === 0 ? 'user/message' : 'assistant/message', { content: `历史消息第 ${i} 条` })
    }
    let summarizeCount = 0
    const model: Model = {
      complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system')?.content ?? ''
        if (typeof sys === 'string' && sys.includes('摘要器')) summarizeCount++
        return { text: 'ok' } // 不返回 usage
      },
    }
    const loop = new AgentLoop(model, [], session, new ApprovalService(), 's1', 1)
    const result = await loop.run('hello')
    expect(result).toBe('ok')
    expect(summarizeCount).toBe(0)
  })

  it('断点续跑恢复历史真实 usage：session 里有 usage/record 时，新建 AgentLoop 首轮即触发压缩', async () => {
    const session = new Session()
    for (let i = 0; i < 10; i++) {
      session.append(i % 2 === 0 ? 'user/message' : 'assistant/message', { content: `历史消息第 ${i} 条` })
    }
    // 模拟上次运行留下的真实 usage（接口返回 totalTokens，超阈值）
    session.append('usage/record', { totalTokens: 70010, promptTokens: 70000, completionTokens: 10 })

    let summarizeCount = 0
    const model: Model = {
      complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system')?.content ?? ''
        if (typeof sys === 'string' && sys.includes('摘要器')) {
          summarizeCount++
          return { text: '压缩后的历史摘要' }
        }
        return { text: '最终回复', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
      },
    }
    // 新建 AgentLoop（等价 resume），构造函数从 session 恢复 usage=70010 > 阈值 60000 → 首轮就该压缩
    const loop = new AgentLoop(model, [], session, new ApprovalService(), 's1', 100000)
    const result = await loop.run('续跑')
    expect(result).toBe('最终回复')
    expect(summarizeCount).toBeGreaterThan(0)
  })

  it('网关返回上下文超限 400 时：强制压缩后重试，不把错误抛给用户', async () => {
    const session = new Session()
    for (let i = 0; i < 10; i++) {
      session.append(i % 2 === 0 ? 'user/message' : 'assistant/message', { content: `历史消息第 ${i} 条，内容较长` })
    }
    let summarizeCount = 0
    let decideCount = 0
    const model: Model = {
      complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system')?.content ?? ''
        if (typeof sys === 'string' && sys.includes('摘要器')) {
          summarizeCount++
          return { text: '压缩后的历史摘要' }
        }
        decideCount++
        if (decideCount === 1) {
          // 第一次发送：网关明确报上下文超限（真实 400）
          throw new Error(
            "upstream error 400: This model's maximum context length is 1048576 tokens. However, you requested 1216414 tokens",
          )
        }
        return { text: '最终回复', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
      },
    }
    const loop = new AgentLoop(model, [], session, new ApprovalService(), 's1', 100000)
    const result = await loop.run('续跑')
    expect(result).toBe('最终回复')
    // 400 后触发强制压缩
    expect(summarizeCount).toBeGreaterThan(0)
    // 压缩后重试成功（decide 共调用 2 次）
    expect(decideCount).toBe(2)
  })

  it('压缩不破坏 tool 配对：摘要请求剥离 tool/toolCalls，压缩后无孤立 tool 消息', async () => {
    const session = new Session()
    // 多轮工具调用历史：user → tool/call → tool/result → assistant，重复多轮（制造足够多的 tool 配对）
    for (let i = 0; i < 6; i++) {
      session.append('user/message', { content: `问题 ${i}` })
      session.append('tool/call', { callId: `c${i}`, name: 'echo', args: {} })
      session.append('tool/result', { callId: `c${i}`, name: 'echo', result: {} })
      session.append('assistant/message', { content: `回答 ${i}` })
    }
    let summarizeMessages: ChatMessage[] | null = null
    const decideMessages: ChatMessage[][] = []
    const model: Model = {
      complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system')?.content ?? ''
        if (typeof sys === 'string' && sys.includes('摘要器')) {
          summarizeMessages = messages
          return { text: '压缩摘要' }
        }
        decideMessages.push(messages)
        if (decideMessages.length === 1) {
          // 第一次 decide：返回工具调用 + 超阈值的真实 usage，触发第二轮压缩
          return { toolCall: { id: 'cX', name: 'echo', args: {} }, usage: { promptTokens: 70000, completionTokens: 10, totalTokens: 70010 } }
        }
        return { text: '最终回复', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
      },
    }
    const loop = new AgentLoop(model, [echoTool()], session, new ApprovalService(), 's1', 100000)
    const result = await loop.run('当前问题')
    expect(result).toBe('最终回复')
    // 摘要请求：剥离了 tool 消息与带 toolCalls 的 assistant 消息（否则切片边界破坏配对，网关 400/502）
    expect(summarizeMessages).toBeTruthy()
    expect(summarizeMessages!.some((m) => m.role === 'tool')).toBe(false)
    expect(summarizeMessages!.some((m) => m.role === 'assistant' && ((m.toolCalls?.length ?? 0) > 0 || m.toolCall))).toBe(false)
    // 压缩后主对话：每个 tool 消息前面都有对应的 assistant(tool_calls)（无孤立 tool）
    const decided = decideMessages[decideMessages.length - 1]!
    for (let i = 0; i < decided.length; i++) {
      const m = decided[i]!
      if (m.role === 'tool') {
        let hasPrecedingToolCall = false
        for (let j = i - 1; j >= 0; j--) {
          const prev = decided[j]!
          if (prev.role === 'assistant') {
            hasPrecedingToolCall = (prev.toolCalls?.length ?? 0) > 0 || !!prev.toolCall
            break
          }
          if (prev.role === 'user' || prev.role === 'system') break
        }
        expect(hasPrecedingToolCall).toBe(true)
      }
    }
  })
})
