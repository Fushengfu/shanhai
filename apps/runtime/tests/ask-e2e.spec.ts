import { describe, it, expect } from 'vitest'
import { bootstrap, type AskRequest } from '../src/bootstrap'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 真实网关 E2E：仅在有本地凭证时运行
const hasCredential = existsSync(join(homedir(), '.shanhai', 'config.json'))

describe.skipIf(!hasCredential)('ask_user 端到端（真实网关：模型调用提问 → 用户回答 → 继续）', () => {
  it('模型调用 ask_user 提问，用户回答后模型基于回答继续', async () => {
    const runtime = await bootstrap()
    try {
      let received: AskRequest | null = null
      const off = runtime.onAskRequest((req) => {
        received = req
      })

      // 明确引导模型调用 ask_user 工具
      const runPromise = runtime.run(
        '请先调用 ask_user 工具向我提一个问题：你希望我用「中文」还是「英文」回答？选项只有「中文」和「英文」两个，单选。' +
          '调用 ask_user 后必须等待我的回答，然后只用我选的语言回复一句话「已按你的选择回答」。',
      )

      // 轮询等待模型调用 ask_user（最多 30 秒）
      const deadline = Date.now() + 30000
      while (!received && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200))
      }
      expect(received).toBeTruthy()
      if (!received) {
        off()
        return
      }
      console.log('模型调用了 ask_user:', JSON.stringify(received))

      // 用户选择「中文」
      runtime.respondAsk(received.id, '中文')

      const result = await runPromise
      console.log('ask_user e2e 最终回复:', result)
      expect(result).toBeTruthy()
      off()
    } finally {
      await runtime.kernel.dispose()
    }
  }, 60000)
})
