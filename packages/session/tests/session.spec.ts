import { describe, it, expect } from 'vitest'
import { Session, effectiveApprovalPolicy } from '../src/session'

describe('Session 类型化事件日志', () => {
  it('append 记录事件，list 按序返回', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', { content: 'hi' })
    session.append('assistant/message', { content: 'hello' })
    const events = session.list()
    expect(events.map((e) => e.type)).toEqual(['turn/start', 'user/message', 'assistant/message'])
  })

  it('effectiveApprovalPolicy 回放最近一条策略', () => {
    const events = [
      { type: 'approval/policy', data: { policy: 'never' }, timestamp: 1 },
      { type: 'approval/policy', data: { policy: 'ask' }, timestamp: 2 },
    ] as const
    expect(effectiveApprovalPolicy(events as never)).toBe('ask')
  })

  it('无策略时返回 undefined', () => {
    expect(effectiveApprovalPolicy([])).toBeUndefined()
  })
})
