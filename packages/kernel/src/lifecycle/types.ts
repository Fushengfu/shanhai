import type { Capability, Grant, PluginState } from '../types'
import type { Fiber, FiberApply } from '../runtime/fiber'

/** 插件版本（不可变，一经 stage 不可修改） */
export interface PluginVersion {
  id: string
  version: string
  inject?: string[]
  capabilities?: Capability
  apply: FiberApply
}

/** 插件记录：一个 pluginId 的版本历史 + 运行时状态 */
export interface PluginRecord {
  id: string
  versions: PluginVersion[]
  currentVersion: string | null
  pendingVersion: string | null
  grant: Grant
  state: PluginState
  run: Fiber | null
  failures: number
}

/** 审批回调：由上层提供（UI 异步应答 / 策略） */
export type Approver = (
  record: PluginRecord,
  version: PluginVersion,
) => Promise<'allow' | 'reject' | 'trust'>
