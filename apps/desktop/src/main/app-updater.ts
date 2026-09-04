import { app, BrowserWindow, dialog, shell } from 'electron'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { safeSend } from './safe-send'

/**
 * 应用版本检查更新（纯手写，不依赖 electron-updater）。
 * 复用网关公开版本检查 API（与登录/模型下发同一网关，无需鉴权）。
 * GET /api/v1/app/version/check?type=macOS&arch=arm64
 *
 * 提醒策略（2026-09 定稿）：
 * - 启动 1 秒后 + 每 10 分钟自动检查；发现新版本用「主进程原生对话框」提醒（不依赖渲染层监听者，
 *   也不依赖某个窗口可见），同一版本号只自动弹一次，跨重启由 userData/update-notice.json 持久化记住。
 * - 手动「检查更新」（设置 → 关于山海）不受只弹一次限制，每次都如实反馈。
 * - 下载过程通过 app:update-download-progress 广播到所有内容窗口，渲染层 UpdateProgressOverlay 显示进度。
 */

const API_BASE = 'https://aigateway.bjctykj.com'
const VERSION_CHECK_URL = `${API_BASE}/api/v1/app/version/check`
const DEVICE_UID_FILE = 'device-uid.json'
/** 自动提醒记录落盘文件（已弹过的最高版本 + 用户显式跳过的版本），跨重启生效 */
const UPDATE_NOTICE_FILE = 'update-notice.json'
/** 版本检查结果推送通道（preload 侧 onUpdateAvailable 监听），现广播到所有窗口 */
const UPDATE_AVAILABLE_CHANNEL = 'app:update-available'
/** 安装包下载进度通道（preload 侧 onUpdateDownloadProgress 监听），广播到所有窗口 */
const DOWNLOAD_PROGRESS_CHANNEL = 'app:update-download-progress'
/** 版本检查请求超时（ms）：避免网关连接挂起把这次检查无限期占住 */
const VERSION_CHECK_TIMEOUT_MS = 10_000
/** 手机端 APK 信息请求超时（ms） */
const MOBILE_APK_TIMEOUT_MS = 10_000

type UpdateType = 'Windows' | 'macOS'

type ApiEnvelope<T> = {
  code?: number
  message?: string
  data?: T
}

type VersionCheckData = {
  version?: string
  version_code?: string | number
  download_url?: string
  downloadUrl?: string
  hash?: string
  sha256_sum?: string
  sha256Sum?: string
  release_notes?: string
  releaseNotes?: string
  forceUpdate?: boolean
  force_update?: boolean
  platform_type?: string
  package_name?: string
}

/** 手机端（Android）APK 下载信息（从版本检查 API 获取） */
export type MobileApkInfo = {
  downloadUrl: string
  version?: string
}

/** 一次版本检查/更新的结果（主进程 → 渲染层） */
export type AppUpdateCheckResult = {
  success: boolean
  checkedAt: number
  currentVersion: string
  hasUpdate: boolean
  latestVersion?: string
  latestVersionCode?: string
  releaseNotes?: string
  downloadUrl?: string
  forceUpdate?: boolean
  /** 用户是否点击了下载 */
  downloadTriggered?: boolean
  /** 提示信息（错误或状态） */
  message?: string
  /** 失败阶段（success=false 时有值）：check=检查/网络，download=下载，verify=校验，install=安装 */
  failureStage?: UpdateFailureStage
}

type CheckUpdateOptions = {
  manual?: boolean
  parentWindow?: BrowserWindow | null
}

let lastUpdateCheckResult: AppUpdateCheckResult | null = null

function fallbackDeviceUid(): string {
  const base = [
    app.getName(),
    process.platform,
    process.arch,
    process.env.HOSTNAME || process.env.COMPUTERNAME || '',
    app.getPath('home'),
  ].join('|')
  const hash = createHash('sha1').update(base).digest('hex').slice(0, 16)
  return `shanhai_fp_${hash}`
}

function createDeviceUid(): string {
  return `shanhai_${randomBytes(16).toString('hex')}`
}

function isValidDeviceUid(value: unknown): value is string {
  const text = String(value ?? '').trim()
  return Boolean(text) && text.length >= 12 && text.length <= 128
}

