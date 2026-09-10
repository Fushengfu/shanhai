/**
 * 技能市场客户端（**主进程**）：搜索 / 详情+审计预览 / 下载安装。
 *
 * 【为什么直连第三方而不是走山海网关】
 * 技能市场的**数据不是山海的**，而是两个第三方公开市场；taco（参考实现）也是客户端直连，
 * 它的 `ai-gateway/` 里 grep `skill|clawhub|skillhub` 为 0 命中 —— 网关本来就不参与这条链路。
 * 走网关等于为了一个不属于自己的数据源新增一套服务端，收益为负。鉴权同 taco：匿名 + User-Agent。
 *
 * 【安装的落盘形态】与既有 `SkillService` 完全兼容（`~/.shanhai/skills/<id>/SKILL.md`
 * + frontmatter 的 name/description），装完 AI 侧 `skill_list` 与新实例 `SkillService.list()`
 * 都能立刻看到（见 main/skills-mcp.ts 的 refreshSkills）。
 *
 * 【安全闸门（三重，缺一不可）】
 *  1) 预览阶段审计：SKILL.md 正文 + scripts/ 脚本 → riskLevel/warnings/requiresBins/requiresEnv；
 *  2) 落盘闸门：riskLevel 为 high/critical 时**必须**调用方显式传 confirmRisk: true，否则不下载任何东西；
 *  3) 解压闸门：解压**前**校验压缩包条目名（拒绝绝对路径 / `..` / 反斜杠 / 盘符），
 *     解压**后**再遍历落盘树（拒绝符号链接与越界路径），任一失败即整体回滚。
 */

import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  SkillInstallProgress,
  SkillInstallResult,
  SkillMarketItem,
  SkillMarketSearchResult,
  SkillMarketSource,
  SkillPreview,
} from '../shared/skills-market'
import {
  auditScriptFiles,
  auditSkillInstructions,
  listFilesRecursive,
  mergeSecurity,
  parseSkillMeta,
  validateArchiveNames,
  validateExtractionTree,
} from './skills-audit'

const execFileAsync = promisify(execFile)

/** 用户技能目录（与 packages/skills 的 SkillService 默认目录同一份真相） */
const SKILLS_DIR = join(homedir(), '.shanhai', 'skills')
/** 覆盖安装时的旧目录暂存区：放在 skillsDir **之外**，否则会被 SkillService 当成一个技能扫出来 */
const TRASH_DIR = join(homedir(), '.shanhai', '.skills-trash')

const UA = 'shanhai-ai-agent'
const REQ_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 60_000
/** 单个技能包体积上限（第三方包，防止一次把磁盘写爆） */
const MAX_ZIP_BYTES = 50 * 1024 * 1024

/** 分类 → SkillHub 的 category key（照抄 taco 的映射，12 类） */
const CATEGORY_TO_SKILLHUB_KEY: Record<string, string> = {
  office: 'office-efficiency',
  content: 'content-creation',
  dev: 'dev-programming',
  data: 'data-analysis',
  design: 'design-media',
  'ai-agent': 'ai-agent',
  knowledge: 'knowledge-management',
  business: 'business-ops',
  edu: 'education',
  pro: 'professional',
  itops: 'it-ops-security',
  life: 'life-service',
}

/* ------------------------------------------------------------------ */
/*  工具                                                                */
/* ------------------------------------------------------------------ */

/** 带超时的 fetch（Node 的 fetch 没有默认超时，第三方不可达时会一直挂着） */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * slug → 本地目录 id。
 * 只保留 `[a-z0-9-_.]`，其余替换为 `-`；去掉首尾的点与横线（防 `.` / `..` / 隐藏目录）。
 * 结果为空则抛错 —— 宁可不装，也不落一个来路不明的目录名。
 */
export function toSkillId(slug: string): string {
  const last = String(slug ?? '').split('/').filter(Boolean).pop() ?? ''
  const id = last
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
  if (!id || id === '.' || id === '..') throw new Error(`无法从 "${slug}" 推导出合法的技能目录名`)
  return id
}

function isSource(v: unknown): v is SkillMarketSource {
  return v === 'clawhub' || v === 'skillhub'
}

/** 本机已安装的技能目录名（每次现读，不用 SkillService 的缓存） */
async function installedIds(): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true })
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name))
  } catch {
    return new Set()
  }
}

/* ------------------------------------------------------------------ */
/*  搜索                                                                */
/* ------------------------------------------------------------------ */

interface ClawHubItem {
  slug?: string
  displayName?: string
  summary?: string
  downloads?: number
  version?: string
  ownerHandle?: string
}

