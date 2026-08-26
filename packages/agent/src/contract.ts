import type { ToolContract } from '@shanhai/tools'

export type { ToolContract }

export interface SkillContract {
  name: string
  description: string
  /** 引用工具注册表的原子工具名 */
  internalTools: string[]
  /** 技能专用提示词 */
  prompt?: string
}
