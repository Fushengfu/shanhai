import { app, dialog } from 'electron'
import { join, basename, resolve, sep } from 'node:path'
import { promises as fs, existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getRuntime } from './runtime'
import { packagePluginShare, SCAFFOLD_WORKSPACE_DIR } from '@shanhai/selfmod'
import { uploadToQiniu } from '@shanhai/storage'
import { PLUGINS_DIR } from './plugin-apps'
import { getMainLocale } from './locale-store'
import { tIn } from '../shared/i18n'
// 任务122：版本比较提到 shared 层（主进程算 hasUpdate / 防降级，渲染层算「提交升级版本共享」，两处共用一份）
import { compareVersions, versionRelation } from '../shared/market-semver'

const execFileAsync = promisify(execFile)

/**
 * 插件市场（任务 2/4：Dock「插件市场」应用 + 下载安装 + 提交）。
 *
 * 网关接口契约（与 AI网关 会话定稿，勿改字段）：
 * - 列表   GET  /api/v1/public/plugins?keyword=&category=&hasUI=&page=&pageSize=
 * - 详情   GET  /api/v1/public/plugins/{pluginId}
 * - 下载   GET  /api/v1/public/plugins/{pluginId}/download（响应带 X-SHA256 头 + Content-Disposition: attachment）
 * - 上传凭证 GET /api/v1/plugins/upload-token?filename=xxx.zip（Bearer gatewayApiKey）→ {provider,upload_url,token,key,public_base_url,domain}
 * - 提交   POST /api/v1/plugins（application/json：file_url/file_sha256/元数据，网关 APIKey 鉴权；勿传 author）
 */

/** 网关基址（与 app-updater / device-report 同一 AI 网关） */
const API_BASE = 'https://aigateway.bjctykj.com'
const MARKET_LIST_URL = `${API_BASE}/api/v1/public/plugins`
const MARKET_SUBMIT_URL = `${API_BASE}/api/v1/plugins`

/** 市场插件条目（对齐网关列表接口返回字段，兼容 snake_case / camelCase 两种命名） */
export interface MarketPlugin {
  id: string
  pluginId?: string
  name: string
  purpose: string
  version?: string
  author?: string
  hasUI?: boolean
  categories?: string[]
  iconUrl?: string
  fileSha256?: string
  fileSize?: number
  /** 本地是否已安装（列表返回时由山海侧补充，供 UI 显示「已安装」状态） */
  installed?: boolean
  /**
   * 网关这一行的**数字主键**（任务122④）。下载时优先用它锁行：
   * 网关按 plugin_id 选版是 `ORDER BY id DESC`，而后台 Restore 缺陷可能让同一 plugin_id 出现两条
   * approved 记录（列表不去重）⇒ 用行 id 才能保证「界面显示的那条」与「拿到的包」是同一个。
   */
  rowId?: number
  /** 本地已安装版本（读 ~/.shanhai/plugins/<id>/manifest.json，未安装为 undefined） */
  localVersion?: string
  /** 有更新：市场 version 明确高于本地 manifest.version（unknown 关系不谎报可升级） */
  hasUpdate?: boolean
  /** 防降级标记（任务122②）：市场 version 明确低于本地 ⇒ 按钮灰态，安装侧也会再拦一次 */
  downgrade?: boolean
  /** 本机是否有可恢复的旧版本备份（任务122⑤：只能靠本地备份，网关无版本历史接口） */
  hasBackup?: boolean
  /** 备份对应的版本号（目录名 <id>@<version> 里的 version） */
  backupVersion?: string
}

/** 解析网关响应信封（兼容 { data } / 直接数组 / { list } / { items } / { data:{list} } 等形态） */
function unwrapList(json: unknown): { list: unknown[]; total: number } {
  if (Array.isArray(json)) return { list: json, total: json.length }
  const obj = json as Record<string, unknown>
  const data = obj?.data
  let maybe: unknown
  let total: number
  if (Array.isArray(data)) {
    // 形态 { data: [...] }
    maybe = data
    total = typeof obj?.total === 'number' ? obj.total : data.length
  } else if (data !== null && typeof data === 'object') {
    // 形态 { code, data: { list: [...] , total } }（网关公开接口信封：数组在 data 对象内一层）
    const d = data as Record<string, unknown>
    maybe = d.list ?? d.items ?? d.plugins ?? d.records ?? d.rows
    total = typeof d.total === 'number' ? d.total : typeof obj?.total === 'number' ? (obj.total as number) : 0
  } else {
    // 形态 { list: [...] } / { items: [...] } / { plugins: [...] }
    maybe = obj?.list ?? obj?.items ?? obj?.plugins
    total = typeof obj?.total === 'number' ? obj.total : 0
  }
  const arr = Array.isArray(maybe) ? maybe : []
  if (arr.length && total === 0) total = arr.length
  return { list: arr, total }
}

/** 归一化单个市场插件条目（兼容字段名变体） */
function normalizeMarketPlugin(raw: Record<string, unknown>): MarketPlugin {
  // 注意：网关列表里 `id` 是数字自增主键，`plugin_id` 才是真正的 kebab-case 插件 id
  // （与本地 ~/.shanhai/plugins/<id>/ 目录名、下载接口 /plugins/{plugin_id}/download 对齐）。
  // 因此这里必须优先取 plugin_id，否则「已安装」标记（installed.has(p.id)）和下载安装都会比对到数字 id 而失效。
  const id = String(raw.plugin_id ?? raw.pluginId ?? raw.id ?? '').trim()
  // 数字行 id（网关主键）：raw.id 是数字时才是行 id；若该形态下 id 已被当成 kebab plugin_id 用，
  // Number() 得 NaN → rowId 留空，下载自动回落 plugin_id 路由（不猜）。
  const rawRowId = Number(raw.id)
  const rowId = Number.isFinite(rawRowId) && rawRowId > 0 ? rawRowId : undefined
  return {
    id,
    pluginId: id,
    rowId,
    name: String(raw.name ?? '').trim(),
    purpose: String(raw.purpose ?? raw.description ?? '').trim(),
    version: raw.version ? String(raw.version) : undefined,
    author: raw.author ? String(raw.author) : undefined,
    hasUI: typeof raw.hasUI === 'boolean' ? raw.hasUI : raw.has_ui === true,
    categories: Array.isArray(raw.categories) ? raw.categories.map((c) => String(c)) : [],
    iconUrl: raw.icon_url ? String(raw.icon_url) : raw.iconUrl ? String(raw.iconUrl) : undefined,
    fileSha256: raw.file_sha256 ? String(raw.file_sha256) : raw.fileSha256 ? String(raw.fileSha256) : undefined,
    fileSize: typeof raw.file_size === 'number' ? raw.file_size : undefined,
  }
}

/** 已安装插件的持久化 id 集合（用于列表里标记「已安装」） */
function installedPluginIds(): Set<string> {
  const ids = new Set<string>()
  try {
    const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) ids.add(e.name)
    }
  } catch {
    // 目录不存在 = 无已安装插件
  }
  return ids
}


