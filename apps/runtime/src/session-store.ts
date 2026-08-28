/**
 * 会话事件日志的磁盘存储层（追加式分段 + gzip 压缩 + 流式读取）。
 *
 * 存储结构：
 * ```
 * ~/.shanhai/sessions/<会话id>/
 * ├── meta.json                    # { id, title, workDir, lastActiveAt }（小文件，覆盖写）
 * ├── events.jsonl                 # 活跃段：每行一个事件（append-only，最新事件写这里）
 * └── events-000001.jsonl.gz ...   # 归档段：历史事件按顺序 gzip 压缩（只读，不再追加）
 * ```
 *
 * 设计目标：
 * - 日志轮转：活跃段超过阈值（默认 SEGMENT_MAX_BYTES=5MB）时自动滚动，把活跃段整体
 *   gzip 归档为 `events-<序号>.jsonl.gz` 并清空活跃段继续追加。活跃段始终保持在阈值内，
 *   追加保持 O(1)，不会随会话无限变大（根治 append-only 无上限导致的文件持续增长）。
 * - 压缩：历史段 gzip(level 9)，JSONL 文本压缩率约 3~10 倍，显著降低磁盘占用。
 * - 流式读取：`streamSessionEvents` 以 async generator 逐段逐行 yield，调用方可逐条消费
 *   而不必把全量事件一次性驻留内存；`loadSessionEventsFile` 复用该流式实现保持全量返回，
 *   向后兼容旧调用方。
 * - 数据零丢失：归档是「读活跃段 → gzip → 写新段 → 清空活跃段」，逐字节等价，仅过滤
 *   本就去冗余的 assistant/delta（由上层 persist 决定，与旧实现一致）。
 * - 不做删除式清理：事件日志是会话的权威完整历史（审计 + 断点续跑依赖完整事件），
 *   「清理磁盘占用」用压缩归档实现，而非删除历史；确需删除用 deleteSessionDir。
 */
import { promises as fs } from 'node:fs'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib'
import { effectiveApprovalPolicy, effectiveModelId, type ApprovalPolicy, type SessionEvent } from '@shanhai/session'

/** 活跃段滚动阈值（字节）：超过即归档为 gz 段，默认 5MB */
export const SEGMENT_MAX_BYTES = 5 * 1024 * 1024

/** gzip 压缩（异步，不阻塞事件循环）；level 9 换取更小归档体积（归档一次性成本） */
function gzip(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzipCb(buf, { level: 9 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
}

/** gzip 解压（异步） */
function gunzip(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzipCb(buf, (err, out) => (err ? reject(err) : resolve(out)))
  })
}

/** meta.json 的持久化结构（不含 events，events 单独放 events.jsonl + 归档段） */
export interface SessionMetaFile {
  id: string
  title: string
  workDir: string
  lastActiveAt: number
  /** 会话级模型 id（会话当前属性，覆盖写；缺省回退全局默认模型） */
  modelId?: string
  /** 会话级审批策略（安全模式），缺省 'ask' */
  approvalPolicy?: ApprovalPolicy
}

/** 会话目录绝对路径 */
export function sessionDirPath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, sessionId)
}

/** 覆盖写 meta.json（原子写：临时文件 + rename，避免崩溃留下半截文件） */
export async function writeSessionMetaFile(dir: string, meta: SessionMetaFile): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const path = join(dir, 'meta.json')
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 })
  await fs.rename(tmp, path)
}

/** 读 meta.json；不存在或损坏返回 null */
export async function readSessionMetaFile(dir: string): Promise<SessionMetaFile | null> {
  try {
    const raw = await fs.readFile(join(dir, 'meta.json'), 'utf8')
    return JSON.parse(raw) as SessionMetaFile
  } catch {
    return null
  }
}

