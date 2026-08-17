import { describe, it, expect } from 'vitest'
import type { ToolContract } from '@shanhai/tools'
import { Session } from '@shanhai/session'
import { ApprovalService } from '../src/approval'

function tool(overrides: Partial<ToolContract>): ToolContract {
  return {
    name: 't',
    description: 'd',
    inputSchema: {},
    riskLevel: 'readonly',
    execute: () => undefined,
    ...overrides,
  }
}

describe('ApprovalService', () => {
  it('requiresApproval：never 不审批，readonly 不审批，irreversible 审批', () => {
    const ask = new ApprovalService()
    expect(ask.requiresApproval(tool({ riskLevel: 'readonly' }))).toBe(false)
    expect(ask.requiresApproval(tool({ riskLevel: 'irreversible' }))).toBe(true)
    expect(ask.requiresApproval(tool({ riskLevel: 'readonly', approvalRequired: true }))).toBe(true)

    const never = new ApprovalService(undefined, 'never')
    expect(never.requiresApproval(tool({ riskLevel: 'irreversible' }))).toBe(false)
  })

  it('request 落事件并返回审批结果', async () => {
    const session = new Session()
    const service = new ApprovalService(async () => 'allowed-once')
    const outcome = await service.request(session, {
      id: 'r1',
      toolName: 'write_file',
      args: { path: '/a' },
      riskLevel: 'reversible',
    })
    expect(outcome).toBe('allowed-once')
    const types = session.list().map((e) => e.type)
    expect(types).toEqual(['approval/request', 'approval/outcome'])
  })

  it('无 approver 时 unavailable', async () => {
    const session = new Session()
    const service = new ApprovalService()
    const outcome = await service.request(session, {
      id: 'r1',
      toolName: 't',
      args: {},
      riskLevel: 'reversible',
    })
    expect(outcome).toBe('unavailable')
  })
})
