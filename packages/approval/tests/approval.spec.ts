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

  it('会话级审批策略：各会话独立，从事件日志回放（安全模式会话隔离）', async () => {
    const sessionA = new Session()
    const sessionB = new Session()
    const service = new ApprovalService(async () => 'allowed-once')

    // 会话 A 设为 never（append approval/policy 事件）
    sessionA.append('approval/policy', { policy: 'never' })

    // requiresApproval：A 用 never，B 用默认 ask
    expect(service.requiresApproval(tool({ riskLevel: 'irreversible' }), sessionA)).toBe(false)
    expect(service.requiresApproval(tool({ riskLevel: 'irreversible' }), sessionB)).toBe(true)

    // request：A 拒绝，B 放行
    const outA = await service.request(sessionA, { id: 'a', toolName: 't', args: {}, riskLevel: 'irreversible' })
    const outB = await service.request(sessionB, { id: 'b', toolName: 't', args: {}, riskLevel: 'irreversible' })
    expect(outA).toBe('rejected')
    expect(outB).toBe('allowed-once')

    // 会话 B 切到 never 后，A 仍保持自己的策略
    sessionB.append('approval/policy', { policy: 'never' })
    expect(service.requiresApproval(tool({ riskLevel: 'irreversible' }), sessionB)).toBe(false)
    expect(service.requiresApproval(tool({ riskLevel: 'irreversible' }), sessionA)).toBe(false)
  })

  it('workdir 策略：工作目录内免审批，访问目录外才审批', () => {
    const service = new ApprovalService(undefined, 'workdir')
    // 工作目录内（outsideWorkdir=false）→ 免审批，即使 irreversible / approvalRequired
    expect(service.requiresApproval(tool({ riskLevel: 'irreversible' }), undefined, false)).toBe(false)
    expect(service.requiresApproval(tool({ riskLevel: 'reversible', approvalRequired: true }), undefined, false)).toBe(false)
    // 访问工作目录外（outsideWorkdir=true）→ 走原有审批逻辑
    expect(service.requiresApproval(tool({ riskLevel: 'reversible', approvalRequired: true }), undefined, true)).toBe(true)
    expect(service.requiresApproval(tool({ riskLevel: 'readonly' }), undefined, true)).toBe(false)
    // 未提供范围（outsideWorkdir=undefined，如非文件工具）→ 走原有逻辑
    expect(service.requiresApproval(tool({ riskLevel: 'irreversible' }), undefined, undefined)).toBe(true)
  })
})
