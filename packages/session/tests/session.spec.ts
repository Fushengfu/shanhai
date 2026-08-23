import { describe, it, expect } from 'vitest'
import { Session, effectiveApprovalPolicy, effectiveModelId } from '../src/session'

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

  it('effectiveModelId 回放最近一条模型选择', () => {
    const events = [
      { type: 'model/select', data: { modelId: 'deepseek-v4-flash' }, timestamp: 1 },
      { type: 'model/select', data: { modelId: 'kimi-k2' }, timestamp: 2 },
    ] as const
    expect(effectiveModelId(events as never)).toBe('kimi-k2')
  })

  it('无模型选择记录时返回 undefined', () => {
    expect(effectiveModelId([])).toBeUndefined()
  })

  it('removeLast 移除指定类型的最后一条事件', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('retry/snapshot', { messages: [], step: 2, maxSteps: 10, atLimit: false, reason: '网络超时' })
    session.append('user/message', { content: 'hi' })
    // 移除最后一条 retry/snapshot
    expect(session.removeLast('retry/snapshot')).toBe(true)
    expect(session.list().map((e) => e.type)).toEqual(['turn/start', 'user/message'])
    // 再移除一次返回 false
    expect(session.removeLast('retry/snapshot')).toBe(false)
  })
})
