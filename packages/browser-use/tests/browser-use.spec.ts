import { describe, it, expect } from 'vitest'
import { createMockBrowserUseService } from '../src/browser-use'
import { createBrowserUseTools } from '../src/tools'

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

  it('写操作（click/type）标记不可逆并需审批，读操作只读', () => {
    expect(byName.get('browser_click')?.approvalRequired).toBe(true)
    expect(byName.get('browser_type')?.approvalRequired).toBe(true)
    expect(byName.get('browser_clear_cookies')?.approvalRequired).toBe(true)
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