interface SkillHubItem {
  slug?: string
  name?: string
  description?: string
  description_zh?: string
  downloads?: number
  version?: string
  ownerName?: string
  category?: string
  stars?: number
  installs?: number
}

async function searchClawHub(query: string): Promise<ClawHubItem[]> {
  const url = `https://clawhub.ai/api/v1/search?q=${encodeURIComponent(query)}`
  const resp = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': UA } }, REQ_TIMEOUT_MS)
  if (!resp.ok) throw new Error(`clawhub ${resp.status} ${resp.statusText}`)
  const data = (await resp.json()) as { results?: ClawHubItem[] }
  return Array.isArray(data?.results) ? data.results : []
}

async function searchSkillHub(
  query: string,
  category?: string,
  pageSize = 30,
): Promise<{ items: SkillHubItem[]; total: number }> {
  let url = `https://api.skillhub.cn/api/skills?keyword=${encodeURIComponent(query)}&sortBy=score&pageSize=${pageSize}&page=1`
  if (category) url += `&category=${encodeURIComponent(CATEGORY_TO_SKILLHUB_KEY[category] ?? category)}`
  const resp = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': UA } }, REQ_TIMEOUT_MS)
  if (!resp.ok) throw new Error(`skillhub ${resp.status} ${resp.statusText}`)
  const data = (await resp.json()) as { code?: number; data?: { skills?: SkillHubItem[]; total?: number } }
  const items = Array.isArray(data?.data?.skills) ? data.data.skills : []
  const total = typeof data?.data?.total === 'number' ? data.data.total : items.length
  return { items, total }
}

/**
 * 搜索两个市场并按下载量合并去重。
 * 单个市场失败不整体失败（另一半结果照常给）；两个都失败才回 error（UI 显示错误态，而不是「没搜到」）。
 */
export async function searchMarket(
  query: string,
  source: SkillMarketSource | 'all' = 'all',
  category?: string,
): Promise<SkillMarketSearchResult> {
  const q = String(query ?? '').trim()
  if (!q && !category) return { items: [], total: 0 }

  const errors: string[] = []
  const collected: Omit<SkillMarketItem, 'installed'>[] = []

  const wantClawHub = source === 'all' || source === 'clawhub'
  const wantSkillHub = source === 'all' || source === 'skillhub'

  const [clawhubRes, skillhubRes] = await Promise.all([
    wantClawHub
      ? searchClawHub(q).then((r) => ({ ok: true as const, r })).catch((e: unknown) => ({ ok: false as const, e }))
      : Promise.resolve({ ok: true as const, r: [] as ClawHubItem[] }),
    wantSkillHub
      ? searchSkillHub(q, category).then((r) => ({ ok: true as const, r })).catch((e: unknown) => ({ ok: false as const, e }))
      : Promise.resolve({ ok: true as const, r: { items: [] as SkillHubItem[], total: 0 } }),
  ])

  if (!clawhubRes.ok) errors.push(`ClawHub: ${clawhubRes.e instanceof Error ? clawhubRes.e.message : String(clawhubRes.e)}`)
  if (!skillhubRes.ok) errors.push(`SkillHub: ${skillhubRes.e instanceof Error ? skillhubRes.e.message : String(skillhubRes.e)}`)

  if (clawhubRes.ok) {
    for (const it of clawhubRes.r) {
      if (!it.slug) continue
      collected.push({
        slug: it.slug,
        displayName: it.displayName || it.slug,
        summary: it.summary || '',
        downloads: typeof it.downloads === 'number' ? it.downloads : 0,
        version: it.version || undefined,
        authorName: it.ownerHandle || '未知',
        source: 'clawhub',
      })
    }
  }
  if (skillhubRes.ok) {
    for (const it of skillhubRes.r.items) {
      if (!it.slug) continue
      collected.push({
        slug: it.slug,
        displayName: it.name || it.slug,
        summary: it.description_zh || it.description || '',
        downloads: typeof it.downloads === 'number' ? it.downloads : 0,
        version: it.version || undefined,
        authorName: it.ownerName || '未知',
        source: 'skillhub',
        category: it.category || undefined,
        stars: typeof it.stars === 'number' ? it.stars : undefined,
        installs: typeof it.installs === 'number' ? it.installs : undefined,
      })
    }
  }

  // 去重（同一 slug 取下载量大的那条）+ 按下载量倒序
  const bySlug = new Map<string, Omit<SkillMarketItem, 'installed'>>()
  for (const item of collected) {
    const prev = bySlug.get(item.slug)
    if (!prev || item.downloads > prev.downloads) bySlug.set(item.slug, item)
  }
  const installed = await installedIds()
  const items = [...bySlug.values()]
    .sort((a, b) => b.downloads - a.downloads)
    .map((it) => {
      let id = ''
      try {
        id = toSkillId(it.slug)
      } catch {
        id = ''
      }
      return { ...it, installed: id ? installed.has(id) : false }
    })

  const total = (skillhubRes.ok ? skillhubRes.r.total : 0) || items.length
  return errors.length === 2 ? { items, total, error: errors.join(' ｜ ') } : { items, total }
}

