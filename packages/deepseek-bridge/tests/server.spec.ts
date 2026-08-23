import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBuiltinTools, safeResolve } from '../src/tools'
import { buildPrompt, parseMessage, parseToolCalls, runAgent } from '../src/react'
import { createDeepSeekModel } from '../src/server'
import { buildBridgeScript, BRIDGE_READY_CHECK } from '../src/bridge-script'

const tmpDirs: string[] = []
function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('safeResolve 路径安全', () => {
  it('resolve 到工作目录内', () => {
    const ws = '/tmp/ws'
    expect(safeResolve(ws, 'a/b.txt')).toBe('/tmp/ws/a/b.txt')
    expect(safeResolve(ws, '.')).toBe('/tmp/ws')
  })
  it('拒绝路径穿越', () => {
    const ws = '/tmp/ws'
    expect(() => safeResolve(ws, '../../etc/passwd')).toThrow(/超出工作目录/)
  })
})

describe('parseToolCalls', () => {
  it('XML 格式', () => {
    const text =
      '<message role="tool"><tool_calls><tool_call><id>call_1</id><type>function</type><function><name>read_file</name><arguments>{"path":"a.txt"}</arguments></function></tool_call></tool_calls></message>'
    const calls = parseToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('read_file')
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'a.txt' })
  })
  it('invoke 格式', () => {
    const text = '<tool_calls><invoke name="search_content"><parameter name="pattern">foo</parameter></invoke></tool_calls>'
    const calls = parseToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('search_content')
  })
  it('裸 JSON 格式', () => {
    const calls = parseToolCalls('{"name":"read_file","arguments":{"path":"b.txt"}}')
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('read_file')
  })
  it('无工具调用返回空', () => {
    expect(parseToolCalls('普通文本')).toEqual([])
  })
})

describe('parseMessage', () => {
  it('解析最终回复', () => {
    const p = parseMessage('<message role="assistant"><reasoning_content>思考</reasoning_content><content>最终答案</content></message>')
    expect(p.role).toBe('assistant')
    expect(p.content).toBe('最终答案')
    expect(p.reasoningContent).toBe('思考')
  })
  it('解析工具调用', () => {
    const p = parseMessage('<message role="tool"><tool_calls><tool_call><id>c1</id><function><name>read_file</name><arguments>{"path":"a"}</arguments></function></tool_call></tool_calls></message>')
    expect(p.role).toBe('tool')
    expect(p.toolCalls).toHaveLength(1)
  })
})

describe('buildPrompt', () => {
  it('按 role 标注拼接', () => {
    const p = buildPrompt([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '你好' },
    ])
    expect(p).toContain('【系统指令】\nsys')
    expect(p).toContain('【用户】\n你好')
  })
})

describe('runAgent ReAct 循环', () => {
  it('工具调用 → 执行 → 最终内容', async () => {
    const ws = makeTmp()
    fs.writeFileSync(path.join(ws, 'hello.txt'), 'hello content', 'utf8')
    const tools = createBuiltinTools(() => ws)

    const replies = [
      '<message role="tool"><tool_calls><tool_call><id>call_1</id><type>function</type><function><name>read_file</name><arguments>{"path":"hello.txt"}</arguments></function></tool_call></tool_calls></message>',
      '<message role="assistant"><reasoning_content>已读取</reasoning_content><content>文件内容是 hello content</content></message>',
    ]
    let i = 0
    const result = await runAgent([{ role: 'user', content: '读取 hello.txt' }], {
      tools,
      maxSteps: 10,
      mode: 'expert',
      thinking: true,
      chat: async () => replies[i++ % replies.length],
    })

    expect(result.content).toContain('hello content')
    expect(result.reasoningContent).toContain('已读取')
  })

  it('无工具直接返回最终内容', async () => {
    const tools = createBuiltinTools(() => makeTmp())
    const result = await runAgent([{ role: 'user', content: '你好' }], {
      tools,
      maxSteps: 10,
      mode: 'expert',
      thinking: true,
      chat: async () => '<message role="assistant"><content>你好！</content></message>',
    })
    expect(result.content).toBe('你好！')
  })
})

describe('createDeepSeekModel', () => {
  it('complete 走自包含 ReAct，只返回最终内容（不外泄内部 tool_calls）', async () => {
    const ws = makeTmp()
    fs.writeFileSync(path.join(ws, 'a.txt'), 'AAA', 'utf8')
    const replies = [
      '<message role="tool"><tool_calls><tool_call><id>call_1</id><type>function</type><function><name>read_file</name><arguments>{"path":"a.txt"}</arguments></function></tool_call></tool_calls></message>',
      '<message role="assistant"><reasoning_content>已读</reasoning_content><content>内容是 AAA</content></message>',
    ]
    let i = 0
    const chats: string[] = []
    const model = createDeepSeekModel({
      chat: async (prompt) => {
        chats.push(prompt)
        return replies[i++ % replies.length]
      },
      getWorkspace: () => ws,
    })
    const resp = await model.complete([{ role: 'user', content: '读 a.txt' }])
    expect(resp.text).toContain('AAA')
    expect(resp.reasoningContent).toContain('已读')
    expect(resp.toolCall).toBeUndefined()
    expect(chats.length).toBeGreaterThanOrEqual(1)
  })
})

describe('bridge 脚本', () => {
  it('生成脚本含 DOM 轮询 + SSE 诊断记录 + 就绪标记（无本地服务依赖）', () => {
    const script = buildBridgeScript()
    expect(script).toContain('window.__dsChat')
    expect(script).toContain('__dsBridgeReady')
    // 结果回传走 DOM 轮询（读 .ds-assistant-message-main-content，Taco 原版可靠路径）
    expect(script).toContain('ds-assistant-message-main-content')
    expect(script).toContain('ds-button--primary')
    // SSE 监听独立成诊断通道：hook fetch 只记录原始 SSE，不解析、不参与结果回传
    expect(script).toContain('window.fetch')
    expect(script).toContain('__dsSseLog')
    // 不再依赖本地 HTTP 服务地址
    expect(script).not.toContain('127.0.0.1:8001')
    expect(BRIDGE_READY_CHECK).toContain('__dsChat')
  })
})