async function resolvePersistentDeviceUid(): Promise<string> {
  const fallback = fallbackDeviceUid()
  try {
    const dir = app.getPath('userData')
    const filePath = path.join(dir, DEVICE_UID_FILE)
    const raw = await fs.readFile(filePath, 'utf-8').catch(() => '')
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { uid?: string }
        if (isValidDeviceUid(parsed?.uid)) return parsed.uid
      } catch {
        // ignore parse error and regenerate
      }
    }

    const uid = createDeviceUid()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      filePath,
      JSON.stringify({ uid, createdAt: Date.now(), schemaVersion: 1 }, null, 2),
      'utf-8',
    )
    return uid
  } catch (err) {
    console.warn('[app-update] [uid] persist failed, fallback deterministic uid:', err)
    return fallback
  }
}

function resolveUpdateType(): UpdateType {
  const envType = String(process.env.SHANHAI_UPDATE_TYPE ?? '').trim()
  if (envType === 'Windows' || envType === 'macOS') return envType
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'win32') return 'Windows'
  throw new Error(`当前系统 ${process.platform} 暂不支持更新类型映射，仅支持 macOS / Windows`)
}

function versionParts(version: string): number[] {
  const parts = String(version)
    .split('.')
    .map((item) => Number.parseInt(item.replace(/[^\d]/g, ''), 10))
    .map((n) => (Number.isFinite(n) ? n : 0))
  while (parts.length < 4) parts.push(0)
  return parts.slice(0, 4)
}

function compareVersion(a: string, b: string): number {
  const pa = versionParts(a)
  const pb = versionParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return 0
}

/**
 * 更新流程的失败阶段。用于把错误文案按「真实原因」分型（历史缺陷：下载/校验/安装失败也被统一
 * 冠以「无法连接更新服务器」，误导用户以为是网络问题）。
 */
export type UpdateFailureStage = 'check' | 'download' | 'verify' | 'install'

/** 带阶段标记的更新失败（check=检查/网络，download=下载，verify=SHA256 校验，install=启动安装） */
class UpdateFailure extends Error {
  readonly stage: UpdateFailureStage

  constructor(stage: UpdateFailureStage, message: string) {
    super(message)
    this.name = 'UpdateFailure'
    this.stage = stage
  }
}

/** 各失败阶段对应的对话框文案（标题 / 正文） */
const UPDATE_FAILURE_COPY: Record<UpdateFailureStage, { title: string; message: string }> = {
  check: { title: '检查更新失败', message: '无法连接更新服务器' },
  download: { title: '下载更新失败', message: '新版本安装包下载未完成' },
  verify: { title: '安装包校验失败', message: '下载的安装包完整性校验未通过，已删除该文件' },
  install: { title: '安装启动失败', message: '安装包已就绪，但无法自动打开安装程序' },
}

/** 下载进度阶段（渲染层 UpdateProgressOverlay 据此切换文案/收尾） */
export type UpdateDownloadPhase = 'pending' | 'downloading' | 'verifying' | 'completed' | 'failed' | 'cancelled'

/** 安装包下载进度（主进程 → 渲染层，广播到所有内容窗口） */
export type AppUpdateDownloadProgress = {
  phase: UpdateDownloadPhase
  fileName: string
  receivedBytes: number
  /** 服务端未返回 Content-Length 时为 0 */
  totalBytes: number
  /** 0-100；totalBytes 为 0（总量未知）时为 -1，渲染层显示不确定态进度条 */
  percent: number
  bytesPerSecond: number
  savePath: string
  latestVersion?: string
  message?: string
  updatedAt: number
}

/**
 * 自动弹窗提醒的持久化状态（userData/update-notice.json）。两类记录语义不同，分开存：
 * - notifiedVersion：最近一次「自动检查已经弹过窗」的版本号。判定用 compareVersion(网关版本, notifiedVersion) > 0，
 *   所以同一版本只自动弹一次，只有网关发布更高版本号才会再弹（重启后依然生效）。
 * - skippedVersions：用户点过「跳过此版本」的版本黑名单，命中后永不再自动弹；
 *   手动「检查更新」不受该黑名单约束，仍会如实提示（只是不再自动骚扰）。
 */
type UpdateNoticeState = {
  schemaVersion: 1
  notifiedVersion: string
  skippedVersions: string[]
  updatedAt: number
}

function updateNoticePath(): string {
  return path.join(app.getPath('userData'), UPDATE_NOTICE_FILE)
}

