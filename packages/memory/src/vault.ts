import fs from 'node:fs'
import path from 'node:path'
import { ALL_SCOPES, CONFIG_SCOPES, isMemoryScope, isMemorySource, type MemoryEntry, type MemoryScope } from './types'

/**
 * 【任务256 · 形态B】记忆 vault 底座：`~/.shanhai/memory/` 下的 Markdown + YAML frontmatter 文件树。
 *
 * 目录口径（管家已定）：
 *   <vaultRoot>/
 *     sessions/<会话目录>/<分类目录>/<key>.md   —— 每个会话一个目录，scope 作一级分类
 *     _global/<分类目录>/<key>.md               —— 无会话归属的存量记忆（needsOwner）
 *     _user/                                    —— 用户手记：**山海只读、永不删、永不改**
 *     _archive/<原相对路径>-<id>-<时间戳>.md     —— 被覆盖/移除的旧正文归档（永不静默丢内容）
 *
 * 三条硬规则（写进代码，不靠调用方自觉）：
 *   1. 只有「路径在 sessions/_global/_user 之下」+「frontmatter 含 shanhai: true」+「scope 合法」三者同时满足，
 *      才被认定为「山海的记忆文件」；其余一律视为未知文件，**只登记、绝不删除、绝不覆盖**。
 *   2. 写入一律「单文件原子写」（同目录 temp + rename），**不存在任何全量重写 vault 的代码路径**。
 *   3. frontmatter 承载 MemoryEntry 的全部结构化字段（id/scope/key/session/created/updated/source/confidence/
 *      needsOwner），正文承载 value —— Obsidian 的 Properties 面板读的就是这份 YAML，字段零丢失。
 */

export const SESSIONS_DIR = 'sessions'
export const GLOBAL_DIR = '_global'
export const USER_DIR = '_user'
export const ARCHIVE_DIR = '_archive'
/** frontmatter 标记位：只有它为 true 才被当成山海记忆 */
export const MARKER_KEY = 'shanhai'
/** 非字符串 value 的编码标记（正文里存 JSON） */
export const ENCODING_KEY = 'valueEncoding'

/**
 * scope → 分类目录名。
 * 【任务259】**与 frontmatter 的 `scope` 值逐字符一致**（英文原名）。为什么不再用中文目录名：
 * ① 目录名与字段值同源 —— find/grep/脚本比对时不必再做「中文目录 ↔ 英文 scope」二次映射；
 * ② 中文路径在跨工具链（CI、非 UTF-8 locale、Windows 压缩包）里是常见的踩坑点。
 */
export const SCOPE_DIRS: Record<MemoryScope, string> = {
  user_preference: 'user_preference',
  environment: 'environment',
  project_knowledge: 'project_knowledge',
  task_experience: 'task_experience',
  session: 'session',
  data_cognition: 'data_cognition',
}

export function scopeDirName(scope: MemoryScope): string {
  return SCOPE_DIRS[scope] ?? 'other'
}

/** 文件名非法字符 + 控制字符（macOS/Windows 通吃；`/` 必须换掉否则是路径分隔） */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g

/**
 * 归一成安全文件名/目录名：非法字符→`-`、连续空白→`-`、去首尾点与连字符；
 * 保留中文（Obsidian 与 APFS 都没问题）；按**码点**截断，避免截出半个代理对。
 */
export function slugifyName(input: unknown, maxLen = 60): string {
  let s = String(input ?? '').replace(ILLEGAL_CHARS, '-')
  s = s.replace(/\s+/g, '-')
  s = s.replace(/-{2,}/g, '-')
  s = s.replace(/^[.\-\s]+/, '')
  s = s.replace(/[.\-\s]+$/, '')
  if (s.length > maxLen) s = Array.from(s).slice(0, maxLen).join('')
  return s || 'entry'
}

/** 去掉 vault 根前缀的相对路径（用于归档时保持层级） */
function relFrom(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/')
}

/** 空 sessionId 的兜底目录名（不应出现；出现时也不许把文件写到 sessions/ 根上） */
export const SESSION_DIR_FALLBACK = 'unknown'

