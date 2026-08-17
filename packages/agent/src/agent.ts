import type { ChatMessage, Model, ModelResponse, ToolCall } from '@shanhai/llm'
import type { ToolContract } from '@shanhai/tools'
import type { Session } from '@shanhai/session'
import type { ApprovalService } from '@shanhai/approval'

export interface AgentLoopOptions {
  maxSteps?: number
  systemPrompt?: string
  /** 流式增量回调（UI 实时逐字渲染用） */
  onDelta?: (text: string) => void
}

/**
 * AgentLoop（对齐 dsh-agent-loop）：ReAct 循环。
 *
 * 消息 → 模型决策 → 工具审批 → 工具执行 → 结果回喂 → 再决策，直到文本收敛。
 * 每个可观测步骤落一条类型化会话事件（回放即状态）。
 *
 * 流式：模型有 stream 时优先流式，逐步落 assistant/delta（UI 实时逐字渲染）。
 */
export class AgentLoop {
  constructor(
    private readonly model: Model,
    private readonly tools: ToolContract[],
    private readonly session: Session,
    private readonly approval: ApprovalService,
  ) {}

  async run(message: string, options?: AgentLoopOptions): Promise<string> {
    const maxSteps = options?.maxSteps ?? 10
    const messages: ChatMessage[] = []
    if (options?.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt })

    // 从 session 事件日志回放历史（多轮对话 + 断点续跑：中断后历史仍在 session）
    for (const e of this.session.list()) {
      if (e.type === 'user/message') {
        messages.push({ role: 'user', content: (e.data as { content: string }).content })
      } else if (e.type === 'assistant/message') {
        messages.push({ role: 'assistant', content: (e.data as { content: string }).content })
      } else if (e.type === 'tool/call') {
        const d = e.data as { callId: string; name: string; args: Record<string, unknown> }
        messages.push({ role: 'assistant', content: '', toolCall: { id: d.callId, name: d.name, args: d.args } })
      } else if (e.type === 'tool/result') {
        const d = e.data as { callId: string; result?: unknown; error?: string }
        messages.push({ role: 'tool', content: JSON.stringify(d.result ?? d.error ?? ''), toolCallId: d.callId })
      }
    }

    // 追加当前消息
    this.session.append('user/message', { content: message })
    messages.push({ role: 'user', content: message })

    this.session.append('turn/start', { turn: 1 })
    const onDelta = options?.onDelta

    for (let step = 0; step < maxSteps; step++) {
      const response = await this.decide(messages, onDelta)
      if (response.toolCall) {
        await this.handleToolCall(messages, response.toolCall)
        continue
      }
      const text = response.text ?? ''
      this.session.append('assistant/message', { content: text })
      this.session.append('turn/end', { turn: 1, text })
      return text
    }
    throw new Error(`agent loop did not converge within ${maxSteps} steps`)
  }

  private async decide(messages: ChatMessage[], onDelta?: (text: string) => void): Promise<ModelResponse> {
    if (this.model.stream) {
      let text = ''
      let toolCall: ToolCall | undefined
      for await (const chunk of this.model.stream(messages, this.tools)) {
        if (chunk.text) {
          text += chunk.text
          this.session.append('assistant/delta', { text: chunk.text })
          onDelta?.(chunk.text)
        }
        if (chunk.toolCall) toolCall = chunk.toolCall
      }
      return { text, toolCall }
    }
    return this.model.complete(messages, this.tools)
  }

  private async handleToolCall(messages: ChatMessage[], call: ToolCall): Promise<void> {
    const callId = call.id ?? `${call.name}-${Date.now()}`
    this.session.append('tool/call', { callId, name: call.name, args: call.args })

    const tool = this.tools.find((t) => t.name === call.name)
    if (!tool) {
      const error = `unknown tool "${call.name}"`
      this.session.append('tool/result', { callId, name: call.name, error })
      messages.push({ role: 'assistant', content: '', toolCall: call })
      messages.push({ role: 'tool', content: error, toolCallId: callId })
      return
    }

    // 审批门
    if (this.approval.requiresApproval(tool)) {
      const outcome = await this.approval.request(this.session, {
        id: callId,
        toolName: call.name,
        args: call.args,
        riskLevel: tool.riskLevel,
      })
      if (outcome !== 'allowed-once') {
        const error = `approval ${outcome}`
        this.session.append('tool/result', { callId, name: call.name, error })
        messages.push({ role: 'assistant', content: '', toolCall: call })
        messages.push({ role: 'tool', content: error, toolCallId: callId })
        return
      }
    }

    // 执行
    try {
      const result = await tool.execute(call.args)
      this.session.append('tool/result', { callId, name: call.name, result })
      messages.push({ role: 'assistant', content: '', toolCall: call })
      messages.push({ role: 'tool', content: JSON.stringify(result), toolCallId: callId })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.session.append('tool/result', { callId, name: call.name, error })
      messages.push({ role: 'assistant', content: '', toolCall: call })
      messages.push({ role: 'tool', content: `error: ${error}`, toolCallId: callId })
    }
  }
}
