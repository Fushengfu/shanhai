import fs from 'node:fs'
import path from 'node:path'
import { isMemoryScope, isMemorySource, type MemoryEntry, type MemoryScope } from './types'
import {
  GLOBAL_DIR,
  SCOPE_DIRS,
  atomicWriteFileSync,
  ensureVaultSkeleton,
  scanVault,
  serializeEntry,
  slugifyName,
  vaultBaseDir,
} from './vault'

/**
 * 【任务256 · 形态B】`~/.shanhai/memory.json` → 记忆 vault 的迁移器。
 *
 * 三条纪律：
 *   1. **绝不修改/删除** 原 `memory.json`；备份是**另写一个新文件** `memory.json.bak-<时间戳>`。
 *   2. 逐条 1:1 落盘（**不做任何 scope/key 去重** —— 去重是 save() 的运行时语义，迁移不是它的场合）。
 *   3. 全程可回滚：删掉 vault 目录 + 把 .bak 换回 memory.json 即可（见回传的「回滚步骤」）。
 */

/** memory.json 里的原始条目形状（字段可能缺省，按需兜底） */
interface LegacyEntry {
  id?: number
  scope?: string
  key?: string
  value?: unknown
  source?: string
  confidence?: number
  timestamp?: number
  sessionId?: string
}

export interface MigrateOptions {
  /** 旧 JSON 路径（`~/.shanhai/memory.json`） */
  memoryJsonPath: string
  /** vault 根（`~/.shanhai/memory/`） */
  vaultRoot: string
  /** 是否写备份（默认 true）；备份**永远是新建文件，不动原文件** */
  backup?: boolean
  /** 时间源（测试可注入） */
  now?: () => number
}

export interface MigrateResult {
  /** 旧文件里的条目总数 */
  total: number
  /** 成功写成 vault 文件的条数 */
  written: number
  /** 跳过的条目（字段非法，附原因） */
  skipped: Array<{ index: number; reason: string }>
  /** id → 落盘文件（供逐条比对断言） */
  files: Map<number, string>
  /** 备份文件路径（未备份则 undefined） */
  backupPath?: string
  /** 整体是否成功（有 skipped 即为 false，调用方据此决定是否回滚） */
  ok: boolean
}

/** 备份旧文件（新建 `<原名>.bak-<时间戳>`；原文件字节不动） */
export function backupMemoryJson(memoryJsonPath: string, now = Date.now()): string {
  const ts = new Date(now).toISOString().replace(/[:.]/g, '-')
  const dest = `${memoryJsonPath}.bak-${ts}`
  fs.copyFileSync(memoryJsonPath, dest)
  return dest
}

function toEntry(raw: LegacyEntry): MemoryEntry | null {
  const key = typeof raw.key === 'string' ? raw.key : ''
  if (!key.trim()) return null
  if (!isMemoryScope(raw.scope)) return null
  const ts = typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now()
  const sid = typeof raw.sessionId === 'string' && raw.sessionId.trim() ? raw.sessionId.trim() : undefined
  const id = typeof raw.id === 'number' && Number.isFinite(raw.id) ? raw.id : 0
  if (id <= 0) return null
  return {
    id,
    scope: raw.scope,
    key,
    value: raw.value,
    source: isMemorySource(raw.source) ? raw.source : 'explicit',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 1,
    timestamp: ts,
    sessionId: sid,
    created: ts,
    updated: ts,
    // 无归属会话的存量 ⇒ 落 _global/，并打标记等用户在面板里指定归属
    ...(sid ? {} : { needsOwner: true }),
  }
}