async function readUpdateNoticeState(): Promise<UpdateNoticeState> {
  try {
    const raw = await fs.readFile(updateNoticePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<UpdateNoticeState>
    const skippedVersions = Array.isArray(parsed.skippedVersions)
      ? parsed.skippedVersions.map((v) => String(v ?? '').trim()).filter(Boolean)
      : []
    return {
      schemaVersion: 1,
      notifiedVersion: String(parsed.notifiedVersion ?? '').trim(),
      skippedVersions,
      updatedAt: Number(parsed.updatedAt ?? 0) || 0,
    }
  } catch {
    return { schemaVersion: 1, notifiedVersion: '', skippedVersions: [], updatedAt: 0 }
  }
}

async function writeUpdateNoticeState(state: UpdateNoticeState): Promise<void> {
  try {
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await fs.writeFile(updateNoticePath(), JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[app-update] [notice] 提醒记录持久化失败（本次仅内存生效）:', err)
  }
}

/** 该版本是否还需要自动弹窗（黑名单命中 / 已弹过同版本或更高版本 → 不再弹） */
async function shouldAutoNotify(latestVersion: string): Promise<boolean> {
  const state = await readUpdateNoticeState()
  if (state.skippedVersions.includes(latestVersion)) return false
  if (state.notifiedVersion && compareVersion(latestVersion, state.notifiedVersion) <= 0) return false
  return true
}

/** 记录「已就某版本自动弹过窗」（水位只升不降，避免网关回滚后重复弹） */
async function markVersionNotified(latestVersion: string): Promise<void> {
  const state = await readUpdateNoticeState()
  if (state.notifiedVersion && compareVersion(state.notifiedVersion, latestVersion) >= 0) return
  await writeUpdateNoticeState({ ...state, schemaVersion: 1, notifiedVersion: latestVersion, updatedAt: Date.now() })
}

/** 记录「用户跳过某版本」：加入黑名单，并把 notifiedVersion 抬到该版本，确保不再自动弹 */
async function markVersionSkipped(latestVersion: string): Promise<void> {
  const state = await readUpdateNoticeState()
  const skippedVersions = state.skippedVersions.includes(latestVersion)
    ? state.skippedVersions
    : [...state.skippedVersions, latestVersion]
  const notifiedVersion =
    state.notifiedVersion && compareVersion(state.notifiedVersion, latestVersion) >= 0
      ? state.notifiedVersion
      : latestVersion
  await writeUpdateNoticeState({ ...state, schemaVersion: 1, skippedVersions, notifiedVersion, updatedAt: Date.now() })
}

/** 广播到所有未销毁窗口（渲染层各窗口自行渲染；safeSend 已兜住窗口销毁竞态） */
function broadcastToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) safeSend(win, channel, payload)
}

async function fetchVersionCheck(
  updateType: UpdateType,
  currentVersion: string,
): Promise<VersionCheckData> {
  const query = new URLSearchParams({ type: updateType, arch: process.arch })
  const requestUrl = `${VERSION_CHECK_URL}?${query.toString()}`

  console.log('[app-update] [request] gateway version-check:', {
    url: requestUrl,
    type: updateType,
    arch: process.arch,
    currentVersion,
  })

  // 超时保护：网关连接挂起（DNS/半开连接）曾会把这次检查无限期占住，10s 内无响应即判失败
  let resp: Response
  try {
    resp = await fetch(requestUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new UpdateFailure(
      'check',
      isTimeout
        ? `检查更新超时：${VERSION_CHECK_TIMEOUT_MS / 1000} 秒内未收到更新服务器响应`
        : `无法连接更新服务器：${detail}`,
    )
  }

  console.log('[app-update] [response] version-check status:', {
    status: resp.status,
    statusText: resp.statusText,
  })

  if (!resp.ok) {
    throw new UpdateFailure('check', `版本检查失败: ${resp.status} ${resp.statusText}`)
  }

  const text = await resp.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    throw new UpdateFailure('check', '版本检查响应不是合法 JSON')
  }

  const envelope = json as ApiEnvelope<VersionCheckData>
  if (envelope.code !== 0 && envelope.code !== undefined) {
    throw new UpdateFailure('check', `版本检查失败: ${envelope.message || envelope.code}`)
  }

  const data = envelope.data ?? (json as VersionCheckData)
  console.log('[app-update] [response] version-check parsed:', {
    version: data.version,
    version_code: data.version_code,
    download_url: data.download_url || data.downloadUrl,
    forceUpdate: data.forceUpdate ?? data.force_update,
  })

  return data
}

/**
 * 从网关公开版本检查 API 获取 Android APK 下载地址（供「下载手机端」入口使用）。
 * 无需鉴权，失败返回 null。type=Android 由网关按平台下发对应安装包。
 */
