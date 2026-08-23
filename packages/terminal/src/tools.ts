import type { ToolContract } from '@shanhai/tools'
import type { TerminalService } from './terminal'

/**
 * terminal 插件：把「持久终端会话」收敛为一组统一工具，形成
 * 「创建 → 执行 → 列表 → 关闭」的完整闭环。
 *
 * 工具清单（4 个）：
 * - terminal_create：创建持久终端会话，返回 terminalId
 * - terminal_run：在终端执行命令，状态保持（cd/export/后台进程）
 * - terminal_list：列出当前终端
 * - terminal_close：关闭终端释放资源
 *
 * 定位为「agent 的受控工作台」：创建终端后，终端内的连续命令信任 agent 执行（run 免审批），
 * 区别于 run_command 的「单条命令独立进程、每次审批」。
 */
export function createTerminalTools(service: TerminalService): ToolContract[] {
  return [createTool(service), runTool(service), listTool(service), closeTool(service)]
}

const terminalIdProp = { terminalId: { type: 'string', description: '终端短标识（create 返回的 terminalId，默认 default）' } }

/** terminal_create：创建持久终端会话，返回 terminalId */
function createTool(service: TerminalService): ToolContract {
  return {
    name: 'terminal_create',
    description:
      '创建持久终端会话，返回 terminalId。需要连续执行多步命令、跑长任务、或保持命令间状态（cd/export/后台进程）时使用。可选传入 name 标注用途（如「构建」「开发服务器」），方便后续区分多终端用途。',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: { type: 'string', description: '自定义终端短标识（可选，省略则自动生成 default/term-2…）' },
        name: { type: 'string', description: '终端用途描述（可选，如「构建」「开发服务器」，供 AI 区分多终端用途）' },
      },
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const terminalId = await service.create(
        typeof args.terminalId === 'string' && args.terminalId ? args.terminalId : undefined,
        typeof args.name === 'string' && args.name ? args.name : undefined,
      )
      return { ok: true, terminalId }
    },
  }
}

/** terminal_run：在终端执行命令，状态保持 */
function runTool(service: TerminalService): ToolContract {
  return {
    name: 'terminal_run',
    description:
      '在指定终端执行命令并返回输出。命令间状态保持（cd/export/后台进程），适合连续多步操作与长任务；单条独立命令仍优先用 run_command。timeoutMs 默认 120000 毫秒；命令仍在后台运行时返回 timedOut=true 与已捕获输出，可继续观察。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeoutMs: { type: 'number', description: '超时毫秒（默认 120000）' },
        ...terminalIdProp,
      },
      required: ['command'],
    },
    riskLevel: 'reversible',
    execute: async (args) => {
      const command = String(args.command ?? '')
      if (!command) throw new Error('terminal_run 需要 command 参数')
      const result = await service.run(
        typeof args.terminalId === 'string' ? args.terminalId : undefined,
        command,
        typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      )
      return { ok: true, ...result }
    },
  }
}

/** terminal_list：列出当前终端 */
function listTool(service: TerminalService): ToolContract {
  return {
    name: 'terminal_list',
    description: '列出当前活跃的终端会话（terminalId / 用途 / 当前目录）。多终端操作前先调用它确认目标终端。',
    inputSchema: { type: 'object', properties: {} },
    riskLevel: 'readonly',
    execute: async () => {
      const terminals = await service.list()
      return { terminals }
    },
  }
}

/** terminal_close：关闭终端 */
function closeTool(service: TerminalService): ToolContract {
  return {
    name: 'terminal_close',
    description: '关闭指定终端会话，释放资源（含其中启动的后台进程）。不再需要该终端时调用。',
    inputSchema: { type: 'object', properties: { ...terminalIdProp } },
    riskLevel: 'reversible',
    execute: async (args) => {
      await service.close(typeof args.terminalId === 'string' ? args.terminalId : undefined)
      return { ok: true }
    },
  }
}