/* ------------------------------------------------------------------ */
/*  详情 + 审计预览                                                      */
/* ------------------------------------------------------------------ */

async function fetchSkillMd(source: SkillMarketSource, slug: string): Promise<string> {
  const host = source === 'skillhub' ? 'https://api.skillhub.cn' : 'https://clawhub.ai'
  const url = `${host}/api/v1/skills/${encodeURIComponent(slug)}/file?path=SKILL.md`
  const resp = await fetchWithTimeout(url, { headers: { Accept: 'text/plain', 'User-Agent': UA } }, REQ_TIMEOUT_MS)
  if (!resp.ok) throw new Error(`获取 SKILL.md 失败：${resp.status} ${resp.statusText}`)
  const text = await resp.text()
  if (!text.trim()) throw new Error('SKILL.md 内容为空')
  return text
}

/** 检查本机是否具备 requiresBins / requiresEnv（只报缺失项，不阻断安装 —— 与 taco 的运行时门控一致） */
async function checkRequirements(bins: string[], envs: string[]): Promise<{ missingBins: string[]; missingEnv: string[] }> {
  const missingBins: string[] = []
  for (const bin of bins) {
    const name = String(bin ?? '').trim()
    if (!name) continue
    try {
      await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [name], { windowsHide: true })
    } catch {
      missingBins.push(name)
    }
  }
  const missingEnv = envs.filter((k) => !String(process.env[String(k)] ?? '').trim())
  return { missingBins, missingEnv }
}

/**
 * 拉取 SKILL.md → 解析 frontmatter → 审计正文 → 预检依赖。
 * 注意：此处只审 SKILL.md（scripts/ 要等包下载解压后才能审），
 * 因此安装的最终风险等级取「预览风险」与「脚本风险」的合并值（见 install）。
 */
export async function previewSkill(source: SkillMarketSource, slug: string): Promise<SkillPreview> {
  const md = await fetchSkillMd(source, slug)
  const meta = parseSkillMeta(md)
  const audit = auditSkillInstructions(md, meta)
  const { missingBins, missingEnv } = await checkRequirements(meta.requiresBins, meta.requiresEnv)
  const id = toSkillId(slug)
  const installed = (await installedIds()).has(id)

  return {
    slug,
    source,
    id,
    name: meta.name || id,
    description: meta.description || '',
    version: meta.version || '',
    author: meta.author || '',
    requiresBins: meta.requiresBins,
    requiresEnv: meta.requiresEnv,
    missingBins,
    missingEnv,
    riskLevel: audit.riskLevel,
    warnings: audit.warnings,
    instructions: md,
    installed,
  }
}

/* ------------------------------------------------------------------ */
/*  下载 + 安装                                                         */
/* ------------------------------------------------------------------ */

/** 列出压缩包条目名（解压前校验用）：macOS/Linux 走 unzip -Z1 */
async function listArchiveEntries(zipPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath], { maxBuffer: 8 * 1024 * 1024 })
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

async function extractArchive(zipPath: string, destDir: string): Promise<void> {
  await execFileAsync('unzip', ['-o', zipPath, '-d', destDir], { maxBuffer: 8 * 1024 * 1024 })
}

/** 解压后若所有内容都在同一个顶层目录里，则整体上移一层（与 taco 一致） */
async function flattenSingleTopDir(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0]?.isDirectory()) return
  const inner = join(dir, entries[0].name)
  for (const child of await fs.readdir(inner)) {
    await fs.rename(join(inner, child), join(dir, child))
  }
  await fs.rm(inner, { recursive: true, force: true })
}

/**
 * 从市场安装一个技能。
 *
 * 流程：详情+审计 → 风险闸门 → 下载 → 条目名校验 → 解压 → 落盘树校验 → 脚本审计 → 提交（原子换入）
 * 任一步失败：清理临时目录、保留旧版本（若有），返回 error。**不会留下半装状态**。
 */