export async function fetchMobileApkInfo(packageName: string): Promise<MobileApkInfo | null> {
  try {
    const query = new URLSearchParams({ type: 'Android', packageName })
    const requestUrl = `${VERSION_CHECK_URL}?${query.toString()}`
    console.log('[app-update] [mobile] request:', { url: requestUrl, packageName })

    const resp = await fetch(requestUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(MOBILE_APK_TIMEOUT_MS),
    })
    if (!resp.ok) {
      console.warn('[app-update] [mobile] API 返回非 2xx:', resp.status)
      return null
    }

    const text = await resp.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      console.warn('[app-update] [mobile] 响应不是合法 JSON')
      return null
    }

    const envelope = json as ApiEnvelope<VersionCheckData>
    const data = envelope.data ?? (json as VersionCheckData)
    const downloadUrl = String(data.download_url ?? data.downloadUrl ?? '').trim()
    if (!downloadUrl) {
      console.warn('[app-update] [mobile] 响应中无 download_url')
      return null
    }

    const result: MobileApkInfo = {
      downloadUrl,
      version: data.version ? String(data.version).trim() : undefined,
    }
    console.log('[app-update] [mobile] success:', result)
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[app-update] [mobile] 获取 APK 下载信息失败:', msg)
    return null
  }
}

function resolveDialogWindow(parentWindow?: BrowserWindow | null): BrowserWindow | undefined {
  if (parentWindow && !parentWindow.isDestroyed()) return parentWindow
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
}

async function showDialog(
  parentWindow: BrowserWindow | null | undefined,
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  const owner = resolveDialogWindow(parentWindow)
  if (owner) return dialog.showMessageBox(owner, options)
  return dialog.showMessageBox(options)
}

/**
 * 自动检查用的「应用级」对话框：不绑父窗口。
 * 原因：macOS 上 showMessageBox(win) 会以 sheet 形式挂在父窗口上，而自动检查的父窗口是聊天窗口
 * （启动时默认隐藏）或全屏桌面壳（位于最底层），都可能出现「弹了但看不见」。
 * 不传窗口 → 系统级居中模态框，无论当前哪个窗口可见都保证用户能看到。
 */
async function showAppLevelDialog(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  return dialog.showMessageBox(options)
}

function safeFileNameFromUrl(downloadUrl: string): string {
  try {
    const u = new URL(downloadUrl)
    const raw = decodeURIComponent(path.basename(u.pathname || '').trim())
    if (raw) return raw
  } catch {
    // ignore
  }
  const ext = process.platform === 'win32' ? '.exe' : '.dmg'
  return `Shanhai-AI-update-${Date.now()}${ext}`
}

async function ensureUniquePath(targetPath: string): Promise<string> {
  const parsed = path.parse(targetPath)
  let candidate = targetPath
  let idx = 1
  while (true) {
    try {
      await fs.access(candidate)
      candidate = path.join(parsed.dir, `${parsed.name} (${idx})${parsed.ext}`)
      idx += 1
    } catch {
      return candidate
    }
  }
}

/** 最近一次下载进度快照（供中途新开的窗口一次性拉取，避免「打开时看不到正在进行的下载」） */
let lastDownloadProgress: AppUpdateDownloadProgress | null = null

/** 当前正在进行的下载项（供渲染层「取消下载」按钮调用） */
let activeDownloadItem: Electron.DownloadItem | null = null

export function getLastDownloadProgress(): AppUpdateDownloadProgress | null {
  return lastDownloadProgress
}

/** 取消当前正在进行的安装包下载（无进行中下载时返回 false） */
export function cancelUpdateDownload(): boolean {
  const item = activeDownloadItem
  if (!item) return false
  try {
    item.cancel()
    return true
  } catch (err) {
    console.warn('[app-update] [download] cancel failed:', err)
    return false
  }
}

/** 广播下载进度到所有内容窗口（含 desktop/dock 也无害：它们没订阅该通道） */
function emitDownloadProgress(patch: Partial<AppUpdateDownloadProgress> & { phase: UpdateDownloadPhase }): void {
  const payload: AppUpdateDownloadProgress = {
    phase: patch.phase,
    fileName: patch.fileName ?? lastDownloadProgress?.fileName ?? '',
    receivedBytes: patch.receivedBytes ?? lastDownloadProgress?.receivedBytes ?? 0,
    totalBytes: patch.totalBytes ?? lastDownloadProgress?.totalBytes ?? 0,
    percent: patch.percent ?? lastDownloadProgress?.percent ?? 0,
    bytesPerSecond: patch.bytesPerSecond ?? lastDownloadProgress?.bytesPerSecond ?? 0,
    savePath: patch.savePath ?? lastDownloadProgress?.savePath ?? '',
    latestVersion: patch.latestVersion ?? lastDownloadProgress?.latestVersion,
    message: patch.message,
    updatedAt: Date.now(),
  }
  lastDownloadProgress = payload
  broadcastToWindows(DOWNLOAD_PROGRESS_CHANNEL, payload)
}

