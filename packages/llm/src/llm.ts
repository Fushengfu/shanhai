import type { ToolContract } from '@shanhai/tools'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

/** 音频格式 */
export type AudioFormat = 'wav' | 'mp3' | 'm4a'
/** 视频格式 */
export type VideoFormat = 'mp4' | 'mov' | 'webm'

/** 多模态内容片段（OpenAI 兼容）：文本 / 图片 / 音频 / 视频 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: AudioFormat } }
  | { type: 'input_video'; input_video: { data: string; format: VideoFormat } }

export interface ChatMessage {
  role: ChatRole
  /** 纯文本，或多模态片段数组（视觉模型截图/图片理解） */
  content: string | ContentPart[]
  /** 一次 assistant 回复里的多个工具调用（OpenAI 并行 tool_calls）。toolCall 单数指向第一个，向后兼容。 */
  toolCalls?: ToolCall[]
  /** @deprecated 用 toolCalls；保留兼容，等价 toolCalls[0] */
  toolCall?: ToolCall
  toolCallId?: string
  /** thinking 模式下的思维链内容（DeepSeek 要求多轮时原样回传，否则 400） */
  reasoningContent?: string
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 命中缓存的 prompt token 数（prompt_tokens_details.cached_tokens，无则 0） */
  cachedPromptTokens?: number
}

export interface ModelResponse {
  text?: string
  /** 一次响应返回的多个工具调用（OpenAI 并行 tool_calls / 连续多工具）。toolCall 单数指向第一个，向后兼容。 */
  toolCalls?: ToolCall[]
  /** @deprecated 用 toolCalls；保留兼容，等价 toolCalls[0] */
  toolCall?: ToolCall
  usage?: Usage
  /** thinking 模式思维链内容（回传用） */
  reasoningContent?: string
}

export interface StreamChunk {
  text?: string
  /** 流式累积产出的多个工具调用（按 index/name 分离，互不拼接）。toolCall 单数指向第一个，向后兼容。 */
  toolCalls?: ToolCall[]
  /** @deprecated 用 toolCalls；保留兼容，等价 toolCalls[0] */
  toolCall?: ToolCall
  usage?: Usage
  /** thinking 模式思维链增量（回传用） */
  reasoningContent?: string
}

/**
 * 模型接口：complete（一次性）+ 可选 stream（流式）。
 * userId 用于网关前缀缓存隔离：每个 agent 循环保持唯一 userId，多 agent 并发请求时各自缓存互不覆盖。
 */
export interface Model {
  complete(messages: ChatMessage[], tools?: ToolContract[], userId?: string): Promise<ModelResponse>
  stream?(messages: ChatMessage[], tools?: ToolContract[], userId?: string): AsyncIterable<StreamChunk>
}

/** mock 模型：按队列返回固定响应（离线/测试用），队列耗尽则复用最后一个 */
export function createMockModel(responses: ModelResponse[]): Model {
  const queue = [...responses]
  return {
    complete: async () => {
      const next = queue.shift()
      if (next) return next
      const last = responses[responses.length - 1]
      return last ?? { text: '' }
    },
  }
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 命中缓存的 prompt token 数（prompt_tokens_details.cached_tokens，无则 0） */
  cachedPromptTokens?: number
}

/** HTTP 原始请求/响应记录（排查问题用）：请求与响应各记一条，字段含接口地址 + 完整原始 body */
export interface HttpTrace {
  /** 阶段：request=请求（body 为最终提交给接口的完整 body 对象），response=响应（body 为接口返回的原始文本） */
  phase: 'request' | 'response'
  /** 完整请求接口地址（含 path） */
  url: string
  method: string
  /** request 阶段 = 最终提交给模型接口的完整 body（序列化前对象，含 model/messages/tools 等全部字段，与 JSON.stringify 后发出内容一致）；
   *  response 阶段 = 接口返回内容，按 JSON 结构记录：非流式 = 解析后的 JSON 对象；流式 = 合并后的完整响应 JSON（等价非流式，不记录逐条 SSE 事件）；无法解析时回退为原始字符串 */
  body?: unknown
  /** 仅 response 阶段有意义：HTTP 状态码 */
  responseStatus?: number
  /** 错误信息（请求失败 / 非 2xx / 解析失败时） */
  error?: string
}

export type HttpTraceCallback = (trace: HttpTrace) => void