/**
 * 【任务259】会话目录名 = **记录里的 sessionId 原文**。
 *
 * - **不截断、不拼接标题、不改大小写**：`s-1787882069598-qpolo76o8xa` 就是目录名，`supervisor` 原样用。
 * - 只有 id 含路径分隔符 / 控制字符等**文件系统非法字符**时才走 `slugifyName` 转义（防目录穿越）；
 *   对正常 id 该函数是**恒等变换**，可读性不变。
 * - 旧规则「`{slug(title)}-{短标签}` / `unknown-{短标签}`」**已删除**：目录名不再依赖会话标题，
 *   因此落盘与迁移**都不需要读 meta.json 取标题**（少一处耦合），会话改名也不会再让目录漂移。
 * - 名字与目录名不再有一一映射关系：**sessionId 只从 frontmatter 的 `session` 字段读**，
 *   任何地方都不得从目录名反解会话 id（否则目录一改名就会读错归属）。
 */
export function sessionDirName(sessionId: string): string {
  const s = String(sessionId ?? '').trim()
  if (!s) return SESSION_DIR_FALLBACK
  return slugifyName(s, 200)
}

/** `_global/`（无归属）或 `sessions/<sessionId>/` */
export function vaultBaseDir(vaultRoot: string, sessionId?: string): string {
  if (!sessionId) return path.join(vaultRoot, GLOBAL_DIR)
  return path.join(vaultRoot, SESSIONS_DIR, sessionDirName(sessionId))
}

// ———————————————————————— frontmatter 序列化 / 解析 ————————————————————————

function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
}

function isoOf(ms: number): string {
  if (!Number.isFinite(ms)) return new Date().toISOString()
  return new Date(ms).toISOString()
}

function msOf(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return t
  }
  return fallback
}

/** value → 正文（字符串原样；非字符串存 JSON 并在 frontmatter 标记） */
function bodyOf(value: unknown): { body: string; encoding: string } {
  if (typeof value === 'string') return { body: value, encoding: 'string' }
  return { body: JSON.stringify(value, null, 2) ?? '', encoding: 'json' }
}

export function serializeEntry(entry: MemoryEntry): string {
  const created = entry.created ?? entry.timestamp
  const updated = entry.updated ?? entry.timestamp
  const { body, encoding } = bodyOf(entry.value)
  const lines = [
    '---',
    `${MARKER_KEY}: true`,
    `id: ${entry.id}`,
    `scope: ${entry.scope}`,
    `key: ${yamlQuote(entry.key)}`,
    `session: ${entry.sessionId ? yamlQuote(entry.sessionId) : '""'}`,
    `created: ${isoOf(created)}`,
    `updated: ${isoOf(updated)}`,
    `source: ${entry.source}`,
    `confidence: ${entry.confidence}`,
    `needsOwner: ${entry.needsOwner === true}`,
  ]
  if (encoding !== 'string') lines.push(`${ENCODING_KEY}: ${encoding}`)
  lines.push('tags:', `  - shanhai/${entry.scope}`, '---', '', body, '')
  return lines.join('\n')
}

function parseScalar(raw: string): unknown {
  const s = raw.trim()
  if (s === '' || s === '~') return s === '' ? '' : null
  if (s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s
      .slice(1, -1)
      .replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c))
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d*\.\d+$/.test(s)) return Number(s)
  return s
}

/**
 * 极简 YAML frontmatter 解析（只覆盖本模块自己生成的形态：标量 + 块状字符串数组）。
 * 不引依赖（本轮禁新增依赖），遇到不认识的行**跳过而不抛错** —— 用户手写的东西不该让山海崩。
 */
