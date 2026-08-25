import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sessionDirPath,
  writeSessionMetaFile,
  readSessionMetaFile,
  appendSessionEventsFile,
  rewriteSessionEventsFile,
  loadSessionEventsFile,
  rotateSessionEventsFile,
  streamSessionEvents,
  compactSessionEventsFile,
  listSegmentFiles,
  deleteSessionDir,
  legacySessionFilePath,
  migrateLegacySessionFile,
} from '../src/session-store'
import type { SessionEvent } from '@shanhai/session'

const ev = (type: string, data: unknown, ts = 1): SessionEvent => ({ type, data, timestamp: ts } as SessionEvent)

describe('session-store 追加式分片存储', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'shanhai-session-store-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('meta 覆盖写 + 读回', async () => {
    const sdir = sessionDirPath(dir, 's1')
    await writeSessionMetaFile(sdir, { id: 's1', title: '标题', workDir: '/w', lastActiveAt: 123 })
    const meta = await readSessionMetaFile(sdir)
    expect(meta).toEqual({ id: 's1', title: '标题', workDir: '/w', lastActiveAt: 123 })
  })

  it('events 追加写 + 逐行读回（顺序与内容一致）', async () => {
    const sdir = sessionDirPath(dir, 's1')
    await appendSessionEventsFile(sdir, [ev('user/message', { content: 'hi' }), ev('assistant/message', { content: 'hello' })])
    await appendSessionEventsFile(sdir, [ev('turn/end', { turn: 1, text: 'done' })])
    const events = await loadSessionEventsFile(sdir)
    expect(events.map((e) => e.type)).toEqual(['user/message', 'assistant/message', 'turn/end'])
    expect((events[0]!.data as { content: string }).content).toBe('hi')
  })

  it('重写覆盖旧内容', async () => {
    const sdir = sessionDirPath(dir, 's1')
    await appendSessionEventsFile(sdir, [ev('user/message', { content: 'old' })])
    await rewriteSessionEventsFile(sdir, [ev('user/message', { content: 'new' })])
    const events = await loadSessionEventsFile(sdir)
    expect(events).toHaveLength(1)
    expect((events[0]!.data as { content: string }).content).toBe('new')
  })

  it('读不存在的目录返回空数组', async () => {
    const events = await loadSessionEventsFile(sessionDirPath(dir, 'nope'))
    expect(events).toEqual([])
  })

  it('删除整个会话目录', async () => {
    const sdir = sessionDirPath(dir, 's1')
    await writeSessionMetaFile(sdir, { id: 's1', title: 't', workDir: '/w', lastActiveAt: 1 })
    await appendSessionEventsFile(sdir, [ev('user/message', { content: 'x' })])
    await deleteSessionDir(sdir)
    await expect(fs.readFile(join(sdir, 'meta.json'), 'utf8')).rejects.toThrow()
  })

  it('旧格式迁移：单文件 → 目录，数据等价，旧文件删除', async () => {
    const legacy = legacySessionFilePath(dir, 's-old')
    const events = [ev('user/message', { content: 'hi' }), ev('assistant/message', { content: 'yo' })]
    await fs.writeFile(legacy, JSON.stringify({ id: 's-old', title: '旧会话', workDir: '/legacy', lastActiveAt: 99, events }), 'utf8')

    const result = await migrateLegacySessionFile(dir, 's-old', '/default')
    expect(result).toEqual({ title: '旧会话', workDir: '/legacy', lastActiveAt: 99, events })

    // 旧文件已删除
    await expect(fs.readFile(legacy, 'utf8')).rejects.toThrow()
    // 新目录 meta + events 正确
    const meta = await readSessionMetaFile(sessionDirPath(dir, 's-old'))
    expect(meta?.title).toBe('旧会话')
    const loaded = await loadSessionEventsFile(sessionDirPath(dir, 's-old'))
    expect(loaded.map((e) => e.type)).toEqual(['user/message', 'assistant/message'])
  })

  it('旧格式迁移缺省 workDir 用默认值', async () => {
    const legacy = legacySessionFilePath(dir, 's2')
    await fs.writeFile(legacy, JSON.stringify({ id: 's2', title: '无wd', events: [ev('user/message', { content: 'x' })] }), 'utf8')
    const result = await migrateLegacySessionFile(dir, 's2', '/default-wd')
    expect(result?.workDir).toBe('/default-wd')
  })

  it('旧格式迁移：回放 model/select 与 approval/policy 到 meta', async () => {
    const legacy = legacySessionFilePath(dir, 's3')
    const events = [
      ev('user/message', { content: 'hi' }),
      ev('model/select', { modelId: 'deepseek-v4-flash' }),
      ev('approval/policy', { policy: 'never' }),
    ]
    await fs.writeFile(legacy, JSON.stringify({ id: 's3', title: '有模型', workDir: '/w', lastActiveAt: 5, events }), 'utf8')

    const result = await migrateLegacySessionFile(dir, 's3', '/default')
    expect(result?.modelId).toBe('deepseek-v4-flash')
    expect(result?.approvalPolicy).toBe('never')

    const meta = await readSessionMetaFile(sessionDirPath(dir, 's3'))
    expect(meta?.modelId).toBe('deepseek-v4-flash')
    expect(meta?.approvalPolicy).toBe('never')
  })
})

