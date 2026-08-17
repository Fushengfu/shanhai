import { describe, it, expect } from 'vitest'
import { createMockComputerUseService } from '../src/computer-use'

describe('ComputerUseService', () => {
  it('mock 兜底：空操作', async () => {
    const service = createMockComputerUseService()
    expect((await service.screenshot()).byteLength).toBe(0)
    await service.clickAt(1, 2)
    await service.typeText('hi')
    await service.pressKey('Enter')
  })
})