export async function installFromMarket(
  payload: { source: unknown; slug: unknown; confirmRisk?: unknown },
  onProgress?: (p: SkillInstallProgress) => void,
): Promise<SkillInstallResult> {
  const source = payload?.source
  const slug = String(payload?.slug ?? '').trim()
  const confirmRisk = payload?.confirmRisk === true

  if (!isSource(source)) return { ok: false, error: '未知的技能市场来源' }
  if (!slug) return { ok: false, error: '缺少技能标识' }

  let id: string
  try {
    id = toSkillId(slug)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const report = (stage: SkillInstallProgress['stage'], percent: number): void => {
    try {
      onProgress?.({ slug, stage, percent })
    } catch {
      /* 进度回调不该影响安装流程 */
    }
  }

  const work = await fs.mkdtemp(join(tmpdir(), 'shanhai-skill-'))
  const zipPath = join(work, 'package.zip')
  const stageDir = join(work, 'stage')

  const cleanup = async (): Promise<void> => {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }

  try {
    // ① 预览 + 风险闸门
    report('audit', -1)
    const preview = await previewSkill(source, slug)
    if ((preview.riskLevel === 'high' || preview.riskLevel === 'critical') && !confirmRisk) {
      await cleanup()
      return { ok: false, needConfirm: true, preview, error: '该技能风险等级较高，需确认后安装' }
    }

    // ② 下载
    report('download', -1)
    const host = source === 'skillhub' ? 'https://api.skillhub.cn' : 'https://clawhub.ai'
    const dlUrl = `${host}/api/v1/download?slug=${encodeURIComponent(slug)}`
    const resp = await fetchWithTimeout(dlUrl, { headers: { 'User-Agent': UA } }, DOWNLOAD_TIMEOUT_MS)
    if (!resp.ok) throw new Error(`下载失败：${resp.status} ${resp.statusText}`)
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length === 0) throw new Error('下载到的压缩包为空')
    if (buf.length > MAX_ZIP_BYTES) throw new Error(`压缩包过大（${(buf.length / 1024 / 1024).toFixed(1)}MB），已拒绝`)
    await fs.writeFile(zipPath, buf)
    report('download', 40)

    // ③ 解压前：条目名校验
    report('verify', 50)
    const names = await listArchiveEntries(zipPath)
    if (names.length === 0) throw new Error('压缩包内没有文件')
    validateArchiveNames(names)

    // ④ 解压
    report('extract', 60)
    await fs.mkdir(stageDir, { recursive: true })
    await extractArchive(zipPath, stageDir)
    await flattenSingleTopDir(stageDir)

    // ⑤ 解压后：落盘树校验（符号链接 / 越界路径）
    await validateExtractionTree(stageDir)
    const mdPath = join(stageDir, 'SKILL.md')
    try {
      await fs.access(mdPath)
    } catch {
      throw new Error('该技能包内没有 SKILL.md，不符合技能格式')
    }

    // ⑥ 脚本审计（SKILL.md 已审过；此处合并 scripts/ 审计结果）
    report('audit', 75)
    const scriptCheck = await auditScriptFiles(stageDir)
    const merged = mergeSecurity({ riskLevel: preview.riskLevel, warnings: preview.warnings }, scriptCheck)
    if ((merged.riskLevel === 'high' || merged.riskLevel === 'critical') && !confirmRisk) {
      await cleanup()
      return {
        ok: false,
        needConfirm: true,
        preview: { ...preview, riskLevel: merged.riskLevel, warnings: merged.warnings },
        error: '该技能的脚本风险等级较高，需确认后安装',
      }
    }

    const files = await listFilesRecursive(stageDir)

    // ⑦ 提交：旧版本暂存 → 换入 → 清暂存
    report('commit', 90)
    const target = join(SKILLS_DIR, id)
    await fs.mkdir(SKILLS_DIR, { recursive: true })
    let trashed: string | null = null
    try {
      await fs.access(target)
      await fs.mkdir(TRASH_DIR, { recursive: true })
      trashed = join(TRASH_DIR, `${id}-${Date.now()}`)
      await fs.rename(target, trashed)
    } catch {
      trashed = null // 目标不存在 = 首次安装
    }

    try {
      await fs.rename(stageDir, target)
    } catch (e) {
      // 换入失败：把旧版本放回去，不留半装状态
      if (trashed) await fs.rename(trashed, target).catch(() => undefined)
      throw e
    }
    if (trashed) await fs.rm(trashed, { recursive: true, force: true }).catch(() => undefined)

    report('commit', 100)
    await cleanup()
    return {
      ok: true,
      id,
      dir: target,
      files,
      preview: { ...preview, riskLevel: merged.riskLevel, warnings: merged.warnings, installed: true },
    }
  } catch (err) {
    await cleanup()
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
