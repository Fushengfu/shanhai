import { describe, it, expect } from 'vitest'
import { createMockComputerUseService, type ComputerUseService, type PerformActionResult } from '../src/computer-use'
import { createComputerUseSkill } from '../src/skill'

describe('ComputerUseService', () => {
  it('mock 兜底：空操作', async () => {
    const service = createMockComputerUseService()
    expect((await service.screenshot()).byteLength).toBe(0)
    await service.clickAt(1, 2)
    await service.typeText('hi')
    await service.pressKey('Enter')
  })
})

describe('createComputerUseSkill', () => {
  const skill = createComputerUseSkill(createMockComputerUseService())

  it('封装为可执行技能：id=computer-use，含 4 个脚本（screenshot/ocr/read_tree/action）', () => {
    expect(skill.id).toBe('computer-use')
    expect(skill.actions?.map((a) => a.name).sort()).toEqual(['action', 'ocr', 'read_tree', 'screenshot'])
  })

  it('风险粒度到 action 级：screenshot/ocr 只读免审批，read_tree 只读但需审批，action 不可逆需审批', () => {
    const screenshot = skill.actions!.find((a) => a.name === 'screenshot')!
    const ocr = skill.actions!.find((a) => a.name === 'ocr')!
    const readTree = skill.actions!.find((a) => a.name === 'read_tree')!
    const action = skill.actions!.find((a) => a.name === 'action')!
    expect(screenshot.riskLevel).toBe('readonly')
    expect(screenshot.approvalRequired).toBeUndefined()
    expect(ocr.riskLevel).toBe('readonly')
    expect(ocr.approvalRequired).toBeUndefined()
    expect(readTree.riskLevel).toBe('readonly')
    // 读树能读任意前台 App 窗口全文，比截图更敏感 → 只读但强制审批
    expect(readTree.approvalRequired).toBe(true)
    expect(action.riskLevel).toBe('irreversible')
    expect(action.approvalRequired).toBe(true)
  })

  it('action 脚本缺坐标/动作时报错', async () => {
    const action = skill.actions!.find((a) => a.name === 'action')!
    await expect(action.execute({})).rejects.toThrow(/不支持/)
    await expect(action.execute({ action: 'click' })).rejects.toThrow(/x\/y/)
  })
})

describe('computer_action 无障碍写操作路径（任务130）', () => {
  // 构造带 performAction 的 service：按入参返回可配置的三态，用于验证三态透传
  function makeService(result: PerformActionResult, spy: { called: boolean; params?: unknown }): ComputerUseService {
    const mock = createMockComputerUseService()
    mock.performAction = async (params) => {
      spy.called = true
      spy.params = params
      return result
    }
    return mock
  }

  it('传 targetRole/targetText 走无障碍路径，success 透传 ok=true 且 status=success', async () => {
    const spy = { called: false }
    const skill = createComputerUseSkill(makeService({ status: 'success', action: 'press', matchedCount: 1 }, spy))
    const action = skill.actions!.find((a) => a.name === 'action')!
    const r = (await action.execute({ action: 'press', targetRole: 'AXButton', targetText: '5' })) as Record<string, unknown>
    expect(spy.called).toBe(true)
    expect(r.status).toBe('success')
    expect(r.ok).toBe(true)
  })

  it('unconfirmed 透传 status=unconfirmed + ok=false + notice，绝不冒充 success', async () => {
    const spy = { called: false }
    const skill = createComputerUseSkill(makeService({ status: 'unconfirmed', delivered: true, changed: {} }, spy))
    const action = skill.actions!.find((a) => a.name === 'action')!
    const r = (await action.execute({ action: 'press', targetRole: 'AXButton', targetText: '5' })) as Record<string, unknown>
    expect(r.status).toBe('unconfirmed')
    expect(r.ok).toBe(false)
    expect(typeof r.notice).toBe('string')
    // 关键：不得出现 success
    expect(r.status).not.toBe('success')
  })

  it('failed 透传 status=failed + ok=false，reason 原样透传', async () => {
    const spy = { called: false }
    const skill = createComputerUseSkill(makeService({ status: 'failed', reason: 'element_not_found' }, spy))
    const action = skill.actions!.find((a) => a.name === 'action')!
    const r = (await action.execute({ action: 'press', targetText: '不存在' })) as Record<string, unknown>
    expect(r.status).toBe('failed')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('element_not_found')
  })

  it('action 缺省时归一化为 press（不报错）', async () => {
    const spy = { called: false, params: undefined as unknown }
    const skill = createComputerUseSkill(makeService({ status: 'success' }, spy))
    const action = skill.actions!.find((a) => a.name === 'action')!
    await action.execute({ targetText: '5' })
    expect(spy.called).toBe(true)
    expect((spy.params as Record<string, unknown>).action).toBe('press')
  })

  it('无障碍路径非法 action 响亮报错（不执行 undefined）', async () => {
    const spy = { called: false }
    const skill = createComputerUseSkill(makeService({ status: 'success' }, spy))
    const action = skill.actions!.find((a) => a.name === 'action')!
    await expect(action.execute({ action: 'click', targetText: '5' })).rejects.toThrow(/不支持的 action/)
    expect(spy.called).toBe(false)
  })

  it('performAction 未装配时返回可见降级原因（不抛错、不静默）', async () => {
    const skill = createComputerUseSkill(createMockComputerUseService())
    const action = skill.actions!.find((a) => a.name === 'action')!
    // mock 的 performAction 返回 failed/unsupported_platform，不会抛错
    const r = (await action.execute({ action: 'press', targetText: '5' })) as Record<string, unknown>
    expect(r.status).toBe('failed')
    expect(r.reason).toBe('unsupported_platform')
  })
})

