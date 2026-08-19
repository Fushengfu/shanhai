import type { Capability } from '../types'

export type DynamicPackageStatus = 'defined' | 'running' | 'stopped'

/** 动态 package（仅内存态：不落盘、不存活重启、会话级隔离） */
export interface DynamicPackage {
  id: string
  name: string
  purpose: string
  code?: string
  client?: string
  status: DynamicPackageStatus
  sessionId: string
  capabilities?: Capability
}

export interface InspectReport {
  /** 当前已知的服务名（由上层注入） */
  services: string[]
  /** 动态 package 列表 */
  packages: DynamicPackage[]
}

/**
 * 动态插件清单（K5 自修改）。
 *
 * 对应 DSH extensions 机制的 plugin_inspect / plugin_define / plugin_stop / plugin_undefine：
 * 只读报告、记录 package、撤回、遗忘。plugin_run 的 vm 沙箱评估在 runtime 层集成审批后执行。
 */
export class PluginInventory {
  private readonly packages = new Map<string, DynamicPackage>()
  private counter = 0

  /** plugin_define：记录 package（语法检查不运行），返回卡片 */
  define(def: {
    name: string
    purpose: string
    code?: string
    client?: string
    sessionId: string
  }): DynamicPackage {
    const pkg: DynamicPackage = {
      id: `dyn-${++this.counter}`,
      name: def.name,
      purpose: def.purpose,
      code: def.code,
      client: def.client,
      status: 'defined',
      sessionId: def.sessionId,
    }
    this.packages.set(pkg.id, pkg)
    return pkg
  }

  get(id: string): DynamicPackage | undefined {
    return this.packages.get(id)
  }

  list(): DynamicPackage[] {
    return [...this.packages.values()]
  }

  setStatus(id: string, status: DynamicPackageStatus): void {
    const pkg = this.packages.get(id)
    if (pkg) pkg.status = status
  }

  /** plugin_undefine：停止并遗忘定义 */
  remove(id: string): void {
    this.packages.delete(id)
  }

  /** plugin_inspect：只读报告（services 由上层注入，packages 为动态包列表） */
  inspect(services: string[] = []): InspectReport {
    return {
      services,
      packages: this.list(),
    }
  }
}
