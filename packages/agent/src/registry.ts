import type { ToolContract } from '@shanhai/tools'
import type { SkillContract, RoleDefinition } from './contract'

export class ToolRegistry {
  private readonly tools = new Map<string, ToolContract>()
  register(tool: ToolContract): void {
    this.tools.set(tool.name, tool)
  }
  get(name: string): ToolContract | undefined {
    return this.tools.get(name)
  }
  list(): ToolContract[] {
    return [...this.tools.values()]
  }
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillContract>()
  register(skill: SkillContract): void {
    this.skills.set(skill.name, skill)
  }
  get(name: string): SkillContract | undefined {
    return this.skills.get(name)
  }
  list(): SkillContract[] {
    return [...this.skills.values()]
  }
}

export class RoleRegistry {
  private readonly roles = new Map<string, RoleDefinition>()
  register(role: RoleDefinition): void {
    this.roles.set(role.id, role)
  }
  get(id: string): RoleDefinition | undefined {
    return this.roles.get(id)
  }
  list(): RoleDefinition[] {
    return [...this.roles.values()]
  }
}
