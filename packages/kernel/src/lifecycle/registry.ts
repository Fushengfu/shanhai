import type { Kernel } from '../runtime/kernel'
import type { Fiber } from '../runtime/fiber'
import type { Plugin } from '../runtime/context'
import type { Capability } from '../types'
import type { Approver, PluginRecord, PluginVersion } from './types'

export interface PluginRegistryOptions {
  /** 看门狗：连续失败达到该值自动停用（inactive） */
  maxFailures?: number
}

/**
 * 版本生命周期注册表（K2）。
 *
 * 核心性质：
 * - 版本不可变：一经 stage 不可修改，更新不覆盖旧版。
 * - currentVersion 只在 fiber settle 到 active 后更新；失败不动、可回滚。
 * - rollback 跳过审批（旧版本此前已获授权）。
 * - 看门狗：连续失败达到阈值自动停用，避免反复重试坏版本。
 */
export class PluginRegistry {
  private readonly records = new Map<string, PluginRecord>()
  private readonly maxFailures: number

  constructor(
    private readonly kernel: Kernel,
    private readonly approve: Approver,
    options: PluginRegistryOptions = {},
  ) {
    this.maxFailures = options.maxFailures ?? 3
  }

  /** 登记一个不可变版本（不激活） */
  stage(
    id: string,
    version: string,
    apply: PluginVersion['apply'],
    opts: { inject?: string[]; capabilities?: Capability } = {},
  ): PluginVersion {
    let record = this.records.get(id)
    if (!record) {
      record = {
        id,
        versions: [],
        currentVersion: null,
        pendingVersion: null,
        grant: 'once',
        state: 'staged',
        run: null,
        failures: 0,
      }
      this.records.set(id, record)
    }
    if (record.versions.some((v) => v.version === version)) {
      throw new Error(`version ${version} already staged for ${id}`)
    }
    const ver: PluginVersion = { id, version, inject: opts.inject, capabilities: opts.capabilities, apply }
    record.versions.push(ver)
    return ver
  }

  /** 激活指定版本（返回 { fiber }：避免 Fiber 的 thenable 被 Promise 展开） */
  async activate(id: string, version: string): Promise<{ fiber: Fiber }> {
    const record = this.records.get(id)
    if (!record) throw new Error(`plugin ${id} not found`)
    const ver = record.versions.find((v) => v.version === version)
    if (!ver) throw new Error(`version ${version} not found for ${id}`)
    return this.activateInternal(record, ver, false)
  }

  /** 回滚到上一个版本（跳过审批） */
  async rollback(id: string): Promise<{ fiber: Fiber }> {
    const record = this.records.get(id)
    if (!record) throw new Error(`plugin ${id} not found`)
    if (!record.currentVersion) throw new Error(`plugin ${id} has no active version`)
    const idx = record.versions.findIndex((v) => v.version === record.currentVersion)
    const prev = record.versions[idx - 1]
    if (!prev) throw new Error(`plugin ${id} has no previous version to rollback`)
    return this.activateInternal(record, prev, true)
  }

  /** 停用当前版本（撤销 fiber，保留版本历史） */
  async deactivate(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) throw new Error(`plugin ${id} not found`)
    if (record.run) {
      await record.run.dispose()
      record.run = null
    }
    record.currentVersion = null
    record.pendingVersion = null
    record.state = 'inactive'
  }

  /** 卸载：停止并删除全部版本与授权 */
  async uninstall(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) return
    if (record.run) {
      await record.run.dispose()
    }
    this.records.delete(id)
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(id)
  }

  list(): PluginRecord[] {
    return [...this.records.values()]
  }

  private async activateInternal(
    record: PluginRecord,
    version: PluginVersion,
    skipApproval: boolean,
  ): Promise<{ fiber: Fiber }> {
    // 幂等：已是当前活跃版本
    const currentRun = record.run
    if (record.currentVersion === version.version && currentRun?.state === 'ACTIVE') {
      return { fiber: currentRun }
    }

    // 审批（回滚跳过）
    if (!skipApproval && record.grant !== 'trusted') {
      const decision = await this.approve(record, version)
      if (decision === 'reject') throw new Error(`plugin ${record.id}@${version.version} rejected`)
      if (decision === 'trust') record.grant = 'trusted'
    }

    // 停旧 fiber（撤销旧副作用）
    if (record.run) {
      await record.run.dispose()
      record.run = null
    }

    // 启新 fiber
    record.pendingVersion = version.version
    const fiber = this.kernel.plugin({
      name: record.id,
      inject: version.inject,
      apply: version.apply,
    } as Plugin)
    record.run = fiber

    try {
      await fiber.await()
      record.currentVersion = version.version
      record.pendingVersion = null
      record.state = 'active'
      record.failures = 0
    } catch (err) {
      record.failures++
      record.state = record.failures >= this.maxFailures ? 'inactive' : 'failed'
      throw err
    }

    return { fiber }
  }
}