/* ────────────── 任务122：升级判定 / 备份 / 原子换盘 / 记账 / 恢复 ────────────── */

/**
 * 备份根目录 ~/.shanhai/plugins-backup/<id>@<version>/
 * 与 PLUGINS_DIR 同级 ⇒「旧目录挪进备份」是同卷 rename（原子），不存在跨卷 EXDEV；
 * 而 staging 在应用 temp 下，与 ~/.shanhai 可能不同卷 ⇒ 换盘那一步才有 EXDEV 兜底。
 */
const PLUGINS_BACKUP_DIR = resolve(PLUGINS_DIR, '..', 'plugins-backup')

/**
 * 最近一次列表加载得到的市场行信息（plugin_id → { 网关数字行 id, 列表 version }）。
 * 只当**提示**用，两处：
 *  1) 下载优先按数字行 id 锁行（任务122④）；
 *  2)「恢复上一版本」快速路径：已知市场版本不高于本地 ⇒ 不必先下一遍 zip 就能进恢复流程（离线也能回退）。
 * 缓存缺失时两条都自动退化（按 plugin_id 下载 / 下载后用实际包版本权威比较），不影响正确性。
 */
const marketRowCache = new Map<string, { rowId?: number; version?: string }>()

/** 插件目录里属于「包本身」的条目（升级换盘时不算用户本地数据） */
const KNOWN_PACKAGE_ENTRIES = new Set(['manifest.json', 'dist', 'node_modules', '.DS_Store'])

/** 本地已安装插件状态 */
interface LocalPluginState {
  version?: string
  name?: string
  /** manifest 原文（记账字段读取用） */
  manifest: Record<string, unknown>
  permissions: string[]
  /** manifest.json / dist / icon / assets 之外的目录条目 —— 可能是插件自己写在目录里的用户数据 */
  extraFiles: string[]
}

/** 读本地已安装插件状态；未安装 / manifest 不可解析 → undefined（不猜） */
function readLocalPluginState(id: string): LocalPluginState | undefined {
  const dir = join(PLUGINS_DIR, id)
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) return undefined
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
  const known = new Set(KNOWN_PACKAGE_ENTRIES)
  if (typeof meta.icon === 'string' && meta.icon) known.add(basename(meta.icon))
  if (Array.isArray(meta.assets)) {
    for (const a of meta.assets) if (typeof a === 'string' && a) known.add(basename(a))
  }
  let extraFiles: string[] = []
  try {
    extraFiles = readdirSync(dir, { withFileTypes: true }).filter((e) => !known.has(e.name)).map((e) => e.name)
  } catch {
    // 目录读不动 ⇒ 按「无额外文件」处理：宁可少提示一次，也不谎报用户数据风险
  }
  return {
    version: typeof meta.version === 'string' && meta.version ? meta.version : undefined,
    name: typeof meta.name === 'string' ? meta.name : undefined,
    manifest: meta,
    permissions: Array.isArray(meta.permissions) ? meta.permissions.map((p) => String(p)) : [],
    extraFiles,
  }
}

/** 版本号做成目录名安全串（缺版本时带时间戳，避免多份备份互相覆盖） */
function backupVersionTag(v?: string): string {
  const s = String(v ?? '')
    .trim()
    .replace(/[^0-9A-Za-z._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || `unknown-${Date.now()}`
}

/** 某插件的本机备份列表（写入侧保证只保 1 份；这里仍按数组返回，[0] 即当前那份） */
function backupDirsOf(id: string): { dir: string; version: string }[] {
  try {
    return readdirSync(PLUGINS_BACKUP_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(`${id}@`))
      .map((e) => ({ dir: join(PLUGINS_BACKUP_DIR, e.name), version: e.name.slice(id.length + 1) }))
  } catch {
    return []
  }
}

/**
 * 换盘失败的带状态错误：rolledBack = 旧版本是否已被挪回原位。
 * ★为什么要带这个标记：回滚走的是「rename 失败再退化成复制」，复制很可能成功；那时插件其实
 *   是可用的，若外层只报「安装失败」，用户会以为插件坏了 —— 属于「失败原因说得不准」那一类。
 */
class SwapFailure extends Error {
  constructor(
    message: string,
    readonly rolledBack: boolean,
    readonly backupDir?: string,
  ) {
    super(message)
  }
}

/** 取 errno code（不依赖 NodeJS 命名空间，避免跨 tsconfig 的类型漂移） */
function errCode(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code ?? '') : ''
}

/**
 * 整目录搬迁：先 rename（同卷原子），跨卷（EXDEV）退化为「复制 → 校验 manifest 可读 → 删源」。
 * ★任何失败都抛给调用方决定回滚；本函数绝不先删目标目录。
 */
async function relocateDir(srcDir: string, dstDir: string): Promise<void> {
  try {
    await fs.rename(srcDir, dstDir)
    return
  } catch (err) {
    if (errCode(err) !== 'EXDEV') throw err
  }
  await fs.cp(srcDir, dstDir, { recursive: true, force: true })
  try {
    JSON.parse(await fs.readFile(join(dstDir, 'manifest.json'), 'utf8'))
  } catch {
    throw new Error(`跨卷复制后 manifest.json 不可读：${dstDir}`)
  }
  await fs.rm(srcDir, { recursive: true, force: true })
}

/** 路径越界防御：目标必须落在 plugins 根内（沿用改前判断口径，抽成函数供换盘/恢复复用） */
function assertInsidePlugins(root: string, target: string, id: string): void {
  const r = resolve(root)
  const t = resolve(target)
  if (t !== r && !t.startsWith(r + sep)) {
    throw new Error(tIn(getMainLocale(), 'market.err.idOutOfRange', { id }))
  }
}

/**
 * 备份 + 原子换盘（★本轮安全底座）。
 * 改前序列是 `rm(旧目录) → 逐条 rename(新包)`：新包任何一步失败就是「旧已删、新未到位」的半安装态，
 * 插件直接消失且无备份可回退（任务121 摸底 E15 的最高风险项）。
 * 现在：旧目录整体 rename 进备份（同卷原子）→ 新包 relocate 到位 → 失败则删掉半成品并把备份挪回。
 */
async function swapPackageIntoTarget(
  id: string,
  stagingDir: string,
  oldVersion?: string,
): Promise<{ targetDir: string; backupDir?: string }> {
  const targetDir = join(PLUGINS_DIR, id)
  assertInsidePlugins(PLUGINS_DIR, targetDir, id)
  let backupDir: string | undefined
  if (existsSync(targetDir)) {
    const dest = join(PLUGINS_BACKUP_DIR, `${id}@${backupVersionTag(oldVersion)}`)
    // 只保 1 份（用户拍板）：清同 id 其它旧备份，但绝不清本次要写的那份目标
    for (const b of backupDirsOf(id)) {
      if (resolve(b.dir) === resolve(dest)) continue
      await fs.rm(b.dir, { recursive: true, force: true }).catch(() => undefined)
    }
    await fs.mkdir(PLUGINS_BACKUP_DIR, { recursive: true })
    await relocateDir(targetDir, dest)
    backupDir = dest
  }
  try {
    await relocateDir(stagingDir, targetDir)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!backupDir) throw err
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined)
    let rolledBack = true
    try {
      await restoreBackupDir(backupDir, targetDir)
    } catch {
      rolledBack = false
    }
    // 回滚成功 ⇒ 旧版本仍在原位、插件可用；回滚失败 ⇒ 旧版本只剩备份目录，必须把路径交给用户
    throw new SwapFailure(msg, rolledBack, rolledBack ? undefined : backupDir)
  }
  return { targetDir, backupDir }
}

