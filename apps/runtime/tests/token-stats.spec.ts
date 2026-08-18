import { describe, it, expect } from 'vitest'
import { bootstrap } from '../src/bootstrap'

describe('token 用量统计', () => {
  it('真实网关调用后：累计/本轮 token 更新、上下文长度就位、占比可计算', async () => {
    const runtime = await bootstrap()
    const models = await runtime.listModels()
    // 优先用已知可用的主力模型（LongCat-2.0 流式会 500）
    const target = models.find((m) => !m.custom && m.id === 'deepseek-v4-flash') ?? models.find((m) => !m.custom)
    if (!target) {
      // 未登录（无系统模型），跳过
      await runtime.kernel.dispose()
      return
    }
    runtime.switchModel(target.id)

    const result = await runtime.run('1+1等于几？直接回答一个数字')
    expect(result.length).toBeGreaterThan(0)

    const stats = runtime.getTokenStats()
    expect(stats.total).toBeGreaterThan(0)
    expect(stats.turn).toBeGreaterThan(0)
    expect(stats.totalPrompt).toBeGreaterThan(0)
    expect(stats.totalCompletion).toBeGreaterThan(0)
    expect(stats.lastPrompt).toBeGreaterThan(0)
    // 系统模型带 contextLength（网关下发），上下文占比在 (0, 1] 区间
    expect(stats.contextLength).toBeGreaterThan(0)
    expect(stats.contextUsageRatio).toBeGreaterThan(0)
    expect(stats.contextUsageRatio).toBeLessThanOrEqual(1)

    await runtime.kernel.dispose()
  })
})
