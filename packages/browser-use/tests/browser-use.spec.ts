import { describe, it, expect } from 'vitest'
import { createMockBrowserUseService } from '../src/browser-use'
import { createBrowserUseTools } from '../src/tools'
import { createBrowserUseSkill } from '../src/skill'

describe('BrowserUseService mock', () => {
  it('mock 兜底：空操作', async () => {
    const service = createMockBrowserUseService()
    expect((await service.screenshot()).byteLength).toBe(0)
    expect((await service.list())[0]?.appId).toBe('default')
    await service.navigate('https://example.com')
    await service.click('#btn')
    await service.type('#input', 'hi')
    expect(await service.getContent()).toBe('')
    expect((await service.getInfo()).url).toBe('')
  })
})

describe('createBrowserUseTools', () => {
  const service = createMockBrowserUseService()
  const tools = createBrowserUseTools(service)
  const byName = new Map(tools.map((t) => [t.name, t]))

  it('生成 17 个工具，覆盖导航/观察/动作/诊断/会话态', () => {
    expect(tools).toHaveLength(17)
    const names = [
      'browser_create',
      'browser_list',
      'browser_navigate',
      'browser_close',
      'browser_screenshot',
      'browser_get_info',
      'browser_get_content',
      'browser_evaluate',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_wait',
      'browser_get_console_logs',
      'browser_get_network_requests',
      'browser_get_cookies',
      'browser_set_cookie',
      'browser_clear_cookies',
    ]
    names.forEach((n) => expect(byName.has(n)).toBe(true))
  })

  it('浏览器用于测试/查资料，所有工具免审批；读操作只读', () => {
    expect(byName.get('browser_click')?.approvalRequired).toBeUndefined()
    expect(byName.get('browser_type')?.approvalRequired).toBeUndefined()
    expect(byName.get('browser_clear_cookies')?.approvalRequired).toBeUndefined()
    expect(byName.get('browser_click')?.riskLevel).toBe('reversible')
    expect(byName.get('browser_type')?.riskLevel).toBe('reversible')
    expect(byName.get('browser_screenshot')?.riskLevel).toBe('readonly')
    expect(byName.get('browser_get_content')?.riskLevel).toBe('readonly')
  })

  it('navigate 缺 url 响亮报错', async () => {
    await expect(byName.get('browser_navigate')!.execute({})).rejects.toThrow(/url/)
  })

  it('click 缺 selector 响亮报错', async () => {
    await expect(byName.get('browser_click')!.execute({})).rejects.toThrow(/selector/)
  })

  it('evaluate 缺 code 响亮报错', async () => {
    await expect(byName.get('browser_evaluate')!.execute({})).rejects.toThrow(/code/)
  })
})

describe('createBrowserUseSkill', () => {
  const service = createMockBrowserUseService()
  const skill = createBrowserUseSkill(service)

  it('封装为可执行技能：id=browser-use，含 17 个脚本，全部免审批', () => {
    expect(skill.id).toBe('browser-use')
    expect(skill.actions).toHaveLength(17)
    // action 名已去掉 browser_ 前缀
    const names = skill.actions!.map((a) => a.name)
    expect(names).toContain('navigate')
    expect(names).toContain('click')
    expect(names).toContain('screenshot')
    expect(names).not.toContain('browser_navigate')
    // 浏览器全部免审批
    expect(skill.actions!.every((a) => a.approvalRequired !== true)).toBe(true)
  })

  it('脚本可执行：navigate 缺 url 报错，click 缺 selector 报错', async () => {
    const navigate = skill.actions!.find((a) => a.name === 'navigate')!
    await expect(navigate.execute({})).rejects.toThrow(/url/)
    const click = skill.actions!.find((a) => a.name === 'click')!
    await expect(click.execute({})).rejects.toThrow(/selector/)
  })

  it('脚本参数说明从 inputSchema 提取', () => {
    const navigate = skill.actions!.find((a) => a.name === 'navigate')!
    expect(navigate.params.url).toBeTruthy()
    expect(navigate.required).toContain('url')
  })
})
