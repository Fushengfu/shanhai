import { describe, it, expect } from 'vitest'
import { bootstrap } from '../src/bootstrap'

describe('长期记忆（remember 工具 + 持久化 + 面板数据）', () => {
  it('remember 保存 → listMemory 返回 → removeMemory 删除', async () => {
    const runtime = await bootstrap()
    try {
      const remember = runtime.tools.find((t) => t.name === 'remember')!
      expect(remember).toBeTruthy()

      const res = (await remember.execute({ scope: 'user_preference', key: '测试偏好', value: '喜欢深色主题' })) as { ok: boolean }
      expect(res.ok).toBe(true)

      const list = runtime.listMemory()
      const found = list.find((m) => m.key === '测试偏好')
      expect(found).toBeTruthy()
      expect(found!.value).toBe('喜欢深色主题')

      runtime.removeMemory(found!.id)
      expect(runtime.listMemory().find((m) => m.key === '测试偏好')).toBeUndefined()
    } finally {
      await runtime.kernel.dispose()
    }
  })

  it('记忆跨 bootstrap 恢复（持久化到 memory.json）', async () => {
    const key = `持久化-${Date.now()}`
    const r1 = await bootstrap()
    try {
      const remember = r1.tools.find((t) => t.name === 'remember')!
      await remember.execute({ scope: 'project_knowledge', key, value: '项目使用 pnpm workspace' })
    } finally {
      await r1.kernel.dispose()
    }

    // 重新 bootstrap，记忆应从 memory.json 恢复
    const r2 = await bootstrap()
    try {
      const found = r2.listMemory().find((m) => m.key === key)
      expect(found).toBeTruthy()
      expect(found!.value).toBe('项目使用 pnpm workspace')
      // 清理测试数据
      r2.removeMemory(found!.id)
    } finally {
      await r2.kernel.dispose()
    }
  })
})
