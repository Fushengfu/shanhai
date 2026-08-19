import { describe, it, expect } from 'vitest'
import { bootstrap, type AskRequest } from '../src/bootstrap'

describe('AI 向用户提问（ask_user 工具 + 阻塞等待 + respondAsk）', () => {
  it('ask_user 注册 → execute 阻塞 → onAskRequest 通知 → respondAsk resolve 用户答案', async () => {
    const runtime = await bootstrap()
    try {
      const ask = runtime.tools.find((t) => t.name === 'ask_user')!
      expect(ask).toBeTruthy()

      // 订阅提问请求（模拟 UI 监听）
      let received: AskRequest | null = null
      const off = runtime.onAskRequest((req) => {
        received = req
      })

      // 启动工具执行（阻塞等待用户回答），不 await，先验证阻塞
      const execPromise = ask.execute({
        question: '请选择部署环境',
        options: ['开发环境', '测试环境', '生产环境'],
        multiple: false,
      }) as Promise<string>

      // 给微任务一点时间让 execute 通知 UI
      await new Promise((r) => setTimeout(r, 50))

      // 验证收到提问请求（问题/选项/单选）
      expect(received).toBeTruthy()
      expect(received!.question).toBe('请选择部署环境')
      expect(received!.options).toEqual(['开发环境', '测试环境', '生产环境'])
      expect(received!.multiple).toBe(false)

      // 模拟用户点「生产环境」提交
      runtime.respondAsk(received!.id, '生产环境')

      // execute 应 resolve 为用户答案
      const answer = await execPromise
      expect(answer).toBe('生产环境')

      off()
    } finally {
      await runtime.kernel.dispose()
    }
  })

  it('无 options 时自由文本输入，多选时 multiple=true 透传', async () => {
    const runtime = await bootstrap()
    try {
      const ask = runtime.tools.find((t) => t.name === 'ask_user')!

      // 自由输入（无 options）
      let freeReq: AskRequest | null = null
      const off1 = runtime.onAskRequest((req) => {
        freeReq = req
      })
      const freeExec = ask.execute({ question: '你的项目叫什么名字？', placeholder: '请输入项目名' }) as Promise<string>
      await new Promise((r) => setTimeout(r, 30))
      expect(freeReq!.options).toBeUndefined()
      expect(freeReq!.placeholder).toBe('请输入项目名')
      runtime.respondAsk(freeReq!.id, '山海')
      expect(await freeExec).toBe('山海')
      off1()

      // 多选透传
      let multiReq: AskRequest | null = null
      const off2 = runtime.onAskRequest((req) => {
        multiReq = req
      })
      const multiExec = ask.execute({ question: '选择要处理的文件', options: ['a.ts', 'b.ts', 'c.ts'], multiple: true }) as Promise<string>
      await new Promise((r) => setTimeout(r, 30))
      expect(multiReq!.multiple).toBe(true)
      runtime.respondAsk(multiReq!.id, 'a.ts、c.ts')
      expect(await multiExec).toBe('a.ts、c.ts')
      off2()
    } finally {
      await runtime.kernel.dispose()
    }
  })

  it('删除会话时取消该会话待回答的提问（避免 agent 卡死）', async () => {
    const runtime = await bootstrap()
    try {
      const ask = runtime.tools.find((t) => t.name === 'ask_user')!
      const sid = runtime.listSessions()[0]?.id

      let received: AskRequest | null = null
      const off = runtime.onAskRequest((req) => {
        received = req
      })
      const execPromise = ask.execute({ question: '等待中的问题' }) as Promise<string>
      await new Promise((r) => setTimeout(r, 30))
      expect(received).toBeTruthy()

      // 删除发起提问的会话 → 该提问应被取消 resolve，不卡死
      await runtime.deleteSession(sid)
      const answer = await execPromise
      expect(answer).toContain('已删除')
      off()
    } finally {
      await runtime.kernel.dispose()
    }
  })
})
