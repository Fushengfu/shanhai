import type { ToolContract } from '@shanhai/tools'
import type { SkillService } from './skill'

/**
 * skills 插件：把「复合技能」收敛为 skill_list / skill_read / skill_run 三个工具。
 *
 * - skill_list：发现可用技能（id/名称/描述/来源），让 agent 知道有哪些技能可用来完成某类任务。
 * - skill_read：读取指定技能的完整手册（instructions）+ 可执行技能的脚本清单（actions），
 *    agent 拿到后按手册步骤、通过 skill_run 执行对应脚本。
 * - skill_run：可执行技能的统一入口——skillId + action + params 执行一个脚本。
 *    browser-use / computer-use 等「组装起来的固定能力」不再以独立工具暴露给 AI，
 *    而是收敛成技能脚本，AI 先 skill_read 读手册再 skill_run 执行，工具数量保持恒定。
 *
 * 审批粒度：skill_run 通过 resolveRisk 按 action 动态解析风险（browser 免审批、computer 桌面动作需审批），
 * 由 agent 层在审批判断前调用（见 ToolContract.resolveRisk）。
 */
export function createSkillTools(service: SkillService): ToolContract[] {
  return [skillListTool(service), skillReadTool(service), skillRunTool(service)]
}

function skillListTool(service: SkillService): ToolContract {
  return {
    name: 'skill_list',
    description:
      '列出所有可用的复合技能（id/名称/描述/来源）。当需要了解有哪些技能可用来完成某类任务、' +
      '或不确定该用什么流程时调用，返回技能清单后再用 skill_read 读取具体手册。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    riskLevel: 'readonly',
    guide: {
      usage: [
        '当需要了解有哪些技能可用来完成某类任务、或不确定该用什么流程时调用，返回技能清单后再用 skill_read 读取具体手册。',
      ],
      cautions: [
        '不要在任务中频繁调用；一次列出后按需 skill_read 即可。',
      ],
    },
    execute: async () => {
      const skills = await service.list()
      return {
        skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description, source: s.source })),
      }
    },
  }
}

function skillReadTool(service: SkillService): ToolContract {
  return {
    name: 'skill_read',
    description:
      '读取指定技能的完整操作手册（instructions）。可执行技能（如 browser-use / computer-use）还会返回脚本清单（actions：每个脚本的 name + 参数说明），拿到后按手册步骤、用 skill_run 执行对应脚本。id 从 skill_list 返回的清单里取。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '技能 id（skill_list 返回的 id）' },
      },
      required: ['id'],
    },
    riskLevel: 'readonly',
    guide: {
      usage: [
        '读取指定技能的完整操作手册（instructions）与可执行脚本清单（actions），拿到后按手册步骤、用 skill_run 执行对应脚本。',
        'id 从 skill_list 返回的清单里取。',
      ],
      cautions: [
        '未读取技能手册前，禁止 skill_run 执行该技能脚本。',
      ],
    },
    execute: async (args) => {
      const id = String(args.id ?? '').trim()
      if (!id) return { ok: false, error: '缺少 id' }
      const skill = await service.read(id)
      if (!skill) return { ok: false, error: `技能不存在: ${id}` }
      return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        // 可执行技能：返回脚本清单（不含 execute 函数），让 AI 知道有哪些脚本及各自参数
        actions: skill.actions?.map((a) => ({
          name: a.name,
          description: a.description,
          params: a.params,
          required: a.required ?? [],
        })),
      }
    },
  }
}

function skillRunTool(service: SkillService): ToolContract {
  return {
    name: 'skill_run',
    description:
      '执行指定技能的一个脚本（action）。这是可执行技能（browser-use / computer-use 等）的统一执行入口。' +
      '使用前必须先 skill_read 读取该技能的手册拿到脚本清单（actions）与参数结构，再按清单填 skillId（技能 id）、' +
      'action（脚本名）、params（脚本参数，参数结构见 skill_read 返回的 actions 清单）。' +
      '注意：skill_run 本身不列出脚本，不清楚有哪些 action 时先 skill_read，不要猜。',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: '技能 id（skill_list / skill_read 返回的 id，如 browser-use、computer-use）' },
        action: { type: 'string', description: '脚本名（skill_read 返回的 actions 清单里的 name，如 navigate、click、screenshot）' },
        params: { type: 'object', description: '脚本参数（参数结构见 skill_read 返回的 actions 清单）' },
      },
      required: ['skillId', 'action'],
    },
    riskLevel: 'reversible',
    guide: {
      usage: [
        '执行指定技能的一个脚本（action），是可执行技能（browser-use/computer-use 等）的统一执行入口。',
        '使用前必须先 skill_read 读取该技能的手册拿到脚本清单（actions）与参数结构，再按清单填 skillId、action、params。',
      ],
      cautions: [
        'skill_run 本身不列出脚本，不清楚有哪些 action 时先 skill_read，不要猜。',
      ],
    },
    /** 动态风险：审批粒度下沉到 action 级（browser-use 免审批、computer-use 的桌面动作需审批） */
    resolveRisk: async (args) => {
      const act = await service.findAction(String(args.skillId ?? ''), String(args.action ?? ''))
      return { riskLevel: act?.riskLevel ?? 'reversible', approvalRequired: act?.approvalRequired ?? false }
    },
    execute: async (args) => {
      const skillId = String(args.skillId ?? '').trim()
      const action = String(args.action ?? '').trim()
      if (!skillId || !action) return { ok: false, error: '缺少 skillId 或 action 参数' }
      const act = await service.findAction(skillId, action)
      if (!act) {
        return { ok: false, error: `技能 ${skillId} 不存在脚本: ${action}（先用 skill_read 查看该技能的可用脚本清单）` }
      }
      const params =
        args.params && typeof args.params === 'object' ? (args.params as Record<string, unknown>) : {}
      return act.execute(params)
    },
  }
}
