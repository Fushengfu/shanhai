import { describe, it, expect } from 'vitest'
import { MemoryStore } from '../src/store'
import { layerOf } from '../src/types'

describe('分层记忆', () => {
  it('配置型写前归档 + 可回滚', () => {
    const store = new MemoryStore()
    store.save('user_preference', 'theme', 'light')
    store.save('user_preference', 'theme', 'dark')
    expect(store.list('user_preference')).toHaveLength(1)
    expect(store.list('user_preference')[0]?.value).toBe('dark')
    expect(store.history('user_preference', 'theme')).toHaveLength(1)
    expect(store.rollback('user_preference', 'theme')).toBe(true)
    expect(store.list('user_preference')[0]?.value).toBe('light')
  })

  it('经验型覆盖累积（不归档）', () => {
    const store = new MemoryStore()
    store.save('task_experience', 'task-1', 'ok')
    store.save('task_experience', 'task-2', 'ok')
    expect(store.list('task_experience')).toHaveLength(2)
    expect(store.history('task_experience', 'task-1')).toHaveLength(0)
  })

  it('recall 关键词匹配', () => {
    const store = new MemoryStore()
    store.save('task_experience', 'fix-bug', 'fixed login bug')
    store.save('task_experience', 'write-doc', 'wrote api doc')
    expect(store.recall('task_experience', 'login').map((e) => e.key)).toEqual(['fix-bug'])
  })

  it('layerOf 分层判断', () => {
    expect(layerOf('session')).toBe('short')
    expect(layerOf('task_experience')).toBe('experience')
    expect(layerOf('user_preference')).toBe('config')
  })
})
