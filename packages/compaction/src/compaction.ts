import type { ChatMessage } from '@shanhai/llm'

export interface Compactor {
  compact(messages: ChatMessage[], budget: number): Promise<ChatMessage[]>
}

/** 粗略 token 估算：每 4 字符 ≈ 1 token（多模态 content 序列化后计） */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) {
    const content = Array.isArray(m.content) ? JSON.stringify(m.content) : m.content
    total += Math.ceil(content.length / 4)
  }
  return total
}

/**
 * token 预算滑动窗口压缩。
 *
 * 超预算时，把靠前消息用 summarize 压成摘要，保留最近 keepRecent 条原文。
 */
export class TokenBudgetCompactor implements Compactor {
  constructor(
    private readonly summarize: (messages: ChatMessage[]) => Promise<string>,
    private readonly keepRecent = 4,
  ) {}

  async compact(messages: ChatMessage[], budget: number): Promise<ChatMessage[]> {
    if (estimateTokens(messages) <= budget) return messages
    if (messages.length <= this.keepRecent) return messages
    const head = messages.slice(0, -this.keepRecent)
    const tail = messages.slice(-this.keepRecent)
    const summary = await this.summarize(head)
    return [{ role: 'system', content: `【历史摘要】${summary}` }, ...tail]
  }
}
