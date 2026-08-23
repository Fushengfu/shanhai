import { describe, it, expect, vi } from 'vitest'
import { AskService } from '../src/ask'
import { createAskTools } from '../src/tools'

describe('AskService', () => {
  it('ask 阻塞等待 respond 返回答案', async () => {
    const service = new AskService()
    const reqs: Array<{ id: string; question: string; options?: string[] }> = []
    service.onRequest((r) => reqs.push(r))

    const p = service.ask('选哪个？', { options: ['A', 'B'] })

    // onRequest 同步触发，已捕获请求
    expect(reqs).toHaveLength(1)
    expect(reqs[0]!.question).toBe('选哪个？')
    expect(reqs[0]!.options).toEqual(['A', 'B'])

    // 未 respond 前不 resolve
    await new Promise((r) => setTimeout(r, 0))
    let settled = false
    void p.then(() => (settled = true))
    expect(settled).toBe(false)

    service.respond(reqs[0]!.id, 'A')
    await expect(p).resolves.toBe('A')
  })

  it('onRequest 订阅触发并支持取消订阅', () => {
    const service = new AskService()
    const fn = vi.fn()
    const off = service.onRequest(fn)
    void service.ask('q')
    expect(fn).toHaveBeenCalledTimes(1)

    off()
    void service.ask('q2')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('respond 未知 id 不抛错', () => {
    const service = new AskService()
    expect(() => service.respond('nope', 'x')).not.toThrow()
  })

  it('cancelSession 只取消指定会话的待回答提问', async () => {
    const service = new AskService()
    const reqs: Array<{ id: string; sessionId?: string }> = []
    service.onRequest((r) => reqs.push(r))

    const p1 = service.ask('会话A的提问', { sessionId: 's-a' })
    const p2 = service.ask('会话B的提问', { sessionId: 's-b' })

    service.cancelSession('s-a')
    await expect(p1).resolves.toContain('已取消')

    // 会话 B 未受影响，仍可正常 respond
    const captured = reqs.find((r) => r.sessionId === 's-b')
    expect(captured).toBeTruthy()
    service.respond(captured!.id, 'ok')
    await expect(p2).resolves.toBe('ok')
  })
})

describe('ask_user 工具', () => {
  it('question 空值返回错误', async () => {
    const service = new AskService()
    const [tool] = createAskTools(service, () => 's1')
    const result = await tool.execute({ question: '   ' })
    expect(result).toEqual({ ok: false, error: 'question 不能为空' })
  })

  it('question 非空时调用 service.ask 并透传选项', async () => {
    const service = new AskService()
    const askSpy = vi.spyOn(service, 'ask')
    const reqs: Array<{ id: string }> = []
    service.onRequest((r) => reqs.push(r))

    const [tool] = createAskTools(service, () => 's1')
    const p = tool.execute({ question: '选', options: ['x', 'y'], multiple: true, placeholder: 'hint' })

    expect(askSpy).toHaveBeenCalledWith('选', {
      options: ['x', 'y'],
      multiple: true,
      placeholder: 'hint',
      sessionId: 's1',
    })

    service.respond(reqs[0]!.id, 'ans')
    await expect(p).resolves.toBe('ans')
  })

  it('riskLevel 为 readonly 且 options 为空时不透传空数组', async () => {
    const service = new AskService()
    const [tool] = createAskTools(service, () => 's1')
    expect(tool.name).toBe('ask_user')
    expect(tool.riskLevel).toBe('readonly')

    const askSpy = vi.spyOn(service, 'ask')
    void tool.execute({ question: 'q', options: [] })
    expect(askSpy).toHaveBeenCalledWith('q', { options: undefined, multiple: false, placeholder: undefined, sessionId: 's1' })
  })
})