export interface DeepSeekOptions {
  apiKey: string
  baseUrl: string
  model: string
  /** 最大输出 token（网关按此预留 completion；不传则网关用其默认预留值，可能远大于模型实际配置） */
  maxTokens?: number
  /** 每次调用后回传 token 用量（成本统计） */
  onUsage?: (usage: TokenUsage) => void
  /** 每次 HTTP 调用后回传原始请求/响应（排查问题用） */
  onTrace?: HttpTraceCallback
  /** 用户标识（网关按 user_id 隔离缓存/计费/用量统计），请求 body 顶层 user_id 字段 */
  userId?: string | number
}

/** 网关响应 choice（网关包装在 { code, data } 里，兼容裸 OpenAI 格式） */
interface GatewayChoice {
  message?: {
    content?: string
    reasoning_content?: string
    reasoning?: string
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  }
}

/** 网关 usage（含 prompt_tokens_details.cached_tokens 缓存命中） */
interface GatewayUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

/** 网关 usage → TokenUsage（解析缓存命中 token） */
function toTokenUsage(u: GatewayUsage): TokenUsage {
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
    cachedPromptTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
  }
}

/**
 * 拼接 chat/completions 完整 URL，兼容两种 baseUrl：
 * - `https://aigateway.bjctykj.com`（不带后缀）→ 拼 /api/v1/chat/completions
 * - `https://aigateway.bjctykj.com/api/v1`（带后缀）→ 拼 /chat/completions
 */
function chatCompletionsUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '')
  if (/\/api\/v\d+$/.test(b) || /\/v\d+$/.test(b)) return `${b}/chat/completions`
  return `${b}/api/v1/chat/completions`
}

/**
 * 将内部 ChatMessage 序列化为 OpenAI 兼容 wire 格式。
 * 关键：内部消息携带 toolCall / toolCallId，但必须转成网关认识的字段名，否则报错：
 *  - assistant 带 toolCall → 输出 tool_calls + content:null（OpenAI 规范：带 tool_calls 时 content 为 null）
 *  - tool 带 toolCallId → 输出 tool_call_id（缺失时网关报 "missing field tool_call_id"）
 */
function serializeMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const calls = m.toolCalls ?? (m.toolCall ? [m.toolCall] : [])
    if (m.role === 'assistant' && calls.length > 0) {
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: {
            name: c.name,
            arguments: JSON.stringify(c.args ?? {}),
          },
        })),
      }
      // thinking 模式：assistant 带 tool_calls 也必须回传 reasoning_content，否则网关 400
      if (m.reasoningContent) msg.reasoning_content = m.reasoningContent
      return msg
    }
    if (m.role === 'tool') {
      // tool 消息必须带 tool_call_id 关联上一条 assistant 的 tool_calls；
      // id 必须严格来自事件日志里记录的 callId（回放时由 replayHistory 忠实读出），缺失直接报错，绝不编造
      if (!m.toolCallId) {
        throw new Error('序列化失败：tool 消息缺少 tool_call_id（事件回放的 callId 缺失）')
      }
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId }
    }
    const msg: Record<string, unknown> = { role: m.role, content: m.content }
    // thinking 模式：assistant 文本消息回传 reasoning_content
    if (m.role === 'assistant' && m.reasoningContent) msg.reasoning_content = m.reasoningContent
    return msg
  })
}

/** 网关请求超时（毫秒）。模型调用若网关挂起（连接/响应头/完整响应阶段）超时抛错，避免任务永久卡死。 */
const FETCH_TIMEOUT_MS = 3 * 60 * 1000

