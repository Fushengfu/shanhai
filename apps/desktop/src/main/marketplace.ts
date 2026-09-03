import { app } from 'electron'
import { join, basename, resolve, sep } from 'node:path'
import { promises as fs, existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getRuntime } from './runtime'
import { packagePluginShare, SCAFFOLD_WORKSPACE_DIR } from '@shanhai/selfmod'
import { uploadToQiniu } from '@shanhai/storage'
import { PLUGINS_DIR } from './plugin-apps'

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
  return {
    id,
    pluginId: id,
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
    const entries = require('node:fs').readdirSync(PLUGINS_DIR, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) ids.add(e.name)
    }
  } catch {
    // 目录不存在 = 无已安装插件
  }
  return ids
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
      return { ok: false, plugins: [], total: 0, error: '响应不是合法 JSON' }
    }
    const { list, total } = unwrapList(json)
    const installed = installedPluginIds()
    const plugins = list
      .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
      .map((x) => {
        const p = normalizeMarketPlugin(x)
        return { ...p, installed: installed.has(p.id) }
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
 * 下载并安装市场插件（完整链路：下载 zip → X-SHA256 完整性校验 → 解包 → 校验 manifest → 还原到
 * ~/.shanhai/plugins/<id>/ → 触发插件加载 + Dock 图标刷新）。
 *
 * 校验用「响应 X-SHA256 头」与下载字节做 SHA-256 对比（小写 hex，忽略大小写），与手机端升级校验同一套算法。
 * 网关未返回 X-SHA256 时按「宁缺毋滥」中止（不装未校验包），与手机端策略一致。
 */
export async function downloadAndInstallPlugin(pluginId: string): Promise<{
  ok: boolean
  id?: string
  name?: string
  message?: string
}> {
  const id = String(pluginId ?? '').trim()
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return { ok: false, message: `非法插件 id: ${pluginId}` }
  }
  const downloadUrl = `${MARKET_LIST_URL}/${encodeURIComponent(id)}/download`

  let resp: Response
  try {
    resp = await fetch(downloadUrl, { method: 'GET' })
  } catch (err) {
    return { ok: false, message: `下载失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    return { ok: false, message: `下载失败：HTTP ${resp.status} ${resp.statusText}${body ? `（${body.slice(0, 160)}）` : ''}` }
  }

  const expectedSha256 = (resp.headers.get('X-SHA256') || resp.headers.get('x-sha256') || '').trim()
  const buf = Buffer.from(await resp.arrayBuffer())
  if (!expectedSha256) {
    return { ok: false, message: '网关未返回 X-SHA256 校验头，为安全起见拒绝安装（宁缺毋滥）' }
  }
  const actualSha256 = createHash('sha256').update(buf).digest('hex')
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    return { ok: false, message: `SHA-256 校验失败：下载包不完整或被篡改\n期望 ${expectedSha256}\n实际 ${actualSha256}` }
  }

  // 解包到临时目录（应用 cache 下），校验 manifest，再覆盖还原到 plugins/<id>/
  const tmpBase = join(app.getPath('temp'), `shanhai-market-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpBase, { recursive: true })
  const zipPath = join(tmpBase, 'plugin.zip')
  const stagingDir = join(tmpBase, 'staging')
  try {
    await fs.writeFile(zipPath, buf)
    await fs.mkdir(stagingDir, { recursive: true })
    await extractZip(zipPath, stagingDir)

    const manifestPath = join(stagingDir, 'manifest.json')
    if (!existsSync(manifestPath)) {
      return { ok: false, message: '共享包缺少 manifest.json，无法安装' }
    }
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>
    } catch {
      return { ok: false, message: 'manifest.json 解析失败' }
    }
    const manifestId = String(manifest.id ?? manifest.plugin_id ?? '').trim()
    if (!manifestId || !/^[a-zA-Z0-9_-]+$/.test(manifestId)) {
      return { ok: false, message: `manifest.json 的 id 非法: ${manifestId || '(空)'}` }
    }
    // manifest id 必须与请求的 pluginId 一致，防止张冠李戴
    if (manifestId !== id) {
      return { ok: false, message: `manifest id（${manifestId}）与请求的插件 id（${id}）不一致，拒绝安装` }
    }

    // 覆盖还原到 ~/.shanhai/plugins/<id>/（先删旧的再整目录复制，保证升级时旧文件不残留）
    const targetDir = join(PLUGINS_DIR, id)
    const resolvedTarget = resolve(targetDir)
    const pluginsRoot = resolve(PLUGINS_DIR)
    if (resolvedTarget !== pluginsRoot && !resolvedTarget.startsWith(pluginsRoot + sep)) {
      return { ok: false, message: `插件 id 越界: ${id}` }
    }
    await fs.rm(resolvedTarget, { recursive: true, force: true })
    await fs.mkdir(resolvedTarget, { recursive: true })
    for (const name of await fs.readdir(stagingDir)) {
      await fs.rename(join(stagingDir, name), join(resolvedTarget, name))
    }

    // 触发插件加载 + Dock 图标刷新（installFromDisk → define + run → deliverClient → push.ts 广播）
    await getRuntime().installMarketPlugin(id)
    const meta = await fs.readFile(join(resolvedTarget, 'manifest.json'), 'utf8').then(
      (s) => JSON.parse(s) as { name?: string },
      () => ({} as { name?: string }),
    )
    return { ok: true, id, name: meta.name ?? id, message: `已安装插件「${meta.name ?? id}」` }
  } catch (err) {
    return { ok: false, message: `安装失败：${err instanceof Error ? err.message : String(err)}` }
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
    return { ok: false, message: `非法插件 id: ${pluginId}` }
  }
  try {
    await getRuntime().uninstallMarketPlugin(id)
    return { ok: true, message: `已卸载插件「${id}」` }
  } catch (err) {
    return { ok: false, message: `卸载失败：${err instanceof Error ? err.message : String(err)}` }
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
    return { ok: false, message: '请先登录后再提交' }
  }
  let zipPath: string
  let manifest: Record<string, unknown> = {}
  try {
    const packed = await packagePluginShare(pluginDirOrId, { categories })
    zipPath = packed.zipPath
    manifest = (packed.manifest ?? {}) as unknown as Record<string, unknown>
  } catch (err) {
    return { ok: false, message: `打包失败：${err instanceof Error ? err.message : String(err)}` }
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
      return { ok: false, message: `获取上传凭证失败：HTTP ${tokenResp.status} ${tokenResp.statusText}${body ? `（${body.slice(0, 160)}）` : ''}`, zipPath }
    }
    const tokenPayload = (await tokenResp.json().catch(() => ({}))) as Record<string, unknown>
    const tokenData = (tokenPayload.data && typeof tokenPayload.data === 'object' ? tokenPayload.data : tokenPayload) as Record<string, unknown>
    const uploadUrl = String(tokenData.upload_url ?? '')
    const token = String(tokenData.token ?? '')
    const key = String(tokenData.key ?? '')
    const publicBaseUrl = String(tokenData.public_base_url ?? tokenData.domain ?? '')
    if (!uploadUrl || !token || !key || !publicBaseUrl) {
      return { ok: false, message: '上传凭证数据不完整（缺 upload_url / token / key / public_base_url）', zipPath }
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
      return { ok: false, message: `上传到七牛失败：HTTP ${put.status}${put.body ? `（${put.body.slice(0, 200)}）` : ''}（已按七牛提示自动纠偏上传区域；若仍失败，请排查网关 upload_url 区域与 bucket 是否匹配）`, zipPath }
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
          message: `提交失败：插件「${pn}」版本 v${pv} 已在创意空间存在（可能是此前已提交过，或由其他账号提交）。同一插件同一版本不能重复提交。如需更新，请把插件版本号升级到更高版本后再点「提交升级版本共享」。`,
          zipPath,
        }
      }
      return { ok: false, message: `提交失败：HTTP ${resp.status} ${resp.statusText}${msg ? `（${msg}）` : ''}`, zipPath }
    }
    return { ok: true, message: '已提交到创意空间（待网关审批）', zipPath, data: json }
  } catch (err) {
    return { ok: false, message: `提交失败：${err instanceof Error ? err.message : String(err)}`, zipPath }
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
    return { entries: new Map(), ok: false, error: '未登录或缺少网关 APIKey' }
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
      return { entries: new Map(), ok: false, error: '响应不是合法 JSON' }
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
    })
  }
  plugins.sort((a, b) => {
    // 自研在前，其次按名称
    if (a.selfMade !== b.selfMade) return a.selfMade ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return { ok: true, plugins, mineError: mine.ok ? undefined : mine.error }
}
