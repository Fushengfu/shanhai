import type { ChatMessage, Model, ModelResponse, ToolCall, ContentPart, Usage } from '@shanhai/llm'
import { toolReasoningContext, type ToolContract } from '@shanhai/tools'
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
 * 失败重试挂起快照（可序列化）：重试耗尽后保存「失败节点发给模型的完整 messages 快照 + 重入位置」。
 * 随会话事件（retry/snapshot）落盘，重启后仍可精确重试（用与失败完全一致的 body 重发请求）。
 */
export interface SuspendedSnapshot {
  messages: ChatMessage[]
  step: number
  maxSteps: number
  /** true=已达步数上限、需走收敛；false=正常 ReAct 循环中失败 */
  atLimit: boolean
  /** 失败原因（展示给用户） */
  reason?: string
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
  /** 最近一次模型调用返回的真实总 token 数（usage.total_tokens，接口返回，非本地估算） */
  private lastUsageTotalTokens = 0
  /** 待注入的用户消息（插入模式）：任务执行中用户追加的消息，在下一个模型调用前以 user 形式追加到上下文 */
  private pendingInjections: string[] = []
  /** 同一会话同一 agent 稳定不变的 user_id：网关前缀缓存隔离 + 命中用（确定性派生，跨请求/跨重启不变） */
  private readonly userId: string
  /** 审批策略会话：审批判断从该会话回放 approval/policy */
  private readonly approvalSession: Session
  /** 是否已被用户中止（点「停止」）：在每轮循环 / 流式每个 chunk / 工具执行前检查，尽快中断 */
  private aborted = false
  /** 挂起状态（任务失败重试耗尽后保存）：messages 快照 + 重入位置，retry() 用相同 body 重新提交 */
  private suspended:
    | (SuspendedSnapshot & {
        onDelta?: (text: string) => void
        onReasoning?: (text: string) => void
      })
    | undefined

  constructor(
    private readonly model: Model,
    private readonly tools: ToolContract[],
    private readonly session: Session,
    private readonly approval: ApprovalService,
    private readonly sessionId?: string,
    /** 上下文窗口大小（token 数）：超阈值时把早期对话历史压成摘要（undefined = 不压缩） */
    private readonly budget?: number,
    /** 当前模型是否支持视觉：true 时截图结果（含 https imageUrl）会以多模态形式直接喂给模型「看」 */
    private readonly supportsVision = false,
    /** 当前模型服务的 apiKey：user_id 确定性派生用（区分不同账号/服务商的前缀缓存） */
    private readonly apiKey?: string,
  ) {
    this.approvalSession = this.session
    // 断点续跑（resume）时新建 AgentLoop，从会话历史恢复「最近一次真实 usage」，避免首轮因无 usage 而跳过压缩、把超长历史直发网关打 400
    this.lastUsageTotalTokens = this.restoreLastUsageTotalTokens()
    // 同一会话同一 agent 的 user_id 永远不变（确定性派生，不含时间戳/随机数，跨请求/跨重启稳定）：
    // user_id = sessionId:apiKey，同一账号同会话所有请求共享，前缀缓存稳定累积命中
    this.userId = [sessionId ?? 'agent', apiKey].filter((x): x is string => !!x).join(':')
  }