/** 带超时的 fetch：超时中断连接并抛错（覆盖网关无响应导致的永久 pending，是任务级卡死的最后一道防线） */
async function fetchWithTimeout(input: Parameters<typeof fetch>[0], init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`模型请求超时（${Math.round(timeoutMs / 1000)}s），网关未响应，已中止本次调用`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** DeepSeek provider：网关 OpenAI 兼容 /api/v1/chat/completions（fetch） */
export class DeepSeekProvider implements Model {
  constructor(private readonly opts: DeepSeekOptions) {}

  async complete(messages: ChatMessage[], tools?: ToolContract[], userId?: string): Promise<ModelResponse> {
    const url = chatCompletionsUrl(this.opts.baseUrl)
    // user_id：优先用本次调用传入的（每个 agent 循环唯一），回退到 provider 静态配置
    const effectiveUserId = userId ?? this.opts.userId
    const body = {
      model: this.opts.model,
      messages: serializeMessages(messages),
      tools: tools?.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      // max_tokens 显式下发，让网关按模型真实配置预留 completion，而非用其默认预留值（否则 1M 窗口可能被默认预留压掉几十万，导致误判超限）
      ...(this.opts.maxTokens ? { max_tokens: this.opts.maxTokens } : {}),
      ...(effectiveUserId != null ? { user_id: effectiveUserId } : {}),
    }
    // 原始请求 = 最终提交给模型接口的完整 body（序列化前对象，含 model/messages/tools 全字段）
    this.opts.onTrace?.({ phase: 'request', url, method: 'POST', body })
    let res: Response
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      this.opts.onTrace?.({ phase: 'response', url, method: 'POST', error: err instanceof Error ? err.message : String(err) })
      throw err
    }
    // 先读原始文本：既用于 trace 记录完整原始响应，也用于后续 JSON 解析与错误提示
    const rawText = await res.text()
    if (!res.ok) {
      this.opts.onTrace?.({ phase: 'response', url, method: 'POST', body: normalizeResponseBody(rawText), responseStatus: res.status, error: `DeepSeek API ${res.status}` })
      throw new Error(`DeepSeek API ${res.status}: ${rawText}`)
    }
    // 网关响应：{ code, data: { choices: [...] } } 包装（兼容裸 OpenAI 格式）
    let raw: {
      code?: number
      error?: string | { message?: string }
      data?: {
        choices?: GatewayChoice[]
        usage?: GatewayUsage
      }
      choices?: GatewayChoice[]
      usage?: GatewayUsage
    }
    try {
      raw = JSON.parse(rawText) as typeof raw
    } catch {
      this.opts.onTrace?.({ phase: 'response', url, method: 'POST', body: normalizeResponseBody(rawText), responseStatus: res.status, error: '响应非合法 JSON' })
      throw new Error(`DeepSeek API ${res.status}: 响应非合法 JSON`)
    }
    this.opts.onTrace?.({ phase: 'response', url, method: 'POST', body: raw, responseStatus: res.status })
    // 网关返回错误（如模型不支持 image_url 多模态），响亮抛错，不静默吞
    if (raw.error) {
      const msg = typeof raw.error === 'string' ? raw.error : (raw.error.message ?? JSON.stringify(raw.error))
      throw new Error(msg)
    }
    if (raw.code !== undefined && raw.code !== 0) {
      throw new Error(`gateway error code ${raw.code}`)
    }
    const payload = raw.data ?? raw
    const usage = payload.usage
    if (usage && this.opts.onUsage) {
      this.opts.onUsage(toTokenUsage(usage))
    }
    const message = payload.choices?.[0]?.message
    const toolCalls = (message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: safeParse(tc.function.arguments),
    }))
    const reasoningContent = message?.reasoning_content || message?.reasoning || undefined
    if (toolCalls.length > 0) {
      return {
        reasoningContent,
        toolCalls,
        toolCall: toolCalls[0],
      }
    }
    return { text: message?.content ?? '', reasoningContent }
  }

  /** SSE 流式：逐行解析，累积工具调用 arguments 分片，产出 text 增量 + 完整 toolCall */
  async *stream(messages: ChatMessage[], tools?: ToolContract[], userId?: string): AsyncIterable<StreamChunk> {
    const url = chatCompletionsUrl(this.opts.baseUrl)
    // user_id：优先用本次调用传入的（每个 agent 循环唯一），回退到 provider 静态配置
    const effectiveUserId = userId ?? this.opts.userId
    const body = {
      model: this.opts.model,
      messages: serializeMessages(messages),
      tools: tools?.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      stream: true,
      // 请求网关在流末尾返回 usage（OpenAI 兼容；网关不支持时自动忽略，不影响流）
      stream_options: { include_usage: true },
      ...(effectiveUserId != null ? { user_id: effectiveUserId } : {}),
    }
    // 原始请求 = 最终提交给模型接口的完整 body（序列化前对象）
    this.opts.onTrace?.({ phase: 'request', url, method: 'POST', body })
    let res: Response
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      this.opts.onTrace?.({ phase: 'response', url, method: 'POST', error: err instanceof Error ? err.message : String(err) })
      throw err
    }
    if (!res.ok || !res.body) {
      const errText = await res.text()
      this.opts.onTrace?.({ phase: 'response', url, method: 'POST', body: normalizeResponseBody(errText), responseStatus: res.status, error: `DeepSeek API ${res.status}` })
      throw new Error(`DeepSeek API ${res.status}: ${errText}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    /** 多个工具调用按 index 分别累积（OpenAI 并行 tool_calls 用 index 区分；网关可能恒为 0，此时靠 name 变化切分，见 handleLine） */
    const toolCallAccs = new Map<number, { id?: string; name?: string; argsText: string }>()
    /** 本次响应已完成的工具调用（按完成顺序累积，text/usage/流结束 时统一产出） */
    const completedToolCalls: ToolCall[] = []
    /** 合并后的完整响应内容（流结束后用于 trace 落盘，替代逐条 SSE 事件） */
    let fullText = ''
    let fullReasoning = ''
    const allToolCalls: ToolCall[] = []
    let finalUsage: Usage | undefined

    /** 累积每个产出 chunk 的完整内容，供流结束后合并成完整 JSON */
    const accumulate = (c: StreamChunk): void => {
      if (c.text) fullText += c.text
      if (c.reasoningContent) fullReasoning += c.reasoningContent
      if (c.toolCalls) allToolCalls.push(...c.toolCalls)
      else if (c.toolCall) allToolCalls.push(c.toolCall)
      if (c.usage) finalUsage = c.usage
    }

    /** 结算所有累积中的工具调用（不产出，仅把完成的 toolCall 推进 completedToolCalls） */
    const flushAll = (): ToolCall[] => {
      const result: ToolCall[] = []
      for (const acc of toolCallAccs.values()) {
        const tc = flushToolCall(acc)
        if (tc) result.push(tc)
      }
      toolCallAccs.clear()
      return result
    }

    const handleLine = (line: string): StreamChunk[] => {
      const ev = parseSseLine(line)
      const out: StreamChunk[] = []
      if (!ev) return out
      // 文本增量：text 到来表示工具调用已结束，结算所有累积中的工具调用
      if (ev.text !== undefined) {
        completedToolCalls.push(...flushAll())
        out.push({ text: ev.text })
      }
      if (ev.reasoningContent !== undefined) {
        // thinking 模式：思维链增量单独产出，供上层累积后回传
        out.push({ reasoningContent: ev.reasoningContent })
      }
      if (ev.toolCall) {
        const idx = ev.toolCall.index
        let acc = toolCallAccs.get(idx)
        // 同 index 下 name 变化（网关把多个连续工具都标成 index 0，靠 name 变化切分）：
        // 先结算上一个工具，再为新工具开新累积，避免两个工具的 arguments 被拼成一个非法 JSON
        if (acc && ev.toolCall.name && acc.name && ev.toolCall.name !== acc.name) {
          const tc = flushToolCall(acc)
          if (tc) completedToolCalls.push(tc)
          toolCallAccs.delete(idx)
          acc = undefined
        }
        if (!acc) {
          acc = { id: ev.toolCall.id, name: ev.toolCall.name, argsText: '' }
          toolCallAccs.set(idx, acc)
        }
        if (ev.toolCall.id) acc.id = ev.toolCall.id
        if (ev.toolCall.name) acc.name = ev.toolCall.name
        acc.argsText += ev.toolCall.argsDelta ?? ''
      }
      // usage 最后处理：结算未 flush 的工具调用 + 回传成本统计。
      // 某些端点每个 chunk 都带 usage（如 poolside），此时 usage 与 text 同 chunk，
      // 文本已在上方处理，这里不会丢，只会额外产出 usage。
      if (ev.usage) {
        completedToolCalls.push(...flushAll())
        if (completedToolCalls.length > 0) {
          out.push({ toolCalls: [...completedToolCalls], toolCall: completedToolCalls[0] })
          completedToolCalls.length = 0
        }
        out.push({ usage: ev.usage })
        if (this.opts.onUsage) this.opts.onUsage(ev.usage)
      }
      return out
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        for (const chunk of handleLine(line)) {
          accumulate(chunk)
          yield chunk
        }
      }
    }
    for (const chunk of handleLine(buffer)) {
      accumulate(chunk)
      yield chunk
    }
    // 流结束：结算残留的工具调用并产出（usage 未返回时的兜底）
    completedToolCalls.push(...flushAll())
    if (completedToolCalls.length > 0) {
      const chunk = { toolCalls: [...completedToolCalls], toolCall: completedToolCalls[0] }
      accumulate(chunk)
      yield chunk
    }
    this.opts.onTrace?.({
      phase: 'response',
      url,
      method: 'POST',
      body: buildMergedStreamBody({
        model: this.opts.model,
        text: fullText,
        reasoningContent: fullReasoning,
        toolCalls: allToolCalls,
        usage: finalUsage,
      }),
      responseStatus: res.status,
    })
  }
}

/** 累积完成的工具调用 → ToolCall */
function flushToolCall(acc: { id?: string; name?: string; argsText: string }): ToolCall | null {
  if (!acc.name) return null
  return { id: acc.id, name: acc.name, args: safeParse(acc.argsText || '{}') }
}

interface SseDeltaEvent {
  text?: string
  toolCall?: { index: number; id?: string; name?: string; argsDelta?: string }
  usage?: Usage
  reasoningContent?: string
}

/** 解析单行 SSE `data: {...}`，返回 text 增量 / tool_calls 分片 / usage；网关返回 error 时抛错 */
function parseSseLine(line: string): SseDeltaEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return null
  let parsed: {
    error?: string | { message?: string }
    usage?: GatewayUsage
    choices?: Array<{
      delta?: {
        content?: string
        reasoning_content?: string
        reasoning?: string
        tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
      }
    }>
  }
  try {
    parsed = JSON.parse(data)
  } catch {
    return null // 非 JSON（如注释行），忽略
  }
  // 网关返回错误（如模型不支持 image_url 多模态），响亮抛错，不静默吞
  if (parsed.error) {
    const msg = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message ?? JSON.stringify(parsed.error))
    throw new Error(msg)
  }
  const delta = parsed.choices?.[0]?.delta
  const text = typeof delta?.content === 'string' && delta.content ? delta.content : undefined
  const reasoningContent =
    (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) ||
    (typeof delta?.reasoning === 'string' && delta.reasoning) ||
    undefined
  const tc = delta?.tool_calls?.[0]
  const toolCall = tc ? { index: tc.index ?? 0, id: tc.id, name: tc.function?.name, argsDelta: tc.function?.arguments ?? '' } : undefined
  // usage 可能与 text/toolCall 出现在同一条 chunk 里（某些 OpenAI 兼容端点如 poolside 每个 chunk 都带 usage），
  // 不能因为命中 usage 就丢弃文本，必须同时提取
  const usage = parsed.usage ? toTokenUsage(parsed.usage) : undefined
  if (text === undefined && !toolCall && reasoningContent === undefined && !usage) return null
  return { text, toolCall, reasoningContent, usage }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 将接口响应原始文本按 JSON 结构归一化（供 trace 落盘，避免 response 记录成转义字符串）：
 * JSON.parse 成对象，失败回退为原始字符串（错误页 / 非 JSON 响应）。
 * 流式响应的合并逻辑见 buildMergedStreamBody（trace 不记录逐条 SSE 事件，只记合并后的完整 JSON）。
 */
function normalizeResponseBody(rawText: string): unknown {
  try {
    return JSON.parse(rawText) as unknown
  } catch {
    return rawText
  }
}

/** 将流式响应累积结果合并成等价于非流式的完整响应 JSON（trace 落盘用，替代逐条 SSE 事件） */
function buildMergedStreamBody(opts: {
  model: string
  text: string
  reasoningContent: string
  toolCalls: ToolCall[]
  usage?: Usage
}): unknown {
  const message: Record<string, unknown> = { role: 'assistant' }
  if (opts.text) message.content = opts.text
  if (opts.reasoningContent) message.reasoning_content = opts.reasoningContent
  if (opts.toolCalls.length > 0) {
    message.tool_calls = opts.toolCalls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    }))
  }
  const body: Record<string, unknown> = {
    model: opts.model,
    stream: false,
    choices: [{ index: 0, message, finish_reason: 'stop' }],
  }
  if (opts.usage) {
    body.usage = {
      prompt_tokens: opts.usage.promptTokens,
      completion_tokens: opts.usage.completionTokens,
      total_tokens: opts.usage.totalTokens,
      ...(opts.usage.cachedPromptTokens != null
        ? { prompt_tokens_details: { cached_tokens: opts.usage.cachedPromptTokens } }
        : {}),
    }
  }
  return body
}

/** 构造图片内容片段（data: URL 或 https 链接） */
export function imageContent(url: string): ContentPart {
  return { type: 'image_url', image_url: { url } }
}

/** 构造音频内容片段（base64 数据） */
export function audioContent(data: string, format: AudioFormat): ContentPart {
  return { type: 'input_audio', input_audio: { data, format } }
}

/** 构造视频内容片段（base64 数据） */
export function videoContent(data: string, format: VideoFormat): ContentPart {
  return { type: 'input_video', input_video: { data, format } }
}

/** 构造「文本 + 多图」的用户消息（视觉模型） */
export function userMessageWithImages(text: string, imageUrls: string[]): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...imageUrls.map((url) => imageContent(url)),
    ],
  }
}

/** 构造「文本 + 多模态片段」的用户消息（图片/音频/视频混排） */
export function userMessageWithParts(text: string, parts: ContentPart[]): ChatMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }, ...parts],
  }
}

// ==================== Anthropic 协议支持 ====================

/** Anthropic Messages API 请求选项 */
export interface AnthropicOptions {
  apiKey: string
  baseUrl: string
  model: string
  /** 最大输出 token（Anthropic 必填；缺省用默认值） */
  maxTokens?: number
  onUsage?: (usage: TokenUsage) => void
  /** 每次 HTTP 调用后回传原始请求/响应（排查问题用） */
  onTrace?: HttpTraceCallback
}

/** 模型调用协议：openai（OpenAI 兼容 /chat/completions，默认）或 anthropic（Anthropic 原生 /messages） */
export type ModelProtocol = 'openai' | 'anthropic'

/** 统一 provider 工厂入参（与 GatewayModel 解耦，避免 llm 包反向依赖 auth） */
export interface ProviderOptions {
  apiKey: string
  baseUrl: string
  model: string
  protocol?: ModelProtocol
  maxTokens?: number
  onUsage?: (usage: TokenUsage) => void
  /** 每次 HTTP 调用后回传原始请求/响应（排查问题用） */
  onTrace?: HttpTraceCallback
  /** 用户标识（网关按 user_id 隔离缓存/计费/用量统计），请求 body 顶层 user_id 字段 */
  userId?: string | number
}

/** Anthropic 缺省最大输出 token（用户自定义模型未指定时兜底；Claude 3.5 系列上限 8192） */
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192

/**
 * 按协议创建模型 provider：
 * - anthropic → AnthropicProvider（Anthropic 原生 /messages）
 * - 其余（含缺省）→ DeepSeekProvider（OpenAI 兼容 /chat/completions，覆盖 DeepSeek/Qwen/GLM 等一切 OpenAI 兼容端点）
 */
export function createModelProvider(opts: ProviderOptions): Model {
  if (opts.protocol === 'anthropic') {
    return new AnthropicProvider(opts)
  }
  return new DeepSeekProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model, maxTokens: opts.maxTokens, onUsage: opts.onUsage, onTrace: opts.onTrace, userId: opts.userId })
}

/**
 * 拼接 Anthropic Messages 完整 URL，兼容多种 baseUrl：
 * - `https://api.anthropic.com`（不带后缀）→ 拼 /v1/messages
 * - `https://api.anthropic.com/v1`（带版本）→ 拼 /messages
 * - `https://xxx.com/v1/messages`（已完整）→ 原样
 */
function anthropicMessagesUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '')
  if (/\/messages$/.test(b)) return b
  if (/\/v\d+$/.test(b)) return `${b}/messages`
  return `${b}/v1/messages`
}

