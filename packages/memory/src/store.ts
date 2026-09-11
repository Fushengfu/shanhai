import fs from 'node:fs'
import {
  ARCHIVE_DIR,
  SCOPE_DIRS,
  archiveFileSync,
  atomicWriteFileSync,
  ensureVaultSkeleton,
  parseMemoryFile,
  scanVault,
  serializeEntry,
  slugifyName,
  vaultBaseDir,
  type UnknownFile,
} from './vault'
import { CONFIG_SCOPES, type MemoryEntry, type MemoryScope, type MemorySource } from './types'

export interface SaveMeta {
  source?: MemorySource
  confidence?: number
  sessionId?: string
}

/** 【任务256】vault 后端选项。**不传则退化为纯内存实现**（等价改造前行为，保证签名与调用方零改动） */
export interface MemoryVaultOptions {
  /** vault 根（`~/.shanhai/memory/`）；缺省 = 不落盘 */
  vaultRoot?: string
  /** 写失败/异常的诊断出口（**不再静默吞掉**）；调用方接 console.warn 或上报 UI */
  onError?: (message: string) => void
}

export interface MemoryPersistStatus {
  ok: boolean
  /** 最近一次写失败原因（读后即清） */
  error?: string
  /** 累计写失败次数 */
  failures: number
  /** 未被认定为山海记忆的 .md（**只登记、永不删除**） */
  unknownFiles: UnknownFile[]
}

/**
 * 分层记忆存储。
 *
 * 【任务256 · 形态B】后端由「内存 + 全量覆盖 JSON」改为「**vault 单文件原子写**」：
 * - 读：启动时 `load()` 扫 `~/.shanhai/memory/`（`sessions/**`、`_global/**`），只在内存里留索引。
 * - 写：`save()` 只原子写「key 对应的那一个 .md」，**再也不存在全量重写** ⇒
 *   用户在 Obsidian 里改过的其它文件**在物理上不可能被山海覆盖**。
 * - 覆盖前把旧文件 rename 进 `_archive/`（**归档而非删除**，旧正文永不静默丢）。
 * - 五个对外方法（save/list/listBySession/remove/recall）**签名逐字未变**，调用方无需改动。
 */
export class MemoryStore {
  private entries: MemoryEntry[] = []
  private readonly archives = new Map<string, MemoryEntry[]>()
  private nextId = 1
  /** id → 该条目当前落盘的文件路径 */
  private readonly fileOf = new Map<number, string>()
  /**
   * 【任务261】文件绝对路径 → 「本进程已知的最后 mtime」（`load()` 读到它、`writeEntry()` 刚写完它时记录）。
   *
   * 写前 stat 的判据**不再**用 `entry.updated - 1000` —— 那个方向是反的：
   * 我们自己刚写完的 mtime 必然 ≥ `updated - 1000`，于是**每次 `update()` 都被误判成「用户手改」**，
   * 既往 `_archive/` 白扔一份副本、又打一条假日志。
   * 现在改为「文件 mtime 晚于本进程上次写/读它的时间」⇒ 只有**真的被外部改过**才算命中（B 语义一字未丢）。
   */
  private readonly knownMtimes = new Map<string, number>()
  private readonly vaultRoot?: string
  private readonly onError?: (message: string) => void
  private lastWriteError: string | null = null
  private failureCount = 0
  private unknownFiles: UnknownFile[] = []

  constructor(opts?: MemoryVaultOptions) {
    this.vaultRoot = opts?.vaultRoot
    this.onError = opts?.onError
  }

  /** 诊断出口：写失败**不再静默**（原实现是 `catch {}`） */
  private report(message: string, isFailure = true): void {
    if (isFailure) {
      this.lastWriteError = message
      this.failureCount += 1
    }
    this.onError?.(message)
  }

  /**
   * 【任务261】记下「本进程读/写该文件时的 mtime」，作为下次「外部手改」判据的基线。
   * 文件不存在（如刚被 rename 进 `_archive/`）时不记，避免留下过期基线。
   */
  private rememberMtime(file: string): void {
    try {
      this.knownMtimes.set(file, fs.statSync(file).mtimeMs)
    } catch {
      this.knownMtimes.delete(file)
    }
  }

