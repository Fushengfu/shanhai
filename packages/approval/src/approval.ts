import type { ToolContract } from '@shanhai/tools'
import { effectiveApprovalPolicy } from '@shanhai/session'
import type { ApprovalOutcome, ApprovalPolicy, Session } from '@shanhai/session'

export interface ApprovalRequest {
  id: string
  toolName: string
  args: Record<string, unknown>
  riskLevel: string
  /** 发起审批的会话 id（并行会话时用于路由展示） */
  sessionId?: string
}

export type Approver = (req: ApprovalRequest) => ApprovalOutcome | Promise<ApprovalOutcome>

/**
 * 审批服务（对齐 dsh-user-approval）。
 *
 * - requiresApproval：never 不审批；工具显式 approvalRequired 或 irreversible/high 风险 → 审批。
 * - request：落 approval/request + approval/outcome 事件（回放即状态）。
 */
export class ApprovalService {
  constructor(
    private readonly approver?: Approver,
    private policy: ApprovalPolicy = 'ask',
  ) {}

  /** 当前审批策略（安全模式） */
  getPolicy(): ApprovalPolicy {
    return this.policy
  }

  /** 运行时切换审批策略：ask=危险操作每次询问，never=从不询问直接执行 */
  setPolicy(policy: ApprovalPolicy): void {
    this.policy = policy
  }

  /**
   * 判断工具是否需要审批。
   * 传入 session 时按「会话级审批策略」判断（从该会话事件日志回放 approval/policy，缺省回退全局默认）；
   * 不传 session 则用全局默认策略。
   */
  requiresApproval(tool: ToolContract, session?: Session): boolean {
    const policy = session ? (effectiveApprovalPolicy(session.list()) ?? this.policy) : this.policy
    if (policy === 'never') return false
    if (tool.approvalRequired === true) return true
    return tool.riskLevel === 'irreversible' || tool.riskLevel === 'high'
  }

  async request(session: Session, req: ApprovalRequest): Promise<ApprovalOutcome> {
    session.append('approval/request', {
      id: req.id,
      toolName: req.toolName,
      args: req.args,
      riskLevel: req.riskLevel,
    })
    // 会话级审批策略：优先从该会话事件日志回放，缺省回退全局默认（支持并行会话各自独立的安全模式）
    const policy = effectiveApprovalPolicy(session.list()) ?? this.policy
    let outcome: ApprovalOutcome
    if (policy === 'never') {
      outcome = 'rejected'
    } else if (!this.approver) {
      outcome = 'unavailable'
    } else {
      outcome = await this.approver(req)
    }
    session.append('approval/outcome', { id: req.id, outcome })
    return outcome
  }
}
