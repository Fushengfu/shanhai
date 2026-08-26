import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { HttpTrace } from '@shanhai/llm'

/** 落盘的一条 HTTP 原始请求/响应记录（请求一条、响应一条，分开记录） */
export interface HttpTraceRecord extends HttpTrace {
  ts: number
  sessionId: string
}

/** 单条 trace 记录中字符串字段（含完整 messages / 原始响应 body）的最大字符数：超出截断，避免 JSON.stringify 超大对象阻塞事件循环（卡顿） */
const HTTP_TRACE_MAX_BODY_CHARS = 200_000
/** 单会话 trace 文件大小上限（字节）：超过删除重建（轮转），防止日志无限膨胀导致 appendFile 越来越慢 */
const HTTP_TRACE_MAX_FILE_BYTES = 50 * 1024 * 1024

export interface HttpTraceStore {
  /** 会话的 HTTP trace 文件路径（每会话一个文件，会话隔离） */
  path(sid: string): string
  append(sid: string, trace: HttpTrace): Promise<void>
  read(sid: string): Promise<HttpTraceRecord[]>
}

export function createHttpTraceStore(tracesDir: string): HttpTraceStore {
  const path = (sid: string): string => join(tracesDir, `${sid}.http.log`)

  /** 追加一条 HTTP 原始请求/响应记录到会话 trace 文件（格式参考 Taco logger：`[ISO时间] [TAG]\n{pretty JSON}\n`，失败静默，绝不阻断主流程） */
  async function append(sid: string, trace: HttpTrace): Promise<void> {
    try {
      await fs.mkdir(tracesDir, { recursive: true })
      const record: HttpTraceRecord = { ts: Date.now(), sessionId: sid, ...trace }
      const iso = new Date(record.ts).toISOString()
      const tag = `HTTP-${trace.phase.toUpperCase()}`
      // replacer 截断超长字符串字段：完整 messages / 原始响应体积可能达数 MB，pretty-print 会同步阻塞主进程事件循环
      const body = JSON.stringify(record, (_k, v) => {
        if (typeof v === 'string' && v.length > HTTP_TRACE_MAX_BODY_CHARS) {
          return `${v.slice(0, HTTP_TRACE_MAX_BODY_CHARS)}…（已截断，原始 ${v.length} 字符）`
        }
        return v
      }, 2)
      const line = `[${iso}] [${tag}]\n${body}\n`
      const filePath = path(sid)
      // 文件轮转：超过上限删除重建，防止日志无限增长拖慢后续追加写
      const stat = await fs.stat(filePath).catch(() => null)
      if (stat && stat.size > HTTP_TRACE_MAX_FILE_BYTES) {
        await fs.rm(filePath, { force: true })
      }
      await fs.appendFile(filePath, line, { mode: 0o600 })
    } catch {
      // 忽略 trace 写入失败
    }
  }

  /** 读取指定会话的 HTTP trace：按 `[ISO时间]` 行分隔每条记录（每条 = 一行 `[时间] [TAG]` + pretty JSON 块），损坏记录跳过；无文件返回空数组 */
  async function read(sid: string): Promise<HttpTraceRecord[]> {
    try {
      const raw = await fs.readFile(path(sid), 'utf8')
      const out: HttpTraceRecord[] = []
      // 以 `[ISO时间]` 开头的行作为每条记录的分隔点
      const blocks = raw.split(/\n(?=\[\d{4}-\d{2}-\d{2}T)/)
      for (const block of blocks) {
        // 每条记录：第一行是 `[时间] [TAG]`，其后是 pretty JSON（从首个 `{` 行开始）
        const lines = block.split('\n')
        const jsonStart = lines.findIndex((l) => l.trimStart().startsWith('{'))
        if (jsonStart < 0) continue
        const jsonText = lines.slice(jsonStart).join('\n')
        try {
          out.push(JSON.parse(jsonText) as HttpTraceRecord)
        } catch {
          // 跳过损坏记录
        }
      }
      return out
    } catch {
      return []
    }
  }

  return { path, append, read }
}