  /**
   * 【任务261】外部手改判定：**文件 mtime 晚于本进程上次写/读它的时间** ⇒ 被外部（Obsidian / 编辑器）改过。
   *
   * - 无基线（本进程既没读过也没写过它）⇒ 返回 false（保守：不误判、不白扔归档）；
   *   正常路径下 `load()` 会给所有已加载文件建立基线，不存在的基线只可能来自「本进程新建的文件」——那种情况
   *   `writeEntry()` 写完即记，同样不会误判。
   * - `+1ms` 容差用于吸收文件系统时间戳精度差异。
   */
  private isExternallyModified(file: string): boolean {
    const known = this.knownMtimes.get(file)
    if (known === undefined) return false
    try {
      return fs.statSync(file).mtimeMs > known + 1
    } catch {
      return false
    }
  }

  /**
   * 启动读盘：扫描 vault 建立内存索引。
   * **只读，不写任何文件**（全新用户 vault 为空 ⇒ loaded=0，由上层决定是否迁移）。
   */
  load(): { loaded: number; unknown: number; errors: number } {
    if (!this.vaultRoot) return { loaded: 0, unknown: 0, errors: 0 }
    ensureVaultSkeleton(this.vaultRoot)
    const scan = scanVault(this.vaultRoot)
    this.unknownFiles = scan.unknown
    const sorted = [...scan.entries].sort((a, b) => a.id - b.id)
    for (const e of sorted) {
      this.entries.push(e)
      const f = scan.files.get(e.id)
      if (f) this.fileOf.set(e.id, f)
      if (f) this.rememberMtime(f) // 【任务261】建立「外部手改」判据基线（此刻磁盘内容 == 内存内容）
      if (e.id >= this.nextId) this.nextId = e.id + 1
    }
    for (const u of scan.unknown) this.report(`未知文件（保留不动）：${u.file} —— ${u.reason}`, false)
    for (const e of scan.errors) this.report(`读取失败：${e.file} —— ${e.reason}`)
    return { loaded: sorted.length, unknown: scan.unknown.length, errors: scan.errors.length }
  }

  /**
   * 内存灌注（**不落盘**）。仅用于「vault 不可用但旧 memory.json 里还有数据」的兜底，
   * 保证读路径不空窗；正常路径请用 `load()`。
   */
  hydrate(entries: MemoryEntry[]): number {
    let n = 0
    for (const e of entries) {
      if (!e || typeof e.key !== 'string') continue
      this.entries.push(e)
      if (e.id >= this.nextId) this.nextId = e.id + 1
      n += 1
    }
    return n
  }

  /** 无落盘时的引导（`hydrate` 用） */
  nextEntryId(): number {
    return this.nextId
  }

  save(scope: MemoryScope, key: string, value: unknown, meta?: SaveMeta): MemoryEntry {
    const now = Date.now()
    const entry: MemoryEntry = {
      id: this.nextId++,
      scope,
      key,
      value,
      source: meta?.source ?? 'explicit',
      confidence: meta?.confidence ?? 1,
      timestamp: now,
      created: now,
      updated: now,
      sessionId: meta?.sessionId,
    }
    if (CONFIG_SCOPES.includes(scope)) {
      const hk = `${scope}:${key}`
      // 与改造前逐字一致：配置型「同 scope+key 只保留最新」，且**不按会话区分**（本轮不动这条既有语义）
      const superseded = this.entries.filter((e) => e.scope === scope && e.key === key)
      if (superseded.length > 0) {
        const hist = this.archives.get(hk) ?? []
        for (const s of superseded) hist.push(s)
        this.archives.set(hk, hist)
      }
      this.entries = this.entries.filter((e) => !(e.scope === scope && e.key === key))
      for (const s of superseded) {
        this.archiveEntryFile(s) // 旧正文进 _archive/，不删除（★必须先归档再摘 fileOf，否则归档拿不到源路径）
        this.fileOf.delete(s.id)
      }
    }
    this.entries.push(entry)
    this.writeEntry(entry)
    return entry
  }

  list(scope?: MemoryScope): MemoryEntry[] {
    if (!scope) return [...this.entries]
    return this.entries.filter((e) => e.scope === scope)
  }

