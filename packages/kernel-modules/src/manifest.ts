/**
 * __DSH_BOOT__ 清单（wire 单一来源）。
 *
 * 宿主扫出所有声明 client 半的插件，组合成 BootManifest，渲染进程按清单懒加载。
 * parseBootManifest 在 wire 边界校验，失败响亮报错（不静默吞）。
 */

export interface BootModule {
  id: string
  path: string
}

export interface BootPlugin {
  id: string
  moduleId: string
  slots: string[]
}

export interface BootManifest {
  modules: BootModule[]
  plugins: BootPlugin[]
}

/** 在 wire 边界校验并解析 BootManifest（非法输入抛错） */
export function parseBootManifest(raw: unknown): BootManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('BootManifest must be an object')
  }
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.modules) || !Array.isArray(obj.plugins)) {
    throw new Error('BootManifest.modules and .plugins must be arrays')
  }
  for (const m of obj.modules as unknown[]) {
    const mod = m as Record<string, unknown>
    if (typeof mod?.id !== 'string' || typeof mod?.path !== 'string') {
      throw new Error('BootManifest module must have string id and path')
    }
  }
  for (const p of obj.plugins as unknown[]) {
    const plugin = p as Record<string, unknown>
    if (typeof plugin?.id !== 'string' || typeof plugin?.moduleId !== 'string') {
      throw new Error('BootManifest plugin must have string id and moduleId')
    }
    if (plugin.slots !== undefined && !Array.isArray(plugin.slots)) {
      throw new Error('BootManifest plugin.slots must be an array')
    }
  }
  return obj as unknown as BootManifest
}
