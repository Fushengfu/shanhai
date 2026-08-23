import { describe, it, expect } from 'vitest'
import type { Model, StreamChunk, ContentPart, ChatMessage } from '@shanhai/llm'
import { createMockModel } from '@shanhai/llm'
import { toolReasoningContext, type ToolContract } from '@shanhai/tools'
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

  it('工具调用：reasoning 通过 toolReasoningContext 传给工具执行', async () => {
    const session = new Session()
    const captured: Array<string | undefined> = []
    const probeTool: ToolContract = {
      name: 'probe',
      description: 'probe',
      inputSchema: {},
      riskLevel: 'readonly',
      execute: async () => {
        // 工具执行时从上下文读出「这一步对应的思考」，runtime 工具包装层据此关联 trace
        captured.push(toolReasoningContext.getStore())
        return { ok: true }
      },
    }
    const model = createMockModel([
      { toolCall: { id: 'c1', name: 'probe', args: {} }, reasoningContent: '我想先探测一下环境' },
      { text: 'done' },
    ])
    const loop = new AgentLoop(model, [probeTool], session, new ApprovalService())
    const result = await loop.run('x')
    expect(result).toBe('done')
    expect(captured).toEqual(['我想先探测一下环境'])
    // reasoning 也落盘到 tool/call 事件，供历史回放渲染
    const callEvt = session.list().find((e) => e.type === 'tool/call')
    expect((callEvt!.data as { reasoningContent?: string }).reasoningContent).toBe('我想先探测一下环境')
  })

  it('超 maxSteps 抛错（不收敛）', async () => {
    const session = new Session()
    const model = createMockModel([{ toolCall: { name: 'echo', args: {} } }])
    const loop = new AgentLoop(model, [echoTool()], session, new ApprovalService())
    await expect(loop.run('x', { maxSteps: 3 })).rejects.toThrow('did not converge')
  })

  it('图片降级：modelContent 存在时落盘保留原始 message + attachments，发模型用降级内容', async () => {
    const session = new Session()
    const sent: string[] = []
    const model: Model = {
      complete: async (messages) => {
        sent.push(typeof messages[0]?.content === 'string' ? (messages[0].content as string) : 'non-string')
        return { text: 'ok' }
      },
    }
    const attachments: ContentPart[] = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }]
    const loop = new AgentLoop(model, [], session, new ApprovalService())
    const result = await loop.run('这张图有啥', {
      attachments,
      modelContent: '这张图有啥\n\n【图片】这是一张手机截图',
    })
    expect(result).toBe('ok')
    // 落盘的 user/message 必须保留原始文本 + 原始图片附件（重启后历史能恢复图片，而非变成描述文字）
    const userEvt = session.list().find((e) => e.type === 'user/message')
    expect((userEvt!.data as { content: string }).content).toBe('这张图有啥')
    expect((userEvt!.data as { attachments?: unknown[] }).attachments).toEqual(attachments)
    // 发给模型的是降级后的文字内容
    expect(sent[0]).toBe('这张图有啥\n\n【图片】这是一张手机截图')
  })

  it('注入消息：落盘带 injected 标记 + 上下文以「追加需求」包装（评估并执行新增需求，正文体现完成情况）', async () => {
    const session = new Session()
    const captured: Array<Array<{ role: string; content: string }>> = []
    let loop: AgentLoop
    const model: Model = {
      complete: async (messages) => {
        captured.push(messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })))
        if (captured.length === 1) {
          // 第一次调用（原始任务）返回工具调用；期间模拟用户插入模式追加消息
          loop.injectUserMessage('追加需求A：顺便帮我列个清单')
          return { toolCall: { id: 'c1', name: 'echo', args: {} } }
        }
        return { text: 'done' }
      },
    }
    loop = new AgentLoop(model, [echoTool()], session, new ApprovalService())
    const result = await loop.run('原始任务')
    expect(result).toBe('done')
    // 注入消息以 injected 标记落盘（UI 据此不显示为独立用户气泡）
    const injectedEvt = session.list().find((e) => e.type === 'user/message' && (e.data as { injected?: boolean }).injected)
    expect(injectedEvt).toBeTruthy()
    expect((injectedEvt!.data as { content: string }).content).toBe('追加需求A：顺便帮我列个清单')
    // 第二次模型调用（最终回答轮）的上下文里，注入消息被「追加需求」标记 + 编号列表包装
    const second = captured[1] ?? []
    const wrapped = second.find((m) => m.role === 'user' && m.content.includes('【任务执行期间，用户追加了以下新需求/新问题】'))
    expect(wrapped).toBeTruthy()
    expect(wrapped!.content).toContain('1. 追加需求A：顺便帮我列个清单')
    expect(wrapped!.content).toContain('新增需求完成情况')
    expect(wrapped!.content).toContain('评估')
  })

  it('重试耗尽：落盘 retry/snapshot 快照（含 reason），重启后可精确重试', async () => {
    const session = new Session()
    const model: Model = {
      complete: async () => {
        throw new Error('网络超时 timed out')
      },
    }
    const loop = new AgentLoop(model, [], session, new ApprovalService())
    await expect(loop.run('hello')).rejects.toThrow('__retry_exhausted__')
    // 挂起快照已落盘，reason 为失败原因
    const snapEvt = session.list().find((e) => e.type === 'retry/snapshot')
    expect(snapEvt).toBeTruthy()
    const data = snapEvt!.data as { messages: unknown[]; step: number; maxSteps: number; atLimit: boolean; reason?: string }
    expect(data.reason).toContain('网络超时 timed out')
    expect(Array.isArray(data.messages)).toBe(true)
    expect(loop.isSuspended()).toBe(true)
  })

  it('重启恢复：从快照 restoreSuspended 后 retry 用相同 messages 继续并成功，清理快照', async () => {
    const session = new Session()
    // 第一次：重试耗尽挂起
    const failingModel: Model = {
      complete: async () => {
        throw new Error('余额不足 quota exceeded')
      },
    }
    const loop1 = new AgentLoop(failingModel, [], session, new ApprovalService())
    await expect(loop1.run('hello')).rejects.toThrow('__retry_exhausted__')
    // 从事件日志读快照（模拟重启后恢复）
    const snapEvt = session.list().find((e) => e.type === 'retry/snapshot')
    expect(snapEvt).toBeTruthy()
    const snapshot = snapEvt!.data as unknown as { messages: ChatMessage[]; step: number; maxSteps: number; atLimit: boolean; reason?: string }
    // 第二次：成功模型，restore 后精确重试
    const okModel: Model = { complete: async () => ({ text: 'recovered' }) }
    const loop2 = new AgentLoop(okModel, [], session, new ApprovalService())
    loop2.restoreSuspended(snapshot)
    const result = await loop2.retry()
    expect(result).toBe('recovered')
    // 快照被清理，任务完成落 turn/end
    expect(session.list().find((e) => e.type === 'retry/snapshot')).toBeUndefined()
    expect(session.list().map((e) => e.type)).toContain('turn/end')
  })
})
