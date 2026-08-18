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
  toolCall?: ToolCall
  toolCallId?: string
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ModelResponse {
  text?: string
  toolCall?: ToolCall
  usage?: Usage
}

export interface StreamChunk {
  text?: string
  toolCall?: ToolCall
  usage?: Usage
}

/** 模型接口：complete（一次性）+ 可选 stream（流式） */
export interface Model {
  complete(messages: ChatMessage[], tools?: ToolContract[]): Promise<ModelResponse>
  stream?(messages: ChatMessage[], tools?: ToolContract[]): AsyncIterable<StreamChunk>
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
}

export interface DeepSeekOptions {
  apiKey: string
  baseUrl: string
  model: string
  /** 每次调用后回传 token 用量（成本统计） */
  onUsage?: (usage: TokenUsage) => void
}

/** 网关响应 choice（网关包装在 { code, data } 里，兼容裸 OpenAI 格式） */
interface GatewayChoice {
  message?: {
    content?: string
    reasoning_content?: string
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
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

/** DeepSeek provider：网关 OpenAI 兼容 /api/v1/chat/completions（fetch） */
export class DeepSeekProvider implements Model {
  constructor(private readonly opts: DeepSeekOptions) {}

  async complete(messages: ChatMessage[], tools?: ToolContract[]): Promise<ModelResponse> {
    const res = await fetch(chatCompletionsUrl(this.opts.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        tools: tools?.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
    })
    if (!res.ok) {
      throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`)
    }
    // 网关响应：{ code, data: { choices: [...] } } 包装（兼容裸 OpenAI 格式）
    const raw = (await res.json()) as {
      code?: number
      error?: string | { message?: string }
      data?: {
        choices?: GatewayChoice[]
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      choices?: GatewayChoice[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
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
      this.opts.onUsage({
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      })
    }
    const message = payload.choices?.[0]?.message
    const toolCall = message?.tool_calls?.[0]
    if (toolCall) {
      return {
        toolCall: {
          id: toolCall.id,
          name: toolCall.function.name,
          args: safeParse(toolCall.function.arguments),
        },
      }
    }
    return { text: message?.content ?? '' }
  }

  /** SSE 流式：逐行解析，累积工具调用 arguments 分片，产出 text 增量 + 完整 toolCall */
  async *stream(messages: ChatMessage[], tools?: ToolContract[]): AsyncIterable<StreamChunk> {
    const res = await fetch(chatCompletionsUrl(this.opts.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        tools: tools?.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
        stream: true,
        // 请求网关在流末尾返回 usage（OpenAI 兼容；网关不支持时自动忽略，不影响流）
        stream_options: { include_usage: true },
      }),
    })
    if (!res.ok || !res.body) {
      throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let toolCallAcc: { id?: string; name?: string; argsText: string } | null = null

    const handleLine = (line: string): StreamChunk[] => {
      const ev = parseSseLine(line)
      const out: StreamChunk[] = []
      if (!ev) return out
      if (ev.usage) {
        // 流末尾 usage：先结算未 flush 的工具调用，再产出 usage，并回传成本统计
        if (toolCallAcc) {
          const tc = flushToolCall(toolCallAcc)
          if (tc) out.push(tc)
          toolCallAcc = null
        }
        out.push({ usage: ev.usage })
        if (this.opts.onUsage) this.opts.onUsage(ev.usage)
        return out
      }
      if (ev.text !== undefined) {
        if (toolCallAcc) {
          const tc = flushToolCall(toolCallAcc)
          if (tc) out.push(tc)
          toolCallAcc = null
        }
        out.push({ text: ev.text })
      }
      if (ev.toolCall) {
        if (!toolCallAcc) toolCallAcc = { id: ev.toolCall.id, name: ev.toolCall.name, argsText: '' }
        if (ev.toolCall.id) toolCallAcc.id = ev.toolCall.id
        if (ev.toolCall.name) toolCallAcc.name = ev.toolCall.name
        toolCallAcc.argsText += ev.toolCall.argsDelta ?? ''
      }
      return out
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        for (const chunk of handleLine(line)) yield chunk
      }
    }
    for (const chunk of handleLine(buffer)) yield chunk
    if (toolCallAcc) {
      const tc = flushToolCall(toolCallAcc)
      if (tc) yield tc
    }
  }
}

/** 累积完成的工具调用 → StreamChunk */
function flushToolCall(acc: { id?: string; name?: string; argsText: string }): StreamChunk | null {
  if (!acc.name) return null
  return { toolCall: { id: acc.id, name: acc.name, args: safeParse(acc.argsText || '{}') } }
}

interface SseDeltaEvent {
  text?: string
  toolCall?: { id?: string; name?: string; argsDelta?: string }
  usage?: Usage
}

/** 解析单行 SSE `data: {...}`，返回 text 增量 / tool_calls 分片 / usage；网关返回 error 时抛错 */
function parseSseLine(line: string): SseDeltaEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return null
  let parsed: {
    error?: string | { message?: string }
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    choices?: Array<{
      delta?: {
        content?: string
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
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
  // 流末尾 usage（stream_options.include_usage 时网关返回）
  if (parsed.usage) {
    return {
      usage: {
        promptTokens: parsed.usage.prompt_tokens ?? 0,
        completionTokens: parsed.usage.completion_tokens ?? 0,
        totalTokens: parsed.usage.total_tokens ?? 0,
      },
    }
  }
  const delta = parsed.choices?.[0]?.delta
  const text = typeof delta?.content === 'string' && delta.content ? delta.content : undefined
  const tc = delta?.tool_calls?.[0]
  const toolCall = tc ? { id: tc.id, name: tc.function?.name, argsDelta: tc.function?.arguments ?? '' } : undefined
  if (text === undefined && !toolCall) return null
  return { text, toolCall }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
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
