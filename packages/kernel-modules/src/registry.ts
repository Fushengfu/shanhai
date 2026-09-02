import type { BootManifest, BootPlugin } from './manifest'

export interface ClientPluginDeclaration {
  id: string
  moduleId: string
  slots: string[]
}

/**
 * 客户端插件注册表（host 侧）。
 *
 * 宿主侧插件声明 client 半（moduleId + slots），注册后组合成引导清单（BootManifest）。
 */
export class ClientModuleRegistry {
  private readonly modules = new Map<string, string>()
  private readonly plugins: ClientPluginDeclaration[] = []

  registerModule(id: string, path: string): void {
    this.modules.set(id, path)
  }

  registerPlugin(plugin: ClientPluginDeclaration): void {
    this.plugins.push(plugin)
  }

  /** 组合引导清单 */
  buildManifest(): BootManifest {
    return {
      modules: [...this.modules.entries()].map(([id, path]) => ({ id, path })),
      plugins: this.plugins.map((p) => ({ id: p.id, moduleId: p.moduleId, slots: p.slots })),
    }
  }
}