/** 计算落盘路径（同目录内 slug 撞名时追加 `-<id>`） */
function targetPath(
  opts: MigrateOptions,
  entry: MemoryEntry,
  taken: Set<string>,
): string {
  // 【任务259】目录口径：sessions/<sessionId 原文>/<scope 英文原名>/
  // sessionId 一律来自记录本身的 frontmatter 字段（entry.sessionId），**不从目录名反解**。
  const base = vaultBaseDir(opts.vaultRoot, entry.sessionId)
  const dir = path.join(base, SCOPE_DIRS[entry.scope] ?? 'other')
  const stem = slugifyName(entry.key)
  let file = path.join(dir, `${stem}.md`)
  if (taken.has(file)) file = path.join(dir, `${stem}-${entry.id}.md`)
  let n = 2
  while (taken.has(file)) {
    file = path.join(dir, `${stem}-${entry.id}-${n}.md`)
    n += 1
  }
  taken.add(file)
  return file
}

/**
 * 执行迁移。返回逐条结果；`ok=false` 时调用方应回滚（删 vault + 换回 .bak）。
 * **不做任何写入以外的副作用**（不改 config、不动 sessions、不联网）。
 */
export function migrateMemoryJsonToVault(opts: MigrateOptions): MigrateResult {
  const now = opts.now ?? Date.now
  const raw = fs.readFileSync(opts.memoryJsonPath, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`memory.json 顶层不是数组（实际 ${typeof parsed}），拒绝迁移`)
  }
  const legacy = parsed as LegacyEntry[]

  const backupPath = opts.backup === false ? undefined : backupMemoryJson(opts.memoryJsonPath, now())
  ensureVaultSkeleton(opts.vaultRoot)

  const taken = new Set<string>()
  const files = new Map<number, string>()
  const skipped: Array<{ index: number; reason: string }> = []
  let written = 0

  for (let i = 0; i < legacy.length; i += 1) {
    const entry = toEntry(legacy[i] as LegacyEntry)
    if (!entry) {
      skipped.push({ index: i, reason: '字段非法（id/key/scope 缺失）' })
      continue
    }
    if (files.has(entry.id)) {
      skipped.push({ index: i, reason: `id=${entry.id} 重复` })
      continue
    }
    const file = targetPath(opts, entry, taken)
    atomicWriteFileSync(file, serializeEntry(entry))
    files.set(entry.id, file)
    written += 1
  }

  return { total: legacy.length, written, skipped, files, backupPath, ok: skipped.length === 0 && written === legacy.length }
}

export interface VerifyResult {
  /** 旧文件条数 */
  total: number
  /** vault 读回条数 */
  loaded: number
  /** 按 id+scope+key 三元组对齐后：旧有新无 */
  missing: string[]
  /** 新有旧无 */
  extra: string[]
  /** 三元组相同但 value 不一致（内容漂移） */
  valueMismatch: string[]
  ok: boolean
}

const triple = (e: { id: number; scope: MemoryScope; key: string }): string => `${e.id}\t${e.scope}\t${e.key}`

/** 迁移正确性硬断言：逐条按 `id + scope + key` 三元组对齐，并顺带核对 value 未漂移 */
export function verifyMigration(memoryJsonPath: string, vaultRoot: string): VerifyResult {
  const legacy = JSON.parse(fs.readFileSync(memoryJsonPath, 'utf8')) as LegacyEntry[]
  const want = new Map<string, LegacyEntry>()
  for (const raw of legacy) {
    const e = toEntry(raw)
    if (e) want.set(triple(e), raw)
  }
  const scan = scanVault(vaultRoot)
  const got = new Map<string, MemoryEntry>()
  for (const e of scan.entries) got.set(triple(e), e)

  const missing: string[] = []
  const valueMismatch: string[] = []
  for (const [k, raw] of want) {
    const hit = got.get(k)
    if (!hit) {
      missing.push(k)
      continue
    }
    const before = typeof raw.value === 'string' ? raw.value : JSON.stringify(raw.value)
    const after = typeof hit.value === 'string' ? hit.value : JSON.stringify(hit.value)
    if (before !== after) valueMismatch.push(k)
  }
  const extra: string[] = []
  for (const k of got.keys()) if (!want.has(k)) extra.push(k)

  return {
    total: want.size,
    loaded: got.size,
    missing,
    extra,
    valueMismatch,
    ok: missing.length === 0 && extra.length === 0 && valueMismatch.length === 0,
  }
}

export const GLOBAL_DIR_NAME = GLOBAL_DIR