/** 从 ChatMessage.content 提取纯文本（string 或 text 片段拼接） */
function extractText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** 图片 URL → Anthropic image content block（data: URL 转 base64，https 链接转 url source） */
function anthropicImageBlock(url: string): Record<string, unknown> | null {
  if (url.startsWith('data:')) {
    const idx = url.indexOf(';base64,')
    if (idx < 0) return null
    const mediaType = url.slice(5, idx)
    const data = url.slice(idx + 8)
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
  }
  if (/^https?:\/\//.test(url)) {
    return { type: 'image', source: { type: 'url', url } }
  }
  return null
}

/** OpenAI 风格 ContentPart[] → Anthropic content block 数组（只支持 text / image_url，audio/video 忽略） */
function anthropicContentBlocks(content: string | ContentPart[]): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  const blocks: Array<Record<string, unknown>> = []
  for (const p of content) {
    if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text })
    else if (p.type === 'image_url' && p.image_url?.url) {
      const img = anthropicImageBlock(p.image_url.url)
      if (img) blocks.push(img)
    }
  }
  return blocks
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

interface AnthropicTextBlock {
  type: 'text'
  text: string
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | Record<string, unknown>

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

/**
 * 将内部 ChatMessage[] 序列化为 Anthropic Messages wire 格式：
 * - system → 顶层 system 字段（多条拼接）
 * - tool → user 角色 + tool_result block（tool_call_id 关联上一条 assistant 的 tool_use）
 * - assistant + toolCall → text block（若有）+ tool_use block
 * - 其余 → user/assistant + content（string 或 block 数组）
 */
function serializeAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = []
  const out: AnthropicMessage[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      const text = extractText(m.content)
      if (text) systemParts.push(text)
      continue
    }
    if (m.role === 'tool') {
      // tool_use_id 必须严格来自事件日志里记录的 callId，缺失直接报错，绝不编造
      if (!m.toolCallId) {
        throw new Error('序列化失败：tool 消息缺少 tool_use_id（事件回放的 callId 缺失）')
      }
      const id = m.toolCallId
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] })
      continue
    }
    const calls = m.toolCalls ?? (m.toolCall ? [m.toolCall] : [])
    if (m.role === 'assistant' && calls.length > 0) {
      const blocks: AnthropicContentBlock[] = []
      const text = extractText(m.content)
      if (text) blocks.push({ type: 'text', text })
      for (const c of calls) {
        // tool_use id 必须严格来自事件日志里记录的 callId，缺失直接报错，绝不编造
        if (!c.id) {
          throw new Error(`序列化失败：assistant 工具调用 ${c.name} 缺少 id（事件回放的 callId 缺失）`)
        }
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} })
      }
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    if (m.role === 'assistant') {
      const text = extractText(m.content)
      out.push({ role: 'assistant', content: text ? [{ type: 'text', text }] : '' })
      continue
    }
    // user（含多模态）
    const content = anthropicContentBlocks(m.content)
    out.push({ role: 'user', content: content.length === 0 ? '' : content })
  }

  return { system: systemParts.join('\n') || undefined, messages: out }
}