async function downloadUpdatePackage(
  downloadUrl: string,
  parentWindow?: BrowserWindow | null,
  expectedSha256?: string,
  latestVersion?: string,
): Promise<string> {
  const owner = resolveDialogWindow(parentWindow)
  const win = owner ?? BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
  if (!win) throw new UpdateFailure('download', '未找到可用窗口，无法下载更新包')

  let normalizedUrl = String(downloadUrl ?? '').trim()
  if (normalizedUrl && !/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = `https://${normalizedUrl}`
  }
  normalizedUrl = normalizedUrl.replace(/\s/g, '%20')

  const downloadsDir = app.getPath('downloads')
  await fs.mkdir(downloadsDir, { recursive: true })
  const fileName = safeFileNameFromUrl(normalizedUrl)
  const savePath = await ensureUniquePath(path.join(downloadsDir, fileName))

  console.log('[app-update] [download] start:', { downloadUrl: normalizedUrl, savePath })

  emitDownloadProgress({
    phase: 'pending',
    fileName,
    savePath,
    receivedBytes: 0,
    totalBytes: 0,
    percent: 0,
    bytesPerSecond: 0,
    latestVersion,
    message: '正在连接下载服务器…',
  })

  return await new Promise<string>((resolve, reject) => {
    const session = win.webContents.session
    let started = false
    let lastLogAt = 0
    /** 进度广播节流：最多每 250ms 一次，避免高频 updated 事件打爆 IPC */
    let lastPushAt = 0
    /** 总量未知时（total=0）按已下载字节推进的兜底百分比上限，绝不假装 100% */
    let lastKnownPercent = 0

    const pushProgress = (patch: Partial<AppUpdateDownloadProgress> & { phase: UpdateDownloadPhase }, force = false) => {
      const now = Date.now()
      if (!force && patch.phase === 'downloading' && now - lastPushAt < 250) return
      lastPushAt = now
      emitDownloadProgress({ ...patch, fileName, savePath, latestVersion })
    }

    /** 统一失败收尾：广播终态（failed / cancelled）后 reject，保证进度 UI 不会停在下载中 */
    const fail = (stage: UpdateFailureStage, message: string, phase: UpdateDownloadPhase = 'failed') => {
      pushProgress({ phase, percent: lastKnownPercent, bytesPerSecond: 0, message }, true)
      reject(new UpdateFailure(stage, message))
    }

    const timeout = setTimeout(() => {
      cleanup()
      fail('download', '下载超时：未收到下载启动事件')
    }, 10_000)

    const cleanup = () => {
      clearTimeout(timeout)
      session.removeListener('will-download', onWillDownload)
      activeDownloadItem = null
      if (!win.isDestroyed()) win.setProgressBar(-1)
    }

    const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem) => {
      if (started) return
      const urlMatch = item.getURL() === normalizedUrl || item.getURLChain?.().includes(normalizedUrl)
      if (!urlMatch) return
      started = true
      clearTimeout(timeout)
      activeDownloadItem = item
      item.setSavePath(savePath)
      if (!win.isDestroyed()) win.setProgressBar(0.01)

      pushProgress(
        { phase: 'downloading', receivedBytes: 0, totalBytes: item.getTotalBytes(), percent: 0, bytesPerSecond: 0, message: '正在下载更新包…' },
        true,
      )

      item.on('updated', (_evt, state) => {
        const received = item.getReceivedBytes()
        const total = item.getTotalBytes()
        const speed = item.getCurrentBytesPerSecond?.() ?? 0
        const ratio = total > 0 ? received / total : -1
        const percent = ratio >= 0 ? Math.min(99, Number((ratio * 100).toFixed(1))) : -1
        if (percent >= 0) lastKnownPercent = percent
        if (!win.isDestroyed()) {
          if (ratio >= 0) win.setProgressBar(Math.max(0.01, Math.min(ratio, 0.99)))
          else win.setProgressBar(2)
        }
        pushProgress({ phase: 'downloading', receivedBytes: received, totalBytes: total, percent, bytesPerSecond: speed })

        const now = Date.now()
        if (now - lastLogAt >= 1_000) {
          lastLogAt = now
          console.log('[app-update] [download] progress:', {
            state,
            receivedBytes: received,
            totalBytes: total,
            bytesPerSecond: speed,
            progressPercent: percent >= 0 ? percent : undefined,
          })
        }
      })

      item.once('done', (_evt, state) => {
        cleanup()
        const finalPath = item.getSavePath() || savePath
        console.log('[app-update] [download] done:', { state, filePath: finalPath })
        if (state === 'completed') {
          void (async () => {
            try {
              if (expectedSha256) {
                pushProgress({ phase: 'verifying', percent: 99, bytesPerSecond: 0, message: '正在校验安装包（SHA256）…' }, true)
                const fileBuffer = await fs.readFile(finalPath)
                const actualHash = createHash('sha256').update(fileBuffer).digest('hex')
                console.log('[app-update] [download] sha256 verify:', {
                  expected: expectedSha256,
                  actual: actualHash,
                })
                if (actualHash.toLowerCase() !== expectedSha256.toLowerCase()) {
                  // 校验失败：删除已下载的损坏文件，避免残留污染 downloads 目录
                  await fs.rm(finalPath, { force: true }).catch(() => undefined)
                  fail('verify', `文件校验失败：SHA256 不匹配\n期望: ${expectedSha256}\n实际: ${actualHash}`)
                  return
                }
                console.log('[app-update] [download] sha256 verified OK')
              }
              const size = (await fs.stat(finalPath).catch(() => null))?.size ?? 0
              pushProgress(
                {
                  phase: 'completed',
                  receivedBytes: size,
                  totalBytes: size,
                  percent: 100,
                  bytesPerSecond: 0,
                  message: '下载完成',
                },
                true,
              )
              resolve(finalPath)
            } catch (err) {
              fail('download', `读取下载文件失败：${err instanceof Error ? err.message : String(err)}`)
            }
          })()
          return
        }
        // 下载中断/取消/出错：清理已落盘的半截文件，避免残留污染 downloads 目录
        void fs.rm(finalPath, { force: true }).catch(() => undefined)
        if (state === 'cancelled') {
          fail('download', '下载已取消（残留文件已清理）', 'cancelled')
          return
        }
        fail('download', `下载失败: ${state}`)
      })
    }

    session.on('will-download', onWillDownload)
    try {
      void session.downloadURL(normalizedUrl)
    } catch (err) {
      cleanup()
      fail('download', err instanceof Error ? err.message : String(err))
    }
  })
}

