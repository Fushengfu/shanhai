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

/** 返回大结果（1000 字符）的工具：用于把「当前轮」撑到超窗口，触发循环中压缩当前轮 */
function bigResultTool(): ToolContract {
  return {
    name: 'big',
    description: 'big',
    inputSchema: {},
    riskLevel: 'readonly',
    execute: async () => ({ output: 'x'.repeat(1000) }),
  }
}

describe('AgentLoop 上下文压缩（用真实 usage 判断，非本地估算）', () => {
  it('循环中真实 usage 超窗口时：压缩当前轮（工具步骤压成摘要），历史回合保留原文', async () => {
    const session = new Session()
    // 塞 10 条历史（user/assistant 交替），作为「历史回合」，压缩时不应被丢弃
    for (let i = 0; i < 10; i++) {
      session.append(i % 2 === 0 ? 'user/message' : 'assistant/message', { content: `历史消息第${i}条` })
    }

    let summarizeCount = 0
    const decideMessages: ChatMessage[][] = []
    const model: Model = {
      complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system')?.content ?? ''
        if (typeof sys === 'string' && sys.includes('摘要器')) {
          summarizeCount++
          return { text: '本轮进度摘要' }
        }
        decideMessages.push(messages)
        if (decideMessages.length === 1) {
          // 第一次 decide：返回工具调用，且返回的真实 usage 超过 budget（100），
          // 表示这次请求上下文已逼近/超过窗口，下一轮将触发压缩当前轮
          return {
            toolCall: { id: 'c1', name: 'big', args: {} },
            usage: { promptTokens: 200, completionTokens: 1, totalTokens: 201 },
          }
        }
        return { text: '最终回复', usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } }
      },
    }

    // budget=100：第一次请求返回 usage=201 > 100，触发下一轮压缩当前轮
    const loop = new AgentLoop(model, [bigResultTool()], session, new ApprovalService(), 's1', 100)
    const result = await loop.run('当前问题', { systemPrompt: '你是系统提示词' })
    expect(result).toBe('最终回复')
    // 压缩被触发
    expect(summarizeCount).toBeGreaterThan(0)
    const decided = decideMessages[decideMessages.length - 1]!
    // system 提示词保留
    expect(decided.some((m) => m.role === 'system' && (m.content as string).includes('你是系统提示词'))).toBe(true)
    // 历史回合原文保留（不被压进摘要）
    expect(decided.some((m) => m.content === '历史消息第0条')).toBe(true)
    expect(decided.some((m) => m.content === '历史消息第8条')).toBe(true)
    // 当前 user 消息保留
    expect(decided.some((m) => m.content === '当前问题')).toBe(true)
    // 当前轮的工具步骤被替换成「本轮执行摘要」
    expect(decided.some((m) => (m.content as string).includes('【本轮执行摘要】'))).toBe(true)
    // 当前轮工具步骤已被摘要替换，不再有 tool 消息
    expect(decided.some((m) => m.role === 'tool')).toBe(false)
  })

  it('真实 usage 未超窗口时不压缩（原文直传）', async () => {
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

  it('无工具步骤时不压缩（当前轮为空无从压缩）', async () => {
    const session = new Session()
    for (let i = 0; i < 10; i++) {
      session.append(i % 2 === 0 ? 'user/message' : 'assistant/message', { content: `历史消息第${i}条` })
    }
    let summarizeCount = 0
    const model: Model = {
      complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system')?.content ?? ''
        if (typeof sys === 'string' && sys.includes('摘要器')) summarizeCount++
        return { text: 'ok' } // 不返回 toolCall，当前轮无工具步骤
      },
    }
    const loop = new AgentLoop(model, [], session, new ApprovalService(), 's1', 1)
    const result = await loop.run('hello')
    expect(result).toBe('ok')
    expect(summarizeCount).toBe(0)
  })

  it('断点续跑：恢复的真实 usage 超窗口时压缩当前轮（最后一条 user 之后的工具步骤）', async () => {
    const session = new Session()
    // 历史：一轮完整对话 + 最后一轮 user 之后有工具步骤（大结果，模拟上次中断在工具循环中）
    session.append('user/message', { content: '问题A' })
    session.append('assistant/message', { content: '回答A' })
    session.append('user/message', { content: '问题B' })
    session.append('tool/call', { callId: 'cB', name: 'big', args: {} })
    session.append('tool/result', { callId: 'cB', name: 'big', result: { output: 'x'.repeat(1000) } })
    // 历史里已有一条 usage/record，totalTokens 超过 budget，恢复后触发压缩
    session.append('usage/record', { totalTokens: 201, promptTokens: 200, completionTokens: 1 })

    let summarizeCount = 0
    const model: Model = {
      complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system')?.content ?? ''
        if (typeof sys === 'string' && sys.includes('摘要器')) {
          summarizeCount++
          return { text: '本轮进度摘要' }
        }
        return { text: '最终回复', usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } }
      },
    }
    // resumeRun 恢复 lastUsageTotalTokens=201 > budget=100，首轮即压缩当前轮
    const loop = new AgentLoop(model, [bigResultTool()], session, new ApprovalService(), 's1', 100)
    const result = await loop.resumeRun('你是系统提示词')
    expect(result).toBe('最终回复')
    expect(summarizeCount).toBeGreaterThan(0)
  })

  it('网关返回上下文超限 400 时：强制压缩当前轮后重试，不把错误抛给用户', async () => {
    const session = new Session()
    for (let i = 0; i < 10; i++) {
      session.append(i % 2 === 0 ? 'user/message' : 'assistant/message', { content: `历史消息第${i}条` })
    }
    let summarizeCount = 0
    let decideCount = 0
    const model: Model = {
      complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system')?.content ?? ''
        if (typeof sys === 'string' && sys.includes('摘要器')) {
          summarizeCount++
          return { text: '本轮进度摘要' }
        }
        decideCount++
        if (decideCount === 1) {
          // 第一次：返回工具调用（让当前轮有工具步骤可压）
          return { toolCall: { id: 'c1', name: 'echo', args: {} }, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
        }
        if (decideCount === 2) {
          // 第二次发送：网关明确报上下文超限（真实 400）
          throw new Error(
            "upstream error 400: This model's maximum context length is 1048576 tokens. However, you requested 1216414 tokens",
          )
        }
        return { text: '最终回复', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
      },
    }
    const loop = new AgentLoop(model, [echoTool()], session, new ApprovalService(), 's1', 100000)
    const result = await loop.run('续跑')
    expect(result).toBe('最终回复')
    // 400 后触发强制压缩当前轮
    expect(summarizeCount).toBeGreaterThan(0)
    // 压缩后重试成功（decide 共调用 3 次：工具调用 + 400 + 重试成功）
    expect(decideCount).toBe(3)
  })

  it('压缩不破坏 tool 配对：历史 tool 配对保留，当前轮被摘要替换（无孤立 tool 消息）', async () => {
    const session = new Session()
    // 多轮工具调用历史：user → tool/call → tool/result → assistant，重复多轮（制造 tool 配对）
    for (let i = 0; i < 6; i++) {
      session.append('user/message', { content: `问题${i}` })
      session.append('tool/call', { callId: `c${i}`, name: 'big', args: {} })
      session.append('tool/result', { callId: `c${i}`, name: 'big', result: { output: 'x'.repeat(50) } })
      session.append('assistant/message', { content: `回答${i}` })
    }
    let summarizeMessages: ChatMessage[] | null = null
    const decideMessages: ChatMessage[][] = []
    const model: Model = {
      complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system')?.content ?? ''
        if (typeof sys === 'string' && sys.includes('摘要器')) {
          summarizeMessages = messages
          return { text: '本轮进度摘要' }
        }
        decideMessages.push(messages)
        if (decideMessages.length === 1) {
          // 第一次 decide：返回工具调用，真实 usage 超过 budget，触发下一轮压缩当前轮
          return { toolCall: { id: 'cX', name: 'big', args: {} }, usage: { promptTokens: 200, completionTokens: 1, totalTokens: 201 } }
        }
        return { text: '最终回复', usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } }
      },
    }
    // budget=100：第一次请求返回 usage=201 > 100，触发下一轮压缩当前轮
    const loop = new AgentLoop(model, [bigResultTool()], session, new ApprovalService(), 's1', 100)
    const result = await loop.run('当前问题')
    expect(result).toBe('最终回复')
    // 摘要请求：当前轮被压平成 user 文本（无 tool 消息、无带 toolCalls 的 assistant），避免摘要请求本身触发网关 400/502
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
