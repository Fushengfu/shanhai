import { describe, it, expect } from 'vitest'
import { createMockComputerUseService } from '../src/computer-use'
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

  it('封装为可执行技能：id=computer-use，含 3 个脚本（screenshot/ocr/action）', () => {
    expect(skill.id).toBe('computer-use')
    expect(skill.actions?.map((a) => a.name).sort()).toEqual(['action', 'ocr', 'screenshot'])
  })

  it('风险粒度到 action 级：screenshot/ocr 只读免审批，action 不可逆需审批', () => {
    const screenshot = skill.actions!.find((a) => a.name === 'screenshot')!
    const ocr = skill.actions!.find((a) => a.name === 'ocr')!
    const action = skill.actions!.find((a) => a.name === 'action')!
    expect(screenshot.riskLevel).toBe('readonly')
    expect(screenshot.approvalRequired).toBeUndefined()
    expect(ocr.riskLevel).toBe('readonly')
    expect(action.riskLevel).toBe('irreversible')
    expect(action.approvalRequired).toBe(true)
  })

  it('action 脚本缺坐标/动作时报错', async () => {
    const action = skill.actions!.find((a) => a.name === 'action')!
    await expect(action.execute({})).rejects.toThrow(/不支持/)
    await expect(action.execute({ action: 'click' })).rejects.toThrow(/x\/y/)
  })
})
