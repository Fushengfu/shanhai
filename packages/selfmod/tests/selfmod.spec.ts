import { describe, it, expect, vi } from 'vitest'
import type { ToolContract } from '@shanhai/tools'
import { PluginStore } from '@shanhai/kernel'
import { SelfModifyRuntime, type SelfModifyHooks } from '../src/selfmod'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeHooks(overrides: Partial<SelfModifyHooks> = {}): SelfModifyHooks & { events: string[]; clients: string[] } {
  const events: string[] = []
  const clients: string[] = []
  return {
    listServices: () => ['session', 'llm'],
    listTools: () => ['read_file'],
    listSlots: () => ['shell.sidebar', 'dynamic-extension'],
    onEvent: (name) => {
      events.push(name)
      return () => {}
    },
    requestClientRun: async () => true,
    deliverClient: async (pkg) => {
      clients.push(pkg.id)
    },
    removeClient: async (id) => {
      const i = clients.indexOf(id)
      if (i >= 0) clients.splice(i, 1)
    },
    ...overrides,
    events,
    clients,
  }
}

describe('SelfModifyRuntime', () => {
  it('define 记录 package，inspect 按会话过滤', () => {
    const hooks = makeHooks()
    const rt = new SelfModifyRuntime(hooks)
    const pkg = rt.define({ name: 'p1', purpose: '测试' }, 's-a')
    rt.define({ name: 'p2', purpose: '其他会话' }, 's-b')

    expect(pkg.id).toMatch(/^dyn-\d+$/)
    expect(pkg.status).toBe('defined')

    const reportA = rt.inspect('s-a') as { packages: Array<{ name: string }>; services: string[]; tools: string[]; slots: string[] }
    expect(reportA.packages.map((p) => p.name)).toEqual(['p1'])
    expect(reportA.services).toEqual(['session', 'llm'])
    expect(reportA.tools).toEqual(['read_file'])
    expect(reportA.slots).toEqual(['shell.sidebar', 'dynamic-extension'])
  })

  it('run 在 vm 沙箱评估 host 半并注册工具/服务，stop 撤销', async () => {
    const hooks = makeHooks()
    const rt = new SelfModifyRuntime(hooks)
    const pkg = rt.define(
      {
        name: 'dyn',
        purpose: '动态工具',
        code: 'module.exports = (ctx) => { ctx.tools.register({ name: "dyn_tool", description: "d", inputSchema: {}, riskLevel: "readonly", execute: () => "ok" }); ctx.provide("dyn_svc", { x: 1 }); return () => {}; }',
      },
      's-a',
    )

    const result = await rt.run(pkg.id, 's-a')
    expect(result.clientDelivered).toBe(false)
    expect(rt.listPluginTools()).toEqual(['dyn_tool'])

    // inspect 应包含动态注册的服务（插件工具经 plugin_tool 分派，见 listPluginTools）
    const report = rt.inspect('s-a') as { services: string[]; tools: string[] }
    expect(report.services).toContain('dyn_svc')
    expect(rt.listPluginTools()).toEqual(['dyn_tool'])

    await rt.stop(pkg.id)
    expect(rt.listPluginTools()).toHaveLength(0)
  })

  it('run 带 browser 半时走审批并投递', async () => {
    const hooks = makeHooks({ requestClientRun: async () => true })
    const rt = new SelfModifyRuntime(hooks)
    const pkg = rt.define({ name: 'ui', purpose: '带 UI', client: '(React, slots) => {}' }, 's-a')

    const result = await rt.run(pkg.id, 's-a')
    expect(result.clientDelivered).toBe(true)
    expect(hooks.clients).toEqual([pkg.id])

    await rt.stop(pkg.id)
    expect(hooks.clients).toHaveLength(0)
  })

  it('run 审批被拒时撤销 host 半并抛错', async () => {
    const hooks = makeHooks({ requestClientRun: async () => false })
    const rt = new SelfModifyRuntime(hooks)
    const pkg = rt.define(
      { name: 'ui', purpose: '带 UI', code: 'module.exports = () => {}', client: '(React, slots) => {}' },
      's-a',
    )

    await expect(rt.run(pkg.id, 's-a')).rejects.toThrow(/拒绝/)
    // host 半被撤销（插件工具 Registry 未残留）
    expect(rt.listPluginTools()).toHaveLength(0)
  })

  it('session 隔离：跨会话 run 抛错', async () => {
    const rt = new SelfModifyRuntime(makeHooks())
    const pkg = rt.define({ name: 'p', purpose: 'x', code: 'module.exports = () => {}' }, 's-a')

    await expect(rt.run(pkg.id, 's-b')).rejects.toThrow(/无权运行/)
  })

  it('无代码 run 抛错', async () => {
    const rt = new SelfModifyRuntime(makeHooks())
    const pkg = rt.define({ name: 'p', purpose: '空' }, 's-a')

    await expect(rt.run(pkg.id, 's-a')).rejects.toThrow(/没有可运行的代码/)
  })

  it('undefine 停止并遗忘定义', async () => {
    const rt = new SelfModifyRuntime(makeHooks())
    const pkg = rt.define({ name: 'p', purpose: 'x', code: 'module.exports = () => {}' }, 's-a')
    await rt.run(pkg.id, 's-a')

    await rt.undefine(pkg.id)
    const report = rt.inspect('s-a') as { packages: Array<{ id: string }> }
    expect(report.packages).toHaveLength(0)
  })
})

