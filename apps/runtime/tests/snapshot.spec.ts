import { describe, it, expect } from 'vitest'
import { bootstrap } from '../src/bootstrap'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

describe('写文件快照回滚（K4 安全，T7.3 安全链路）', () => {
  it('write_file 写前快照 → rollback_file 恢复原内容', async () => {
    const runtime = await bootstrap()
    try {
      const dir = runtime.getSessionWorkdir()
      await fs.mkdir(dir, { recursive: true })
      const file = join(dir, `snapshot-test-${Date.now()}.txt`)
      await fs.writeFile(file, '原始内容')

      const writeFile = runtime.tools.find((t) => t.name === 'write_file')!
      const rollbackFile = runtime.tools.find((t) => t.name === 'rollback_file')!
      expect(rollbackFile).toBeTruthy()

      const res = (await writeFile.execute({ path: file, content: '新内容' })) as { ok: boolean; snapshotId?: string }
      expect(res.ok).toBe(true)
      // 覆盖已有文件 → 写前快照，返回 snapshotId
      expect(res.snapshotId).toBeTruthy()
      expect(await fs.readFile(file, 'utf8')).toBe('新内容')

      const rb = (await rollbackFile.execute({ path: file, snapshotId: res.snapshotId })) as { ok: boolean; rolledBack: boolean }
      expect(rb.ok).toBe(true)
      expect(rb.rolledBack).toBe(true)
      // 回滚后恢复原始内容
      expect(await fs.readFile(file, 'utf8')).toBe('原始内容')

      await fs.rm(file, { force: true })
    } finally {
      await runtime.kernel.dispose()
    }
  })

  it('新建文件（不存在）无需快照：snapshotId 为空，rollback 缺 id 报错', async () => {
    const runtime = await bootstrap()
    try {
      const dir = runtime.getSessionWorkdir()
      await fs.mkdir(dir, { recursive: true })
      const file = join(dir, `snapshot-new-${Date.now()}.txt`)
      try {
        await fs.rm(file, { force: true })
      } catch {
        // 忽略
      }

      const writeFile = runtime.tools.find((t) => t.name === 'write_file')!
      const res = (await writeFile.execute({ path: file, content: '全新文件' })) as { ok: boolean; isNew: boolean; snapshotId?: string }
      expect(res.isNew).toBe(true)
      expect(res.snapshotId).toBeUndefined()

      const rollbackFile = runtime.tools.find((t) => t.name === 'rollback_file')!
      const rb = (await rollbackFile.execute({ path: file, snapshotId: '' })) as { ok: boolean; error?: string }
      expect(rb.ok).toBe(false)
      expect(rb.error).toContain('snapshotId')

      await fs.rm(file, { force: true })
    } finally {
      await runtime.kernel.dispose()
    }
  })
})
