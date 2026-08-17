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

/** 角色定义（专家即配置）：一个专家 = 通用运行时 + 一份角色 JSON */
export interface RoleDefinition {
  id: string
  name: string
  description: string
  systemPrompt: string
  toolSet: string[]
  skillSet: string[]
}
