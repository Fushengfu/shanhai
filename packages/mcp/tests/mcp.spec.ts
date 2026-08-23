import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StdioMcpClient } from '../src/client'
import { McpService } from '../src/service'
import { createMcpTools } from '../src/tools'

/** 内联 mock MCP 服务器：读 stdin 的 JSON-RPC 请求并响应，验证完整链路 */
const MOCK_SERVER_SCRIPT = `
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1.0.0' } } }))
  } else if (msg.method === 'tools/list') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }] } }))
  } else if (msg.method === 'tools/call') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(msg.params.arguments) }] } }))
  }
})
`

describe('StdioMcpClient', () => {
  it('initialize → listTools → callTool 完整链路', async () => {
    const client = new StdioMcpClient({ command: process.execPath, args: ['-e', MOCK_SERVER_SCRIPT] })
    await client.start()
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('echo')
    const result = (await client.callTool('echo', { hello: 'world' })) as { content?: unknown[] }
    expect(JSON.stringify(result)).toContain('hello')
    client.close()
  })
})

describe('McpService', () => {
  it('读配置列出服务器', async () => {
    const dir = join(tmpdir(), `shanhai-mcp-test-${Date.now()}`)
    const cfgPath = join(dir, 'mcp.json')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(cfgPath, JSON.stringify({ servers: { mock: { command: process.execPath, args: ['-e', MOCK_SERVER_SCRIPT] } } }), 'utf8')
    const svc = new McpService(cfgPath)
    const servers = await svc.listServers()
    expect(servers).toHaveLength(1)
    expect(servers[0]!.id).toBe('mock')
    await svc.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('listToolsOf 服务器不存在时降级返回 error', async () => {
    const svc = new McpService(join(tmpdir(), 'shanhai-mcp-nonexistent'))
    const r = await svc.listToolsOf('nope')
    expect(r.error).toBeTruthy()
  })

  it('listToolsOf 真实 mock 服务器返回工具', async () => {
    const dir = join(tmpdir(), `shanhai-mcp-test-${Date.now()}`)
    const cfgPath = join(dir, 'mcp.json')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(cfgPath, JSON.stringify({ servers: { mock: { command: process.execPath, args: ['-e', MOCK_SERVER_SCRIPT] } } }), 'utf8')
    const svc = new McpService(cfgPath)
    const r = await svc.listToolsOf('mock')
    expect(r.error).toBeUndefined()
    expect(r.tools.map((t) => t.name)).toContain('echo')
    await svc.close()
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('createMcpTools', () => {
  it('生成 mcp_list_tools / mcp_call 工具', () => {
    const svc = new McpService(join(tmpdir(), 'shanhai-mcp-nonexistent-2'))
    const tools = createMcpTools(svc)
    expect(tools.map((t) => t.name).sort()).toEqual(['mcp_call', 'mcp_list_tools'].sort())
  })
})