export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } | null {
  const norm = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!norm.startsWith('---\n')) return null
  const end = norm.indexOf('\n---', 3)
  if (end < 0) return null
  const fmRaw = norm.slice(4, end)
  const afterFence = norm.indexOf('\n', end + 1)
  // 正文**逐字节保真**：只剥掉序列化时补的那个分隔空行与收尾换行各一个字符，
  // 不做任何 trim —— 否则 value 自身的首尾空白/换行会被吃掉（round-trip 漂移）。
  let body = ''
  if (afterFence >= 0) {
    body = norm.slice(afterFence + 1)
    if (body.startsWith('\n')) body = body.slice(1)
    if (body.endsWith('\n')) body = body.slice(0, -1)
  }
  const meta: Record<string, unknown> = {}
  let listKey: string | null = null
  for (const rawLine of fmRaw.split('\n')) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue
    const isIndented = /^\s/.test(rawLine)
    if (!isIndented) {
      const m = /^([A-Za-z0-9_.-]+):(.*)$/.exec(rawLine)
      if (!m) continue
      const key = m[1] as string
      const rest = m[2] ?? ''
      if (rest.trim() === '') {
        listKey = key
        meta[key] = []
      } else {
        listKey = null
        meta[key] = parseScalar(rest)
      }
      continue
    }
    if (listKey) {
      const li = /^\s+-\s*(.*)$/.exec(rawLine)
      const arr = meta[listKey]
      if (li && Array.isArray(arr)) arr.push(parseScalar(li[1] ?? ''))
    }
  }
  return { meta, body }
}

export interface ParsedMemoryFile {
  entry: MemoryEntry | null
  reason?: string
}

/**
 * 把一个 .md 文件解析成 MemoryEntry。**三条件同时满足**才算山海的记忆文件：
 * ① `shanhai: true` ② scope 合法 ③ id / key 可用；否则返回 `{entry:null, reason}` 由调用方登记为未知文件。
 */
export function parseMemoryFile(text: string, file: string): ParsedMemoryFile {
  const parsed = parseFrontmatter(text)
  if (!parsed) return { entry: null, reason: `无 frontmatter（${path.basename(file)}）` }
  const { meta, body } = parsed
  if (meta[MARKER_KEY] !== true) return { entry: null, reason: 'frontmatter 缺 shanhai: true 标记' }
  const scope = meta['scope']
  if (!isMemoryScope(scope)) return { entry: null, reason: `scope 非法：${String(scope)}` }
  const rawId = meta['id']
  const id = typeof rawId === 'number' ? rawId : Number.parseInt(String(rawId ?? ''), 10)
  if (!Number.isFinite(id) || id <= 0) return { entry: null, reason: 'id 非法' }
  const key = meta['key']
  if (typeof key !== 'string' || !key.trim()) return { entry: null, reason: 'key 为空' }

  const sessionRaw = meta['session']
  const sessionId = typeof sessionRaw === 'string' && sessionRaw.trim() ? sessionRaw.trim() : undefined
  const created = msOf(meta['created'], msOf(meta['updated'], Date.now()))
  const updated = msOf(meta['updated'], created)
  const sourceRaw = meta['source']
  const confidenceRaw = meta['confidence']
  let value: unknown = body
  if (meta[ENCODING_KEY] === 'json') {
    try {
      value = JSON.parse(body)
    } catch {
      value = body // JSON 坏了就退回原文，绝不丢内容
    }
  }
  return {
    entry: {
      id,
      scope,
      key,
      value,
      source: isMemorySource(sourceRaw) ? sourceRaw : 'explicit',
      confidence: typeof confidenceRaw === 'number' ? confidenceRaw : Number(confidenceRaw ?? 1) || 1,
      timestamp: updated,
      sessionId,
      created,
      updated,
      needsOwner: meta['needsOwner'] === true,
    },
  }
}

// ———————————————————————— 原子写 / 扫描 ————————————————————————

/**
 * 原子写：同目录 temp + fsync + rename（同卷 rename 是原子操作）。
 * 任何一步失败都会抛错，由调用方负责记录 —— **绝不吞异常**（写失败必须可见）。
 */
export function atomicWriteFileSync(file: string, content: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  let fd: number | null = null
  try {
    fd = fs.openSync(tmp, 'w', 0o600)
    fs.writeFileSync(fd, content, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 关闭失败无补救手段，忽略 */
      }
    }
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清理临时文件失败同样无补救手段，忽略 */
    }
    throw err
  }
}