describe('computer_action 坐标路径 type 回读校验（任务143 缺陷①）', () => {
  function makeService(overrides: Partial<ComputerUseService>): ComputerUseService {
    return { ...createMockComputerUseService(), ...overrides }
  }

  it('type 回读到相同文本 → success（ok=true）', async () => {
    let typed = ''
    const service = makeService({
      typeText: async (t) => { typed = t },
      readTree: async () => ({ ok: true, status: 'ok', text: 'AXTextField [雷涛]' }),
    })
    const skill = createComputerUseSkill(service)
    const action = skill.actions!.find((a) => a.name === 'action')!
    const r = (await action.execute({ action: 'type', text: '雷涛' })) as Record<string, unknown>
    expect(typed).toBe('雷涛')
    expect(r.status).toBe('success')
    expect(r.ok).toBe(true)
  })

  it('type 回读不到变化 → unconfirmed（ok=false，绝不冒充 success）', async () => {
    const service = makeService({
      typeText: async () => {},
      readTree: async () => ({ ok: true, status: 'ok', text: 'AXButton [确定]' }),
    })
    const skill = createComputerUseSkill(service)
    const action = skill.actions!.find((a) => a.name === 'action')!
    const r = (await action.execute({ action: 'type', text: '雷涛' })) as Record<string, unknown>
    expect(r.status).toBe('unconfirmed')
    expect(r.ok).toBe(false)
    expect(r.status).not.toBe('success')
  })

  it('typeText 抛错 → failed（ok=false）', async () => {
    const service = makeService({
      typeText: async () => { throw new Error('pbcopy 失败') },
    })
    const skill = createComputerUseSkill(service)
    const action = skill.actions!.find((a) => a.name === 'action')!
    const r = (await action.execute({ action: 'type', text: '雷涛' })) as Record<string, unknown>
    expect(r.status).toBe('failed')
    expect(r.ok).toBe(false)
  })

  it('无 readTree 回读能力 → unconfirmed（不冒充 success）', async () => {
    const service = makeService({
      typeText: async () => {},
      readTree: undefined,
    })
    const skill = createComputerUseSkill(service)
    const action = skill.actions!.find((a) => a.name === 'action')!
    const r = (await action.execute({ action: 'type', text: 'hi' })) as Record<string, unknown>
    expect(r.status).toBe('unconfirmed')
    expect(r.ok).toBe(false)
  })

  it('归一化匹配：全角Ａ 与回读半角 A 视为相同（NFKC）→ success', async () => {
    const service = makeService({
      typeText: async () => {},
      // 写入全角 Ａ（U+FF21），回读树里是半角 A（NFKC 后一致）
      readTree: async () => ({ ok: true, status: 'ok', text: 'AXTextField [A]' }),
    })
    const skill = createComputerUseSkill(service)
    const action = skill.actions!.find((a) => a.name === 'action')!
    const r = (await action.execute({ action: 'type', text: '\uFF21' })) as Record<string, unknown>
    expect(r.status).toBe('success')
  })

  it('归一化反向例：写入「雷涛」回读「雷明」不同 → unconfirmed（不误判成功）', async () => {
    const service = makeService({
      typeText: async () => {},
      readTree: async () => ({ ok: true, status: 'ok', text: 'AXTextField [雷明]' }),
    })
    const skill = createComputerUseSkill(service)
    const action = skill.actions!.find((a) => a.name === 'action')!
    const r = (await action.execute({ action: 'type', text: '雷涛' })) as Record<string, unknown>
    expect(r.status).toBe('unconfirmed')
    expect(r.ok).toBe(false)
  })
})

describe('computer_action 坐标点击前台命中校验（任务143 缺陷②）', () => {
  it('坐标处窗口 ≠ 前台 App → 停下报错（ok=false, reason=foreground_mismatch, 不点击）', async () => {
    let clicked = false
    const service: ComputerUseService = {
      ...createMockComputerUseService(),
      clickAt: async () => { clicked = true },
      windowOwnerAtPoint: async () => ({ matched: false, frontmost: 'QQ', ownerAtPoint: '访达' }),
    }
    const skill = createComputerUseSkill(service)
    const action = skill.actions!.find((a) => a.name === 'action')!
    const r = (await action.execute({ action: 'click', x: 100, y: 100 })) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('foreground_mismatch')
    expect(clicked).toBe(false)
  })

  it('坐标处窗口 == 前台 App → 正常点击（ok=true）', async () => {
    let clicked = false
    const service: ComputerUseService = {
      ...createMockComputerUseService(),
      clickAt: async () => { clicked = true },
      windowOwnerAtPoint: async () => ({ matched: true, frontmost: 'QQ', ownerAtPoint: 'QQ' }),
    }
    const skill = createComputerUseSkill(service)
    const action = skill.actions!.find((a) => a.name === 'action')!
    const r = (await action.execute({ action: 'click', x: 100, y: 100 })) as Record<string, unknown>
    expect(r.ok).toBe(true)
    expect(clicked).toBe(true)
  })

  it('无 windowOwnerAtPoint 能力 → 跳过校验直接点击（兜底不阻断）', async () => {
    let clicked = false
    const service: ComputerUseService = {
      ...createMockComputerUseService(),
      clickAt: async () => { clicked = true },
    }
    const skill = createComputerUseSkill(service)
    const action = skill.actions!.find((a) => a.name === 'action')!
    const r = (await action.execute({ action: 'click', x: 100, y: 100 })) as Record<string, unknown>
    expect(r.ok).toBe(true)
    expect(clicked).toBe(true)
  })
})
