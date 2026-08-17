import type { AgentLoop } from './agent'

export interface TaskStep {
  id: string
  expertId: string
  title: string
  deps: string[]
}

export interface TaskPlan {
  steps: TaskStep[]
}

/** Triage 路由：主控用旗舰模型拆解意图，按依赖调度专家 */
export interface Triage {
  route(message: string): Promise<TaskPlan>
}

export interface RunResult {
  sessionId: string
  text: string
  status: 'completed' | 'interrupted' | 'failed'
}

/** Handoff：专家间交接控制权（第一个停、第二个带上下文接管） */
export interface Handoff {
  transfer(targetExpertId: string, context: unknown): Promise<void>
}

export interface OrchestratorOptions {
  sessionId: string
}

/**
 * 多专家编排：按依赖图调度（无依赖并行、有依赖串行）。
 *
 * 拓扑调度：每轮找出依赖已满足的步骤并行执行，直到全部完成。
 */
export class Orchestrator {
  constructor(
    private readonly triage: Triage,
    private readonly agents: Map<string, AgentLoop>,
    private readonly options: OrchestratorOptions,
  ) {}

  async run(task: string): Promise<RunResult> {
    const plan = await this.triage.route(task)
    const results = new Map<string, string>()
    const completed = new Set<string>()
    const pending = [...plan.steps]

    while (pending.length > 0) {
      const ready = pending.filter((s) => s.deps.every((d) => completed.has(d)))
      if (ready.length === 0) throw new Error('circular dependency in task plan')

      const outputs = await Promise.all(
        ready.map(async (step) => {
          const agent = this.agents.get(step.expertId)
          if (!agent) throw new Error(`expert "${step.expertId}" not found`)
          const result = await agent.run(step.title)
          return { step, result }
        }),
      )
      for (const { step, result } of outputs) {
        results.set(step.id, result)
        completed.add(step.id)
      }
      for (const step of ready) {
        const idx = pending.indexOf(step)
        if (idx >= 0) pending.splice(idx, 1)
      }
    }

    const text = plan.steps.map((s) => `${s.title}: ${results.get(s.id) ?? ''}`).join('\n')
    return { sessionId: this.options.sessionId, text, status: 'completed' }
  }

  /** 断点续跑：从会话事件日志回放，继续未完成的步骤 */
  async resume(sessionId: string): Promise<RunResult> {
    // 完整回放由 runtime 层基于 Session 事件日志实现，这里返回占位结果
    void sessionId
    return { sessionId: this.options.sessionId, text: '', status: 'interrupted' }
  }
}
