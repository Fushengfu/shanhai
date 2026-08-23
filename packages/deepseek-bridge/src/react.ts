/**
 * ReAct 循环 + 标签协议解析：把 DeepSeek 网页版的纯文本回复解析为
 * 「思考 / 工具调用 / 最终回答」，执行内置工具并回填，循环直到得到最终内容。
 *
 * 网页版 DeepSeek 没有原生 tool_calls 能力，靠「标签协议」让模型用 <message>/<tool_calls>
 * 结构化输出；server 解析后执行工具，结果回填继续推理。
 */
import type { BuiltinToolRegistry } from './tools'
import { truncateToolResult, toolSystemPrompt } from './tools'

/** OpenAI 风格消息（server 收到 /v1/chat/completions 的 messages 项） */
export interface BridgeMessage {
  role: string
  content?: unknown
}

/** ReAct 最终结果（只含最终内容与思考过程；工具调用已在内部消费，不外泄） */
export interface ReActResult {
  content: string
  reasoningContent: string
}

/** ReAct 执行上下文 */
export interface ReActContext {
  tools: BuiltinToolRegistry
  maxSteps: number
  mode: 'expert' | 'fast' | 'vision'
  thinking: boolean
  /** 发送一条 prompt 给 DeepSeek 网页版，返回 AI 原始回复（由 server 经任务队列 + bridge 完成） */
  chat: (prompt: string, opts: { mode: string; thinking: boolean }) => Promise<string>
}

/** 把 OpenAI 风格 messages 拼成可读的纯文本 prompt（网页版只有纯文本 prompt 字段） */
export function buildPrompt(messages: BridgeMessage[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const parts: string[] = []
  for (const m of messages) {
    if (!m || m.content == null) continue
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    if (!content || !content.trim()) continue
    switch (m.role) {
      case 'system':
        parts.push('【系统指令】\n' + content)
        break
      case 'user':
        parts.push('【用户】\n' + content)
        break
      case 'assistant':
        parts.push('【助手】\n' + content)
        break
      case 'tool':
        parts.push('【工具返回结果】\n' + content)
        break
      default:
        parts.push(content)
    }
  }
  return parts.join('\n\n')
}

/** 从标签文本中提取内容：优先取 <![CDATA[...]]>，否则取标签内纯文本 */
function extractTagContent(html: unknown, tagName: string): string | null {
  if (html == null) return null
  const re = new RegExp('<' + tagName + '\\s*[^>]*>([\\s\\S]*?)<\\/' + tagName + '>', 'i')
  const m = String(html).match(re)
  if (!m) return null
  const inner = m[1] ?? ''
  const cdata = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
  if (cdata) return cdata[1] ?? null
  return inner.trim()
}

/** OpenAI 标准工具调用结构 */
export interface ParsedToolCall {
  id: string
  type: string
  function: { name: string; arguments: string }
}

let callIdCounter = 0
function nextCallId(): string {
  callIdCounter += 1
  return 'call_' + callIdCounter
}

/** 从模型回复解析工具调用（支持 XML / invoke / 裸 JSON 三种格式），返回 OpenAI 标准结构 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  if (!text) return []
  const cleaned = String(text).replace(/```(?:json)?/g, '')
  const result: ParsedToolCall[] = []

  // 1) XML：<tool_call><id/><type/><function><name/><arguments/></function></tool_call>
  const tcBlock = cleaned.match(/<tool_calls\s*>([\s\S]*?)<\/tool_calls>/i)
  const scope = tcBlock ? (tcBlock[1] ?? '') : cleaned
  const callRe = /<tool_call\s*>([\s\S]*?)<\/tool_call>/g
  let cm: RegExpExecArray | null
  while ((cm = callRe.exec(scope)) !== null) {
    const callBody = cm[1] ?? ''
    const fnMatch = callBody.match(/<function\s*>([\s\S]*?)<\/function>/i)
    let name: string | null = null
    let argsRaw: string | null = null
    if (fnMatch) {
      name = extractTagContent(fnMatch[1], 'name')
      argsRaw = extractTagContent(fnMatch[1], 'arguments')
    }
    // 旧格式兜底：<tool_call> 内直接是 JSON
    if (!name) {
      try {
        const obj = JSON.parse(callBody.trim()) as { name?: string; arguments?: unknown }
        if (obj && obj.name) {
          name = obj.name
          argsRaw = JSON.stringify(obj.arguments || {})
        }
      } catch {
        /* 忽略 */
      }
    }
    if (name) {
      const id = extractTagContent(callBody, 'id') || nextCallId()
      const type = extractTagContent(callBody, 'type') || 'function'
      let args: unknown = {}
      if (argsRaw != null && String(argsRaw).trim()) {
        try {
          args = JSON.parse(argsRaw)
        } catch {
          args = { _raw: argsRaw }
        }
      }
      result.push({ id, type, function: { name, arguments: JSON.stringify(args) } })
    }
  }

  // 2) invoke：<tool_calls><invoke name=""><parameter name="">值</parameter></invoke></tool_calls>
  if (result.length === 0) {
    const invokeRe = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/g
    let im: RegExpExecArray | null
    while ((im = invokeRe.exec(cleaned)) !== null) {
      const name = im[1] ?? ''
      const args: Record<string, unknown> = {}
      const paramRe = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/g
      let pm: RegExpExecArray | null
      while ((pm = paramRe.exec(im[2] ?? '')) !== null) {
        let val: unknown = pm[2] ?? ''
        try {
          val = JSON.parse(val as string)
        } catch {
          /* 保持纯文本 */
        }
        args[pm[1] ?? ''] = val
      }
      if (name) {
        result.push({ id: nextCallId(), type: 'function', function: { name, arguments: JSON.stringify(args) } })
      }
    }
  }

  // 3) 裸 JSON：{"name":"...","arguments":{...}}
  if (result.length === 0) {
    try {
      const obj = JSON.parse(String(text).trim()) as { name?: string; arguments?: unknown }
      if (obj && obj.name) {
        result.push({ id: nextCallId(), type: 'function', function: { name: obj.name, arguments: JSON.stringify(obj.arguments || {}) } })
      }
    } catch {
      /* 无工具调用 */
    }
  }

  return result
}