  /** 按会话隔离：只返回归属于指定会话的记忆（全局/旧数据不在此列） */
  listBySession(sessionId: string, scope?: MemoryScope): MemoryEntry[] {
    let list = this.entries.filter((e) => e.sessionId === sessionId)
    if (scope) list = list.filter((e) => e.scope === scope)
    return [...list]
  }

  /**
   * 【任务257】更新一条记忆的**正文**（只改 `value`）。
   *
   * 边界（与面板 UI 一致，不可越）：
   * - 可变：`value`、`updated`；
   * - **不可变**：`id` / `scope` / `key` / `sessionId` / `created` —— 改 scope/key 等于换目录换文件名（属另一件事）。
   *
   * 写入**完全复用 `writeEntry()`**（原子写 + 写前 stat + 外部手改优先归档 + 失败上报），
   * 不新开旁路 —— 这样自动继承形态B P1 的全部保护。
   */
  update(id: number, value: unknown): { ok: boolean; error?: string; entry?: MemoryEntry } {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return { ok: false, error: 'not_found' }
    // 写前检查：判据与 writeEntry 内部一致（基线 = 本进程上次写/读该文件时的 mtime）。
    // 命中「用户手改」⇒ 先把手工版本归档再写，手工内容永不静默丢。
    const file = this.fileOf.get(id)
    if (file && this.vaultRoot && fs.existsSync(file) && this.isExternallyModified(file)) {
      try {
        const r = archiveFileSync(this.vaultRoot, file, id)
        this.report(
          `检测到外部编辑（Obsidian/编辑器手改）：${file} —— 已把手工版本归档至 ${r.dest ?? '_archive/'} 后再写入`,
          false,
        )
        this.fileOf.delete(id) // 让 writeEntry 重新登记，避免二次归档
        this.knownMtimes.delete(file)
      } catch (err) {
        this.report(`写前检查失败（继续按新值写入）：${file} —— ${err instanceof Error ? err.message : String(err)}`, false)
      }
    }
    entry.value = value
    entry.updated = Date.now()
    const ok = this.writeEntry(entry)
    return ok ? { ok: true, entry } : { ok: false, error: this.lastWriteError ?? 'write_failed', entry }
  }

  /** 删除一条记忆（按 id）。文件**归档而非删除**（用户可在 `_archive/` 回捞） */
  remove(id: number): boolean {
    const idx = this.entries.findIndex((e) => e.id === id)
    if (idx < 0) return false
    const entry = this.entries[idx] as MemoryEntry
    this.entries.splice(idx, 1)
    this.archiveEntryFile(entry)
    this.fileOf.delete(id)
    return true
  }

  /** 召回：按 key / 内容关键词匹配，返回最新的在前；传 sessionId 时仅召回该会话记忆（全隔离） */
  recall(scope: MemoryScope, keyword?: string, sessionId?: string): MemoryEntry[] {
    let list = this.entries.filter((e) => e.scope === scope)
    if (sessionId !== undefined) list = list.filter((e) => e.sessionId === sessionId)
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
    const doomed = this.entries.filter((e) => e.scope === scope && e.key === key)
    for (const d of doomed) {
      this.archiveEntryFile(d)
      this.fileOf.delete(d.id)
    }
    this.entries = this.entries.filter((e) => !(e.scope === scope && e.key === key))
    const restored: MemoryEntry = { ...last, id: this.nextId++, timestamp: Date.now(), updated: Date.now() }
    this.entries.push(restored)
    this.writeEntry(restored)
    hist.pop()
    return true
  }

  // ———————————————————————— 落盘（全部走单文件原子写） ————————————————————————

  /**
   * 「写失败可见」的汇合点：把最近一次写失败取走（读后即清），供上层决定如何提示。
   * **不做任何批量刷盘** —— 写已在 save() 内完成（这正是「只写增量」的含义）。
   */
  flushStatus(): MemoryPersistStatus {
    const error = this.lastWriteError ?? undefined
    this.lastWriteError = null
    return { ok: !error, error, failures: this.failureCount, unknownFiles: [...this.unknownFiles] }
  }

  /** 只读：当前累积的写失败次数（不做副作用） */
  writeFailureCount(): number {
    return this.failureCount
  }

