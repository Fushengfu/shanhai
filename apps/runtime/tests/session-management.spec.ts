import { describe, it, expect } from 'vitest'
import { bootstrap } from '../src/bootstrap'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

describe('会话管理（持久化 / 重命名 / 删除 / 工作目录）', () => {
  it('默认工作目录、修改工作目录、重命名、消息持久化、删除', async () => {
    const runtime = await bootstrap()

    // 1. 默认工作目录 = ~/shanhai/workspace
    const id = runtime.createSession('测试会话')
    expect(runtime.getSessionWorkdir(id)).toBe(join(homedir(), 'shanhai', 'workspace'))

    // 2. 修改工作目录
    runtime.setSessionWorkdir(id, '/tmp/shanhai-test-workspace')
    expect(runtime.getSessionWorkdir(id)).toBe('/tmp/shanhai-test-workspace')

    // 3. 重命名
    runtime.renameSession(id, '改名后的会话')
    expect(runtime.listSessions().find((s) => s.id === id)?.title).toBe('改名后的会话')

    // 4. 跑一条消息（走 mock 模型），run 结束后事件应落盘
    const result = await runtime.run('你好')
    expect(result.length).toBeGreaterThan(0)

    const file = join(homedir(), '.shanhai', 'sessions', `${id}.json`)
    const raw = await fs.readFile(file, 'utf8')
    const data = JSON.parse(raw) as { title: string; workDir: string; events: unknown[] }
    expect(data.title).toBe('改名后的会话')
    expect(data.workDir).toBe('/tmp/shanhai-test-workspace')
    expect(Array.isArray(data.events)).toBe(true)
    expect(data.events.length).toBeGreaterThan(0)

    // 5. 历史回放：getSessionHistory 能读出 user + assistant 消息
    const history = runtime.getSessionHistory(id)
    expect(history.some((h) => h.kind === 'user')).toBe(true)
    expect(history.some((h) => h.kind === 'assistant')).toBe(true)

    // 6. 删除：列表不再包含，磁盘文件被清理
    await runtime.deleteSession(id)
    expect(runtime.listSessions().some((s) => s.id === id)).toBe(false)
    await expect(fs.readFile(file, 'utf8')).rejects.toThrow()

    await runtime.kernel.dispose()
  })

  it('跨 bootstrap 重启后：会话标题与历史消息完整恢复（重启不丢）', async () => {
    const r1 = await bootstrap()
    const id = r1.createSession('跨重启会话')
    r1.renameSession(id, '跨重启改名')
    r1.setSessionWorkdir(id, '/tmp/shanhai-restart-workspace')
    await r1.run('你好')
    await r1.kernel.dispose()

    // 模拟重启：重新 bootstrap，从磁盘加载历史会话
    const r2 = await bootstrap()
    const found = r2.listSessions().find((s) => s.id === id)
    expect(found).toBeDefined()
    expect(found?.title).toBe('跨重启改名')
    expect(found?.workDir).toBe('/tmp/shanhai-restart-workspace')

    const history = r2.getSessionHistory(id)
    expect(history.some((h) => h.kind === 'user')).toBe(true)
    expect(history.some((h) => h.kind === 'assistant')).toBe(true)

    // 清理
    await r2.deleteSession(id)
    await r2.kernel.dispose()
  })
})
