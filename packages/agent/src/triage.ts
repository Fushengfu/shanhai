import type { Model } from '@shanhai/llm'
import type { TaskPlan, TaskStep } from './orchestrator'
import type { RoleDefinition } from './contract'

/** 从模型回复里提取 JSON 对象（容错：剥离 markdown 代码块围栏 + 截取首尾大括号） */
function extractJsonObject(text: string): unknown {
  // 去掉 ```json ... ``` 或 ``` ... ``` 围栏
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1]!.trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON 对象')
  return JSON.parse(s.slice(start, end + 1))
}

/** 兜底计划：拆解失败时退化为单步（general 专家直接处理整条消息） */
function fallbackPlan(message: string): TaskPlan {
  return { steps: [{ id: 's1', expertId: 'general', title: message, deps: [] }] }
}

/**
 * 模型驱动的 Triage 路由：用模型把用户任务拆解成「步骤 → 专家」的依赖图。
 *
 * 输出契约（JSON）：{"steps":[{"id":"s1","expertId":"code","title":"...","deps":[]}, ...]}
 * 任何解析失败都退化为单步 general 计划，绝不因拆解失败阻断主流程。
 */
export class ModelTriage {
  constructor(
    private readonly model: Model,
    private roles: RoleDefinition[] = [],
  ) {}

  /** 更新可用专家列表（新增/删除专家后调用，让拆解能指派到最新角色） */
  setRoles(roles: RoleDefinition[]): void {
    this.roles = roles
  }

  async route(message: string): Promise<TaskPlan> {
    const roleLines = this.roles.map((r) => `- ${r.id}: ${r.name}（${r.description}）`).join('\n')
    const systemPrompt = [
      '你是任务规划器（Triage）。把用户任务拆解成可执行的步骤，并为每步指派最合适的专家。',
      '',
      '可用专家：',
      roleLines,
      '',
      '严格按以下 JSON 输出（只输出 JSON，不要任何解释文字）：',
      '{"steps":[{"id":"s1","expertId":"general","title":"步骤描述","deps":[]}]}',
      '',
      '规则：',
      '1. 简单任务（一句话能完成，如问答/闲聊）只输出 1 步，expertId 用 general。',
      '2. 复杂任务（多个环节，如「读代码→改代码→跑测试」）拆成多步，用 deps 声明依赖（无依赖并行、有依赖串行）。',
      '3. id 用 s1、s2…；title 用简短中文概括该步骤要做什么。',
      '4. 涉及代码/文件/命令的步骤指派 code；写作文案指派 writer；数据总结分析指派 analyst；其余用 general。',
    ].join('\n')

    try {
      const res = await this.model.complete(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        [],
      )
      const text = res.text ?? ''
      const parsed = extractJsonObject(text) as { steps?: unknown }
      if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) return fallbackPlan(message)
      const steps = parsed.steps as Array<Partial<TaskStep>>
      const valid = steps
        .filter((s) => typeof s.id === 'string' && typeof s.title === 'string' && s.title!.trim() !== '')
        .map((s): TaskStep => ({
          id: s.id!,
          expertId: typeof s.expertId === 'string' && this.roles.some((r) => r.id === s.expertId) ? s.expertId! : 'general',
          title: s.title!,
          deps: Array.isArray(s.deps) ? (s.deps as string[]).filter((d) => typeof d === 'string') : [],
        }))
      return valid.length > 0 ? { steps: valid } : fallbackPlan(message)
    } catch (err) {
      // 模型/网络/解析失败：退化单步，不阻断主流程
      console.error('[triage] 拆解失败，退化为单步:', err instanceof Error ? err.message : err)
      return fallbackPlan(message)
    }
  }
}
