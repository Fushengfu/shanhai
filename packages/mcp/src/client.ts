import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * MCP（Model Context Protocol）stdio 客户端：手写 JSON-RPC 2.0 over stdio，
 * 不引入 @modelcontextprotocol/sdk，避免新增重依赖。
 *
 * 协议流程：initialize 握手 → tools/list 发现工具 → tools/call 调用工具。
 * 请求带自增 id，响应按 id 匹配 resolve；通知消息（无 id）忽略。stderr 忽略（日志噪声）。
 */

/** MCP 服务器提供的工具（tools/list 返回项） */
export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** 单个 MCP 服务器的启动配置（对齐 stdio 传输：command + args + env） */
export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private buffer = ''
  private closed = false

  constructor(private readonly config: McpServerConfig) {}

  /** 启动子进程并完成 initialize 握手 */
  async start(timeoutMs = 15000): Promise<void> {
    if (this.child) return
    this.closed = false
    const child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    child.stderr.on('data', () => {
      // stderr 属日志噪声，忽略（避免缓冲区撑爆）
    })
    child.on('error', (err) => this.failAll(err))
    child.on('exit', (code) => {
      this.closed = true
      if (code !== 0 && this.pending.size > 0) {
        this.failAll(new Error(`MCP 服务器进程退出（code=${code}）`))
      }
    })
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'shanhai', version: '0.1.0' },
    }, timeoutMs)
    this.notify('notifications/initialized', {})
  }

  /** 发现工具（tools/list） */
  async listTools(): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpTool[] }
    return Array.isArray(result.tools) ? result.tools : []
  }

  /** 调用工具（tools/call），返回工具执行结果 */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args })
  }

  /** 关闭并销毁子进程，拒绝所有待处理请求 */
  close(): void {
    this.closed = true
    this.failAll(new Error('MCP 客户端已关闭'))
    if (this.child && !this.child.killed) this.child.kill()
    this.child = null
  }

  private request(method: string, params?: unknown, timeoutMs = 30000): Promise<unknown> {
    if (!this.child || this.closed) return Promise.reject(new Error('MCP 客户端未连接'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  private notify(method: string, params?: unknown): void {
    if (!this.child || this.closed) return
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  /** 逐行解析 stdout，按 id 匹配响应（响应可能跨 chunk，用 buffer 累积） */
  private onData(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg: JsonRpcResponse
      try {
        msg = JSON.parse(line) as JsonRpcResponse
      } catch {
        continue
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`MCP 错误: ${msg.error.message ?? JSON.stringify(msg.error)}`))
        else p.resolve(msg.result)
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }
}
