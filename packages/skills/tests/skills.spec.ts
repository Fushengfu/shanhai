import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SkillService, type Skill } from '../src/skill'
import { createSkillTools } from '../src/tools'

describe('SkillService', () => {
  it('列出内置技能（开箱即用）', async () => {
    const svc = new SkillService(join(tmpdir(), 'shanhai-skills-nonexistent-1'))
    const skills = await svc.list()
    expect(skills.length).toBeGreaterThan(0)
    expect(skills.some((s) => s.id === 'code-review')).toBe(true)
    expect(skills.some((s) => s.id === 'code-search')).toBe(true)
    expect(skills.every((s) => s.source === 'builtin')).toBe(true)
  })

  it('扫描用户技能目录并解析 frontmatter + 正文', async () => {
    const dir = join(tmpdir(), `shanhai-skills-test-${Date.now()}`)
    await fs.mkdir(join(dir, 'my-skill'), { recursive: true })
    await fs.writeFile(
      join(dir, 'my-skill', 'SKILL.md'),
      '---\nname: 我的技能\ndescription: 测试技能\n---\n\n这是操作指南正文。\n第二行。\n',
      'utf8',
    )
    const svc = new SkillService(dir)
    const skills = await svc.list()
    const mine = skills.find((s) => s.id === 'my-skill')
    expect(mine).toBeDefined()
    expect(mine?.name).toBe('我的技能')
    expect(mine?.description).toBe('测试技能')
    expect(mine?.instructions).toContain('操作指南正文')
    expect(mine?.source).toBe('user')
    // read 按 id 读取
    const read = await svc.read('my-skill')
    expect(read?.instructions).toContain('第二行')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('用户技能与内置技能同名 id 时用户技能覆盖', async () => {
    const dir = join(tmpdir(), `shanhai-skills-test-${Date.now()}`)
    await fs.mkdir(join(dir, 'code-review'), { recursive: true })
    await fs.writeFile(
      join(dir, 'code-review', 'SKILL.md'),
      '---\nname: 自定义审查\ndescription: 覆盖内置\n---\n\n自定义正文。\n',
      'utf8',
    )
    const svc = new SkillService(dir)
    const skills = await svc.list()
    const cr = skills.find((s) => s.id === 'code-review')
    expect(cr?.name).toBe('自定义审查')
    expect(cr?.source).toBe('user')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('注册可执行技能：list/read/findAction 均可见，优先级高于内置', async () => {
    const svc = new SkillService(join(tmpdir(), 'shanhai-skills-nonexistent-3'))
    const executable: Skill = {
      id: 'demo-runner',
      name: '演示执行器',
      description: '测试用可执行技能',
      source: 'builtin',
      instructions: '按清单执行脚本。',
      actions: [
        {
          name: 'greet',
          description: '打招呼',
          params: { who: '要打招呼的对象' },
          required: ['who'],
          riskLevel: 'readonly',
          execute: async (params) => ({ ok: true, msg: `hello ${params.who}` }),
        },
      ],
    }
    svc.registerExecutable(executable)
    const skills = await svc.list()
    expect(skills.some((s) => s.id === 'demo-runner')).toBe(true)
    const read = await svc.read('demo-runner')
    expect(read?.actions).toHaveLength(1)
    expect(read?.actions?.[0]?.name).toBe('greet')
    const act = await svc.findAction('demo-runner', 'greet')
    expect(act).toBeDefined()
    const notFound = await svc.findAction('demo-runner', 'nope')
    expect(notFound).toBeUndefined()
  })
})

describe('createSkillTools', () => {
  it('生成 skill_list / skill_read / skill_run 三个工具', async () => {
    const svc = new SkillService(join(tmpdir(), 'shanhai-skills-nonexistent-4'))
    const tools = createSkillTools(svc)
    expect(tools.map((t) => t.name).sort()).toEqual(['skill_list', 'skill_read', 'skill_run'].sort())

    const listResult = (await tools[0]!.execute({})) as { skills: unknown[] }
    expect(Array.isArray(listResult.skills)).toBe(true)
    expect(listResult.skills.length).toBeGreaterThan(0)

    const readResult = (await tools[1]!.execute({ id: 'code-review' })) as { instructions: string }
    expect(readResult.instructions).toBeTruthy()

    const missing = (await tools[1]!.execute({ id: 'nope' })) as { error: string }
    expect(missing.error).toBeTruthy()
  })

  it('skill_run 执行可执行技能的脚本；skill_read 返回 actions 清单；resolveRisk 动态风险', async () => {
    const svc = new SkillService(join(tmpdir(), 'shanhai-skills-nonexistent-5'))
    svc.registerExecutable({
      id: 'demo',
      name: '演示',
      description: '测试',
      source: 'builtin',
      instructions: '手册正文',
      actions: [
        {
          name: 'read',
          description: '只读动作',
          params: {},
          riskLevel: 'readonly',
          execute: async () => ({ value: 42 }),
        },
        {
          name: 'write',
          description: '危险动作',
          params: { path: '路径' },
          required: ['path'],
          riskLevel: 'irreversible',
          approvalRequired: true,
          execute: async (params) => ({ wrote: params.path }),
        },
      ],
    })
    const tools = createSkillTools(svc)
    const skillRun = tools.find((t) => t.name === 'skill_run')!
    const skillRead = tools.find((t) => t.name === 'skill_read')!

    // skill_read 返回 actions 清单（不含 execute）
    const read = (await skillRead.execute({ id: 'demo' })) as { actions: Array<{ name: string }> }
    expect(read.actions.map((a) => a.name).sort()).toEqual(['read', 'write'])

    // 执行 read action
    const readResult = (await skillRun.execute({ skillId: 'demo', action: 'read', params: {} })) as { value: number }
    expect(readResult.value).toBe(42)

    // 执行 write action（参数透传）
    const writeResult = (await skillRun.execute({ skillId: 'demo', action: 'write', params: { path: '/tmp/x' } })) as { wrote: string }
    expect(writeResult.wrote).toBe('/tmp/x')

    // 不存在的 action 报错
    const badAction = (await skillRun.execute({ skillId: 'demo', action: 'nope', params: {} })) as { error: string }
    expect(badAction.error).toContain('不存在脚本')

    // 缺 skillId/action 报错
    const missingArgs = (await skillRun.execute({})) as { error: string }
    expect(missingArgs.error).toContain('缺少')

    // resolveRisk 动态风险：read → readonly，write → irreversible + 需审批
    const readRisk = await skillRun.resolveRisk!({ skillId: 'demo', action: 'read' })
    expect(readRisk.riskLevel).toBe('readonly')
    expect(readRisk.approvalRequired).toBe(false)
    const writeRisk = await skillRun.resolveRisk!({ skillId: 'demo', action: 'write' })
    expect(writeRisk.riskLevel).toBe('irreversible')
    expect(writeRisk.approvalRequired).toBe(true)
  })
})
