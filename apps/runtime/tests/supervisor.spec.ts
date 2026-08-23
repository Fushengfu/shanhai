import { describe, it, expect } from 'vitest'
import { bootstrap } from '../src/bootstrap'
import { createSupervisorTools, SUPERVISOR_ID } from '../src/supervisor'

describe('会话管家（主 Agent）', () => {
  it('管家会话隔离：不暴露在 listSessions，describeSession 不查询管家自己', async () => {
    const runtime = await bootstrap()
    const userSid = runtime.createSession('管家隔离测试会话')

    // 管家超级会话（id=supervisor）不暴露给用户侧边栏
    expect(runtime.listSessions().some((s) => s.id === 'supervisor')).toBe(false)
    expect(runtime.listSessions().some((s) => s.id === userSid)).toBe(true)

    // describeSession 不查询管家自己（返回 null）
    expect(runtime.describeSession('supervisor')).toBeNull()
    // 不存在的会话返回 null
    expect(runtime.describeSession('no-such-session')).toBeNull()

    await runtime.kernel.dispose()
  })

  it('describeSession 返回会话状态摘要（模型/审批策略/需求/步数/上下文）', async () => {
    const runtime = await bootstrap()
    const userSid = runtime.createSession('描述测试会话')

    const summary = runtime.describeSession(userSid)
    expect(summary).not.toBeNull()
    expect(summary?.id).toBe(userSid)
    expect(summary?.busy).toBe(false)
    expect(summary?.approvalPolicy).toBe('ask')
    expect(summary?.currentRequest).toBe('')
    expect(summary?.stepCount).toBe(0)
    expect(summary?.turnCount).toBe(0)
    expect(summary?.hasIncompleteTurn).toBe(false)
    expect(summary?.contextUsageRatio).toBeGreaterThanOrEqual(0)

    await runtime.kernel.dispose()
  })

  it('setSessionModel / setSessionApprovalPolicy：写事件日志，切换会话后回放生效', async () => {
    const runtime = await bootstrap()
    const userSid = runtime.createSession('配置测试会话')

    // 边界：不存在的会话返回失败
    expect(runtime.setSessionModel('no-such', 'x').ok).toBe(false)
    expect(runtime.setSessionApprovalPolicy('no-such', 'never').ok).toBe(false)

    // 安全模式：写事件日志，切到该会话后 getApprovalPolicy 回放
    const policyRes = runtime.setSessionApprovalPolicy(userSid, 'never')
    expect(policyRes.ok).toBe(true)
    runtime.switchSession(userSid)
    expect(runtime.getApprovalPolicy()).toBe('never')

    await runtime.kernel.dispose()
  })

  it('sendMessageToSession：空闲会话异步下发任务，完成后通过事件回传正文结果', async () => {
    const runtime = await bootstrap()
    const userSid = runtime.createSession('转发测试会话')

    // 订阅管家结果回传事件（异步执行完成后触发）
    let notified: { sessionId: string; title: string; result?: string; error?: string } | null = null
    const off = runtime.onSupervisorResult((sessionId, title, result, error) => {
      notified = { sessionId, title, result, error }
    })

    const res = await runtime.sendMessageToSession(userSid, '请回复一句话', 'insert')
    expect(res.ok).toBe(true)
    // 异步投递：立即返回投递结果，不带 result（正文通过事件回传，不再同步阻塞等待）
    expect(res.result).toBeUndefined()

    // 等待异步任务完成并触发结果回传（轮询，最多 30s）
    await new Promise((resolve) => {
      const t0 = Date.now()
      const timer = setInterval(() => {
        if (notified || Date.now() - t0 > 30000) {
          clearInterval(timer)
          resolve(undefined)
        }
      }, 100)
    })

    // 结果通过事件回传到管家（sessionId 为目标会话，正文非空）
    expect(notified).not.toBeNull()
    expect(notified?.sessionId).toBe(userSid)
    expect(notified?.result?.length).toBeGreaterThan(0)

    // 目标会话最终产生历史消息（user + assistant）
    const history = runtime.getSessionHistory(userSid)
    expect(history.some((h) => h.kind === 'user')).toBe(true)
    expect(history.some((h) => h.kind === 'assistant')).toBe(true)

    // 边界：不存在的会话返回失败
    const bad = await runtime.sendMessageToSession('no-such', 'hi', 'insert')
    expect(bad.ok).toBe(false)

    off()
    await runtime.kernel.dispose()
  }, 40000)

  it('runSupervisor：管家会话单步执行（mock 模型 + 管家工具集），返回非空', async () => {
    const runtime = await bootstrap()
    const result = await runtime.runSupervisor('你好')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)

    // 管家历史可见
    const history = runtime.getSessionHistory('supervisor')
    expect(history.some((h) => h.kind === 'user')).toBe(true)

    await runtime.kernel.dispose()
  })

  it('createSession / renameSession / deleteSession：会话生命周期代管 + 管家保护', async () => {
    const runtime = await bootstrap()
    const a = runtime.createSession('生命周期A')
    const b = runtime.createSession('生命周期B')

    // createSession 返回会话 id，且都出现在列表
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(runtime.listSessions().some((s) => s.id === a)).toBe(true)
    expect(runtime.listSessions().some((s) => s.id === b)).toBe(true)

    // renameSession 重命名
    runtime.renameSession(b, '重命名后的B')
    expect(runtime.listSessions().find((s) => s.id === b)?.title).toBe('重命名后的B')

    // 管家会话不可重命名：改后管家历史仍可读，且不新增/改名用户会话
    runtime.renameSession(SUPERVISOR_ID, '不该生效')
    expect(runtime.listSessions().some((s) => s.title === '不该生效')).toBe(false)

    // deleteSession 删除 b，a 保留
    await runtime.deleteSession(b)
    expect(runtime.listSessions().some((s) => s.id === b)).toBe(false)
    expect(runtime.listSessions().some((s) => s.id === a)).toBe(true)

    // 管家会话不可删除：删除后管家历史仍可读
    await runtime.deleteSession(SUPERVISOR_ID)
    expect(runtime.getSessionHistory(SUPERVISOR_ID)).toBeDefined()

    await runtime.kernel.dispose()
  })

  it('createSupervisorTools 包含 create_session / rename_session / set_session_workdir / delete_session，delete_session 为危险操作', () => {
    const tools = createSupervisorTools({
      listSessions: () => [],
      inspectSession: () => null,
      listModels: () => [],
      sendMessage: async () => ({ ok: true, message: '' }),
      switchSession: () => ({ ok: true, message: '' }),
      setSessionModel: () => ({ ok: true, message: '' }),
      setSessionApproval: () => ({ ok: true, message: '' }),
      createSession: () => ({ ok: true, message: '', sessionId: 'x' }),
      renameSession: () => ({ ok: true, message: '' }),
      deleteSession: async () => ({ ok: true, message: '' }),
      setSessionWorkdir: () => ({ ok: true, message: '' }),
      askSessionPicker: async () => 's-1',
      askModelPicker: async () => 'm-1',
    })
    const names = tools.map((t) => t.name)
    expect(names).toContain('create_session')
    expect(names).toContain('rename_session')
    expect(names).toContain('set_session_workdir')
    expect(names).toContain('delete_session')
    expect(names).toContain('choose_session')
    expect(names).toContain('choose_model')
    expect(tools.find((t) => t.name === 'delete_session')?.riskLevel).toBe('irreversible')
    expect(tools.find((t) => t.name === 'choose_session')?.riskLevel).toBe('readonly')
  })
})