/**
 * 换盘【前】的预检 —— 把 installFromDisk 会抛的两类错误提前拦掉。
 *
 * selfmod.installFromDisk 是「先撤旧 inventory（disposer + removeClient + inventory.remove）
 * 再校验新包产物」，一旦校验失败就是「磁盘是新包、内存是空、重启前不可用」（任务121 摸底 E15②）。
 * 本轮不改 selfmod 的撤销/激活语义（那会牵动 restoreAll / skipApproval 的既有契约），
 * 而是把它校验的两件事提前在这里做完 ⇒ 那个窗口在本路径上被压成零：
 *   ① PluginStore.load 要求 manifest.id === 目录名 且 typeof manifest.name === 'string'；
 *   ② installFromDisk 要求 dist/host.cjs / dist/client.html 至少其一存在（与 store.entryFile 同口径）。
 */
function precheckStagingPackage(
  stagingDir: string,
  id: string,
): { ok: true; version?: string; name: string; permissions: string[] } | { ok: false; message: string } {
  const locale = getMainLocale()
  const manifestPath = join(stagingDir, 'manifest.json')
  if (!existsSync(manifestPath)) return { ok: false, message: tIn(locale, 'market.err.noManifest') }
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  } catch {
    return { ok: false, message: tIn(locale, 'market.err.manifestParse') }
  }
  const manifestId = String(manifest.id ?? manifest.plugin_id ?? '').trim()
  if (!manifestId || !/^[a-zA-Z0-9_-]+$/.test(manifestId)) {
    return { ok: false, message: tIn(locale, 'market.err.manifestIdIllegal', { id: manifestId || tIn(locale, 'market.err.idEmpty') }) }
  }
  // manifest id 必须与请求的 pluginId 一致，防止张冠李戴
  if (manifestId !== id) {
    return { ok: false, message: tIn(locale, 'market.err.manifestIdMismatch', { manifestId, id }) }
  }
  if (typeof manifest.name !== 'string' || !manifest.name) {
    return { ok: false, message: tIn(locale, 'market.err.manifestNameMissing', { id }) }
  }
  const hasHost = existsSync(join(stagingDir, 'dist', 'host.cjs'))
  const hasHtml = existsSync(join(stagingDir, 'dist', 'client.html'))
  if (!hasHost && !hasHtml) {
    return { ok: false, message: tIn(locale, 'market.err.noArtifact', { id }) }
  }
  return {
    ok: true,
    version: typeof manifest.version === 'string' && manifest.version ? manifest.version : undefined,
    name: manifest.name,
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions.map((p) => String(p)) : [],
  }
}

/**
 * 解析下载响应头 Content-Disposition 里的版本（网关形态：filename={plugin_id}-{version}.zip）。
 * 任务122①：记账要「实际落盘 manifest.version / 响应头 version / X-SHA256」三者对齐，
 * 列表 version 只用于展示与触发。解析不出返回 undefined（不猜，后续跳过对齐校验）。
 */
function parseContentDispositionVersion(cd: string | null, id: string): string | undefined {
  if (!cd) return undefined
  const m = cd.match(/filename\*?\s*=\s*(?:UTF-8'')?"?([^";]+)"?/i)
  if (!m) return undefined
  let name = String(m[1] ?? '').trim()
  try {
    name = decodeURIComponent(name)
  } catch {
    // 原文已可用
  }
  name = name.replace(/\.zip$/i, '')
  const prefix = `${id}-`
  if (name.startsWith(prefix)) {
    const v = name.slice(prefix.length).trim()
    return v || undefined
  }
  const tail = name.match(/-(\d[0-9A-Za-z._-]*)$/)
  return tail ? String(tail[1]) : undefined
}

/**
 * 记账：把市场来源信息写进实际落盘的 manifest.json。
 * ★取值全部来自「本次下载 + 实际落盘文件」，不信列表 version（任务122①）。
 * 写失败不打断安装（插件已可用；下次升级会重写），但返回值仍是实际版本，供上层如实播报。
 */
async function writeMarketAccounting(
  id: string,
  a: { sha256: string; headerVersion?: string; previousVersion?: string },
): Promise<string | undefined> {
  const manifestPath = join(PLUGINS_DIR, id, 'manifest.json')
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
  const actualVersion = typeof meta.version === 'string' && meta.version ? meta.version : undefined
  try {
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          ...meta,
          marketInstalledVersion: actualVersion,
          marketFileSha256: a.sha256,
          marketHeaderVersion: a.headerVersion,
          marketInstalledAt: Date.now(),
          marketPreviousVersion: a.previousVersion,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
  } catch {
    // 见上：记账失败不影响插件可用
  }
  return actualVersion
}

/**
 * 把备份挪回插件目录：先 rename；失败则退化为「复制 + 删源」。
 * ★为什么要退化：换盘失败最常见的原因就是目标路径本身出问题（权限/只读/占用），
 *   而回滚要写的正是同一个目标路径 ⇒ 只靠 rename 会连回滚一起失败，旧版本就"只存在于备份目录"、
 *   用户完全不知道。复制兜底至少多一次机会；再失败就走下面的 backupRescueHint 把路径告诉用户。
 */
async function restoreBackupDir(backupDir: string, targetDir: string): Promise<void> {
  try {
    await fs.rename(backupDir, targetDir)
    return
  } catch (err) {
    // 备份本身不见了 ⇒ 无从回滚，直接抛（调用方按「无备份可救」处理）
    if (errCode(err) === 'ENOENT') throw err
  }
  await fs.cp(backupDir, targetDir, { recursive: true, force: true })
  await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
}

/** 回滚：删掉半成品，把备份挪回来，并尽力重新激活旧版本 */
async function rollbackToBackup(id: string, backupDir: string): Promise<boolean> {
  try {
    const targetDir = join(PLUGINS_DIR, id)
    await fs.rm(targetDir, { recursive: true, force: true })
    await restoreBackupDir(backupDir, targetDir)
    await getRuntime()
      .installMarketPlugin(id)
      .catch(() => undefined)
    return true
  } catch {
    return false
  }
}

