import { app, BrowserWindow, dialog, shell } from 'electron'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 应用版本检查更新（纯手写，不依赖 electron-updater）。
 * 复用网关公开版本检查 API（与登录/模型下发同一网关，无需鉴权）。
 * GET /api/v1/app/version/check?type=macOS&arch=arm64
 */

const API_BASE = 'https://aigateway.bjctykj.com'
const VERSION_CHECK_URL = `${API_BASE}/api/v1/app/version/check`
const DEVICE_UID_FILE = 'device-uid.json'
/** 自动检查发现新版本时推送给渲染进程的通道（preload 侧 onUpdateAvailable 监听） */
const UPDATE_AVAILABLE_CHANNEL = 'app:update-available'

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

function versionToBuildCode(version: string): number {
  const parts = versionParts(version)
  const a = parts[0] ?? 0
  const b = parts[1] ?? 0
  const c = parts[2] ?? 0
  const d = parts[3] ?? 0
  return a * 1_000_000_000 + b * 1_000_000 + c * 1_000 + d
}

function parseVersionCode(value: unknown): number {
  const numeric = Number.parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10)
  return Number.isFinite(numeric) ? numeric : 0
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

  const resp = await fetch(requestUrl, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  })

  console.log('[app-update] [response] version-check status:', {
    status: resp.status,
    statusText: resp.statusText,
  })

  if (!resp.ok) {
    throw new Error(`版本检查失败: ${resp.status} ${resp.statusText}`)
  }

  const text = await resp.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('版本检查响应不是合法 JSON')
  }

  const envelope = json as ApiEnvelope<VersionCheckData>
  if (envelope.code !== 0 && envelope.code !== undefined) {
    throw new Error(`版本检查失败: ${envelope.message || envelope.code}`)
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

async function downloadUpdatePackage(
  downloadUrl: string,
  parentWindow?: BrowserWindow | null,
  expectedSha256?: string,
): Promise<string> {
  const owner = resolveDialogWindow(parentWindow)
  const win = owner ?? BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
  if (!win) throw new Error('未找到可用窗口，无法显示下载进度')

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

  return await new Promise<string>((resolve, reject) => {
    const session = win.webContents.session
    let started = false
    let lastLogAt = 0
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('下载超时：未收到下载启动事件'))
    }, 10_000)

    const cleanup = () => {
      clearTimeout(timeout)
      session.removeListener('will-download', onWillDownload)
      if (!win.isDestroyed()) win.setProgressBar(-1)
    }

    const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem) => {
      if (started) return
      const urlMatch = item.getURL() === normalizedUrl || item.getURLChain?.().includes(normalizedUrl)
      if (!urlMatch) return
      started = true
      clearTimeout(timeout)
      item.setSavePath(savePath)
      if (!win.isDestroyed()) win.setProgressBar(0.01)

      item.on('updated', (_evt, state) => {
        const received = item.getReceivedBytes()
        const total = item.getTotalBytes()
        const progress = total > 0 ? received / total : -1
        if (!win.isDestroyed()) {
          if (progress >= 0) win.setProgressBar(Math.max(0.01, Math.min(progress, 0.99)))
          else win.setProgressBar(2)
        }
        const now = Date.now()
        if (now - lastLogAt >= 1_000) {
          lastLogAt = now
          console.log('[app-update] [download] progress:', {
            state,
            receivedBytes: received,
            totalBytes: total,
            progressPercent: progress >= 0 ? Number((progress * 100).toFixed(1)) : undefined,
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
                const fileBuffer = await fs.readFile(finalPath)
                const actualHash = createHash('sha256').update(fileBuffer).digest('hex')
                console.log('[app-update] [download] sha256 verify:', {
                  expected: expectedSha256,
                  actual: actualHash,
                })
                if (actualHash.toLowerCase() !== expectedSha256.toLowerCase()) {
                  reject(new Error(`文件校验失败：SHA256 不匹配\n期望: ${expectedSha256}\n实际: ${actualHash}`))
                  return
                }
                console.log('[app-update] [download] sha256 verified OK')
              }
              resolve(finalPath)
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)))
            }
          })()
          return
        }
        reject(new Error(`下载失败: ${state}`))
      })
    }

    session.on('will-download', onWillDownload)
    try {
      void session.downloadURL(normalizedUrl)
    } catch (err) {
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
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

export async function checkAndPromptForUpdate(
  options: CheckUpdateOptions = {},
): Promise<AppUpdateCheckResult> {
  const manual = Boolean(options.manual)
  const currentVersion = app.getVersion()
  const checkedAt = Date.now()
  const uid = await resolvePersistentDeviceUid()
  const updateType = resolveUpdateType()

  console.log('[app-update] check start:', { manual, currentVersion, updateType, uid })

  try {
    const latest = await fetchVersionCheck(updateType, currentVersion)
    const latestVersion = String(latest.version ?? '').trim()
    const latestVersionCode = String(latest.version_code ?? '').trim()
    const currentBuildCode = versionToBuildCode(currentVersion)
    const remoteBuildCode = parseVersionCode(latest.version_code)
    const versionCmp = latestVersion ? compareVersion(latestVersion, currentVersion) : 0
    const hasUpdate = Boolean(
      latestVersion && (versionCmp > 0 || (versionCmp === 0 && remoteBuildCode > currentBuildCode)),
    )
    const releaseNotes = String(latest.release_notes ?? latest.releaseNotes ?? '').trim()
    const downloadUrl = String(latest.download_url ?? latest.downloadUrl ?? '').trim()
    const forceUpdate = Boolean(latest.forceUpdate ?? latest.force_update)
    const sha256Sum = String(latest.sha256_sum ?? latest.sha256Sum ?? '').trim() || undefined

    let downloadTriggered = false
    if (hasUpdate && manual) {
      const detailLines = [
        `当前版本：v${currentVersion}`,
        `最新版本：v${latestVersion}${latestVersionCode ? ` (${latestVersionCode})` : ''}`,
        releaseNotes ? `更新内容：\n${releaseNotes}` : '',
        forceUpdate ? '该版本标记为强制更新。' : '',
      ].filter(Boolean)

      const result = await showDialog(options.parentWindow, {
        type: 'info',
        title: '发现新版本',
        message: `检测到新版本 v${latestVersion}`,
        detail: detailLines.join('\n\n'),
        buttons: ['稍后', '下载更新'],
        cancelId: 0,
        defaultId: 1,
        noLink: true,
      })

      if (result.response === 1 && downloadUrl) {
        downloadTriggered = true
        const downloadedFile = await downloadUpdatePackage(downloadUrl, options.parentWindow, sha256Sum)
        const install = await showDialog(options.parentWindow, {
          type: 'question',
          title: '更新包下载完成',
          message: '安装更新需要先退出山海。是否现在退出并开始安装？',
          detail: downloadedFile,
          buttons: ['稍后安装', '立即安装（退出应用）'],
          cancelId: 0,
          defaultId: 1,
          noLink: true,
        })
        if (install.response === 1) {
          if (process.platform === 'darwin') {
            const scheduled = scheduleInstallerLaunchAfterQuit(downloadedFile)
            if (!scheduled) {
              throw new Error('安装启动失败：无法安排退出后自动打开安装包')
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
        }
      }
    } else if (manual) {
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

    // 自动检查发现新版本时主动推送给渲染进程
    if (output.hasUpdate && options.parentWindow && !options.parentWindow.isDestroyed()) {
      options.parentWindow.webContents.send(UPDATE_AVAILABLE_CHANNEL, output)
    }

    return output
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[app-update] check failed:', message)

    if (manual) {
      try {
        await showDialog(options.parentWindow, {
          type: 'error',
          title: '检查更新失败',
          message: '无法连接更新服务器',
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
      message,
    }
    lastUpdateCheckResult = failed
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
