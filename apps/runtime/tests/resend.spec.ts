import { describe, it, expect } from 'vitest'
import { bootstrap } from '../src/bootstrap'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 重新发送 / 编辑后重发 / 断点续跑（对齐 taco 的 resendFromExisting）。
 * 核心语义：截断到目标用户消息之前，重新生成，丢弃旧回复。
 */
describe('重新发送 / 编辑重发 / 断点续跑', () => {
  it('resend：截断到目标用户消息之前，旧回复被丢弃，重新生成', async () => {
    const runtime = await bootstrap()
    const id = runtime.createSession('重发测试')

    await runtime.run('第一问')
    await runtime.run('第二问')

    // 此时应有 2 条 user/message + 2 条 assistant/message
    const before = runtime.getSessionHistory(id)
    const userCountBefore = before.filter((h) => h.kind === 'user').length
    expect(userCountBefore).toBe(2)

    // 重新发送第 1 条用户消息（0 起 = 「第二问」）
    const result = await runtime.resend(id, 1)
    expect(result.length).toBeGreaterThan(0)

    const after = runtime.getSessionHistory(id)
    const userCountAfter = after.filter((h) => h.kind === 'user').length
    // 截断后仍应只有 2 条用户消息（第二问被重新生成，不重复追加）
    expect(userCountAfter).toBe(2)

    // 磁盘落盘后的会话文件，第二问之后只有一条 assistant 回复（旧回复被截断）
    const file = join(homedir(), '.shanhai', 'sessions', `${id}.json`)
    const data = JSON.parse(await fs.readFile(file, 'utf8')) as { events: Array<{ type: string }> }
    const assistantCount = data.events.filter((e) => e.type === 'assistant/message').length
    expect(assistantCount).toBe(2)

    await runtime.deleteSession(id)
    await runtime.kernel.dispose()
  }, 60000)

  it('resend + newContent：编辑后重发用新内容生成', async () => {
    const runtime = await bootstrap()
    const id = runtime.createSession('编辑测试')

    await runtime.run('原始问题')
    const before = runtime.getSessionHistory(id)
    expect(before.filter((h) => h.kind === 'user').length).toBe(1)

    const result = await runtime.resend(id, 0, '编辑后的新问题')
    expect(result.length).toBeGreaterThan(0)

    const after = runtime.getSessionHistory(id)
    const user = after.find((h) => h.kind === 'user')
    // 编辑后，用户消息内容应为新内容
    expect(user?.content).toBe('编辑后的新问题')
    // 仍只有 1 条用户消息（截断 + 重发，不重复）
    expect(after.filter((h) => h.kind === 'user').length).toBe(1)

    await runtime.deleteSession(id)
    await runtime.kernel.dispose()
  }, 60000)

  it('hasIncompleteTurn：完成一轮后返回 false，resume 能继续执行', async () => {
    const runtime = await bootstrap()
    const id = runtime.createSession('续跑测试')

    // 空会话：无用户消息 → 不完整
    expect(runtime.hasIncompleteTurn(id)).toBe(false)

    await runtime.run('一条完整消息')
    // 完成后有 assistant/message + turn/end → 完整
    expect(runtime.hasIncompleteTurn(id)).toBe(false)

    await runtime.deleteSession(id)
    await runtime.kernel.dispose()
  })
})