/** OpenAI 风格 ToolContract[] → Anthropic tools（name/description/input_schema） */
function anthropicTools(tools?: ToolContract[]): Array<Record<string, unknown>> {
  if (!tools || tools.length === 0) return []
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }))
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** Anthropic 响应 → ModelResponse（text 取首个 text block，tool_use → toolCall） */
function parseAnthropicResponse(resp: AnthropicResponse, onUsage?: (u: TokenUsage) => void): ModelResponse {
  const usage = resp.usage
  if (usage && onUsage) {
    onUsage({
      promptTokens: usage.input_tokens ?? 0,
      completionTokens: usage.output_tokens ?? 0,
      totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    })
  }
  let text = ''
  const toolCalls: ToolCall[] = []
  for (const block of resp.content ?? []) {
    if (block.type === 'text' && block.text) {
      text += block.text
    } else if (block.type === 'tool_use' && block.name) {
      toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} })
    }
  }
  if (toolCalls.length > 0) return { toolCalls, toolCall: toolCalls[0] }
  return { text }
}

/** Anthropic provider：Anthropic 原生 /v1/messages（fetch），支持工具调用 + 多模态图片 */
export class AnthropicProvider implements Model {
  constructor(private readonly opts: AnthropicOptions) {}

  async complete(messages: ChatMessage[], tools?: ToolContract[]): Promise<ModelResponse> {
    const { system, messages: wire } = serializeAnthropicMessages(messages)
    const url = anthropicMessagesUrl(this.opts.baseUrl)
    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
      messages: wire,
    }
    if (system) body.system = system
    const toolDefs = anthropicTools(tools)
    if (toolDefs.length > 0) body.tools = toolDefs

