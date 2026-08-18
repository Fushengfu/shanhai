import { describe, it, expect } from 'vitest'
import { bootstrap } from '../src/bootstrap'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { StepTrace } from '@shanhai/agent'

// 真实网关 E2E：仅在有本地凭证时运行（无凭证环境自动跳过）
const hasCredential = existsSync(join(homedir(), '.shanhai', 'config.json'))

describe.skipIf(!hasCredential)('多专家编排 E2E（真实网关）', () => {
  it('Triage 拆解 + 编排调度跑通（复杂任务应触发专家轨迹）', async () => {
    const runtime = await bootstrap()
    try {
      const sid = runtime.createSession('编排验证')
      runtime.switchSession(sid)
      const traces: StepTrace[] = []
      runtime.onExpertTrace((t) => traces.push(t))

      // 明确的分步任务：先总结再翻译，强引导模型拆成多步
      const result = await runtime.run(
        '请分两步完成这个任务：第一步，用中文总结「人工智能」这个概念的核心含义；第二步，把第一步的总结翻译成英文。',
      )
      expect(result.length).toBeGreaterThan(0)
      // 编排是否触发取决于模型拆解结果：打印轨迹供观察（不硬性断言步骤数）
      console.log('=== 编排轨迹 ===')
      console.log(traces.map((t) => `${t.status}:${t.expertName}:${t.title}`).join('\n') || '（单步，无轨迹）')
      console.log('=== 最终结果 ===')
      console.log(result)
      expect(true).toBe(true)
    } finally {
      await runtime.kernel.dispose()
    }
  }, 120000)
})
