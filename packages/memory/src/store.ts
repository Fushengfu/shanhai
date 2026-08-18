import { CONFIG_SCOPES, type MemoryEntry, type MemoryScope, type MemorySource } from './types'

export interface SaveMeta {
  source?: MemorySource
  confidence?: number
}

/**
 * 分层记忆存储（内存实现）。
 *
 * - 配置型（CONFIG_SCOPES）：全量注入、写前归档、可回滚。
 * - 经验型（task_experience）：相关性召回（按 key/内容匹配）、置信度标注。
 */
export class MemoryStore {
  private entries: MemoryEntry[] = []
  private readonly archives = new Map<string, MemoryEntry[]>()
  private nextId = 1

  save(scope: MemoryScope, key: string, value: unknown, meta?: SaveMeta): MemoryEntry {
    const entry: MemoryEntry = {
      id: this.nextId++,
      scope,
      key,
      value,
      source: meta?.source ?? 'explicit',
      confidence: meta?.confidence ?? 1,
      timestamp: Date.now(),
    }
    if (CONFIG_SCOPES.includes(scope)) {
      const hk = `${scope}:${key}`
      const current = this.entries.filter((e) => e.scope === scope && e.key === key).at(-1)
      if (current) {
        const hist = this.archives.get(hk) ?? []
        hist.push(current)
        this.archives.set(hk, hist)
      }
      // 配置型：同 key 只保留最新值
      this.entries = this.entries.filter((e) => !(e.scope === scope && e.key === key))
    }
    this.entries.push(entry)
    return entry
  }

  list(scope?: MemoryScope): MemoryEntry[] {
    if (!scope) return [...this.entries]
    return this.entries.filter((e) => e.scope === scope)
  }

  /** 删除一条记忆（按 id） */
  remove(id: number): boolean {
    const idx = this.entries.findIndex((e) => e.id === id)
    if (idx < 0) return false
    this.entries.splice(idx, 1)
    return true
  }

  /** 召回：按 key / 内容关键词匹配，返回最新的在前 */
  recall(scope: MemoryScope, keyword?: string): MemoryEntry[] {
    let list = this.entries.filter((e) => e.scope === scope)
    if (keyword) {
      list = list.filter(
        (e) => e.key.includes(keyword) || JSON.stringify(e.value).includes(keyword),
      )
    }
    return [...list].reverse()
  }

  history(scope: MemoryScope, key: string): MemoryEntry[] {
    return [...(this.archives.get(`${scope}:${key}`) ?? [])]
  }

  /** 回滚到上一个历史版本（仅配置型） */
  rollback(scope: MemoryScope, key: string): boolean {
    const hk = `${scope}:${key}`
    const hist = this.archives.get(hk)
    const last = hist?.at(-1)
    if (!last || !hist) return false
    this.entries = this.entries.filter((e) => !(e.scope === scope && e.key === key))
    this.entries.push({ ...last, id: this.nextId++, timestamp: Date.now() })
    hist.pop()
    return true
  }
}
