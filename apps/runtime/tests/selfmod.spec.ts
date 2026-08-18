import { describe, it, expect, vi } from 'vitest'
import { SelfModifyRuntime } from '../src/selfmod'
import { bootstrap } from '../src/bootstrap'
import type { ToolContract } from '@shanhai/tools'

/** 构造一套 mock hooks，便于断言工具/事件/服务的注册与撤销 */
function makeHooks() {
  const tools: ToolContract[] = []
  const events = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const services = new Map<string, unknown>()
  const clientDeliveries: Array<{ pkgId: string; code: string }> = []
  const clientRemovals: string[] = []

  return {
    hooks: {
      listServices: () => [...services.keys()],
      listTools: () => tools.map((t) => t.name),
      registerTool: (tool: ToolContract) => {
        tools.push(tool)
        return () => {
          const i = tools.indexOf(tool)
          if (i >= 0) tools.splice(i, 1)
        }
      },
      onEvent: (name: string, listener: (...args: unknown[]) => unknown) => {
        const arr = events.get(name) ?? []
        arr.push(listener)
        events.set(name, arr)
        return () => {
          const cur = events.get(name) ?? []
          const i = cur.indexOf(listener)
          if (i >= 0) cur.splice(i, 1)
        }
      },
      requestClientRun: vi.fn(async () => true),
      deliverClient: async (pkg: { id: string; client?: string }) => {
        clientDeliveries.push({ pkgId: pkg.id, code: pkg.client ?? '' })
      },
      removeClient: async (pkgId: string) => {
        clientRemovals.push(pkgId)
      },
    },
    tools,
    events,
    clientDeliveries,
    clientRemovals,
  }
}

const HOST_TOOL_CODE = `module.exports = (ctx) => {
  ctx.tools.register({ name: 'dyn_tool', description: 'd', inputSchema: {}, riskLevel: 'readonly', execute: async () => 'dyn-ok' })
  ctx.provide('dyn-service', { hello: () => 'world' })
  ctx.on('dyn/event', (x) => { globalThis.__dynEvent = x })
}`