    this.opts.onTrace?.({ phase: 'request', url, method: 'POST', body })
    let res: Response
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.opts.apiKey,
          Authorization: `Bearer ${this.opts.apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      this.opts.onTrace?.({ phase: 'response', url, method: 'POST', error: err instanceof Error ? err.message : String(err) })
      throw err
    }
    const rawText = await res.text()
    if (!res.ok) {
      this.opts.onTrace?.({ phase: 'response', url, method: 'POST', body: normalizeResponseBody(rawText), responseStatus: res.status, error: `Anthropic API ${res.status}` })
      throw new Error(`Anthropic API ${res.status}: ${rawText}`)
    }
    let raw: AnthropicResponse
    try {
      raw = JSON.parse(rawText) as AnthropicResponse
    } catch {
      this.opts.onTrace?.({ phase: 'response', url, method: 'POST', body: normalizeResponseBody(rawText), responseStatus: res.status, error: '响应非合法 JSON' })
      throw new Error(`Anthropic API ${res.status}: 响应非合法 JSON`)
    }
    this.opts.onTrace?.({ phase: 'response', url, method: 'POST', body: raw, responseStatus: res.status })
    return parseAnthropicResponse(raw, this.opts.onUsage)
  }

  /** SSE 流式：解析 content_block_delta 产出 text 增量，累积 input_json_delta 产出完整 toolCall */
  async *stream(messages: ChatMessage[], tools?: ToolContract[]): AsyncIterable<StreamChunk> {
    const { system, messages: wire } = serializeAnthropicMessages(messages)
    const url = anthropicMessagesUrl(this.opts.baseUrl)
    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
      messages: wire,
      stream: true,
    }
    if (system) body.system = system
    const toolDefs = anthropicTools(tools)
    if (toolDefs.length > 0) body.tools = toolDefs

    this.opts.onTrace?.({ phase: 'request', url, method: 'POST', body })
    let res: Response
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.opts.apiKey,
          Authorization: `Bearer ${this.opts.apiKey}`,
          'anthropic-version': '2023-06-01',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      this.opts.onTrace?.({ phase: 'response', url, method: 'POST', error: err instanceof Error ? err.message : String(err) })
      throw err
    }
    if (!res.ok || !res.body) {
      const errText = await res.text()
      this.opts.onTrace?.({ phase: 'response', url, method: 'POST', body: normalizeResponseBody(errText), responseStatus: res.status, error: `Anthropic API ${res.status}` })
      throw new Error(`Anthropic API ${res.status}: ${errText}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let toolUseAcc: { id?: string; name?: string; jsonText: string } | null = null
    let inputTokens = 0
    /** 合并后的完整响应内容（流结束后用于 trace 落盘，替代逐条 SSE 事件） */
    let fullText = ''
    const allToolCalls: ToolCall[] = []
    let finalUsage: Usage | undefined