/** 解析 <content>（新协议）/ <final_answer>（旧协议） */
export function parseContent(text: string): string | null {
  if (!text) return null
  const cleaned = String(text).replace(/```(?:json)?/g, '')
  const m = cleaned.match(/<content>\s*([\s\S]*?)\s*<\/content>/)
  if (m) return (m[1] ?? '').trim()
  const old = cleaned.match(/<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/)
  if (!old) return null
  const inner = (old[1] ?? '').trim()
  try {
    const obj = JSON.parse(inner) as { content?: unknown }
    if (obj && obj.content != null) {
      return typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content)
    }
    return inner
  } catch {
    return inner
  }
}

/** 解析思考过程 <reasoning_content> / <think> */
export function parseReasoning(text: string): string | null {
  if (!text) return null
  const cleaned = String(text).replace(/```(?:json)?/g, '')
  const m =
    cleaned.match(/<reasoning_content>\s*([\s\S]*?)\s*<\/reasoning_content>/) ||
    cleaned.match(/<think>\s*([\s\S]*?)\s*<\/think>/)
  if (!m) return null
  return (m[1] ?? '').trim() || null
}

/** 统一解析模型回复：content / reasoning_content / tool_calls */
export interface ParsedMessage {
  role: string | null
  content: string | null
  reasoningContent: string | null
  toolCalls: ParsedToolCall[]
}

export function parseMessage(text: string): ParsedMessage {
  if (!text) return { role: null, content: null, reasoningContent: null, toolCalls: [] }
  let body = String(text)

  const msgMatch = body.match(/<message\s+role="([^"]+)"\s*>([\s\S]*?)<\/message>/i)
  let role: string | null = null
  if (msgMatch) {
    role = msgMatch[1] ?? null
    body = msgMatch[2] ?? ''
  }

  let content = extractTagContent(body, 'content')
  if (content == null) content = parseContent(body)
  const reasoning = parseReasoning(body)
  let toolCalls = parseToolCalls(body)
  if (toolCalls.length === 0) toolCalls = parseToolCalls(text)

  return {
    role,
    content: content != null ? content.trim() : null,
    reasoningContent: reasoning != null ? reasoning.trim() : null,
    toolCalls,
  }
}

/** 执行内置工具，返回截断后的文本 */
function runTool(tools: BuiltinToolRegistry, name: string, args: Record<string, unknown>): string {
  const tool = tools[name]
  if (!tool) throw new Error('未知工具: ' + name)
  return truncateToolResult(tool.run(args || {}))
}

/** ReAct 循环：对话 → 解析工具调用 → 执行 → 回填 → 再对话，直到给出最终答案 */
export async function runAgent(messages: BridgeMessage[], ctx: ReActContext): Promise<ReActResult> {
  const maxSteps = Number(ctx.maxSteps || 1000)
  const mode = ctx.mode || 'expert'
  const thinking = ctx.thinking != null ? !!ctx.thinking : true

  const working: BridgeMessage[] = [{ role: 'system', content: toolSystemPrompt(ctx.tools) }, ...messages]

  let content = ''
  let reasoningContent = ''
  let noToolCount = 0

  for (let step = 0; step < maxSteps; step++) {
    const prompt = buildPrompt(working)
    const reply = await ctx.chat(prompt, { mode, thinking })

    const parsed = parseMessage(reply)
    const reasoning = parsed.reasoningContent
    const calls = parsed.toolCalls

    if (reasoning) {
      reasoningContent = reasoningContent ? reasoningContent + '\n\n' + reasoning : reasoning
    }

    if (calls.length > 0) {
      working.push({ role: 'assistant', content: reply })
      for (const call of calls) {
        const name = call.function.name
        let args: Record<string, unknown> = {}
        try {
          args = (JSON.parse(call.function.arguments || '{}') as Record<string, unknown>) || {}
        } catch {
          args = {}
        }
        let toolResult: string
        try {
          toolResult = runTool(ctx.tools, name, args)
        } catch (e) {
          toolResult = '工具执行出错: ' + (e instanceof Error ? e.message : String(e))
        }
        working.push({ role: 'tool', content: '工具 ' + name + ' 返回结果:\n' + toolResult })
      }
    } else {
      const final = parsed.content
      if (final != null && final.trim() !== '') {
        content = final.trim()
        break
      }
      noToolCount += 1
      working.push({ role: 'assistant', content: reply })
      if (noToolCount > 3) {
        content = reply
        break
      }
      working.push({
        role: 'user',
        content: '请继续：如仍需获取信息，输出 <tool_calls>；如已能完整回答，输出非空的 <content>。不要输出其他文字。',
      })
    }
  }

  if (!content) content = '(已达到最大步数 ' + maxSteps + '，仍未得到最终答案)'
  return { content, reasoningContent }
}