async function openInstallerPackage(filePath: string): Promise<void> {
  const target = String(filePath ?? '').trim()
  if (!target) throw new Error('安装包路径为空')

  await fs.access(target).catch(() => {
    throw new Error(`安装包不存在: ${target}`)
  })

  console.log('[app-update] [install] openPath:', { filePath: target })
  const openPathErr = await shell.openPath(target)
  if (!openPathErr) {
    console.log('[app-update] [install] openPath success')
    return
  }

  console.warn('[app-update] [install] openPath failed, fallback openExternal(file://):', openPathErr)
  const fileUrl = pathToFileURL(target).toString()
  try {
    await shell.openExternal(fileUrl)
    console.log('[app-update] [install] fallback openExternal success:', { fileUrl })
    return
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`打开安装包失败: ${openPathErr || detail}`)
  }
}

function shellQuote(text: string): string {
  return `'${String(text ?? '').replace(/'/g, `'\\''`)}'`
}

function scheduleInstallerLaunchAfterQuit(filePath: string): boolean {
  if (process.platform !== 'darwin') return false
  const target = String(filePath ?? '').trim()
  if (!target) return false
  try {
    const appName = shellQuote(app.getName())
    const cmd = `for i in $(seq 1 120); do if ! pgrep -x ${appName} >/dev/null 2>&1; then break; fi; sleep 0.2; done; open ${shellQuote(target)}`
    const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' })
    child.unref()
    console.log('[app-update] [install] scheduled launch after quit:', { filePath: target })
    return true
  } catch (err) {
    console.error('[app-update] [install] failed to schedule launch after quit:', err)
    return false
  }
}

/** 更新对话框是否正在显示（防止自动检查与手动检查同时弹窗叠加） */
let updateDialogOpen = false

/**
 * 弹出「发现新版本」对话框并（在用户选择时）走下载 → 安装引导。
 * 手动检查与自动检查共用本函数，差别只在：自动检查受「同一版本只弹一次 / 跳过名单」约束（由调用方判定）。
 * @returns 用户是否真正触发了下载
 */
async function promptAndInstallUpdate(
  params: {
    manual: boolean
    parentWindow?: BrowserWindow | null
    currentVersion: string
    latestVersion: string
    latestVersionCode: string
    releaseNotes: string
    forceUpdate: boolean
    downloadUrl: string
    sha256Sum?: string
  },
): Promise<boolean> {
  const detailLines = [
    `当前版本：v${params.currentVersion}`,
    `最新版本：v${params.latestVersion}${params.latestVersionCode ? ` (build ${params.latestVersionCode})` : ''}`,
    params.releaseNotes ? `更新内容：\n${params.releaseNotes}` : '',
    params.forceUpdate ? '该版本标记为强制更新。' : '',
    params.manual
      ? ''
      : '（同一版本只会自动提醒一次；想再次收到提醒，需等网关发布更高版本；也可随时在「设置 → 关于山海」手动检查。）',
  ].filter(Boolean)

  updateDialogOpen = true
  let result: MessageBoxReturnValue
  try {
    const promptOptions: MessageBoxOptions = {
      type: 'info',
      title: '发现新版本',
      message: `检测到新版本 v${params.latestVersion}`,
      detail: detailLines.join('\n\n'),
      buttons: ['稍后', '跳过此版本', '下载更新'],
      cancelId: 0,
      defaultId: 2,
      noLink: true,
    }
    // 手动检查挂在发起窗口（设置窗口，一定可见）；自动检查用应用级对话框（父窗口可能隐藏/在最底层）
    result = params.manual ? await showDialog(params.parentWindow, promptOptions) : await showAppLevelDialog(promptOptions)
  } finally {
    updateDialogOpen = false
  }

  // 1 = 跳过此版本：写入黑名单，该版本号之后不再自动弹（手动检查仍如实提示）
  if (result.response === 1) {
    await markVersionSkipped(params.latestVersion)
    console.log('[app-update] user skipped version:', params.latestVersion)
    return false
  }
  if (result.response !== 2) return false
  if (!params.downloadUrl) {
    throw new UpdateFailure('download', '网关未返回下载地址，无法下载更新包')
  }

  const downloadedFile = await downloadUpdatePackage(
    params.downloadUrl,
    params.parentWindow,
    params.sha256Sum,
    params.latestVersion,
  )

  updateDialogOpen = true
  let install: MessageBoxReturnValue
  try {
    const installOptions: MessageBoxOptions = {
      type: 'question',
      title: '更新包下载完成',
      message: '安装更新需要先退出山海。是否现在退出并开始安装？',
      detail: process.platform === 'darwin'
        ? `${downloadedFile}\n\nmacOS：将为你打开安装包（dmg），请把「山海」拖入「应用程序」覆盖后重新打开。`
        : downloadedFile,
      buttons: ['稍后安装', '立即安装（退出应用）'],
      cancelId: 0,
      defaultId: 1,
      noLink: true,
    }
    install = params.manual ? await showDialog(params.parentWindow, installOptions) : await showAppLevelDialog(installOptions)
  } finally {
    updateDialogOpen = false
  }

  if (install.response !== 1) return true

  try {
    if (process.platform === 'darwin') {
      const scheduled = scheduleInstallerLaunchAfterQuit(downloadedFile)
      if (!scheduled) {
        throw new UpdateFailure('install', '安装启动失败：无法安排退出后自动打开安装包')
      }
      setTimeout(() => {
        app.quit()
      }, 120)
    } else if (process.platform === 'win32') {
      await openInstallerPackage(downloadedFile)
      setTimeout(() => {
        app.quit()
      }, 200)
    } else {
      await openInstallerPackage(downloadedFile)
    }
  } catch (err) {
    if (err instanceof UpdateFailure) throw err
    throw new UpdateFailure('install', `安装启动失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return true
}