/** 列出目录内所有归档段文件名（按序号升序）；目录不存在或损坏返回空数组 */
export async function listSegmentFiles(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  return entries
    .filter((n) => /^events-\d+\.jsonl\.gz$/.test(n))
    .sort((a, b) => seqOf(a) - seqOf(b))
}

/** 从归档段文件名解析序号（events-000042.jsonl.gz → 42） */
function seqOf(name: string): number {
  const m = /^events-(\d+)\.jsonl\.gz$/.exec(name)
  return m ? parseInt(m[1]!, 10) : 0
}

/** 下一个归档段序号 = 现有最大序号 + 1 */
async function nextSegmentSeq(dir: string): Promise<number> {
  const files = await listSegmentFiles(dir)
  return files.length > 0 ? seqOf(files[files.length - 1]!) + 1 : 0
}

/**
 * 日志轮转：活跃段超过 maxBytes 时，把整个活跃段 gzip 归档为 `events-<序号>.jsonl.gz`
 * 并清空活跃段（截断为 0），后续追加重新从空段开始。
 * maxBytes 传 0 表示「无论大小都归档」（compact 用）。返回是否发生轮转。
 * 数据逐字节等价，不丢事件。
 */
export async function rotateSessionEventsFile(dir: string, maxBytes = SEGMENT_MAX_BYTES): Promise<boolean> {
  const path = join(dir, 'events.jsonl')
  let stat
  try {
    stat = await fs.stat(path)
  } catch {
    return false // 活跃段不存在，无需轮转
  }
  if (stat.size < maxBytes) return false
  const raw = await fs.readFile(path)
  if (raw.length === 0) return false
  const compressed = await gzip(raw)
  const seq = await nextSegmentSeq(dir)
  await fs.writeFile(join(dir, `events-${String(seq).padStart(6, '0')}.jsonl.gz`), compressed, { mode: 0o600 })
  // 清空活跃段（截断为 0），保留文件以便后续 append
  await fs.writeFile(path, '', { mode: 0o600 })
  return true
}

/** 追加写事件到活跃段 events.jsonl；活跃段超阈值自动轮转归档（默认 5MB） */
export async function appendSessionEventsFile(
  dir: string,
  events: SessionEvent[],
  maxBytes = SEGMENT_MAX_BYTES,
): Promise<void> {
  if (events.length === 0) return
  await fs.mkdir(dir, { recursive: true })
  const path = join(dir, 'events.jsonl')
  const lines = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  await fs.appendFile(path, lines, { mode: 0o600 })
  // 追加后检查：活跃段超过阈值则滚动归档（历史段 gzip，控制活跃段体积与读放大）
  await rotateSessionEventsFile(dir, maxBytes)
}