  private entryFilePath(entry: MemoryEntry): string | null {
    if (!this.vaultRoot) return null
    const base = vaultBaseDir(this.vaultRoot, entry.sessionId)
    const dir = `${base}/${SCOPE_DIRS[entry.scope] ?? 'other'}`
    const stem = slugifyName(entry.key)
    let file = `${dir}/${stem}.md`
    if (this.fileTakenByOther(file, entry.id)) file = `${dir}/${stem}-${entry.id}.md`
    return file
  }

  /** 目标路径是否已被「别的条目」占用（同名不同 id 的 key；或用户手写的同名文件） */
  private fileTakenByOther(file: string, id: number): boolean {
    for (const [eid, f] of this.fileOf) {
      if (f === file && eid !== id) return true
    }
    try {
      if (!fs.existsSync(file)) return false
      const parsed = parseMemoryFile(fs.readFileSync(file, 'utf8'), file)
      const fid = parsed.entry?.id
      return fid !== undefined && fid !== id
    } catch {
      return true // 读不了就当别人的文件，改名避让
    }
  }

  /** 把某个条目的当前文件 rename 进 `_archive/`（不删除） */
  private archiveEntryFile(entry: MemoryEntry): void {
    const file = this.fileOf.get(entry.id)
    if (!file || !this.vaultRoot) return
    const r = archiveFileSync(this.vaultRoot, file, entry.id)
    if (r.ok) this.knownMtimes.delete(file) // 【任务261】文件已改名进 _archive/，旧基线作废
    if (!r.ok && r.error !== '源文件不存在') {
      this.report(`归档失败（旧正文仍在原处，未删除）：${file} —— ${r.error}`)
    }
  }

  /**
   * 【任务257】写失败可见的**只读**快照（不清空，供渲染层面板轮询显示横幅）。
   *
   * 语义：`ok=false` ⇒ 存储当前处于失败态（最近一次写盘失败且之后没有成功的写入）。
   * `failures` 为累计次数（只增不减，作为「历史上确实失败过」的证据）。
   * 与 `flushStatus()`（读后即清，诊断用）区分开 —— 面板轮询不能把状态清掉。
   */
  persistStatus(): MemoryPersistStatus {
    return {
      ok: this.lastWriteError === null,
      error: this.lastWriteError ?? undefined,
      failures: this.failureCount,
      unknownFiles: [...this.unknownFiles],
    }
  }

  /**
   * 【任务257】写单个文件。三道保障：
   * ① **写前检查**：目标文件 mtime 晚于**本进程上次写/读它的时间** ⇒ 判定「用户手改过」⇒ 先把用户版本归档再写（手改优先，永不静默覆盖）；
   * ② 原子写（同目录 temp + fsync + rename）；
   * ③ 任何异常都记录下来并抛给上层诊断，**不吞**。
   *
   * 返回值：true = 落盘成功（或本实例未配置 vault，纯内存模式）；false = 写盘失败（原因见 `persistStatus().error`）。
   */
  private writeEntry(entry: MemoryEntry): boolean {
    if (!this.vaultRoot) return true
    const file = this.entryFilePath(entry)
    if (!file) return true
    try {
      const prev = this.fileOf.get(entry.id)
      if (prev === file && fs.existsSync(file) && this.isExternallyModified(file)) {
        const r = archiveFileSync(this.vaultRoot, file, entry.id)
        this.report(
          `检测到外部编辑（Obsidian/编辑器手改）：${file} —— 已把手工版本归档至 ${r.dest ?? '_archive/'} 后再写入`,
          false,
        )
        this.knownMtimes.delete(file)
      }
      atomicWriteFileSync(file, serializeEntry(entry))
      this.fileOf.set(entry.id, file)
      this.rememberMtime(file) // 【任务261】记录本次写出的 mtime，作为下次「外部手改」判据的基线
      this.lastWriteError = null // 【任务257】写成功即清除失败态（存储已恢复健康）
      return true
    } catch (err) {
      this.report(`记忆落盘失败：${file} —— ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** 当前 vault 根（诊断用） */
  vaultPath(): string | undefined {
    return this.vaultRoot
  }

  /** 归档目录名（诊断/测试用） */
  static readonly ARCHIVE_DIR = ARCHIVE_DIR
}
