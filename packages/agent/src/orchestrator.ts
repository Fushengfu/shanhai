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

/** Handoff：专家间交接控制权（第一个停、第二个带完整上下文接管） */
export interface Handoff {
  transfer(targetExpertId: string, context: unknown): Promise<void>
}

/** 每步执行轨迹（UI 展示多专家协作过程） */
export interface StepTrace {
  sessionId?: string
  stepId: string
  expertId: string
  expertName: string
  title: string
  status: 'started' | 'completed' | 'failed'
  result?: string
  error?: string
}

export interface OrchestratorOptions {
  sessionId: string
  /** 专家 id → 专家显示名（轨迹回调用） */
  expertNames?: Map<string, string>
  /** 专家 id → 专家专属 systemPrompt（runStep 时注入） */
  expertSystemPrompts?: Map<string, string>
  /** 每步执行轨迹回调 */
  onStep?: (trace: StepTrace) => void
  /** 专家流式增量回调（串行调度时顺序清晰，UI 实时渲染） */
  onDelta?: (text: string) => void
  /** 专家流式思考增量回调 */
  onReasoning?: (text: string) => void
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
    const expertName = (id: string): string => this.options.expertNames?.get(id) ?? id
    const emit = (step: TaskStep, status: StepTrace['status'], extra?: Partial<StepTrace>): void => {
      this.options.onStep?.({ sessionId: this.options.sessionId, stepId: step.id, expertId: step.expertId, expertName: expertName(step.expertId), title: step.title, status, ...extra })
    }

    while (pending.length > 0) {
      const ready = pending.filter((s) => s.deps.every((d) => completed.has(d)))
      if (ready.length === 0) {
        // 有剩余步骤但都未就绪 → 环形依赖，兜底按顺序串行执行剩余步骤，避免卡死
        for (const step of pending) {
          await this.runStep(step, results, completed, emit)
        }
        break
      }

      // 串行调度：保证专家流式输出顺序清晰、事件日志不交错（并行作为后续优化）
      for (const step of ready) {
        const r = await this.runStep(step, results, completed, emit)
        results.set(step.id, r)
        const idx = pending.indexOf(step)
        if (idx >= 0) pending.splice(idx, 1)
      }
    }

    const text = plan.steps
      .map((s) => `【${expertName(s.expertId)}】${s.title}\n${results.get(s.id) ?? ''}`)
      .filter((line) => line.trim() !== '')
      .join('\n\n')
    return { sessionId: this.options.sessionId, text, status: 'completed' }
  }

  private async runStep(
    step: TaskStep,
    results: Map<string, string>,
    completed: Set<string>,
    emit: (step: TaskStep, status: StepTrace['status'], extra?: Partial<StepTrace>) => void,
  ): Promise<string> {
    const agent = this.agents.get(step.expertId)
    if (!agent) throw new Error(`expert "${step.expertId}" not found`)
    emit(step, 'started')
    try {
      // 把已完成的依赖步骤结果作为上下文注入（专家能看到前置结论）
      const context = step.deps.length > 0
        ? `\n\n【前置步骤已完成，结论如下】\n${step.deps.map((d) => `- ${d}: ${results.get(d) ?? ''}`).join('\n')}`
        : ''
      const systemPrompt = this.options.expertSystemPrompts?.get(step.expertId)
      const result = await agent.run(step.title + context, {
        ...(systemPrompt ? { systemPrompt } : {}),
        onDelta: this.options.onDelta,
        onReasoning: this.options.onReasoning,
      })
      completed.add(step.id)
      emit(step, 'completed', { result })
      return result
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      emit(step, 'failed', { error })
      // 单步失败不中断整条链：记录错误作为该步结果，让后续依赖步骤仍能继续
      completed.add(step.id)
      return `（步骤失败：${error}）`
    }
  }

  /** 断点续跑：从会话事件日志回放，继续未完成的步骤（运行时层基于 Session 日志实现，这里返回占位） */
  async resume(sessionId: string): Promise<RunResult> {
    void sessionId
    return { sessionId: this.options.sessionId, text: '', status: 'interrupted' }
  }
}
