import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { StdioMcpClient, type McpServerConfig, type McpTool } from './client'

/** ~/.shanhai/mcp.json 的顶层结构（山海自有格式，不复用 Taco 的 ~/.taco/mcp.json） */
export interface McpConfigFile {
  servers?: Record<string, McpServerConfig>
}

export interface ServerSummary {
  id: string
  command: string
  args: string[]
}

export interface ServerToolsResult {
  serverId: string
  tools: McpTool[]
  error?: string
}

/**
 * MCP 服务（能力缝 Provider）：加载 ~/.shanhai/mcp.json 配置、按需懒连接各服务器、
 * 缓存连接、统一异常降级（连接失败/调用失败都返回错误信息，不向上抛崩溃）。
 */
export class McpService {
  private config: McpConfigFile | null = null
  private readonly clients = new Map<string, StdioMcpClient>()

  constructor(private readonly configPath: string = join(homedir(), '.shanhai', 'mcp.json')) {}

  /** 列出所有已配置的服务器（id + command + args） */
  async listServers(): Promise<ServerSummary[]> {
    const cfg = await this.loadConfig()
    return Object.entries(cfg.servers ?? {}).map(([id, s]) => ({
      id,
      command: s.command,
      args: s.args ?? [],
    }))
  }

  /** 列出某个服务器的工具（连接失败降级为 error 字段） */
  async listToolsOf(serverId: string): Promise<ServerToolsResult> {
    try {
      const client = await this.getClient(serverId)
      const tools = await client.listTools()
      return { serverId, tools }
    } catch (err) {
      return { serverId, tools: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 列出所有服务器的工具（逐台降级） */
  async listAllTools(): Promise<ServerToolsResult[]> {
    const servers = await this.listServers()
    const out: ServerToolsResult[] = []
    for (const s of servers) out.push(await this.listToolsOf(s.id))
    return out
  }

  /** 调用某服务器的工具（失败抛错，由工具层 catch 转为结果） */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.getClient(serverId)
    return client.callTool(toolName, args)
  }

  /** 关闭所有连接（退出时清理子进程） */
  async close(): Promise<void> {
    for (const [, client] of this.clients) client.close()
    this.clients.clear()
  }

  private async loadConfig(): Promise<McpConfigFile> {
    if (this.config) return this.config
    try {
      const raw = await fs.readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw) as McpConfigFile
      this.config = { servers: parsed.servers ?? {} }
    } catch {
      this.config = { servers: {} }
    }
    return this.config
  }

  private async getClient(serverId: string): Promise<StdioMcpClient> {
    const cfg = await this.loadConfig()
    const serverCfg = cfg.servers?.[serverId]
    if (!serverCfg) throw new Error(`MCP 服务器不存在: ${serverId}`)
    const cached = this.clients.get(serverId)
    if (cached) return cached
    const client = new StdioMcpClient(serverCfg)
    await client.start()
    this.clients.set(serverId, client)
    return client
  }
}