describe('session-store 日志轮转 / 压缩 / 流式读取', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'shanhai-session-rotate-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('活跃段超阈值自动轮转：历史段归档为 gz，活跃段清空，读回顺序一致', async () => {
    const sdir = sessionDirPath(dir, 's1')
    const big = 'x'.repeat(500) // 单条事件 ~ 500 字节
    // 用 10 字节阈值触发轮转：多次 append，每次追加后活跃段可能被归档
    await appendSessionEventsFile(sdir, [ev('user/message', { content: big })], 10)
    await appendSessionEventsFile(sdir, [ev('assistant/message', { content: big })], 10)
    await appendSessionEventsFile(sdir, [ev('turn/end', { turn: 1, text: 'done' })], 10)
    const segments = await listSegmentFiles(sdir)
    expect(segments.length).toBeGreaterThan(0)
    const events = await loadSessionEventsFile(sdir)
    expect(events.map((e) => e.type)).toEqual(['user/message', 'assistant/message', 'turn/end'])
    expect((events[0]!.data as { content: string }).content).toBe(big)
  })

  it('compact force 无论大小都把活跃段归档为 gz', async () => {
    const sdir = sessionDirPath(dir, 's1')
    await appendSessionEventsFile(sdir, [ev('user/message', { content: 'hello' })])
    // 默认阈值下不会轮转（文件很小）
    expect(await listSegmentFiles(sdir)).toHaveLength(0)
    // force 压缩归档：活跃段清空，产生 1 个归档段
    const rotated = await compactSessionEventsFile(sdir, true)
    expect(rotated).toBe(true)
    expect(await listSegmentFiles(sdir)).toHaveLength(1)
    // 读回内容不丢
    const events = await loadSessionEventsFile(sdir)
    expect(events).toHaveLength(1)
    expect((events[0]!.data as { content: string }).content).toBe('hello')
  })

  it('streamSessionEvents 逐条流式 yield，顺序与 load 一致', async () => {
    const sdir = sessionDirPath(dir, 's1')
    const types = ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end'] as const
    for (const t of types) {
      await appendSessionEventsFile(sdir, [ev(t, { content: t })], 10)
    }
    const streamed: string[] = []
    for await (const e of streamSessionEvents(sdir)) streamed.push(e.type)
    expect(streamed).toEqual([...types])
  })

  it('rewrite 全量重写后清空归档段（避免新旧重复）', async () => {
    const sdir = sessionDirPath(dir, 's1')
    await appendSessionEventsFile(sdir, [ev('user/message', { content: 'a' }), ev('assistant/message', { content: 'b' })], 10)
    expect(await listSegmentFiles(sdir)).toHaveLength(1)
    // 全量重写（截断场景）：归档段被清除，历史归并到活跃段
    await rewriteSessionEventsFile(sdir, [ev('user/message', { content: 'only' })])
    expect(await listSegmentFiles(sdir)).toHaveLength(0)
    const events = await loadSessionEventsFile(sdir)
    expect(events).toHaveLength(1)
    expect((events[0]!.data as { content: string }).content).toBe('only')
  })

  it('轮转后继续追加，新旧段顺序连续不丢', async () => {
    const sdir = sessionDirPath(dir, 's1')
    const n = 30
    for (let i = 0; i < n; i++) {
      await appendSessionEventsFile(sdir, [ev('user/message', { content: `m${i}` })], 40)
    }
    const events = await loadSessionEventsFile(sdir)
    expect(events).toHaveLength(n)
    expect((events[0]!.data as { content: string }).content).toBe('m0')
    expect((events[n - 1]!.data as { content: string }).content).toBe(`m${n - 1}`)
  })
})