  /** 从会话事件日志倒序找最近一条 usage/record，恢复真实总 token 数（无则 0） */
  private restoreLastUsageTotalTokens(): number {
    const events = this.session.list()
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'usage/record') {
        return (e.data as { totalTokens: number }).totalTokens
      }
    }
    return 0
  }

  /**
   * 注入一条用户消息（插入模式）：任务执行中用户追加消息时调用。
   * 不中断当前任务——消息先落盘到会话日志（历史完整），并在下一个模型调用前以 user 形式追加到上下文。
   * 多条注入消息按顺序全部追加，不覆盖、不丢失。
   */
  injectUserMessage(message: string): void {
    // 只入队，不立即落盘：立即 session.append 会赶在「工具执行中」（tool/call 已落盘、tool/result 未落盘）
    // 把消息插进二者之间，违背「追加在最后面」的语义，且回放时产生孤立 tool 消息 → 网关 400。
    // 落盘延迟到 runLoop 下一轮开头（当前工具回合已完整结束），保证追加到事件日志末尾。
    this.pendingInjections.push(message)
  }

  /** 把未消费的注入消息落盘到会话日志末尾（供中止时调用，避免追加需求丢失） */
  private flushPendingInjections(): void {
    for (const m of this.pendingInjections.splice(0, this.pendingInjections.length)) {
      this.session.append('user/message', { content: m, injected: true })
    }
  }

  /** 中止当前任务循环（用户点「停止」）：设置标志，run 循环 / 流式 chunk / 工具执行前检查后抛 __stopped__ 尽快退出。
   * 注意：无法真正取消「正在 await 的工具 Promise」（如正在跑的 run_command），但能保证工具执行完立即停止、不进入下一轮。 */
  abort(): void {
    this.aborted = true
  }

  async run(message: string, options?: AgentLoopOptions): Promise<string> {
    const maxSteps = options?.maxSteps ?? 1000
    let messages: ChatMessage[] = []
    if (options?.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt })

    // 从 session 事件日志回放历史（多轮对话 + 断点续跑：中断后历史仍在 session）
    this.replayHistory(messages)

    // 追加当前消息（含多模态附件，附件一并写入事件日志，回放时还原）。
    // 落盘永远保留原始 message + attachments；发给模型的内容在有 modelContent 时用降级后的文字（如图片降级）
    const attachments = options?.attachments
    this.session.append('user/message', { content: message, attachments: (attachments ?? []) as unknown[] })
    if (options?.modelContent !== undefined) {
      // 非视觉模型降级路径：发给模型的是降级后的文字（字符串）
      messages.push({ role: 'user', content: options.modelContent })
    } else if (this.supportsVision) {
      // 多模态模型：所有用户消息统一用数组结构（标准多模态格式），无附件时也保持数组，
      // 避免 content 一会儿字符串一会儿数组，保证网关/模型对结构一致性不敏感。
      const parts: ContentPart[] = [{ type: 'text', text: message }]
      if (attachments && attachments.length > 0) parts.push(...attachments)
      messages.push({ role: 'user', content: parts })
    } else if (attachments && attachments.length > 0) {
      messages.push({ role: 'user', content: [{ type: 'text', text: message }, ...attachments] })
    } else {
      messages.push({ role: 'user', content: message })
    }

    this.session.append('turn/start', { turn: 1 })
    const onDelta = options?.onDelta
    const onReasoning = options?.onReasoning

    return this.runLoop(messages, 0, maxSteps, onDelta, onReasoning)
  }

  /** 回放会话事件日志到 messages（user/assistant/tool 三类；delta/turn/usage/retry-snapshot 等中间态或元数据事件忽略）。 */
  private replayHistory(messages: ChatMessage[]): void {
    for (const e of this.session.list()) {
      if (e.type === 'user/message') {
        const d = e.data as { content: string; attachments?: ContentPart[] }
        if (this.supportsVision) {
          // 多模态模型：历史用户消息统一用数组结构（重发 https 附件），与当前消息结构保持一致；
          // 非视觉模型仍走 replayUserContent 的占位符（避免 400 / 重复计费）。
          const parts: ContentPart[] = []
          if (d.content) parts.push({ type: 'text', text: d.content })
          if (d.attachments && d.attachments.length > 0) parts.push(...d.attachments)
          messages.push({ role: 'user', content: parts.length > 0 ? parts : [{ type: 'text', text: '' }] })
        } else {
          // 历史附件只回放占位符，不重新发送 base64（避免请求体巨大 / 非视觉模型 400 / 重复计费）
          messages.push({ role: 'user', content: replayUserContent(d.content, d.attachments) })
        }
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
  }

  /** 断点续跑（「继续执行」用）：从会话事件日志回放已执行的历史（含完整工具回合），不追加新 user 消息、不新建 turn，
   * 直接继续 ReAct 循环。用户停止后 session 日志已完整记录已执行步骤，回放即恢复进度，从断点继续而非重新生成。 */
  async resumeRun(
    systemPrompt: string | undefined,
    onDelta?: (text: string) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    // 清理上次中断残留的流式增量（半截 assistant/delta）：回放时虽忽略，但残留会污染持久化文件与后续重建
    const events = this.session.list()
    let cut = events.length
    while (cut > 0 && events[cut - 1]?.type === 'assistant/delta') cut--
    if (cut < events.length) this.session.truncate(cut)

    const maxSteps = 1000
    const messages: ChatMessage[] = []
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
    this.replayHistory(messages)
    return this.runLoop(messages, 0, maxSteps, onDelta, onReasoning)
  }

  /**
   * ReAct 循环主体（可重入）：挂起后 retry() 从失败的那一步用「相同 messages 快照」重新进入，
   * 即向 LLM 重新提交与上次失败完全一致的请求 body（上下文数据不变），而非重新回放历史/重新构建。
   */
  private async runLoop(
    messages: ChatMessage[],
    startStep: number,
    maxSteps: number,
    onDelta?: (text: string) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    for (let step = startStep; step < maxSteps; step++) {
      // 用户点「停止」：每轮开始即检查，尽快中断（覆盖工具执行完回到循环、以及 reasoning/正文流式之前）
      if (this.aborted) {
        // 中止时 flush 未消费的注入消息落盘（此时工具回合已完整结束，位置在末尾），避免追加需求丢失
        this.flushPendingInjections()
        throw new Error('__stopped__')
      }
      // 插入模式：任务执行中用户追加的消息，在下一个模型调用前一次性追加到上下文（多条全部追加，不覆盖丢失）。
      // 用「追加需求」标记 + 编号列表注入，并指示模型在最终回答正文里单独回应，让追加的需求/问题在输出中显式体现。
      if (this.pendingInjections.length > 0) {
        const injected = this.pendingInjections.splice(0, this.pendingInjections.length)
        // 落盘：此处上一轮工具回合（tool/call + tool/result）已完整落盘，追加到事件日志末尾才是「最后面」
        for (const m of injected) this.session.append('user/message', { content: m, injected: true })
        const list = injected.map((m, i) => `${i + 1}. ${m}`).join('\n')
        messages.push({
          role: 'user',
          content: `【任务执行期间，用户追加了以下新需求/新问题】\n${list}\n\n请按以下步骤处理，不要中断原有任务：\n1. 继续完成原有任务。\n2. 对上述每条新增需求逐条评估：判断是否需要在当前任务内实际执行、是否可行、优先级如何。\n3. 对可执行的新增需求，请像处理原任务一样调用工具实际去完成（不要只做文字回应），直到这些新增需求也得到落实；确实无法完成的需求，说明原因。\n4. 全部完成后，在最终回答正文中用「新增需求完成情况」小节，按上述编号逐条列出：需求内容 → 评估结论 → 完成状态（已完成 / 部分完成 / 无法完成并说明原因）。`,
        })
      }
      // 压缩：token 超预算时把早期对话历史压成摘要，避免上下文窗口溢出
      messages = await this.maybeCompact(messages)
      let response: ModelResponse
      try {
        response = await this.decideWithRetry(messages, onDelta, onReasoning)
      } catch (err) {
        // 兜底：网关明确告知上下文超限（真实值，非本地估算）时，强制压缩后重试一次——
        // 覆盖「resume 首轮无 usage」「压缩漏触发」「摘要请求本身超限」等预防性压缩没拦住的情况
        if (isContextLengthError(err)) {
          const compacted = await this.maybeCompact(messages, true)
          if (compacted === messages) throw err
          messages = compacted
          try {
            response = await this.decideWithRetry(messages, onDelta, onReasoning)
          } catch (err2) {
            // 压缩后仍失败（可能是重试耗尽）：挂起，保存当前 messages 快照供 retry 重提交相同 body
            if (err2 instanceof Error && err2.message.startsWith('__retry_exhausted__')) {
              this.suspend(messages, step, maxSteps, onDelta, onReasoning, false, retryExhaustedReason(err2))
            }
            throw err2
          }
        } else {
          // 重试耗尽：挂起（保存失败节点的 messages 快照），任务保持上下文可重试
          if (err instanceof Error && err.message.startsWith('__retry_exhausted__')) {
            this.suspend(messages, step, maxSteps, onDelta, onReasoning, false, retryExhaustedReason(err))
          }
          throw err
        }
      }
      const toolCalls = response.toolCalls ?? (response.toolCall ? [response.toolCall] : [])
      if (toolCalls.length > 0) {
        // 一次响应可能返回多个工具调用（OpenAI 并行 tool_calls）：逐个执行，结果依次回喂
        for (const tc of toolCalls) {
          await this.handleToolCall(messages, tc, response.reasoningContent)
        }
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
    try {
      return await this.runConvergence(messages, maxSteps, onDelta, onReasoning)
    } catch (err) {
      // 收敛请求也失败（重试耗尽）：挂起，保存含收敛指令的 messages 快照供 retry
      if (err instanceof Error && err.message.startsWith('__retry_exhausted__')) {
        this.suspend(messages, maxSteps, maxSteps, onDelta, onReasoning, true, retryExhaustedReason(err))
      }
      throw err
    }
  }

  /** 步数上限后的强制收敛：让模型直接给最终结论（不再调工具） */
  private async runConvergence(
    messages: ChatMessage[],
    maxSteps: number,
    onDelta?: (text: string) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    const final = await this.decideWithRetry(messages, onDelta, onReasoning)
    const finalCalls = final.toolCalls ?? (final.toolCall ? [final.toolCall] : [])
    if (finalCalls.length > 0) {
      // 极端情况：模型仍坚持调用工具（如陷入死循环），保留保护性报错
      throw new Error(`agent loop did not converge within ${maxSteps} steps`)
    }
    const text = final.text ?? ''
    this.session.append('assistant/message', { content: text, reasoningContent: final.reasoningContent })
    this.session.append('turn/end', { turn: 1, text })
    return text
  }

  /** 挂起任务：保存失败节点的 messages 快照 + 重入位置，供 retry() 用「相同 body」重新提交。
   * 同时落盘 retry/snapshot 事件（覆盖旧快照），重启后可从会话事件恢复精确重试。 */
  private suspend(
    messages: ChatMessage[],
    step: number,
    maxSteps: number,
    onDelta: ((text: string) => void) | undefined,
    onReasoning: ((text: string) => void) | undefined,
    atLimit: boolean,
    reason?: string,
  ): void {
    this.suspended = { messages: [...messages], step, maxSteps, onDelta, onReasoning, atLimit, reason }
    // 落盘快照（先移除旧快照再 append，保证事件日志里最多一条、且反映「当前是否有挂起任务」）
    this.session.removeLast('retry/snapshot')
    this.session.append('retry/snapshot', { messages: [...messages], step, maxSteps, atLimit, reason })
  }

  /** 用户点击「重试」：用失败节点相同的 messages 快照重新提交请求，继续循环（不重新开始、不重新回放历史）。
   * 重启恢复场景：onDelta/onReasoning 从外部传入（快照里无函数），保证流式思考/正文仍能实时回显。 */
  async retry(onDelta?: (text: string) => void, onReasoning?: (text: string) => void): Promise<string> {
    const s = this.suspended
    if (!s) throw new Error('没有挂起的任务可重试')
    this.suspended = undefined
    // 清理挂起快照（无论重试成败；若重试又失败，suspend 会重新落盘新快照）
    this.session.removeLast('retry/snapshot')
    const d = onDelta ?? s.onDelta
    const r = onReasoning ?? s.onReasoning
    if (s.atLimit) {
      return this.runConvergence(s.messages, s.maxSteps, d, r)
    }
    return this.runLoop(s.messages, s.step, s.maxSteps, d, r)
  }

  /** 从持久化快照恢复挂起态（重启后精确重试用）：onDelta/onReasoning 不随快照序列化，retry 时由运行时重新绑定 */
  restoreSuspended(snapshot: SuspendedSnapshot): void {
    this.suspended = { ...snapshot, messages: [...snapshot.messages], onDelta: undefined, onReasoning: undefined }
  }

  /** 是否处于挂起状态（供运行时判断 retry 后 loop 是否仍需保留） */
  isSuspended(): boolean {
    return this.suspended !== undefined
  }

  /** 超预算压缩：保留 system 消息，把早期对话历史用模型压成摘要，保留最近 4 条原文。
   * 判断依据：接口返回的真实 usage.total_tokens（lastUsageTotalTokens），不是本地估算——
   * 本地估算在中文/代码/多模态混合时误差大，容易漏触发（打网关 400）或误触发。
   * @param force true 时跳过阈值判断直接压缩（网关已返回 400 超限时的兜底强制压缩） */
  private async maybeCompact(messages: ChatMessage[], force = false): Promise<ChatMessage[]> {
    if (!this.budget) return messages
    // 上下文窗口的 60% 作为触发阈值（留 40% 余量给回复 + 工具结果），对齐 Taco 的压缩触发比例
    const threshold = Math.floor(this.budget * 0.6)
    // 首次调用前还没有真实 usage（lastUsageTotalTokens=0），不压缩；之后用接口真实返回判断
    if (!force && this.lastUsageTotalTokens <= threshold) return messages
    const systemMsgs = messages.filter((m) => m.role === 'system')
    const rest = messages.filter((m) => m.role !== 'system')
    if (rest.length <= 6) return messages
    // 安全切分：tail 起点不能落在 tool 消息上——否则其前面对应的 assistant(tool_calls) 会被切进 head 压成摘要，
    // 压缩后的 messages 出现「孤立 tool 消息」，网关报 400（tool must be a response to a preceding tool_calls）。
    // 前移切分点直到起点不是 tool 消息，保证「assistant(tool_calls) ↔ tool」配对不被切断。
    let cut = rest.length - 4
    if (cut < 0) cut = 0
    while (cut > 0 && rest[cut]?.role === 'tool') cut--
    const head = rest.slice(0, cut)
    const tail = rest.slice(cut)
    // 摘要输入只保留纯文本对话（user / assistant 文本），剥离 tool 消息与带 toolCalls 的 assistant 消息：
    // 否则 head 边界切断工具配对，摘要请求本身也会被网关判非法（400/502，insufficient tool messages / tool must be a response）。
    const summarizable = head.filter(
      (m) => m.role !== 'tool' && !(m.role === 'assistant' && ((m.toolCalls?.length ?? 0) > 0 || m.toolCall)),
    )
    if (summarizable.length === 0) return messages
    // 摘要输入裁剪：只取最近 SUMMARY_WINDOW 条 + 单条内容截断，避免把超长 head 整体塞给模型导致摘要请求本身也超限
    const summaryInput = summarizable.slice(-SUMMARY_WINDOW).map(truncateMessageForSummary)
    const droppedCount = summarizable.length - summaryInput.length
    let summary = ''
    try {
      const res = await this.model.complete(
        [
          {
            role: 'system',
            content: '你是对话摘要器。把以下对话历史压缩成简洁的续跑摘要，保留关键信息：用户需求、已完成的操作与结论、待办事项、下一步行动。',
          },
          ...summaryInput,
        ],
        [],
        this.userId,
      )
      summary = res.text ?? ''
    } catch {
      // 摘要失败不阻断主流程：跳过压缩，继续用原文（可能超预算，但至少不崩）
      return messages
    }
    const droppedNote = droppedCount > 0 ? `\n（另有 ${droppedCount} 条更早历史因篇幅省略）` : ''
    return [...systemMsgs, { role: 'system', content: `【历史摘要】${summary}${droppedNote}` }, ...tail]
  }

  /** 带自动重试的模型决策：可重试错误（网络/超时/5xx/429/余额不足/网关错误）自动重试最多 MAX_AUTO_RETRY 次（指数退避）。
   * 全部失败抛 __retry_exhausted__::<原因>，由上层弹窗让用户选择「重试（保持上下文续跑）/取消」。
   * 用户点「停止」（__stopped__）与上下文超限不自动重试（前者立即中止、后者走专门压缩兜底）。 */
  private async decideWithRetry(
    messages: ChatMessage[],
    onDelta?: (text: string) => void,
    onReasoning?: (text: string) => void,
  ): Promise<ModelResponse> {
    let lastErr: unknown
    for (let attempt = 0; attempt < MAX_AUTO_RETRY; attempt++) {
      try {
        return await this.decide(messages, onDelta, onReasoning)
      } catch (err) {
        if (err instanceof Error && err.message === '__stopped__') throw err
        if (isContextLengthError(err)) throw err
        if (!isRetryableError(err)) throw err
        lastErr = err
        if (attempt < MAX_AUTO_RETRY - 1) await sleep(AUTO_RETRY_BACKOFF_MS * 2 ** attempt)
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
    throw new Error(`__retry_exhausted__::${msg}`)
  }

  private async decide(
    messages: ChatMessage[],
    onDelta?: (text: string) => void,
    onReasoning?: (text: string) => void,
  ): Promise<ModelResponse> {
    if (this.model.stream) {
      let text = ''
      let reasoningContent = ''
      let reasoningFlushed = false
      const toolCalls: ToolCall[] = []
      let usage: Usage | undefined
      try {
        for await (const chunk of this.model.stream(messages, this.tools, this.userId)) {
          // 用户点「停止」：流式每个 chunk 检查（含 reasoning 阶段，此前只在正文 onDelta 回调检查，思考阶段停不下来）
          if (this.aborted) throw new Error('__stopped__')
          if (chunk.reasoningContent) {
            reasoningContent += chunk.reasoningContent
          }
          if (chunk.text) {
            // 最终回答轮：首次遇到正文时，把累积的思考一次性回调到前端（顶部「思考过程」展示）。
            // 工具调用轮的思考不回调（避免堆在顶部），而是通过 toolReasoningContext 关联到对应工具步骤
            if (!reasoningFlushed) {
              reasoningFlushed = true
              if (reasoningContent) onReasoning?.(reasoningContent)
            }
            text += chunk.text
            this.session.append('assistant/delta', { text: chunk.text })
            onDelta?.(chunk.text)
          }
          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            toolCalls.push(...chunk.toolCalls)
          } else if (chunk.toolCall) {
            toolCalls.push(chunk.toolCall)
          }
          if (chunk.usage) {
            usage = chunk.usage
            this.recordUsage(chunk.usage)
          }
        }
      } catch (err) {
        throw err
      }
      const response = { text, toolCalls, toolCall: toolCalls[0], reasoningContent: reasoningContent || undefined, usage }
      return response
    }
    let res: ModelResponse
    try {
      res = await this.model.complete(messages, this.tools, this.userId)
    } catch (err) {
      throw err
    }
    if (res.usage) this.recordUsage(res.usage)
    // 非流式模型：只有最终回答轮（无工具调用）才把思考回调到前端，工具轮思考只走 toolReasoningContext
    const resCalls = res.toolCalls ?? (res.toolCall ? [res.toolCall] : [])
    if (resCalls.length === 0 && res.reasoningContent) onReasoning?.(res.reasoningContent)
    return res
  }

  /** 记录最近一次模型调用返回的真实总 token 数（usage.total_tokens），供压缩判断使用。
   * 同时持久化到会话事件日志，断点续跑（resume）新建 AgentLoop 时据此恢复，避免首轮无 usage 跳过压缩。 */
  private recordUsage(usage: Usage): void {
    this.lastUsageTotalTokens = usage.totalTokens
    this.session.append('usage/record', {
      totalTokens: usage.totalTokens,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedPromptTokens: usage.cachedPromptTokens ?? 0,
    })
  }

  private async handleToolCall(messages: ChatMessage[], call: ToolCall, reasoningContent?: string): Promise<void> {
    // 用户点「停止」：工具执行前检查，已中止则不落盘 tool/call、不执行工具，直接中断
    if (this.aborted) {
      this.flushPendingInjections()
      throw new Error('__stopped__')
    }
    const callId = call.id ?? `${call.name}-${Date.now()}`
    // tool/call 事件落盘 reasoningContent：thinking 模式多轮回放时需回传
    this.session.append('tool/call', { callId, name: call.name, args: call.args, reasoningContent })
    // 构造带思维链的 assistant 工具调用消息（回传 reasoning_content 用）
    const assistantCallMsg = (): ChatMessage => ({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: callId, name: call.name, args: call.args }],
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

    // 审批门（会话级审批策略：requiresApproval 从该会话事件日志回放 policy）。
    // 统一入口工具（skill_run）通过 resolveRisk 按 args 动态解析风险（action 级），
    // 未提供 resolveRisk 的工具回退到静态 riskLevel / approvalRequired。
    const dynamicRisk = tool.resolveRisk ? await tool.resolveRisk(call.args) : undefined
    const riskLevel = dynamicRisk?.riskLevel ?? tool.riskLevel
    const approvalRequired = dynamicRisk?.approvalRequired ?? tool.approvalRequired
    const outsideWorkdir = dynamicRisk?.outsideWorkdir
    if (this.approval.requiresApproval({ ...tool, riskLevel, approvalRequired }, this.approvalSession, outsideWorkdir)) {
      const outcome = await this.approval.request(this.approvalSession, {
        id: callId,
        toolName: call.name,
        args: call.args,
        riskLevel,
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

    // 执行（带超时兜底：防止单个工具永久挂起——如浏览器 loadURL 白屏——导致整个任务卡死）。
    // 用 toolReasoningContext 把「这一轮调用工具的思考」注入执行上下文，runtime 工具包装层据此把
    // reasoning 关联到本次工具调用的 trace 上（前端工具步骤卡片折叠展示）。
    try {
      const result = await withTimeout(
        toolReasoningContext.run(reasoningContent, () => Promise.resolve(tool.execute(call.args))),
        TOOL_TIMEOUT_MS,
      )
      this.session.append('tool/result', { callId, name: call.name, result })
      messages.push(assistantCallMsg())
      messages.push({ role: 'tool', content: JSON.stringify(result), toolCallId: callId })
      // 视觉直看：当前模型支持视觉，且工具结果是截图（含 https imageUrl）时，额外注入图片让模型直接「看」，
      // 而非只看到 imageUrl 字符串（支持视觉的模型能真正理解截图内容，无需再调 image_analyze）
      if (this.supportsVision) {
        const imageUrl = extractImageUrl(result)
        if (imageUrl) {
          messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }] })
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.session.append('tool/result', { callId, name: call.name, error })
      messages.push(assistantCallMsg())
      messages.push({ role: 'tool', content: `error: ${error}`, toolCallId: callId })
    }
  }
}

/** 单工具执行超时兜底（毫秒）。run_command 等长任务可能跑很久，给足时间但防止永久挂起卡死整个任务循环。 */
const TOOL_TIMEOUT_MS = 5 * 60 * 1000

/** 模型请求可重试错误（网络/超时/5xx/429/余额不足/网关错误）自动重试次数（全失败后弹窗让用户选择重试/取消） */
const MAX_AUTO_RETRY = 5
/** 自动重试初始退避时间（毫秒），指数增长（500ms → 1s → 2s → 4s） */
const AUTO_RETRY_BACKOFF_MS = 500

/** 压缩时摘要输入最多取最近 N 条历史消息（更早的直接丢弃，避免摘要请求本身超限） */
const SUMMARY_WINDOW = 16

/** 压缩时单条消息内容最多参与摘要的字符数（超过截断，控制摘要请求体积） */
const MAX_SUMMARY_MSG_CHARS = 4000

/** 从工具结果中提取 https 图片链接（截图工具返回的 imageUrl），供视觉模型直接「看」。
 * 只接受 http(s) 开头的公网链接，不接受 data: URL / 本地路径，避免误注入。 */
function extractImageUrl(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const r = result as { imageUrl?: unknown }
  if (typeof r.imageUrl === 'string' && /^https?:\/\//.test(r.imageUrl)) return r.imageUrl
  return null
}

/** 判断错误是否为「上下文超限」（网关返回的 invalid_request_error / maximum context length 等）。
 * 这是最权威的「真实超限」信号——网关明确告知请求 token 数超过窗口，据此触发强制压缩兜底。 */
function isContextLengthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /context length|maximum context|invalid_request_error|too many tokens|reduce the length/i.test(msg)
}

/** 判断错误是否为「可自动重试」（临时性故障：网络抖动/超时/网关 5xx/限流 429/余额或配额不足）。
 * 命中后由 decideWithRetry 自动重试 MAX_AUTO_RETRY 次，全失败再抛 __retry_exhausted__ 弹窗。
 * 注意：__stopped__（用户停止）与上下文超限已在 decideWithRetry 里提前拦截，不会走到这里。 */
function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  // 超时
  if (/超时|timed?\s*out|ETIMEDOUT/i.test(msg)) return true
  // 网络层错误（fetch 底层抛出的系统错误 + undici 连接中断类错误）
  // terminated / aborted / UND_ERR_SOCKET / ECONNABORTED / socket hang up 都是 undici 在连接被对端关闭或重置时抛出的
  // 「临时性网络故障」，应纳入自动重试（此前漏掉导致 TypeError: terminated 绕过重试直接冒泡到 IPC 层）
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED|UND_ERR_SOCKET|fetch\s*failed|network|socket|terminated|aborted|socket\s*hang\s*up|网络/i.test(msg)) return true
  // HTTP 5xx（网关/服务端临时故障）与 429（限流）
  if (/(?:API|status|HTTP)\s*5\d\d|(?:API|status|HTTP)\s*429/i.test(msg)) return true
  // 余额不足 / 配额 / 限流
  if (/余额不足|insufficient|balance|quota|billing|rate\s*limit|限流|超额/i.test(msg)) return true
  // 网关错误码（gateway error code N）
  if (/gateway\s*error/i.test(msg)) return true
  return false
}

/** 从 __retry_exhausted__::<原因> 错误中提取失败原因（无前缀返回 undefined），供挂起快照落盘、前端弹窗展示 */
function retryExhaustedReason(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  if (!err.message.startsWith('__retry_exhausted__::')) return undefined
  return err.message.slice('__retry_exhausted__::'.length)
}

/** 延时（自动重试指数退避用） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 摘要输入的单条消息裁剪：纯文本超过 MAX_SUMMARY_MSG_CHARS 截断，避免巨型工具结果撑爆摘要请求 */
function truncateMessageForSummary(m: ChatMessage): ChatMessage {
  if (typeof m.content !== 'string') return m
  if (m.content.length <= MAX_SUMMARY_MSG_CHARS) return m
  return { ...m, content: `${m.content.slice(0, MAX_SUMMARY_MSG_CHARS)}\n…（内容过长，摘要时已截断）` }
}

/** 给 Promise 加超时：超时 reject，正常 resolve/reject 则透传。finally 清理定时器避免泄漏。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`工具执行超时（${Math.round(ms / 1000)}s），已中止本次调用，请检查目标是否可达后重试`)),
      ms,
    )
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
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
