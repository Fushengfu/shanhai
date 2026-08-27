import { describe, it, expect, vi } from 'vitest'
import { createMockModel, userMessageWithImages, audioContent, videoContent, userMessageWithParts, DeepSeekProvider, AnthropicProvider, createModelProvider } from '../src/llm'

describe('Model 接口', () => {
  it('mock 模型按队列返回响应', async () => {
    const model = createMockModel([
      { text: 'first' },
      { toolCall: { name: 'read_file', args: { path: '/a' } } },
    ])
    expect(await model.complete([])).toEqual({ text: 'first' })
    expect(await model.complete([])).toEqual({ toolCall: { name: 'read_file', args: { path: '/a' } } })
  })

  it('队列耗尽复用最后一个', async () => {
    const model = createMockModel([{ text: 'only' }])
    expect(await model.complete([])).toEqual({ text: 'only' })
    expect(await model.complete([])).toEqual({ text: 'only' })
  })
})

describe('多模态（视觉/音频/视频）', () => {
  it('userMessageWithImages 构造文本 + 图片消息', () => {
    const msg = userMessageWithImages('看图', ['data:image/png;base64,xxx'])
    expect(msg.role).toBe('user')
    expect(Array.isArray(msg.content)).toBe(true)
    const parts = msg.content as Array<{ type: string }>
    expect(parts[0]?.type).toBe('text')
    expect(parts[1]?.type).toBe('image_url')
  })

  it('audioContent / videoContent 构造音视频片段', () => {
    expect(audioContent('base64-audio', 'wav')).toEqual({
      type: 'input_audio',
      input_audio: { data: 'base64-audio', format: 'wav' },
    })
    expect(videoContent('base64-video', 'mp4')).toEqual({
      type: 'input_video',
      input_video: { data: 'base64-video', format: 'mp4' },
    })
  })

  it('userMessageWithParts 构造图文音视频混排消息', () => {
    const msg = userMessageWithParts('分析这段', [
      audioContent('audio-data', 'mp3'),
      videoContent('video-data', 'webm'),
    ])
    const parts = msg.content as Array<{ type: string }>
    expect(parts.map((p) => p.type)).toEqual(['text', 'input_audio', 'input_video'])
  })
})