/** 全量重写活跃段 events.jsonl（仅截断/删除历史时使用，频率低；原子写）；同时清空所有归档段 */
export async function rewriteSessionEventsFile(dir: string, events: SessionEvent[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const path = join(dir, 'events.jsonl')
  const tmp = `${path}.tmp`
  const lines = events.length > 0 ? `${events.map((e) => JSON.stringify(e)).join('\n')}\n` : ''
  await fs.writeFile(tmp, lines, { mode: 0o600 })
  await fs.rename(tmp, path)
  // 全量重写后历史归并到活跃段，删除所有归档段（避免新旧重复）
  for (const file of await listSegmentFiles(dir)) {
    await fs.rm(join(dir, file), { force: true }).catch(() => undefined)
  }
}

/**
 * 流式逐条读取会话事件（先归档段按序号升序，后活跃段），以 async generator 逐条 yield。
 * 调用方可逐条消费而不必一次性把全量事件驻留内存；损坏行/损坏段跳过，不阻断整体恢复。
 */
export async function* streamSessionEvents(dir: string): AsyncGenerator<SessionEvent> {
  // 1. 归档段（gzip）：按序号升序，保证时间顺序
  for (const file of await listSegmentFiles(dir)) {
    try {
      const buf = await fs.readFile(join(dir, file))
      const text = (await gunzip(buf)).toString('utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          yield JSON.parse(trimmed) as SessionEvent
        } catch {
          // 跳过损坏行
        }
      }
    } catch {
      // 跳过损坏/不可读段
    }
  }
  // 2. 活跃段（未压缩 JSONL）：readline 流式逐行
  const rl = createInterface({
    input: createReadStream(join(dir, 'events.jsonl'), { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        yield JSON.parse(trimmed) as SessionEvent
      } catch {
        // 跳过损坏行
      }
    }
  } catch {
    // 活跃段不存在：仅返回归档段已读到的事件
  }
}

/** 逐行流式读全部事件，返回事件数组；文件不存在返回空数组；损坏行跳过 */
export async function loadSessionEventsFile(dir: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = []
  for await (const e of streamSessionEvents(dir)) out.push(e)
  return out
}

/**
 * 定期清理/压缩归档入口：把活跃段压缩归档以降低磁盘占用（不删除历史）。
 * - force=false：仅当活跃段超过默认阈值时才归档（等价 rotate 默认行为）。
 * - force=true：无论大小都归档（用于定期把「已结束会话」的活跃段压成 gz 段）。
 * 返回是否发生归档。
 */
export async function compactSessionEventsFile(dir: string, force = false): Promise<boolean> {
  return rotateSessionEventsFile(dir, force ? 0 : SEGMENT_MAX_BYTES)
}

/** 删除整个会话目录（含 meta.json + 活跃段 + 归档段） */
export async function deleteSessionDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

/** 旧格式 <会话id>.json 文件路径（迁移前） */
export function legacySessionFilePath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.json`)
}

/** 迁移后返回的旧格式数据（供 bootstrap 构造 SessionMeta 与回放） */
export interface LegacySessionData {
  title: string
  workDir: string
  lastActiveAt: number
  events: SessionEvent[]
  /** 迁移时从旧事件日志回放的会话级模型 id（可能 undefined） */
  modelId?: string
  /** 迁移时从旧事件日志回放的会话级审批策略（可能 undefined） */
  approvalPolicy?: ApprovalPolicy
}

/**
 * 旧格式 → 新格式迁移：读 <会话id>.json（{ events: [] } 单文件），
 * 重写为 <会话id>/meta.json + <会话id>/events.jsonl 后删除旧文件。
 * 数据逐字节等价迁移（旧文件本就不含 assistant/delta），返回旧数据；失败返回 null。
 */
export async function migrateLegacySessionFile(
  sessionsDir: string,
  sessionId: string,
  defaultWorkDir: string,
): Promise<LegacySessionData | null> {
  const legacyPath = legacySessionFilePath(sessionsDir, sessionId)
  const dir = sessionDirPath(sessionsDir, sessionId)
  try {
    const raw = await fs.readFile(legacyPath, 'utf8')
    const data = JSON.parse(raw) as {
      id?: string
      title?: string
      workDir?: string
      lastActiveAt?: number
      events?: SessionEvent[]
    }
    if (!Array.isArray(data.events)) return null
    const workDir = data.workDir ?? defaultWorkDir
    const lastActiveAt = typeof data.lastActiveAt === 'number' ? data.lastActiveAt : 0
    // 会话级模型/审批策略已迁至 meta：从旧事件日志回放一次写入 meta（事件本身保留作历史痕迹，新代码只读 meta 不再回放）
    const modelId = effectiveModelId(data.events)
    const approvalPolicy = effectiveApprovalPolicy(data.events)
    await writeSessionMetaFile(dir, {
      id: sessionId,
      title: data.title || '新会话',
      workDir,
      lastActiveAt,
      modelId,
      approvalPolicy,
    })
    await rewriteSessionEventsFile(dir, data.events)
    await fs.rm(legacyPath, { force: true })
    return { title: data.title || '新会话', workDir, lastActiveAt, events: data.events, modelId, approvalPolicy }
  } catch {
    return null
  }
}