describe('createTools', () => {
  it('返回 plugin_* 工具（含 plugin_tool / plugin_apps），install/uninstall 需审批（run 工具不叠加顶层审批）', () => {
    const rt = new SelfModifyRuntime(makeHooks())
    const tools = rt.createTools(() => 's-a')
    expect(tools.map((t) => t.name)).toEqual([
      'plugin_inspect',
      'plugin_define',
      'plugin_run',
      'plugin_stop',
      'plugin_undefine',
      'plugin_test',
      'plugin_install',
      'plugin_uninstall',
      'plugin_scaffold',
      'plugin_build',
      'plugin_test_load',
      'plugin_verify',
      'plugin_tool',
      'plugin_apps',
    ])

    const runTool = tools.find((t) => t.name === 'plugin_run')!
    // 已消除双重审批：run 不再走 irreversible / approvalRequired，browser 半投递在 requestClientRun 单独审批
    expect(runTool.riskLevel).toBe('reversible')
    expect(runTool.approvalRequired).toBeUndefined()

    const inspectTool = tools.find((t) => t.name === 'plugin_inspect')!
    expect(inspectTool.riskLevel).toBe('readonly')

    // install / uninstall 是「写入内核 / 删除持久化」的高危动作，需用户审批
    const installTool = tools.find((t) => t.name === 'plugin_install')!
    expect(installTool.approvalRequired).toBe(true)
    const uninstallTool = tools.find((t) => t.name === 'plugin_uninstall')!
    expect(uninstallTool.approvalRequired).toBe(true)
  })
})

describe('SelfModifyRuntime 持久化（install / uninstall / restore）', () => {
  async function makeStore(): Promise<{ store: PluginStore; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), 'shanhai-plugins-'))
    return { store: new PluginStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) }
  }

  it('test 临时运行并撤回，不持久化', async () => {
    const { store, cleanup } = await makeStore()
    try {
      const hooks = makeHooks()
      const rt = new SelfModifyRuntime(hooks, store)
      const pkg = rt.define(
        { name: 'tmp', purpose: '测试', code: 'module.exports = (ctx) => { ctx.tools.register({ name: "t", description: "d", inputSchema: {}, riskLevel: "readonly", execute: () => "ok" }); return () => {}; }' },
        's-a',
      )

      const result = await rt.test(pkg.id, 's-a')
      expect(result.ok).toBe(true)
      // 测试后已撤回：注册的工具被撤销
      expect(rt.listPluginTools()).toHaveLength(0)
      // 未持久化
      expect(await store.list()).toHaveLength(0)
    } finally {
      await cleanup()
    }
  })

  it('install 持久化并激活，inspect 报告 installed，restore 恢复，uninstall 删除', async () => {
    const { store, cleanup } = await makeStore()
    try {
      const hooks = makeHooks()
      const rt = new SelfModifyRuntime(hooks, store)
      const pkg = rt.define(
        { name: 'todo-list', purpose: '待办', code: 'module.exports = (ctx) => { ctx.tools.register({ name: "todo", description: "d", inputSchema: {}, riskLevel: "readonly", execute: () => "ok" }); return () => {}; }' },
        's-a',
      )

      const { id } = await rt.install(pkg.id, 's-a')
      expect(id).toBe('todo-list')

      // 已激活 + 已标记 installed（跨会话全局可见）
      const report = rt.inspect('s-b') as { installed: Array<{ id: string }> }
      expect(report.installed.map((p) => p.id)).toEqual(['todo-list'])

      // 已持久化
      expect((await store.list()).map((m) => m.id)).toEqual(['todo-list'])

      // 模拟重启：新 runtime + 同一 store，restoreAll 恢复
      const hooks2 = makeHooks()
      const rt2 = new SelfModifyRuntime(hooks2, store)
      const restored = await rt2.restoreAll()
      expect(restored).toBe(1)
      expect(rt2.listPluginTools()).toEqual(['todo'])

      // 卸载：撤销 + 删除持久化
      await rt2.uninstall('todo-list')
      expect(await store.list()).toHaveLength(0)
    } finally {
      await cleanup()
    }
  })

  it('install 无 store 抛错', async () => {
    const rt = new SelfModifyRuntime(makeHooks())
    const pkg = rt.define({ name: 'x', purpose: 'y', code: 'module.exports = () => {}' }, 's-a')
    await expect(rt.install(pkg.id, 's-a')).rejects.toThrow(/仓库未装配/)
  })

  it('install 中文 name 无法生成持久化 id 抛错', async () => {
    const { store, cleanup } = await makeStore()
    try {
      const rt = new SelfModifyRuntime(makeHooks(), store)
      const pkg = rt.define({ name: '中文名', purpose: 'y', code: 'module.exports = () => {}' }, 's-a')
      await expect(rt.install(pkg.id, 's-a')).rejects.toThrow(/持久化 id/)
    } finally {
      await cleanup()
    }
  })
})