export async function checkAndPromptForUpdate(
  options: CheckUpdateOptions = {},
): Promise<AppUpdateCheckResult> {
  const manual = Boolean(options.manual)
  const currentVersion = app.getVersion()
  const checkedAt = Date.now()
  const uid = await resolvePersistentDeviceUid()

  console.log('[app-update] check start:', { manual, currentVersion, uid })

  try {
    // 平台映射放进 try：不支持的平台（如 Linux）此前会把异常抛到函数外，
    // 导致手动检查点了按钮毫无反应、自动检查只留一条 info 日志。
    const updateType = resolveUpdateType()
    const latest = await fetchVersionCheck(updateType, currentVersion)
    const latestVersion = String(latest.version ?? '').trim()
    const latestVersionCode = String(latest.version_code ?? '').trim()
    // 判据只保留「version 字符串比较」这一个维度。
    // 不再参与判定：网关 version_code（形如 minor*10+patch，例 0.6.2→62）与本地 macOS
    // CFBundleVersion（electron-builder.yml 手工 buildVersion，每次发版 +1，例 0.6.2→3）
    // 是两套互不相干的编号体系，「同 version 再比 build code」必然产生误报
    // （已发布的 0.6.2 包会被判成「发现新版本 v0.6.2」且永远消不掉）。
    // version_code 现在只作为对话框里的展示信息（build N），不参与 hasUpdate 判定。
    const versionCmp = latestVersion ? compareVersion(latestVersion, currentVersion) : 0
    const hasUpdate = Boolean(latestVersion && versionCmp > 0)
    const releaseNotes = String(latest.release_notes ?? latest.releaseNotes ?? '').trim()
    const downloadUrl = String(latest.download_url ?? latest.downloadUrl ?? '').trim()
    const forceUpdate = Boolean(latest.forceUpdate ?? latest.force_update)
    const sha256Sum = String(latest.sha256_sum ?? latest.sha256Sum ?? '').trim() || undefined

    let downloadTriggered = false
    if (hasUpdate) {
      // 自动检查：同一版本号只弹一次（跳过名单命中 / 已弹过同版本或更高版本 → 静默）
      const shouldPrompt = manual || (await shouldAutoNotify(latestVersion))
      if (shouldPrompt && !updateDialogOpen) {
        // 先落「已弹过」水位再弹窗：即便弹窗期间崩溃/被强杀，也不会下次重复骚扰
        if (!manual) await markVersionNotified(latestVersion)
        downloadTriggered = await promptAndInstallUpdate({
          manual,
          parentWindow: options.parentWindow,
          currentVersion,
          latestVersion,
          latestVersionCode,
          releaseNotes,
          forceUpdate,
          downloadUrl,
          sha256Sum,
        })
      } else if (!shouldPrompt) {
        console.log('[app-update] 自动提醒已抑制（该版本已弹过或被跳过）:', latestVersion)
      }
    } else if (manual) {
      updateDialogOpen = true
      try {
        await showDialog(options.parentWindow, {
          type: 'info',
          title: '检查更新',
          message: '当前已是最新版本',
          detail: `当前版本：v${currentVersion}`,
          buttons: ['知道了'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
      } finally {
        updateDialogOpen = false
      }
    }

    const output: AppUpdateCheckResult = {
      success: true,
      checkedAt,
      currentVersion,
      hasUpdate,
      latestVersion: latestVersion || undefined,
      latestVersionCode: latestVersionCode || undefined,
      releaseNotes: releaseNotes || undefined,
      downloadUrl: downloadUrl || undefined,
      forceUpdate,
      downloadTriggered,
      message: hasUpdate ? '发现新版本' : '当前已是最新版本',
    }
    lastUpdateCheckResult = output
    console.log('[app-update] check result:', output)

    // 检查结果广播到所有窗口：设置页（独立窗口）与聊天窗口都能实时同步，
    // 不再只发给一个没有监听者的窗口
    broadcastToWindows(UPDATE_AVAILABLE_CHANNEL, output)

    return output
  } catch (err) {
    const stage: UpdateFailureStage = err instanceof UpdateFailure ? err.stage : 'check'
    const message = err instanceof Error ? err.message : String(err)
    console.error('[app-update] check failed:', { stage, message })

    const copy = UPDATE_FAILURE_COPY[stage]
    if (manual) {
      try {
        await showDialog(options.parentWindow, {
          type: 'error',
          title: copy.title,
          message: copy.message,
          detail: message,
          buttons: ['知道了'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
      } catch {
        // ignore dialog errors
      }
    }

    const failed: AppUpdateCheckResult = {
      success: false,
      checkedAt,
      currentVersion,
      hasUpdate: false,
      message: `${copy.title}：${message}`,
      failureStage: stage,
    }
    lastUpdateCheckResult = failed
    broadcastToWindows(UPDATE_AVAILABLE_CHANNEL, failed)
    return failed
  }
}

export function getLastUpdateCheckResult(): AppUpdateCheckResult | null {
  return lastUpdateCheckResult
}

const AUTO_CHECK_INTERVAL_MS = 10 * 60 * 1000 // 每 10 分钟检查一次

export function scheduleStartupUpdateCheck(parentWindow?: BrowserWindow | null): void {
  const startupDelayMs = 1_000
  const runCheck = () => {
    void checkAndPromptForUpdate({ manual: false, parentWindow }).catch((err) => {
      console.info('[app-update] 自动检查更新失败（已忽略）', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
  setTimeout(() => {
    runCheck()
    setInterval(runCheck, AUTO_CHECK_INTERVAL_MS)
  }, startupDelayMs)
}