/** 时间戳（归档文件名用，避免同毫秒撞名） */
function stamp(now = Date.now()): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

export interface ArchiveResult {
  ok: boolean
  dest?: string
  error?: string
}

/**
 * 把 vault 里的某个文件移进 `_archive/`（**rename，不是删除**）—— 覆盖/移除前保全旧正文。
 * `_archive` 里保持原层级，便于人工回捞。
 */
export function archiveFileSync(vaultRoot: string, file: string, id: number, now = Date.now()): ArchiveResult {
  try {
    if (!fs.existsSync(file)) return { ok: false, error: '源文件不存在' }
    const rel = relFrom(vaultRoot, file)
    const dest = path.join(vaultRoot, ARCHIVE_DIR, rel.replace(/\.md$/, `-${id}-${stamp(now)}.md`))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(file, dest)
    return { ok: true, dest }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface UnknownFile {
  file: string
  reason: string
}

export interface VaultScanResult {
  /** 解析出的记忆条目（按文件路径排序，保证可复现） */
  entries: MemoryEntry[]
  /** id → 文件绝对路径 */
  files: Map<number, string>
  /** 不能被认定为山海记忆的 .md（只登记，**永不删除**） */
  unknown: UnknownFile[]
  /** 读取失败的文件（同样只登记） */
  errors: UnknownFile[]
}

const SKIP_DIR = new Set([ARCHIVE_DIR, '.obsidian', '.trash', 'node_modules'])

function walkMarkdown(dir: string, out: string[]): void {
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在/无权限：静默跳过（读路径必须容错）
  }
  for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (d.name.startsWith('.') || SKIP_DIR.has(d.name)) continue
    const full = path.join(dir, d.name)
    if (d.isDirectory()) walkMarkdown(full, out)
    else if (d.isFile() && d.name.toLowerCase().endsWith('.md')) out.push(full)
  }
}

/**
 * 扫描 vault：只遍历 `sessions/` 与 `_global/` 两个记忆根。
 * `_user/`（用户手记）、`_archive/`（归档）、`.obsidian/`、`.trash/` **一律不进扫描范围** ⇒ 永不被改写/删除。
 */
export function scanVault(vaultRoot: string): VaultScanResult {
  const entries: MemoryEntry[] = []
  const files = new Map<number, string>()
  const unknown: UnknownFile[] = []
  const errors: UnknownFile[] = []
  const roots = [path.join(vaultRoot, SESSIONS_DIR), path.join(vaultRoot, GLOBAL_DIR)]
  const all: string[] = []
  for (const r of roots) walkMarkdown(r, all)
  all.sort()
  const seen = new Set<number>()
  for (const file of all) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      errors.push({ file, reason: `读取失败：${err instanceof Error ? err.message : String(err)}` })
      continue
    }
    const parsed = parseMemoryFile(text, file)
    if (!parsed.entry) {
      unknown.push({ file, reason: parsed.reason ?? '无法解析' })
      continue
    }
    if (seen.has(parsed.entry.id)) {
      unknown.push({ file, reason: `id=${parsed.entry.id} 与已有文件重复（保留先出现者，本文件不载入也不改写）` })
      continue
    }
    seen.add(parsed.entry.id)
    entries.push(parsed.entry)
    files.set(parsed.entry.id, file)
  }
  return { entries, files, unknown, errors }
}

/** 该路径是否落在「记忆三根」之下（未知文件判定的路径条件） */
export function isUnderMemoryRoots(vaultRoot: string, file: string): boolean {
  const rel = relFrom(vaultRoot, file)
  return (
    rel.startsWith(`${SESSIONS_DIR}/`) || rel.startsWith(`${GLOBAL_DIR}/`) || rel.startsWith(`${USER_DIR}/`)
  )
}

/** 确保 vault 骨架存在（`_user/` 先建，用户随时可以往里放手记） */
export function ensureVaultSkeleton(vaultRoot: string): void {
  fs.mkdirSync(path.join(vaultRoot, USER_DIR), { recursive: true })
}
