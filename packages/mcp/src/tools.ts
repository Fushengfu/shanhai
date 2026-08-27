import type { ToolContract } from '@shanhai/tools'
import type { McpService } from './service'

/**
 * mcp 插件：把 MCP 能力收敛为 mcp_list_tools / mcp_call 两个工具。
 *
 * - mcp_list_tools：列出已配置服务器及其工具（发现外部能力）。
 * - mcp_call：调用某服务器的工具（外部能力可能有副作用，默认需审批）。
 *
 * 连接/调用异常统一降级为返回错误信息，不向上抛崩溃，agent 可据此重试或放弃。
 */
export function createMcpTools(service: McpService): ToolContract[] {
  return [mcpListToolsTool(service), mcpCallTool(service)]
}

function mcpListToolsTool(service: McpService): ToolContract {
  return {
    name: 'mcp_list_tools',
    description:
      '列出已配置的 MCP 服务器及其提供的工具。需要了解有哪些外部能力（经 MCP 协议接入的工具）可用时调用。' +
      '不传 serverId 返回全部服务器；传 serverId 只返回该服务器的工具清单。',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: '可选：只列出指定服务器的工具' },
      },
    },
    riskLevel: 'readonly',
    guide: {
      usage: [
        '需要了解有哪些外部能力（经 MCP 协议接入的工具）可用时调用。',
        '不传 serverId 返回全部服务器；传 serverId 只返回该服务器的工具清单。',
        '调用任何 MCP 工具前必须先调用此工具确认可用工具及参数 schema。',
      ],
      cautions: [
        '禁止跳过 mcp_list_tools 直接 mcp_call。',
      ],
    },
    execute: async (args) => {
      const serverId = args.serverId ? String(args.serverId).trim() : undefined
      if (serverId) {
        const result = await service.listToolsOf(serverId)
        return { serverId, tools: result.tools, error: result.error }
      }
      const servers = await service.listAllTools()
      return {
        servers: servers.map((s) => ({ serverId: s.serverId, tools: s.tools, error: s.error })),
      }
    },
  }
}

function mcpCallTool(service: McpService): ToolContract {
  return {
    name: 'mcp_call',
    description:
      '调用 MCP 服务器提供的工具。serverId 与 toolName 从 mcp_list_tools 返回的清单里取；' +
      'arguments 是传给该工具的参数对象（需匹配该工具的 inputSchema）。外部工具可能有副作用，默认需用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'MCP 服务器 id（mcp_list_tools 返回）' },
        toolName: { type: 'string', description: '要调用的工具名' },
        arguments: { type: 'object', description: '传给工具的参数对象' },
      },
      required: ['serverId', 'toolName'],
    },
    riskLevel: 'irreversible',
    approvalRequired: true,
    guide: {
      usage: [
        '必须在 mcp_list_tools 之后调用，严格按返回的 inputSchema 组装 arguments。',
        'serverId 与 toolName 从 mcp_list_tools 返回的清单里取。',
        'arguments 字段类型必须与 inputSchema 一致，不允许猜字段名。',
      ],
      cautions: [
        '调用失败先检查 schema、参数和值类型，再决定是否重试。',
        'MCP 返回的是外部能力结果，必须结合当前任务目标再做判断，不可机械转述。',
      ],
    },
    execute: async (args) => {
      const serverId = String(args.serverId ?? '').trim()
      const toolName = String(args.toolName ?? '').trim()
      if (!serverId || !toolName) return { ok: false, error: '缺少 serverId 或 toolName' }
      const callArgs = (args.arguments ?? {}) as Record<string, unknown>
      try {
        const result = await service.callTool(serverId, toolName, callArgs)
        return { ok: true, serverId, toolName, result }
      } catch (err) {
        return { ok: false, serverId, toolName, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
