import { describe, it, expect, vi } from 'vitest'
import { createMockTerminalService, type TerminalService } from '../src/terminal'
import { createTerminalTools } from '../src/tools'
import { createTerminalSkill } from '../src/skill'

describe('TerminalService mock', () => {
  it('mock 兜底：空操作', async () => {
    const service = createMockTerminalService()
    expect(await service.create()).toBe('default')
    expect((await service.run('default', 'ls')).output).toBe('')
    expect(await service.list()).toEqual([])
    await service.close('default')
  })
})

describe('createTerminalTools', () => {
  const service = createMockTerminalService()
  const tools = createTerminalTools(service)
  const byName = new Map(tools.map((t) => [t.name, t]))

  it('生成 4 个工具：create/run/list/close', () => {
    expect(tools).toHaveLength(4)
    expect(byName.has('terminal_create')).toBe(true)
    expect(byName.has('terminal_run')).toBe(true)
    expect(byName.has('terminal_list')).toBe(true)
    expect(byName.has('terminal_close')).toBe(true)
  })

  it('终端是 agent 受控工作台，所有工具免审批', () => {
    for (const t of tools) expect(t.approvalRequired).toBeUndefined()
    expect(byName.get('terminal_run')?.riskLevel).toBe('reversible')
    expect(byName.get('terminal_list')?.riskLevel).toBe('readonly')
  })

  it('run 缺 command 响亮报错', async () => {
    await expect(byName.get('terminal_run')!.execute({})).rejects.toThrow(/command/)
  })
})

describe('createTerminalSkill', () => {
  const service = createMockTerminalService()
  const skill = createTerminalSkill(service)

  it('封装为可执行技能：id=terminal，含 4 个脚本，全部免审批', () => {
    expect(skill.id).toBe('terminal')
    expect(skill.actions).toHaveLength(4)
    const names = skill.actions!.map((a) => a.name)
    expect(names).toContain('create')
    expect(names).toContain('run')
    expect(names).toContain('list')
    expect(names).toContain('close')
    expect(names).not.toContain('terminal_create')
    expect(skill.actions!.every((a) => a.approvalRequired !== true)).toBe(true)
  })

  it('脚本可执行：run 缺 command 报错', async () => {
    const run = skill.actions!.find((a) => a.name === 'run')!
    await expect(run.execute({})).rejects.toThrow(/command/)
  })

  it('脚本参数说明从 inputSchema 提取', () => {
    const run = skill.actions!.find((a) => a.name === 'run')!
    expect(run.params.command).toBeTruthy()
    expect(run.required).toContain('command')
  })
})

describe('createTerminalTools 端到端（mock 记录命令）', () => {
  it('run 通过 service.run 透传命令与 terminalId，返回输出', async () => {
    const run = vi.fn(async (terminalId: string, command: string) => ({ output: `ran[${terminalId}]: ${command}`, exitCode: 0 }))
    const service: TerminalService = {
      create: async () => 'default',
      run,
      list: async () => [{ terminalId: 'default', name: 'build' }],
      close: async () => {},
    }
    const tools = createTerminalTools(service)
    const runTool = tools.find((t) => t.name === 'terminal_run')!
    const result = (await runTool.execute({ terminalId: 'default', command: 'pnpm build' })) as { output: string }
    expect(run).toHaveBeenCalledWith('default', 'pnpm build', undefined)
    expect(result.output).toBe('ran[default]: pnpm build')
  })
})
