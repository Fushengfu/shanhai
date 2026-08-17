import { describe, it, expect, vi } from 'vitest'
import { Kernel } from '../src/runtime/kernel'
import { PluginRegistry } from '../src/lifecycle/registry'

describe('K2 版本生命周期', () => {
  it('stage + activate 更新 currentVersion 并激活', async () => {
    const kernel = new Kernel()
    const registry = new PluginRegistry(kernel, async () => 'allow')
    registry.stage('p', '1.0.0', () => {})
    const { fiber } = await registry.activate('p', '1.0.0')
    expect(registry.get('p')?.currentVersion).toBe('1.0.0')
    expect(fiber.state).toBe('ACTIVE')
  })

  it('reject 审批抛错，不激活', async () => {
    const kernel = new Kernel()
    const registry = new PluginRegistry(kernel, async () => 'reject')
    registry.stage('p', '1.0.0', () => {})
    await expect(registry.activate('p', '1.0.0')).rejects.toThrow('rejected')
    expect(registry.get('p')?.currentVersion).toBeNull()
  })

  it('trust 后不再审批', async () => {
    const kernel = new Kernel()
    const approve = vi.fn(async () => 'trust' as const)
    const registry = new PluginRegistry(kernel, approve)
    registry.stage('p', '1.0.0', () => {})
    registry.stage('p', '2.0.0', () => {})
    await registry.activate('p', '1.0.0')
    await registry.activate('p', '2.0.0')
    expect(approve).toHaveBeenCalledTimes(1)
  })

  it('rollback 回滚到上一个版本', async () => {
    const kernel = new Kernel()
    const registry = new PluginRegistry(kernel, async () => 'allow')
    registry.stage('p', '1.0.0', () => {})
    registry.stage('p', '2.0.0', () => {})
    await registry.activate('p', '1.0.0')
    await registry.activate('p', '2.0.0')
    expect(registry.get('p')?.currentVersion).toBe('2.0.0')
    await registry.rollback('p')
    expect(registry.get('p')?.currentVersion).toBe('1.0.0')
  })

  it('看门狗：连续失败达阈值置 inactive', async () => {
    const kernel = new Kernel()
    const registry = new PluginRegistry(kernel, async () => 'allow', { maxFailures: 2 })
    registry.stage('p', '1.0.0', () => {
      throw new Error('boom')
    })
    await expect(registry.activate('p', '1.0.0')).rejects.toThrow('boom')
    await expect(registry.activate('p', '1.0.0')).rejects.toThrow('boom')
    expect(registry.get('p')?.state).toBe('inactive')
  })
})
