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
  /** 所属轮次序号（会话内 user 消息序号，从 1 开始）；用于把「多专家协作」卡片插到对应那一轮消息之后 */
  turnSeq?: number
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
  /** 专家流式增量回调（并行调度时多个专家输出会交错，UI 侧按 stepId 归集） */
  onDelta?: (text: string) => void
  /** 专家流式思考增量回调 */
  onReasoning?: (text: string) => void
  /**
   * 汇总器：多步骤（>1）全部执行完后，把各步骤结果汇总成「针对用户任务的最终回答」。
   * 提供时最终正文 = 汇总结果（onDelta 回调接收汇总流式增量）；不提供时最终正文 = 各步骤结果拼接（现状）。
   */
  summarize?: (task: string, steps: SummarizedStep[], onDelta: (text: string) => void) => Promise<string>
}

/** 汇总器入参：单个专家步骤的产出（专家名 + 步骤标题 + 步骤结果） */
export interface SummarizedStep {
  expert: string
  title: string
  result: string
}

/**
 * 多专家编排：按依赖图调度（无依赖并行、有依赖串行）。
 *
 * 拓扑调度：每轮找出依赖已满足的步骤并行执行，直到全部完成。
 * 断点续跑：resume 从已持久化的 plan + 已完成步骤结果继续，跳过已完成步骤、只跑未完成步骤。
 */
export class Orchestrator {
  constructor(
    private readonly triage: Triage,
    private readonly agents: Map<string, AgentLoop>,
    private readonly options: OrchestratorOptions,
  ) {}

  async run(task: string): Promise<RunResult> {
    const plan = await this.triage.route(task)
    return this.runFromPlan(task, plan, new Map(), new Set())
  }

  /**
   * 断点续跑：从已持久化的拆解计划 + 已完成步骤结果继续，跳过已完成步骤、只跑未完成步骤。
   * 运行时层从会话事件日志回放 plan（orchestrator/plan）+ 已完成步骤结果（orchestrator/step completed）后传入。
   */
  async resume(task: string, plan: TaskPlan, results: Map<string, string>, completed: Set<string>): Promise<RunResult> {
    return this.runFromPlan(task, plan, results, completed)
  }

  private async runFromPlan(
    task: string,
    plan: TaskPlan,
    results: Map<string, string>,
    completed: Set<string>,
  ): Promise<RunResult> {
    const pending = plan.steps.filter((s) => !completed.has(s.id))
    const expertName = (id: string): string => this.options.expertNames?.get(id) ?? id
    const emit = (step: TaskStep, status: StepTrace['status'], extra?: Partial<StepTrace>): void => {
      this.options.onStep?.({ sessionId: this.options.sessionId, stepId: step.id, expertId: step.expertId, expertName: expertName(step.expertId), title: step.title, status, ...extra })
    }

    while (pending.length > 0) {
      const ready = pending.filter((s) => s.deps.every((d) => completed.has(d)))
      if (ready.length === 0) {
        // 有剩余步骤但都未就绪 → 环形依赖，兜底按顺序串行执行剩余步骤，避免卡死
        for (const step of pending) {
          results.set(step.id, await this.runStep(step, results, completed, emit))
        }
        pending.length = 0
        break
      }

      // 从 pending 一次性移除所有就绪步骤，避免并行完成时序竞争导致误判
      for (const step of ready) {
        const idx = pending.indexOf(step)
        if (idx >= 0) pending.splice(idx, 1)
      }

      // 并行调度：无依赖的就绪步骤并发执行（有依赖步骤因 deps 未满足，天然留在下一轮串行）
      await Promise.all(
        ready.map(async (step) => {
          results.set(step.id, await this.runStep(step, results, completed, emit))
        }),
      )
    }

    const stepOutputs: SummarizedStep[] = plan.steps
      .map((s) => ({ expert: expertName(s.expertId), title: s.title, result: results.get(s.id) ?? '' }))
      .filter((o) => o.result.trim() !== '')

    // 多步骤且提供汇总器：正文 = 汇总后的最终回答（专家过程仅保留在轨迹回调，不进正文）；
    // 否则（单步 / 未提供汇总器 / 汇总失败兜底）正文 = 各步骤结果拼接。
    let text: string
    if (this.options.summarize && stepOutputs.length > 1) {
      text = await this.options.summarize(task, stepOutputs, (t) => this.options.onDelta?.(t))
      if (!text.trim()) {
        text = stepOutputs.map((o) => `【${o.expert}】${o.title}\n${o.result}`).join('\n\n')
      }
    } else {
      text = stepOutputs.map((o) => `【${o.expert}】${o.title}\n${o.result}`).join('\n\n')
    }
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
        // 专家执行阶段的流式正文不进最终正文（正文只在汇总阶段生成，见 run() 的 summarize 兜底）
        onReasoning: this.options.onReasoning,
      })
      completed.add(step.id)
      emit(step, 'completed', { result })
      return result
    } catch (err) {
      // 用户点「停止」：__stopped__ 不当作步骤失败吞掉，重新抛出让 Orchestrator.run 整体中断（传播到运行时返回「已中断」）
      // 重试耗尽（网络/余额不足等基础设施故障）：同样重新抛出，中断整条编排并弹窗，而不是降级为「步骤失败」继续跑（继续跑也是徒劳）
      if (err instanceof Error && (err.message === '__stopped__' || err.message.startsWith('__retry_exhausted__'))) throw err
      const error = err instanceof Error ? err.message : String(err)
      emit(step, 'failed', { error })
      // 单步失败不中断整条链：记录错误作为该步结果，让后续依赖步骤仍能继续
      completed.add(step.id)
      return `（步骤失败：${error}）`
    }
  }
}