describe('SelfModifyRuntime（K5 自修改）', () => {
  it('define → run 注册工具/服务/事件 → stop 逆序撤销', async () => {
    const { hooks, tools, events } = makeHooks()
    const rt = new SelfModifyRuntime(hooks)

    const pkg = rt.define({ name: 'dyn', purpose: 'test', code: HOST_TOOL_CODE }, 's1')
    expect(pkg.id).toMatch(/^dyn-/)
    expect(pkg.status).toBe('defined')

    await rt.run(pkg.id, 's1')
    expect(pkg.status).toBe('running')
    // 工具已注册且可执行
    expect(tools.map((t) => t.name)).toContain('dyn_tool')
    expect(await tools.find((t) => t.name === 'dyn_tool')!.execute({})).toBe('dyn-ok')
    // 事件监听已挂上
    expect(events.get('dyn/event')?.length).toBe(1)

    await rt.stop(pkg.id)
    expect(pkg.status).toBe('stopped')
    // 撤销后工具移除、事件清空
    expect(tools.map((t) => t.name)).not.toContain('dyn_tool')
    expect(events.get('dyn/event')?.length ?? 0).toBe(0)
  })

  it('session 隔离：A 会话定义的包，B 会话无权运行', async () => {
    const { hooks } = makeHooks()
    const rt = new SelfModifyRuntime(hooks)
    const pkg = rt.define({ name: 'dyn', purpose: 'test', code: HOST_TOOL_CODE }, 's1')
    await expect(rt.run(pkg.id, 's2')).rejects.toThrow(/其他会话/)
    // inspect 按会话过滤
    const report = rt.inspect('s2') as { packages: Array<{ id: string }> }
    expect(report.packages).toHaveLength(0)
    const reportS1 = rt.inspect('s1') as { packages: Array<{ id: string }> }
    expect(reportS1.packages).toHaveLength(1)
  })

  it('browser 半：approve 时投递，reject 时撤销 host 半并抛错', async () => {
    // approve 场景
    {
      const { hooks, clientDeliveries } = makeHooks()
      const rt = new SelfModifyRuntime(hooks)
      const ok = rt.define({ name: 'ui', purpose: 'x', code: HOST_TOOL_CODE, client: '(React,slots)=>{}' }, 's1')
      const res = await rt.run(ok.id, 's1')
      expect(res.clientDelivered).toBe(true)
      expect(clientDeliveries).toHaveLength(1)
    }
    // reject 场景：requestClientRun 返回 false，host 半应被撤销并抛错
    {
      const { hooks, tools } = makeHooks()
      ;(hooks.requestClientRun as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
      const rt = new SelfModifyRuntime(hooks)
      const rej = rt.define({ name: 'ui2', purpose: 'y', code: HOST_TOOL_CODE, client: '(React,slots)=>{}' }, 's1')
      await expect(rt.run(rej.id, 's1')).rejects.toThrow(/拒绝/)
      // reject 后 host 半的工具被撤销（stack.dispose 生效）
      expect(tools.map((t) => t.name)).not.toContain('dyn_tool')
    }
  })

  it('undefine：停止并遗忘定义', async () => {
    const { hooks } = makeHooks()
    const rt = new SelfModifyRuntime(hooks)
    const pkg = rt.define({ name: 'dyn', purpose: 'test', code: HOST_TOOL_CODE }, 's1')
    await rt.run(pkg.id, 's1')
    await rt.undefine(pkg.id)
    const report = rt.inspect('s1') as { packages: Array<{ id: string }> }
    expect(report.packages).toHaveLength(0)
    await expect(rt.run(pkg.id, 's1')).rejects.toThrow(/不存在/)
  })

  it('host 半代码必须导出函数，否则 run 报错', async () => {
    const { hooks } = makeHooks()
    const rt = new SelfModifyRuntime(hooks)
    const pkg = rt.define({ name: 'bad', purpose: 'x', code: 'module.exports = 42' }, 's1')
    await expect(rt.run(pkg.id, 's1')).rejects.toThrow(/导出函数/)
  })
})

describe('bootstrap 集成 cordis 工具（K5 自修改接入 agent 工具表）', () => {
  it('tools 包含 5 个 cordis_* 工具，cordis_inspect 可调用', async () => {
    const runtime = await bootstrap()
    try {
      const names = runtime.tools.map((t) => t.name)
      expect(names).toEqual(
        expect.arrayContaining(['cordis_inspect', 'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine']),
      )
      const inspect = runtime.tools.find((t) => t.name === 'cordis_inspect')!
      const report = (await inspect.execute({})) as { tools: string[]; packages: unknown[]; services: string[] }
      expect(report.tools).toContain('read_file')
      expect(report.tools).toContain('cordis_run')
      expect(report.packages).toEqual([])
      expect(report.services.length).toBeGreaterThan(0)
      // selfmodInspect 与工具返回一致（走同一份清单）
      const viaRuntime = runtime.selfmodInspect() as { tools: string[] }
      expect(viaRuntime.tools).toContain('read_file')
    } finally {
      await runtime.kernel.dispose()
    }
  })

  it('cordis_define → cordis_run 注册动态工具 → cordis_stop 移除（对 agent 工具表生效）', async () => {
    const runtime = await bootstrap()
    try {
      const define = runtime.tools.find((t) => t.name === 'cordis_define')!
      const run = runtime.tools.find((t) => t.name === 'cordis_run')!
      const stop = runtime.tools.find((t) => t.name === 'cordis_stop')!

      const defined = (await define.execute({ name: 'dyn', purpose: 'test', code: HOST_TOOL_CODE })) as { id: string }
      expect(runtime.tools.map((t) => t.name)).not.toContain('dyn_tool')

      await run.execute({ id: defined.id })
      // 动态工具注册后，对 agent 工具表（同一数组引用）立即可见
      expect(runtime.tools.map((t) => t.name)).toContain('dyn_tool')

      await stop.execute({ id: defined.id })
      expect(runtime.tools.map((t) => t.name)).not.toContain('dyn_tool')
    } finally {
      await runtime.kernel.dispose()
    }
  })

  it('browser 半完整链路：run 触发 round-trip 审批 → respond → 投递 code → stop 卸载', async () => {
    const runtime = await bootstrap()
    try {
      const define = runtime.tools.find((t) => t.name === 'cordis_define')!
      const run = runtime.tools.find((t) => t.name === 'cordis_run')!
      const stop = runtime.tools.find((t) => t.name === 'cordis_stop')!

      const requests: Array<{ requestId: string; pkgId: string; name: string }> = []
      const codes: Array<{ pkgId: string; code: string }> = []
      const removals: string[] = []
      const offReq = runtime.onClientRunRequest((req) => requests.push(req))
      const offCode = runtime.onClientCode((p) => codes.push(p))
      const offRemove = runtime.onClientRemove((id) => removals.push(id))

      const clientCode = `(React, slots) => { slots.register({ slot: 'dynamic-extension', id: 'x', component: () => React.createElement('div', {}, 'hi') }) }`
      const defined = (await define.execute({ name: 'ui', purpose: 'x', code: HOST_TOOL_CODE, client: clientCode })) as { id: string }

      // run 会阻塞在 requestClientRun（round-trip 审批），先启动再等审批请求到达
      const runPromise = run.execute({ id: defined.id }) as Promise<{ clientDelivered: boolean }>
      await vi.waitFor(() => expect(requests.length).toBe(1))
      const req = requests[0]!
      expect(req.name).toBe('ui')
      runtime.respondClientRun(req.requestId, true)

      const res = await runPromise
      expect(res.clientDelivered).toBe(true)
      expect(codes.length).toBe(1)
      expect(codes[0]!.pkgId).toBe(defined.id)

      await stop.execute({ id: defined.id })
      expect(removals).toContain(defined.id)

      offReq()
      offCode()
      offRemove()
    } finally {
      await runtime.kernel.dispose()
    }
  })
})