describe('DeepSeekProvider 消息序列化（OpenAI wire 格式）', () => {
  it('assistant 的 tool_calls 与 tool 的 tool_call_id 正确输出（修复 missing field tool_call_id）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { choices: [{ message: { content: 'ok' } }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    try {
      const provider = new DeepSeekProvider({ apiKey: 'k', baseUrl: 'https://x.com', model: 'm' })
      await provider.complete([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCall: { id: 'call-1', name: 'read_file', args: { path: '/a' } } },
        { role: 'tool', content: 'result', toolCallId: 'call-1' },
      ])
      const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as {
        messages: Array<Record<string, unknown>>
      }
      expect(body.messages[1]).toMatchObject({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file' } }],
      })
      expect(body.messages[2]).toEqual({ role: 'tool', content: 'result', tool_call_id: 'call-1' })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('thinking 模式 assistant 消息回传 reasoning_content（修复 must be passed back 400）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { choices: [{ message: { content: 'ok' } }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    try {
      const provider = new DeepSeekProvider({ apiKey: 'k', baseUrl: 'https://x.com', model: 'm' })
      await provider.complete([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '答案', reasoningContent: '让我思考一下' },
        { role: 'assistant', content: '', toolCall: { id: 'call-2', name: 'read_file', args: {} }, reasoningContent: '需要读文件' },
        { role: 'tool', content: 'r', toolCallId: 'call-2' },
      ])
      const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as {
        messages: Array<Record<string, unknown>>
      }
      // 文本 assistant 消息回传 reasoning_content
      expect(body.messages[1]).toMatchObject({ role: 'assistant', content: '答案', reasoning_content: '让我思考一下' })
      // 带 tool_calls 的 assistant 消息也回传 reasoning_content
      expect(body.messages[2]).toMatchObject({ role: 'assistant', content: null, reasoning_content: '需要读文件' })
      // 无 reasoning 的消息不输出 reasoning_content 字段
      expect(body.messages[3]).not.toHaveProperty('reasoning_content')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('supportsReasoning 模式：缺 reasoning_content 的 assistant 消息回传占位符（网关吞 reasoning_content 兜底，修复 resume 400）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { choices: [{ message: { content: 'ok' } }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    try {
      const provider = new DeepSeekProvider({ apiKey: 'k', baseUrl: 'https://x.com', model: 'm', supportsReasoning: true })
      await provider.complete([
        { role: 'user', content: 'hi' },
        // 网关在纯工具调用轮吞掉 reasoning_content，落盘后该字段缺失
        { role: 'assistant', content: '', toolCall: { id: 'call-3', name: 'run_command', args: {} } },
        { role: 'tool', content: 'r', toolCallId: 'call-3' },
        // 文本 assistant 消息同样兜底
        { role: 'assistant', content: '答案' },
      ])
      const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as {
        messages: Array<Record<string, unknown>>
      }
      expect(body.messages[1]).toMatchObject({ role: 'assistant', content: null, reasoning_content: '继续' })
      expect(body.messages[3]).toMatchObject({ role: 'assistant', content: '答案', reasoning_content: '继续' })
      // tool / user 消息不受影响
      expect(body.messages[0]).not.toHaveProperty('reasoning_content')
      expect(body.messages[2]).not.toHaveProperty('reasoning_content')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('非 supportsReasoning 模式：缺 reasoning_content 不回传占位符（普通模型不注入伪 reasoning）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { choices: [{ message: { content: 'ok' } }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    try {
      const provider = new DeepSeekProvider({ apiKey: 'k', baseUrl: 'https://x.com', model: 'm' })
      await provider.complete([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCall: { id: 'call-4', name: 'read_file', args: {} } },
        { role: 'tool', content: 'r', toolCallId: 'call-4' },
      ])
      const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as {
        messages: Array<Record<string, unknown>>
      }
      expect(body.messages[1]).not.toHaveProperty('reasoning_content')
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('AnthropicProvider（Anthropic 原生 /messages 协议）', () => {
  it('complete 序列化：system 顶层 + tool 转 tool_result + tool_use block + max_tokens', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    try {
      const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://api.anthropic.com', model: 'claude-3-5' })
      await provider.complete(
        [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', toolCall: { id: 'tool-1', name: 'read_file', args: { path: '/a' } } },
          { role: 'tool', content: 'result', toolCallId: 'tool-1' },
        ],
        [{ name: 'read_file', description: '读取文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
      )
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.anthropic.com/v1/messages')
      const headers = init.headers as Record<string, string>
      expect(headers['x-api-key']).toBe('k')
      expect(headers['anthropic-version']).toBe('2023-06-01')
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body.model).toBe('claude-3-5')
      expect(body.max_tokens).toBeGreaterThan(0)
      expect(body.system).toBe('你是助手')
      const messages = body.messages as Array<Record<string, unknown>>
      expect(messages[0]).toEqual({ role: 'user', content: 'hi' })
      expect((messages[1].content as Array<Record<string, unknown>>)[0]).toEqual({ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: '/a' } })
      expect(messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }] })
      expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'read_file', description: '读取文件', input_schema: { type: 'object' } })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('parseResponse 解析 tool_use → toolCall + usage', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: '/a' } }],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    try {
      const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://api.anthropic.com', model: 'm' })
      const res = await provider.complete([{ role: 'user', content: 'hi' }])
      expect(res.toolCall).toEqual({ id: 'tu-1', name: 'read_file', args: { path: '/a' } })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('createModelProvider 按 protocol 路由：anthropic → /messages，缺省 → /chat/completions', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    try {
      const anthropic = createModelProvider({ apiKey: 'k', baseUrl: 'https://api.anthropic.com', model: 'm', protocol: 'anthropic' })
      await anthropic.complete([{ role: 'user', content: 'hi' }])
      expect((fetchSpy.mock.calls[0]?.[0] as string).endsWith('/messages')).toBe(true)

      const openai = createModelProvider({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'm' })
      await openai.complete([{ role: 'user', content: 'hi' }])
      expect((fetchSpy.mock.calls[1]?.[0] as string).endsWith('/chat/completions')).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('createModelProvider 把 onTrace 传给 DeepSeekProvider（OpenAI 协议），修复 trace 丢失 bug', async () => {
    const onTrace = vi.fn()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    try {
      const provider = createModelProvider({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'm', onTrace })
      await provider.complete([{ role: 'user', content: 'hi' }])
      const phases = onTrace.mock.calls.map((c) => c[0].phase)
      expect(phases).toContain('request')
      expect(phases).toContain('response')
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('DeepSeekProvider 流式解析（SSE）', () => {
  it('chunk 同时带 usage 和 text 时文本不丢失（poolside 每个 chunk 都带 usage）', async () => {
    // poolside 等 OpenAI 兼容端点的非标准行为：每个流式 chunk 都附带完整 usage。
    // 旧逻辑命中 usage 就提前 return，导致 delta.content 文本被全部丢弃 → 回复气泡空白。
    const chunks = [
      { choices: [{ index: 0, delta: { content: '你' } }], usage: { prompt_tokens: 3255, completion_tokens: 2, total_tokens: 3257 } },
      { choices: [{ index: 0, delta: { content: '好' } }], usage: { prompt_tokens: 3255, completion_tokens: 3, total_tokens: 3258 } },
    ]
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse))
            controller.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    )
    try {
      const provider = new DeepSeekProvider({ apiKey: 'k', baseUrl: 'https://x.com', model: 'm' })
      const texts: string[] = []
      for await (const chunk of provider.stream!([{ role: 'user', content: 'hi' }])) {
        if (chunk.text) texts.push(chunk.text)
      }
      expect(texts.join('')).toBe('你好')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('一次响应多个工具调用（网关 index 恒为 0）参数正确分离，不拼接损坏', async () => {
    // 根因回归：deepseek-v4-flash 一次响应连发多个工具（list_dir + run_command），
    // 且网关把多个 tool_calls 都标成 index=0。旧逻辑把所有 arguments 拼到同一个累加器，
    // 得到 {"path":".","maxDepth":2}{"command":"ls"} 非法 JSON，safeParse 吞成 {} → 工具"缺参数"。
    const chunks = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_dir', arguments: '' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":".","' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'maxDepth":2}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'run_command', arguments: '' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
    ]
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse))
            controller.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    )
    try {
      const provider = new DeepSeekProvider({ apiKey: 'k', baseUrl: 'https://x.com', model: 'm' })
      const allCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }> = []
      for await (const chunk of provider.stream!([{ role: 'user', content: 'hi' }])) {
        if (chunk.toolCalls) allCalls.push(...chunk.toolCalls)
      }
      expect(allCalls).toHaveLength(2)
      expect(allCalls[0]).toEqual({ id: 'call_1', name: 'list_dir', args: { path: '.', maxDepth: 2 } })
      expect(allCalls[1]).toEqual({ id: 'call_2', name: 'run_command', args: { command: 'ls' } })
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('user_id 缓存隔离', () => {
  it('complete 传入 userId 时，请求 body 顶层带 user_id（网关按 user_id 隔离前缀缓存）', async () => {
    let capturedBody: Record<string, unknown> | null = null
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({ code: 0, data: { choices: [{ message: { content: 'ok' } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    try {
      const provider = new DeepSeekProvider({ apiKey: 'k', baseUrl: 'https://x.com', model: 'm' })
      await provider.complete([{ role: 'user', content: 'hi' }], undefined, 'agent-abc-123')
      expect(capturedBody?.user_id).toBe('agent-abc-123')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('未传 userId 且 provider 未配置时，body 不带 user_id', async () => {
    let capturedBody: Record<string, unknown> | null = null
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({ code: 0, data: { choices: [{ message: { content: 'ok' } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    try {
      const provider = new DeepSeekProvider({ apiKey: 'k', baseUrl: 'https://x.com', model: 'm' })
      await provider.complete([{ role: 'user', content: 'hi' }])
      expect(capturedBody?.user_id).toBeUndefined()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
