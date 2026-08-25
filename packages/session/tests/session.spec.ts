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

  it('增量持久化游标：restore 后视为已持久化，追加新事件可切片获取', () => {
    const session = new Session()
    session.restore([{ type: 'user/message', data: { content: 'a' }, timestamp: 1 }])
    expect(session.size).toBe(1)
    expect(session.persistedCount).toBe(1)
    expect(session.requireRewrite()).toBe(false)

    session.append('assistant/message', { content: 'b' })
    session.append('assistant/delta', { text: 'c' }) // delta 会在持久化层被过滤
    // 从已持久化游标切片：拿到新增的 2 条
    const delta = session.slice(session.persistedCount)
    expect(delta.map((e) => e.type)).toEqual(['assistant/message', 'assistant/delta'])
  })

  it('truncate 命中已持久化区段时标记需要重写', () => {
    const session = new Session()
    session.restore([
      { type: 'user/message', data: { content: 'a' }, timestamp: 1 },
      { type: 'assistant/message', data: { content: 'b' }, timestamp: 2 },
    ])
    expect(session.persistedCount).toBe(2)

    // 截断到 1 条（裁掉了已持久化的第 2 条）
    session.truncate(1)
    expect(session.requireRewrite()).toBe(true)
    expect(session.persistedCount).toBe(1)

    // markPersisted 清除重写标记并推进游标
    session.markPersisted()
    expect(session.requireRewrite()).toBe(false)
    expect(session.persistedCount).toBe(1)
  })

  it('removeLast 命中已持久化区段时标记需要重写', () => {
    const session = new Session()
    session.restore([
      { type: 'turn/start', data: { turn: 1 }, timestamp: 1 },
      { type: 'retry/snapshot', data: { messages: [], step: 2, maxSteps: 10, atLimit: false }, timestamp: 2 },
      { type: 'user/message', data: { content: 'hi' }, timestamp: 3 },
    ])
    expect(session.persistedCount).toBe(3)

    // 删除已持久化区段的 retry/snapshot（第 2 条，位于已持久化部分）
    expect(session.removeLast('retry/snapshot')).toBe(true)
    expect(session.requireRewrite()).toBe(true)
    expect(session.persistedCount).toBe(2)
  })
})
