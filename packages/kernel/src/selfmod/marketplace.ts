/** 插件来源（市场）：提供可安装插件的清单与元数据 */
export interface PluginSource {
  id: string
  list(): Promise<Array<{ id: string; version: string }>>
  fetch(pluginId: string, version: string): Promise<unknown>
}

export interface UpdateCheck {
  current: string | null
  latest: string | null
  hasUpdate: boolean
}

/**
 * 升级检查（K5 自修改）。
 *
 * 只负责「是否有新版本」的查询与判断，实际的 stage/activate 交给 PluginRegistry（K2）。
 */
export class Updater {
  constructor(private readonly source: PluginSource) {}

  async check(pluginId: string, currentVersion: string | null): Promise<UpdateCheck> {
    const list = await this.source.list()
    const found = list.find((p) => p.id === pluginId)
    const latest = found?.version ?? null
    return {
      current: currentVersion,
      latest,
      hasUpdate: latest !== null && latest !== currentVersion,
    }
  }
}