    /** 累积每个产出 chunk 的完整内容，供流结束后合并成完整 JSON */
    const accumulate = (c: StreamChunk): void => {
      if (c.text) fullText += c.text
      if (c.reasoningContent) fullText += c.reasoningContent
      if (c.toolCalls) allToolCalls.push(...c.toolCalls)
      else if (c.toolCall) allToolCalls.push(c.toolCall)
      if (c.usage) finalUsage = c.usage
    }

    const handleEvent = (event: Record<string, unknown>): StreamChunk[] => {
      const out: StreamChunk[] = []
      const type = event.type
      if (type === 'message_start') {
        const msg = (event.message ?? {}) as { usage?: { input_tokens?: number } }
        if (msg.usage?.input_tokens != null) inputTokens = msg.usage.input_tokens
      } else if (type === 'content_block_start') {
        const cb = (event.content_block ?? {}) as { type?: string; id?: string; name?: string }
        if (cb.type === 'tool_use') {
          toolUseAcc = { id: cb.id, name: cb.name, jsonText: '' }
        }
      } else if (type === 'content_block_delta') {
        const delta = (event.delta ?? {}) as { type?: string; text?: string; partial_json?: string }
        if (delta.type === 'text_delta' && delta.text) {
          out.push({ text: delta.text })
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          if (!toolUseAcc) toolUseAcc = { jsonText: '' }
          toolUseAcc.jsonText += delta.partial_json
        }
      } else if (type === 'content_block_stop') {
        if (toolUseAcc?.name) {
          out.push({ toolCall: { id: toolUseAcc.id, name: toolUseAcc.name, args: safeParse(toolUseAcc.jsonText || '{}') } })
        }
        toolUseAcc = null
      } else if (type === 'message_delta') {
        const usage = (event.usage ?? {}) as { output_tokens?: number }
        if (usage.output_tokens != null) {
          const full = {
            promptTokens: inputTokens,
            completionTokens: usage.output_tokens,
            totalTokens: inputTokens + usage.output_tokens,
          }
          if (this.opts.onUsage) this.opts.onUsage(full)
          out.push({ usage: full })
        }
      }
      return out
    }

    const parseLine = (line: string): StreamChunk[] => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return []
      const data = trimmed.slice(5).trim()
      if (!data) return []
      try {
        return handleEvent(JSON.parse(data) as Record<string, unknown>)
      } catch {
        return []
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        for (const chunk of parseLine(line)) {
          accumulate(chunk)
          yield chunk
        }
      }
    }
    for (const chunk of parseLine(buffer)) {
      accumulate(chunk)
      yield chunk
    }
    this.opts.onTrace?.({
      phase: 'response',
      url,
      method: 'POST',
      body: buildMergedStreamBody({
        model: this.opts.model,
        text: fullText,
        reasoningContent: '',
        toolCalls: allToolCalls,
        usage: finalUsage,
      }),
      responseStatus: res.status,
    })
  }
}

