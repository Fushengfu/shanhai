import type { ToolContract } from '@shanhai/tools'
import type { ApprovalOutcome, ApprovalPolicy, Session } from '@shanhai/session'

export interface ApprovalRequest {
  id: string
  toolName: string
  args: Record<string, unknown>
  riskLevel: string
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
    private readonly policy: ApprovalPolicy = 'ask',
  ) {}

  requiresApproval(tool: ToolContract): boolean {
    if (this.policy === 'never') return false
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
    let outcome: ApprovalOutcome
    if (this.policy === 'never') {
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
