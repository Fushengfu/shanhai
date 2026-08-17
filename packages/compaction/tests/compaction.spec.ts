import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@shanhai/llm'
import { TokenBudgetCompactor, estimateTokens } from '../src/compaction'

const msg = (content: string): ChatMessage => ({ role: 'user', content })

describe('Compactor', () => {
  it('预算内不压缩', async () => {
    const compactor = new TokenBudgetCompactor(async () => 'summary')
    const messages = [msg('hi')]
    expect(await compactor.compact(messages, 1000)).toEqual(messages)
  })

  it('超预算压成摘要 + 保留最近', async () => {
    const compactor = new TokenBudgetCompactor(async () => 'compressed', 2)
    const messages = [msg('a'), msg('b'), msg('c'), msg('d')]
    const result = await compactor.compact(messages, 1)
    expect(result[0]?.role).toBe('system')
    expect((result[0]?.content as string).includes('compressed')).toBe(true)
    expect(result.slice(1)).toEqual([msg('c'), msg('d')])
  })

  it('estimateTokens 粗略估算', () => {
    expect(estimateTokens([msg('abcd')])).toBe(1)
    expect(estimateTokens([msg('abcdefgh')])).toBe(2)
  })
})
