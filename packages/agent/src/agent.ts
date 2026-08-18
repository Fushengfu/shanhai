import type { ChatMessage, Model, ModelResponse, ToolCall, ContentPart } from '@shanhai/llm'
import type { ToolContract } from '@shanhai/tools'
import type { Session } from '@shanhai/session'
import type { ApprovalService } from '@shanhai/approval'

export interface AgentLoopOptions {
  maxSteps?: number
  systemPrompt?: string
  /** 流式增量回调（UI 实时逐字渲染用） */
  onDelta?: (text: string) => void
  /** 流式思考增量回调（推理模型先输出 reasoning_content，UI 实时渲染「思考过程」用） */
  onReasoning?: (text: string) => void
  /** 多模态附件（图片/音频/视频） */
  attachments?: ContentPart[]
  /** 发给模型的内容（可选）。图片降级等场景下：落盘仍保留原始 message + attachments，发给模型改用降级后的文字 */
  modelContent?: string
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
    private readonly sessionId?: string,
  ) {}

  async run(message: string, options?: AgentLoopOptions): Promise<string> {
    const maxSteps = options?.maxSteps ?? 30
    const messages: ChatMessage[] = []
    if (options?.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt })

    // 从 session 事件日志回放历史（多轮对话 + 断点续跑：中断后历史仍在 session）
    for (const e of this.session.list()) {
      if (e.type === 'user/message') {
        const d = e.data as { content: string; attachments?: ContentPart[] }
        // 历史附件只回放占位符，不重新发送 base64（避免请求体巨大 / 非视觉模型 400 / 重复计费）
        messages.push({ role: 'user', content: replayUserContent(d.content, d.attachments) })
      } else if (e.type === 'assistant/message') {
        const d = e.data as { content: string; reasoningContent?: string }
        messages.push({ role: 'assistant', content: d.content, reasoningContent: d.reasoningContent })
      } else if (e.type === 'tool/call') {
        const d = e.data as { callId: string; name: string; args: Record<string, unknown>; reasoningContent?: string }
        messages.push({ role: 'assistant', content: '', toolCall: { id: d.callId, name: d.name, args: d.args }, reasoningContent: d.reasoningContent })
      } else if (e.type === 'tool/result') {
        const d = e.data as { callId: string; result?: unknown; error?: string }
        messages.push({ role: 'tool', content: JSON.stringify(d.result ?? d.error ?? ''), toolCallId: d.callId })
      }
    }

    // 追加当前消息（含多模态附件，附件一并写入事件日志，回放时还原）。
    // 落盘永远保留原始 message + attachments；发给模型的内容在有 modelContent 时用降级后的文字（如图片降级）
    const attachments = options?.attachments
    this.session.append('user/message', { content: message, attachments: (attachments ?? []) as unknown[] })
    if (options?.modelContent !== undefined) {
      messages.push({ role: 'user', content: options.modelContent })
    } else if (attachments && attachments.length > 0) {
      messages.push({ role: 'user', content: [{ type: 'text', text: message }, ...attachments] })
    } else {
      messages.push({ role: 'user', content: message })
    }

    this.session.append('turn/start', { turn: 1 })
    const onDelta = options?.onDelta
    const onReasoning = options?.onReasoning

    for (let step = 0; step < maxSteps; step++) {
      const response = await this.decide(messages, onDelta, onReasoning)
      if (response.toolCall) {
        await this.handleToolCall(messages, response.toolCall, response.reasoningContent)
        continue
      }
      const text = response.text ?? ''
      this.session.append('assistant/message', { content: text, reasoningContent: response.reasoningContent })
      this.session.append('turn/end', { turn: 1, text })
      return text
    }
    // 达到步数上限：不直接抛错，追加一条强制收敛指令，让模型基于已有执行结果直接给出最终结论
    messages.push({
      role: 'user',
      content: `已到达最大工具调用步数（${maxSteps} 步）。请不要再调用任何工具，基于以上已完成的执行结果，直接给出最终结论。`,
    })
    const final = await this.decide(messages, onDelta, onReasoning)
    if (final.toolCall) {
      // 极端情况：模型仍坚持调用工具（如陷入死循环），保留保护性报错
      throw new Error(`agent loop did not converge within ${maxSteps} steps`)
    }
    const text = final.text ?? ''
    this.session.append('assistant/message', { content: text, reasoningContent: final.reasoningContent })
    this.session.append('turn/end', { turn: 1, text })
    return text
  }

  private async decide(
    messages: ChatMessage[],
    onDelta?: (text: string) => void,
    onReasoning?: (text: string) => void,
  ): Promise<ModelResponse> {
    if (this.model.stream) {
      let text = ''
      let reasoningContent = ''
      let toolCall: ToolCall | undefined
      for await (const chunk of this.model.stream(messages, this.tools)) {
        if (chunk.reasoningContent) {
          reasoningContent += chunk.reasoningContent
          onReasoning?.(chunk.reasoningContent)
        }
        if (chunk.text) {
          text += chunk.text
          this.session.append('assistant/delta', { text: chunk.text })
          onDelta?.(chunk.text)
        }
        if (chunk.toolCall) toolCall = chunk.toolCall
      }
      return { text, toolCall, reasoningContent: reasoningContent || undefined }
    }
    return this.model.complete(messages, this.tools)
  }

  private async handleToolCall(messages: ChatMessage[], call: ToolCall, reasoningContent?: string): Promise<void> {
    const callId = call.id ?? `${call.name}-${Date.now()}`
    // tool/call 事件落盘 reasoningContent：thinking 模式多轮回放时需回传
    this.session.append('tool/call', { callId, name: call.name, args: call.args, reasoningContent })
    // 构造带思维链的 assistant 工具调用消息（回传 reasoning_content 用）
    const assistantCallMsg = (): ChatMessage => ({
      role: 'assistant',
      content: '',
      toolCall: { id: callId, name: call.name, args: call.args },
      reasoningContent,
    })

    const tool = this.tools.find((t) => t.name === call.name)
    if (!tool) {
      const error = `unknown tool "${call.name}"`
      this.session.append('tool/result', { callId, name: call.name, error })
      messages.push(assistantCallMsg())
      messages.push({ role: 'tool', content: error, toolCallId: callId })
      return
    }

    // 审批门（会话级审批策略：requiresApproval 从该会话事件日志回放 policy）
    if (this.approval.requiresApproval(tool, this.session)) {
      const outcome = await this.approval.request(this.session, {
        id: callId,
        toolName: call.name,
        args: call.args,
        riskLevel: tool.riskLevel,
        sessionId: this.sessionId,
      })
      if (outcome !== 'allowed-once') {
        const error = `approval ${outcome}`
        this.session.append('tool/result', { callId, name: call.name, error })
        messages.push(assistantCallMsg())
        messages.push({ role: 'tool', content: error, toolCallId: callId })
        return
      }
    }

    // 执行
    try {
      const result = await tool.execute(call.args)
      this.session.append('tool/result', { callId, name: call.name, result })
      messages.push(assistantCallMsg())
      messages.push({ role: 'tool', content: JSON.stringify(result), toolCallId: callId })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.session.append('tool/result', { callId, name: call.name, error })
      messages.push(assistantCallMsg())
      messages.push({ role: 'tool', content: `error: ${error}`, toolCallId: callId })
    }
  }
}

/** 回放历史用户消息：附件（图片/音频/视频）不再重新发送 base64 数据，改用占位符。
 * 原因：历史附件已在上轮被模型处理过；重新发送 base64 会导致请求体巨大、非视觉模型 400、重复计费。 */
function replayUserContent(content: string, attachments?: ContentPart[]): string {
  if (!attachments || attachments.length === 0) return content
  const marks = attachments
    .map((a) => {
      if (a.type === 'image_url') return '[图片附件]'
      if (a.type === 'input_audio') return '[语音附件]'
      if (a.type === 'input_video') return '[视频附件]'
      return ''
    })
    .filter(Boolean)
    .join(' ')
  return content ? `${content} ${marks}` : marks
}
