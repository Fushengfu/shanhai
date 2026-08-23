import type { Skill, SkillAction } from '@shanhai/skills'
import type { ToolContract } from '@shanhai/tools'
import type { TerminalService } from './terminal'
import { createTerminalTools } from './tools'

/**
 * 把「持久终端会话」封装成可执行技能（skill），而非直接暴露 4 个独立工具。
 *
 * 对齐「一切皆插件」理念：AI 先 skill_list 发现、skill_read 读手册拿到脚本清单，
 * 再通过统一入口 skill_run('terminal', action, params) 执行。底层 TerminalService 不变。
 *
 * 终端定位为「agent 的受控工作台」：创建终端后，终端内的连续命令信任 agent 执行（run 免审批），
 * 区别于 run_command 的单条命令独立进程。
 */
export function createTerminalSkill(service: TerminalService): Skill {
  const actions: SkillAction[] = createTerminalTools(service).map((tool) => toSkillAction(tool))
  return {
    id: 'terminal',
    name: '终端',
    description: '持久终端会话（创建/执行命令/列表/关闭），命令间状态保持，用于多步命令执行与长任务',
    source: 'builtin',
    instructions: [
      '当需要连续执行多步命令、跑长任务、或需要命令之间保持状态（cd 目录切换、export 环境变量、后台进程）时使用。',
      '',
      '执行步骤：',
      '1. skill_run(\'terminal\', \'create\', { name: "用途" }) 创建持久终端，拿到 terminalId。',
      '2. skill_run(\'terminal\', \'run\', { terminalId, command }) 执行命令，输出会返回。',
      '3. 多终端时用 skill_run(\'terminal\', \'list\', {}) 确认各终端用途。',
      '4. 不再需要时 skill_run(\'terminal\', \'close\', { terminalId }) 释放资源。',
      '',
      '原则：',
      '- 命令间状态保持：cd 后后续命令沿用新目录，export 的变量跨命令有效。',
      '- 长任务（编译/训练/开发服务器）：run 会等待命令完成或超时返回（timedOut=true 表示仍在后台运行）。',
      '- 单条独立命令（读文件/搜索/一次性操作）仍优先用 run_command，不要为单条命令开终端。',
      '- 所有操作免审批，直接执行。',
    ].join('\n'),
    actions,
  }
}

/** 把工具契约转换为技能脚本：name 去掉 terminal_ 前缀作为 action 名，参数说明从 inputSchema 提取 */
function toSkillAction(tool: ToolContract): SkillAction {
  const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {}
  const params: Record<string, string> = {}
  for (const [key, meta] of Object.entries(props)) {
    params[key] = meta?.description ?? ''
  }
  const required = (tool.inputSchema as { required?: string[] }).required ?? []
  return {
    name: tool.name.replace(/^terminal_/, ''),
    description: tool.description,
    params,
    required: Array.isArray(required) ? required : [],
    riskLevel: tool.riskLevel,
    approvalRequired: tool.approvalRequired,
    execute: tool.execute,
  }
}