/**
 * 升级确认对话框（用户拍板：新增权限必须弹一次确认；本地额外文件必须如实告知，禁止静默覆盖）。
 *
 * ★实现取舍：这里用主进程原生对话框（dialog.showMessageBox），不是应用内弹层。原因：
 *   应用内两段式确认要把「预检 → 用户点确认 → 提交」的意图透传回主进程，需同时改
 *   preload + ipc-handlers + renderer/types 三处，会突破本轮「改动文件 ≤6 / 不新增 IPC 通道」上限。
 *   原生对话框有既有先例（app-updater.ts:445 应用级对话框，注释写明「不绑父窗口 ⇒ 无论哪个窗口
 *   可见都保证看得到」，也正是分享按钮那次「弹层跑到屏幕外」的反面），文案同样走词典（主进程 tIn 口径）。
 */
async function confirmUpgradeDialog(a: {
  name: string
  oldVersion?: string
  newVersion?: string
  added: string[]
  oldPerms: string[]
  newPerms: string[]
  extraFiles: string[]
}): Promise<boolean> {
  const locale = getMainLocale()
  const none = tIn(locale, 'market.confirm.permsNone')
  const lines: string[] = [tIn(locale, 'market.confirm.version', { old: a.oldVersion ?? '?', next: a.newVersion ?? '?' })]
  if (a.added.length > 0) {
    lines.push(
      tIn(locale, 'market.confirm.permsAdded', {
        n: a.added.length,
        list: a.added.join(', '),
        oldN: a.oldPerms.length,
        newN: a.newPerms.length,
        oldList: a.oldPerms.length > 0 ? a.oldPerms.join(', ') : none,
        newList: a.newPerms.length > 0 ? a.newPerms.join(', ') : none,
      }),
    )
  }
  if (a.extraFiles.length > 0) {
    const shown = a.extraFiles.slice(0, 8).join(', ')
    lines.push(
      tIn(locale, 'market.confirm.extraFiles', {
        n: a.extraFiles.length,
        list: a.extraFiles.length > 8 ? `${shown} …` : shown,
        dir: PLUGINS_BACKUP_DIR,
      }),
    )
  }
  const res = await dialog.showMessageBox({
    type: 'warning',
    title: tIn(locale, 'market.confirm.title'),
    message: tIn(locale, 'market.confirm.message', { name: a.name }),
    detail: lines.join('\n\n'),
    buttons: [tIn(locale, 'market.confirm.ok'), tIn(locale, 'common.cancel')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  return res.response === 0
}

/**
 * 从本地备份恢复上一版本（任务122⑤）。
 *
 * ★能力边界（必须让用户知道）：网关公开 API 只有 list / detail / download 三条路由，无版本历史接口、
 * download 也没有按 version 取包的参数（已实证）⇒「恢复」**只能靠本机升级时留下的备份**，且只保 1 份。
 * 也就是说：只有「本机曾用山海升级过该插件、且之后没再升级过」才可用，不是随时能退回任意历史版本。
 * 恢复动作本身是 rename ⇒ 备份被消耗，恢复后当前版本不再另有备份。
 */
async function restorePluginFromBackup(
  id: string,
  local: LocalPluginState,
  backup: { dir: string; version: string },
): Promise<{ ok: boolean; id?: string; name?: string; message?: string }> {
  const locale = getMainLocale()
  const displayName = local.name ?? id
  const res = await dialog.showMessageBox({
    type: 'warning',
    title: tIn(locale, 'market.restore.title'),
    message: tIn(locale, 'market.restore.message', { name: displayName }),
    detail: tIn(locale, 'market.restore.detail', {
      backup: backup.version,
      current: local.version ?? '?',
      dir: backup.dir,
    }),
    buttons: [tIn(locale, 'market.restore.ok'), tIn(locale, 'common.cancel')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (res.response !== 0) return { ok: false, message: tIn(locale, 'market.msg.cancelled') }
  const targetDir = join(PLUGINS_DIR, id)
  const holding = `${targetDir}.restoring`
  try {
    assertInsidePlugins(PLUGINS_DIR, targetDir, id)
    await fs.rm(holding, { recursive: true, force: true }).catch(() => undefined)
    if (existsSync(targetDir)) await relocateDir(targetDir, holding)
    try {
      await relocateDir(backup.dir, targetDir)
    } catch (err) {
      if (existsSync(holding)) await relocateDir(holding, targetDir).catch(() => undefined)
      throw err
    }
    await fs.rm(holding, { recursive: true, force: true }).catch(() => undefined)
    await getRuntime().installMarketPlugin(id)
    const after = readLocalPluginState(id)
    return {
      ok: true,
      id,
      name: displayName,
      message: tIn(locale, 'market.msg.restored', { name: displayName, v: after?.version ?? backup.version }),
    }
  } catch (err) {
    return {
      ok: false,
      message: tIn(locale, 'market.err.restoreFailed', { msg: err instanceof Error ? err.message : String(err) }),
    }
  }
}

/** 按 plugin_id 去重（任务122③）：同一 plugin_id 只保留网关数字行 id 最大的那条 */
function dedupeMarketPlugins(list: MarketPlugin[]): MarketPlugin[] {
  const best = new Map<string, MarketPlugin>()
  for (const p of list) {
    if (!p.id) continue
    const prev = best.get(p.id)
    if (!prev) {
      best.set(p.id, p)
      continue
    }
    // 行 id 大者优先（与网关 ORDER BY id DESC 同向）；行 id 相同/缺失时用 semver 兜底，保证稳定
    const byRow = (p.rowId ?? -1) - (prev.rowId ?? -1)
    if (byRow > 0) best.set(p.id, p)
    else if (byRow === 0 && compareVersions(p.version, prev.version) > 0) best.set(p.id, p)
  }
  const out: MarketPlugin[] = []
  const seen = new Set<string>()
  for (const p of list) {
    if (!p.id) {
      out.push(p) // 没有 id 的条目原样保留（不猜它是谁的重复）
      continue
    }
    if (seen.has(p.id)) continue
    seen.add(p.id)
    const keep = best.get(p.id)
    if (keep) out.push(keep)
  }
  return out
}

/**
 * 拉取插件市场列表（公开接口，无需鉴权）。
 * 接口未就绪（网络错误/非 2xx/非 JSON）时返回 { ok: false, error }，由 UI 降级 mock 数据。
 */
export async function listMarketPlugins(params: {
  keyword?: string
  category?: string
  hasUI?: boolean | ''
  page?: number
  pageSize?: number
}): Promise<{ ok: boolean; plugins: MarketPlugin[]; total: number; error?: string }> {
  try {
    const q = new URLSearchParams()
    if (params.keyword) q.set('keyword', params.keyword)
    if (params.category) q.set('category', params.category)
    if (params.hasUI === true || params.hasUI === false) q.set('hasUI', String(params.hasUI))
    q.set('page', String(params.page ?? 1))
    q.set('pageSize', String(params.pageSize ?? 50))
    const url = `${MARKET_LIST_URL}?${q.toString()}`
    const resp = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } })
    if (!resp.ok) {
      return { ok: false, plugins: [], total: 0, error: `HTTP ${resp.status} ${resp.statusText}` }
    }
    const text = await resp.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, plugins: [], total: 0, error: tIn(getMainLocale(), 'market.err.badJson') }
    }
    const { list, total } = unwrapList(json)
    const installed = installedPluginIds()
    const mapped = list
      .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
      .map((x) => normalizeMarketPlugin(x))
    // 任务122③：客户端按 plugin_id 去重（取数字行 id 最大那条）。网关列表无 GROUP BY，
    // 其后台 Restore 漏调 WithdrawOldApproved ⇒ 同一插件可能出现两行；不去重就会出现
    // 「用户点其中一行的更新、拿到的却是另一行的包」（点了装错东西那一类）。
    const deduped = dedupeMarketPlugins(mapped)
    const plugins = deduped.map((p) => {
      const st = installed.has(p.id) ? readLocalPluginState(p.id) : undefined
      const rel = st ? versionRelation(p.version, st.version) : 'unknown'
      marketRowCache.set(p.id, { rowId: p.rowId, version: p.version })
      const backup = st ? backupDirsOf(p.id)[0] : undefined
      return {
        ...p,
        installed: installed.has(p.id),
        localVersion: st?.version,
        // 只在明确 newer 时给「有更新」；unknown（任一侧无版本号）不谎报
        hasUpdate: !!st && rel === 'newer',
        // 明确 older ⇒ 灰态 + 安装侧再拦一次（任务122②）
        downgrade: !!st && rel === 'older',
        hasBackup: !!backup,
        backupVersion: backup?.version,
      }
    })
    return { ok: true, plugins, total }
  } catch (err) {
    return { ok: false, plugins: [], total: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 解包 zip 到目标目录（跨平台：darwin/linux 用系统 unzip，win32 用 PowerShell Expand-Archive）。
 * 返回解包后的根目录（zip 内条目可能带一层根目录，需检测后统一归一到 stagingDir）。
 */
async function extractZip(zipPath: string, stagingDir: string): Promise<string> {
  if (process.platform === 'win32') {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${stagingDir.replace(/'/g, "''")}' -Force`,
    ])
  } else {
    await execFileAsync('unzip', ['-oq', zipPath, '-d', stagingDir])
  }
  // 若 zip 内带一层根目录（常见），把内容上提一层，保证 manifest.json 直接位于 stagingDir 下
  const entries = await fs.readdir(stagingDir, { withFileTypes: true })
  const subdirs = entries.filter((e) => e.isDirectory())
  const hasManifestAtRoot = existsSync(join(stagingDir, 'manifest.json'))
  if (!hasManifestAtRoot && subdirs.length === 1 && entries.length === 1) {
    const inner = join(stagingDir, subdirs[0]!.name)
    const innerEntries = await fs.readdir(inner)
    for (const name of innerEntries) {
      await fs.rename(join(inner, name), join(stagingDir, name))
    }
    await fs.rm(inner, { recursive: true, force: true })
  }
  return stagingDir
}

/**
 * 下载并安装 / **升级**市场插件（任务122 P1）。
 *
 * 链路：下载 zip（优先按网关数字行 id 锁行）→ X-SHA256 强校验 → 解包 → 预检（换盘前）→
 *      防降级判定 → 升级确认（新增权限 / 本地额外文件）→ 备份 + 原子换盘 → 记账 → 激活（失败自动回滚）。
 *
 * ★记账与播报一律以「实际落盘 manifest.version + 本次下载响应头」为准，不信列表 version（任务122①）：
 *   网关选版是 `ORDER BY id DESC` 而非 semver 最大，作者在新版之后又提交一个更低版本号并过审时，
 *   列表与下载都会返回那个更低的版本 —— 所以列表 version 只用于「是否有更新」的展示与触发。
 */
export async function downloadAndInstallPlugin(pluginId: string): Promise<{
  ok: boolean
  id?: string
  name?: string
  message?: string
}> {
  const id = String(pluginId ?? '').trim()
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return { ok: false, message: tIn(getMainLocale(), 'market.err.illegalId', { id: pluginId }) }
  }
  const locale = getMainLocale()
  const local = readLocalPluginState(id)
  const backups = backupDirsOf(id)
  const cached = marketRowCache.get(id)

  // ── 恢复上一版本（任务122⑤）：只在「本机有备份 + 已知市场版本不高于本地」时零下载直进恢复流程。
  //    缓存缺失时不在此判定，落到下面用下载包版本做权威比较（同一入口，不新增 IPC 通道）。
  if (local && backups.length > 0 && cached?.version && versionRelation(cached.version, local.version) !== 'newer') {
    return restorePluginFromBackup(id, local, backups[0]!)
  }

  // 任务122④：优先用列表返回的数字行 id 下载（与界面显示的那条锁死）；无缓存回落 plugin_id 路由。
  const downloadKey = cached?.rowId != null ? String(cached.rowId) : id
  const downloadUrl = `${MARKET_LIST_URL}/${encodeURIComponent(downloadKey)}/download`

  let resp: Response
  try {
    resp = await fetch(downloadUrl, { method: 'GET' })
  } catch (err) {
    // err.message 是 fetch/Node 原始错误：按口径④作为 {msg} 原样带入，不建映射表
    return { ok: false, message: tIn(locale, 'market.err.downloadFailed', { msg: err instanceof Error ? err.message : String(err) }) }
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    // 改前是「中文前缀 + HTTP 状态 + 全角括号包原文」三段拼，英文语序不同拼不出来 → 整句词条
    return {
      ok: false,
      message: body
        ? tIn(locale, 'market.err.downloadHttpBody', { status: resp.status, statusText: resp.statusText, body: body.slice(0, 160) })
        : tIn(locale, 'market.err.downloadHttp', { status: resp.status, statusText: resp.statusText }),
    }
  }

  const expectedSha256 = (resp.headers.get('X-SHA256') || resp.headers.get('x-sha256') || '').trim()
  const buf = Buffer.from(await resp.arrayBuffer())
  if (!expectedSha256) {
    return { ok: false, message: tIn(locale, 'market.err.noSha256Header') }
  }
  const actualSha256 = createHash('sha256').update(buf).digest('hex')
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    return {
      ok: false,
      message: tIn(locale, 'market.err.sha256Mismatch', { expected: expectedSha256, actual: actualSha256 }),
    }
  }
  // 任务122①：响应头 filename={plugin_id}-{version}.zip 里的版本，与落盘版本做三方对齐
  const headerVersion = parseContentDispositionVersion(resp.headers.get('content-disposition'), id)

  // 解包到临时目录（应用 cache 下），预检通过后才动 ~/.shanhai/plugins/<id>/
  const tmpBase = join(app.getPath('temp'), `shanhai-market-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpBase, { recursive: true })
  const zipPath = join(tmpBase, 'plugin.zip')
  const stagingDir = join(tmpBase, 'staging')
  try {
    await fs.writeFile(zipPath, buf)
    await fs.mkdir(stagingDir, { recursive: true })
    await extractZip(zipPath, stagingDir)

    const pre = precheckStagingPackage(stagingDir, id)
    if (!pre.ok) {
      // 预检失败时旧目录一动未动 ⇒ 不存在「半安装」，如实回错
      return { ok: false, message: pre.message }
    }
    const pkgVersion = pre.version
    const displayName = pre.name

    // ── 防降级（任务122②）：用**实际包版本**权威判定，绝不出现「点更新 → 本地高版本被低版本覆盖」
    if (local) {
      const rel = versionRelation(pkgVersion, local.version)
      if (rel === 'older') {
        return {
          ok: false,
          message: tIn(locale, 'market.err.downgradeBlocked', {
            name: displayName,
            local: local.version ?? '?',
            market: pkgVersion ?? '?',
          }),
        }
      }
      if (rel === 'same') {
        // 已是最新：本机有备份 ⇒ 这条入口就是「恢复上一版本」（列表缓存未命中时的兜底路径）
        if (backups.length > 0) return restorePluginFromBackup(id, local, backups[0]!)
        return {
          ok: true,
          id,
          name: displayName,
          message: tIn(locale, 'market.msg.upToDate', { name: displayName, v: pkgVersion ?? '?' }),
        }
      }
    }

    // ── 升级确认：新增权限（静默扩权风险）或本地有额外文件（静默删数据风险），任一命中都要点头；首装不问
    if (local) {
      const added = pre.permissions.filter((p) => !local.permissions.includes(p))
      if (added.length > 0 || local.extraFiles.length > 0) {
        const go = await confirmUpgradeDialog({
          name: displayName,
          oldVersion: local.version,
          newVersion: pkgVersion,
          added,
          oldPerms: local.permissions,
          newPerms: pre.permissions,
          extraFiles: local.extraFiles,
        })
        if (!go) return { ok: false, message: tIn(locale, 'market.msg.cancelled') }
      }
    }

    // ── 备份 + 原子换盘（任何一步失败自动回滚，绝不留「旧已删、新未到位」）
    const swapped = await swapPackageIntoTarget(id, stagingDir, local?.version)
    const backupDir = swapped.backupDir

    // ── 记账（实际落盘版本 + 响应头版本 + 本次下载 sha256）
    const actualVersion = await writeMarketAccounting(id, {
      sha256: actualSha256,
      headerVersion,
      previousVersion: local?.version,
    })

    // ── 激活：installFromDisk（撤销旧运行 → define → run → Dock 刷新）；失败回滚到旧版本
    try {
      await getRuntime().installMarketPlugin(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (backupDir) {
        const rolled = await rollbackToBackup(id, backupDir)
        if (rolled) {
          return { ok: false, message: tIn(locale, 'market.msg.installFailedRolledBack', { msg, v: local?.version ?? '?' }) }
        }
        // ★回滚没成功：旧版本至少还在备份目录里，必须把路径告诉用户，不能只说「安装失败」
        const still = backupDirsOf(id)[0]
        const base = tIn(locale, 'market.msg.installFailedNoRollback', { msg, v: local?.version ?? '?' })
        return { ok: false, message: still ? `${base}\n${tIn(locale, 'market.msg.backupRescueHint', { dir: still.dir })}` : base }
      }
      return { ok: false, message: tIn(locale, 'market.err.installFailed', { msg }) }
    }

    let message = local
      ? tIn(locale, 'market.msg.updated', {
          name: displayName,
          v: actualVersion ?? pkgVersion ?? '?',
          old: local.version ?? '?',
        })
      : tIn(locale, 'market.msg.installedPlugin', { name: displayName })
    // ★版本一致性：界面显示的目标版本 / 响应头版本 / 实际落盘版本不一致时如实播报，绝不谎报「已更新到 vY」
    if (actualVersion && cached?.version && versionRelation(cached.version, actualVersion) !== 'same') {
      message += `\n${tIn(locale, 'market.msg.actualVersion', { actual: actualVersion, target: cached.version })}`
    }
    if (actualVersion && headerVersion && versionRelation(headerVersion, actualVersion) !== 'same') {
      message += `\n${tIn(locale, 'market.msg.headerMismatch', { actual: actualVersion, header: headerVersion })}`
    }
    if (backupDir) {
      message += `\n${tIn(locale, 'market.msg.backupHint', { dir: backupDir })}`
    }
    return { ok: true, id, name: displayName, message }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof SwapFailure) {
      if (err.rolledBack) {
        // 旧版本已挪回原位 ⇒ 如实说「插件仍可用」，不要让用户误以为插件坏了
        return { ok: false, message: tIn(locale, 'market.msg.swapFailedRolledBack', { msg, v: local?.version ?? '?' }) }
      }
      // ★最坏情况：换盘失败且回滚也没成功 ⇒ 插件目录不可用，但旧版本还在备份里，
      //   不把路径说清楚就是「插件凭空消失、用户无从恢复」（任务121 摸底列出的最高风险项）。
      const base = tIn(locale, 'market.err.installFailed', { msg })
      const dir = err.backupDir ?? backupDirsOf(id)[0]?.dir
      return { ok: false, message: dir ? `${base}\n${tIn(locale, 'market.msg.backupRescueHint', { dir })}` : base }
    }
    const broken = readLocalPluginState(id) === undefined
    const rescue = broken ? backupDirsOf(id)[0] : undefined
    const base2 = tIn(locale, 'market.err.installFailed', { msg })
    return {
      ok: false,
      message: rescue ? `${base2}\n${tIn(locale, 'market.msg.backupRescueHint', { dir: rescue.dir })}` : base2,
    }
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 卸载已安装插件（用户点「我已安装」卡片的「卸载」按钮）：撤销运行 + 删除 ~/.shanhai/plugins/<id>/ 目录。
 * 走 runtime 的 selfmod.uninstall（撤销 disposer + removeClient + 删除持久化目录），不可恢复。
 */
export async function uninstallMarketPlugin(pluginId: string): Promise<{ ok: boolean; message: string }> {
  const id = String(pluginId ?? '').trim()
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return { ok: false, message: tIn(getMainLocale(), 'market.err.illegalId', { id: pluginId }) }
  }
  try {
    await getRuntime().uninstallMarketPlugin(id)
    return { ok: true, message: tIn(getMainLocale(), 'market.msg.uninstalledPlugin', { id }) }
  } catch (err) {
    return { ok: false, message: tIn(getMainLocale(), 'market.err.uninstallFailed', { msg: err instanceof Error ? err.message : String(err) }) }
  }
}

/**
 * 提交插件到市场：先打包（复用 task 1 的 packagePluginShare）再 POST 到网关。
 * @param pluginDirOrId 本地自研插件工程（仅限 plugins-workspace 下），或工程 id
 * @param categories 行业分类（缺省 ["其他"]）
 */
export async function submitPluginToMarket(pluginDirOrId: string, categories?: string[]): Promise<{
  ok: boolean
  message: string
  zipPath?: string
  data?: unknown
}> {
  const apiKey = getRuntime().getGatewayApiKey()
  if (!apiKey) {
    // 需求：未登录（无登录态网关凭证）时直接拒绝，不发起任何请求；与 UI 前置禁用双保险
    return { ok: false, message: tIn(getMainLocale(), 'market.err.needLogin') }
  }
  let zipPath: string
  let manifest: Record<string, unknown> = {}
  try {
    const packed = await packagePluginShare(pluginDirOrId, { categories })
    zipPath = packed.zipPath
    manifest = (packed.manifest ?? {}) as unknown as Record<string, unknown>
  } catch (err) {
    return { ok: false, message: tIn(getMainLocale(), 'market.err.packFailed', { msg: err instanceof Error ? err.message : String(err) }) }
  }

  try {
    // 2. 本地对 zip 计算 SHA-256（小写 hex 64 位，与网关 hash 校验同一套算法）
    const zipBuf = await fs.readFile(zipPath)
    const fileSha256 = createHash('sha256').update(zipBuf).digest('hex')
    const fileSize = zipBuf.byteLength

    // 3. 向网关申请七牛上传凭证
    const filename = basename(zipPath)
    const tokenResp = await fetch(
      `${API_BASE}/api/v1/plugins/upload-token?filename=${encodeURIComponent(filename)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
    )
    if (!tokenResp.ok) {
      const body = await tokenResp.text().catch(() => '')
      return {
        ok: false,
        message: body
          ? tIn(getMainLocale(), 'market.err.tokenHttpBody', { status: tokenResp.status, statusText: tokenResp.statusText, body: body.slice(0, 160) })
          : tIn(getMainLocale(), 'market.err.tokenHttp', { status: tokenResp.status, statusText: tokenResp.statusText }),
        zipPath,
      }
    }
    const tokenPayload = (await tokenResp.json().catch(() => ({}))) as Record<string, unknown>
    const tokenData = (tokenPayload.data && typeof tokenPayload.data === 'object' ? tokenPayload.data : tokenPayload) as Record<string, unknown>
    const uploadUrl = String(tokenData.upload_url ?? '')
    const token = String(tokenData.token ?? '')
    const key = String(tokenData.key ?? '')
    const publicBaseUrl = String(tokenData.public_base_url ?? tokenData.domain ?? '')
    if (!uploadUrl || !token || !key || !publicBaseUrl) {
      return { ok: false, message: tIn(getMainLocale(), 'market.err.tokenIncomplete'), zipPath }
    }

    // 4. 统一七牛直传（@shanhai/storage 的 uploadToQiniu，内置跨区域自愈重试）
    const put = await uploadToQiniu({
      uploadUrl,
      token,
      key,
      file: new Blob([new Uint8Array(zipBuf)], { type: 'application/zip' }),
      filename,
      publicBaseUrl,
    })
    if (!put.ok) {
      return {
        ok: false,
        message: put.body
          ? tIn(getMainLocale(), 'market.err.qiniuHttpBody', { status: put.status, body: put.body.slice(0, 200) })
          : tIn(getMainLocale(), 'market.err.qiniuHttp', { status: put.status }),
        zipPath,
      }
    }

    // 5. 公网 file_url = public_base_url + '/' + key（uploadToQiniu 已拼好；此处兜底手动拼接）
    const fileUrl = put.url ?? `${publicBaseUrl.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`

    // 6. POST application/json 提交入库（不传 author，保持网关默认 key_<id> 身份标识）
    const payload: Record<string, unknown> = {
      plugin_id: String(manifest.plugin_id ?? manifest.id ?? ''),
      name: String(manifest.name ?? ''),
      purpose: String(manifest.purpose ?? ''),
      version: String(manifest.version ?? ''),
      has_ui: manifest.hasUI === true || manifest.has_ui === true,
      categories:
        Array.isArray(manifest.categories) && manifest.categories.length > 0
          ? manifest.categories.map(String)
          : categories ?? ['其他'],
      icon_url: String(manifest.icon ?? ''),
      file_url: fileUrl,
      file_sha256: fileSha256,
      file_size: fileSize,
    }
    const resp = await fetch(MARKET_SUBMIT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await resp.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      // 非 JSON 响应保留原文
    }
    if (!resp.ok) {
      const msg = json && typeof json === 'object' ? (json as { message?: string }).message : undefined
      // 网关对「同一 plugin_id + 同一 version 重复提交」返回唯一索引冲突（idx_plugin_version），
      // 很可能该版本已被其他账号/此前提交过，转成用户能懂的提示，避免出现难懂的 duplicate 英文报错。
      const dup = /duplicate|idx_plugin_version/i.test(`${msg ?? ''} ${text}`)
      if (dup) {
        const pn = String(manifest.name ?? manifest.plugin_id ?? '')
        const pv = String(manifest.version ?? '')
        return {
          ok: false,
          message: tIn(getMainLocale(), 'market.err.submitDuplicate', { name: pn, version: pv }),
          zipPath,
        }
      }
      return {
        ok: false,
        message: msg
          ? tIn(getMainLocale(), 'market.err.submitHttpBody', { status: resp.status, statusText: resp.statusText, msg })
          : tIn(getMainLocale(), 'market.err.submitHttp', { status: resp.status, statusText: resp.statusText }),
        zipPath,
      }
    }
    return { ok: true, message: tIn(getMainLocale(), 'market.msg.submittedToMarket'), zipPath, data: json }
  } catch (err) {
    return { ok: false, message: tIn(getMainLocale(), 'market.err.submitFailed', { msg: err instanceof Error ? err.message : String(err) }), zipPath }
  }
}

/**
 * 「我已安装」区块的插件条目（本机已安装插件，叠加自研标记与网关提交状态）。
 */
export interface MyPluginItem {
  id: string
  name: string
  purpose?: string
  /** 本地版本：自研工程 package.json version 优先，否则已安装 manifest version */
  version?: string
  /** 是否自研（~/.shanhai/plugins-workspace 下存在同 id 工程目录） */
  selfMade: boolean
  /** 是否已安装（~/.shanhai/plugins 下存在同 id 目录） */
  installed: boolean
  /** 网关是否有该 plugin_id 的提交记录（来自 GET /api/v1/plugins/mine） */
  submitted: boolean
  /** 网关最新版本（mine 接口 latest_version） */
  gatewayVersion?: string
  /** 网关最新状态（mine 接口 latest_status，如 approved/pending/rejected） */
  gatewayStatus?: string
  /** 网关是否有已审批版本 */
  hasApproved?: boolean
  /** 已安装 manifest 里的版本（自研卡片的 version 字段优先取工程 package.json，这里给落盘真值） */
  localVersion?: string
  /** 本机是否有可恢复的旧版本备份（任务122⑤：只有升级过才有，且只保 1 份） */
  hasBackup?: boolean
  /** 备份对应的版本号 */
  backupVersion?: string
  /** 上次从市场安装/升级时记账的版本（非市场安装为空） */
  marketInstalledVersion?: string
}

/** 网关 mine 接口单条记录（按 plugin_id 聚合） */
interface MineEntry {
  latestVersion?: string
  latestStatus?: string
  hasApproved?: boolean
}

/** 读取本地元数据：name/purpose 优先取已安装 manifest（显示名更友好），version 优先取自研工程 package.json（本地最新开发版本） */
function readLocalMeta(id: string, selfMade: boolean): { name?: string; version?: string; purpose?: string } {
  let manifestMeta: Record<string, unknown> = {}
  try {
    manifestMeta = JSON.parse(readFileSync(join(PLUGINS_DIR, id, 'manifest.json'), 'utf8')) as Record<string, unknown>
  } catch {
    // 未安装 / manifest 缺失
  }
  let pkgMeta: Record<string, unknown> = {}
  if (selfMade) {
    try {
      pkgMeta = JSON.parse(readFileSync(join(SCAFFOLD_WORKSPACE_DIR, id, 'package.json'), 'utf8')) as Record<string, unknown>
    } catch {
      // 工程 package.json 缺失（仍按自研标记，但版本退回已安装 manifest）
    }
  }
  return {
    name: (manifestMeta.name ?? pkgMeta.name) ? String(manifestMeta.name ?? pkgMeta.name) : undefined,
    purpose: (manifestMeta.purpose ?? pkgMeta.description) ? String(manifestMeta.purpose ?? pkgMeta.description) : undefined,
    // 版本：自研工程 package.json version 优先（无则已安装 manifest version）
    version: (pkgMeta.version ?? manifestMeta.version) ? String(pkgMeta.version ?? manifestMeta.version) : undefined,
  }
}

/**
 * 拉取网关「我的插件提交记录」（GET /api/v1/plugins/mine，APIKey 鉴权，按 plugin_id 聚合
 * latest_version / latest_status / has_approved）。
 *
 * 接口未就绪（未登录 / 网络错误 / 非 2xx / 非 JSON）时返回空 Map + ok=false + error，由调用方按
 * 「默认未提交」降级（UI 显示「分享」）。
 */
async function fetchMinePlugins(): Promise<{ entries: Map<string, MineEntry>; ok: boolean; error?: string }> {
  const apiKey = getRuntime().getGatewayApiKey()
  if (!apiKey) {
    return { entries: new Map(), ok: false, error: tIn(getMainLocale(), 'market.err.noApiKey') }
  }
  try {
    const resp = await fetch(`${API_BASE}/api/v1/plugins/mine`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!resp.ok) {
      return { entries: new Map(), ok: false, error: `HTTP ${resp.status} ${resp.statusText}` }
    }
    let json: unknown
    try {
      json = JSON.parse(await resp.text())
    } catch {
      return { entries: new Map(), ok: false, error: tIn(getMainLocale(), 'market.err.badJson') }
    }

    const map = new Map<string, MineEntry>()
    const normalize = (e: Record<string, unknown>): MineEntry => ({
      latestVersion:
        e.latest_version != null ? String(e.latest_version) : e.latestVersion != null ? String(e.latestVersion) : undefined,
      latestStatus:
        e.latest_status != null ? String(e.latest_status) : e.latestStatus != null ? String(e.latestStatus) : undefined,
      hasApproved: typeof e.has_approved === 'boolean' ? e.has_approved : typeof e.hasApproved === 'boolean' ? e.hasApproved : undefined,
    })

    // 兼容多种信封形态：{ data: [...] } / { data: { id: {...} } } / 直接数组 / { list: [...] }
    let raw: unknown = json
    if (json && typeof json === 'object' && 'data' in (json as Record<string, unknown>)) {
      raw = (json as Record<string, unknown>).data
    }
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const o = item as Record<string, unknown>
        const key = String(o.plugin_id ?? o.pluginId ?? o.id ?? '').trim()
        if (key) map.set(key, normalize(o))
      }
    } else if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>
      const list = obj.list ?? obj.items
      if (Array.isArray(list)) {
        for (const item of list) {
          if (!item || typeof item !== 'object') continue
          const o = item as Record<string, unknown>
          const key = String(o.plugin_id ?? o.pluginId ?? o.id ?? '').trim()
          if (key) map.set(key, normalize(o))
        }
      } else {
        for (const [key, val] of Object.entries(obj)) {
          if (val && typeof val === 'object') map.set(key, normalize(val as Record<string, unknown>))
        }
      }
    }
    return { entries: map, ok: true }
  } catch (err) {
    return { entries: new Map(), ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 列出「我已安装」插件（本机 ~/.shanhai/plugins/ 下的插件），叠加自研标记（plugins-workspace 下同 id 工程）
 * 与网关提交状态（GET /api/v1/plugins/mine）。
 */
export async function listMyPlugins(): Promise<{ ok: boolean; plugins: MyPluginItem[]; mineError?: string }> {
  const installedIds = new Set<string>()
  try {
    for (const e of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
      if (e.isDirectory()) installedIds.add(e.name)
    }
  } catch {
    // 目录不存在 = 无已安装插件
  }
  const workspaceIds = new Set<string>()
  try {
    for (const e of readdirSync(SCAFFOLD_WORKSPACE_DIR, { withFileTypes: true })) {
      if (e.isDirectory()) workspaceIds.add(e.name)
    }
  } catch {
    // 无自研工程
  }

  const mine = await fetchMinePlugins()

  const plugins: MyPluginItem[] = []
  for (const id of installedIds) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue
    const selfMade = workspaceIds.has(id)
    const local = readLocalMeta(id, selfMade)
    const entry = mine.entries.get(id)
    const state = readLocalPluginState(id)
    const backup = backupDirsOf(id)[0]
    plugins.push({
      id,
      name: local.name ?? id,
      purpose: local.purpose,
      version: local.version,
      selfMade,
      installed: true,
      submitted: entry !== undefined,
      gatewayVersion: entry?.latestVersion,
      gatewayStatus: entry?.latestStatus,
      hasApproved: entry?.hasApproved,
      localVersion: state?.version,
      hasBackup: !!backup,
      backupVersion: backup?.version,
      marketInstalledVersion: state?.manifest.marketInstalledVersion
        ? String(state.manifest.marketInstalledVersion)
        : undefined,
    })
  }
  plugins.sort((a, b) => {
    // 自研在前，其次按名称
    if (a.selfMade !== b.selfMade) return a.selfMade ? -1 : 1
    // 改前写死 'zh-CN' 排序规则：英文界面下按拼音序排英文名会错乱。跟随当前语言。
    return a.name.localeCompare(b.name, getMainLocale())
  })
  return { ok: true, plugins, mineError: mine.ok ? undefined : mine.error }
}
