import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { release as osRelease, cpus as osCpus, hostname as osHostname } from 'node:os'
import path from 'node:path'
import { getRuntime } from './runtime'

/**
 * 启动上报：应用每次打开时，匿名 POST「设备信息 + 版本信息」到山海后台（AI 网关），
 * 供后台统计安装量与活跃情况。失败静默——不阻塞启动、不弹窗、不做重试轰炸。
 *
 * 复用网关公开上报接口（与版本检查 / 模型下发同一网关，匿名无需鉴权）。
 * POST /api/v1/public/desktop/report
 */

const REPORT_URL = 'https://aigateway.bjctykj.com/api/v1/public/desktop/report'
const REPORT_STATE_FILE = 'device-report-state.json'
/** 单次上报超时（毫秒）：超过即放弃，避免挂起的 fetch 占用资源 */
const REPORT_TIMEOUT_MS = 10_000
/** 失败重试次数（不含首次）：最多重试 1 次，仍失败则静默丢弃 */
const MAX_RETRY = 1

type ReportEvent = 'install' | 'startup'

interface DeviceReportPayload {
  device_id: string
  platform: string
  arch: string
  version: string
  event: ReportEvent
  app_name: string
  os_version: string
  device_model: string
  os_arch: string
}

/**
 * 读「是否已上报过 install」的本地标记（userData 下）。
 * 返回 true = 已上报过（非首次）；false = 尚未上报过 install（首次）。
 *
 * 说明：device_id 本身无法用来判断首次——它由 runtime 启动早期的 ensureDeviceInfo
 * 生成并持久化到 ~/.shanhai/config.json（早于本上报），因此这里用独立的
 * device-report-state 标记判断「是否第一次上报」。
 */
async function hasReportedBefore(): Promise<boolean> {
  try {
    const filePath = path.join(app.getPath('userData'), REPORT_STATE_FILE)
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { reported?: boolean }
    return parsed?.reported === true
  } catch {
    return false
  }
}

/** 落盘「已上报」标记（仅首次 install 上报成功后写一次）。 */
async function markReported(): Promise<void> {
  try {
    const dir = app.getPath('userData')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, REPORT_STATE_FILE),
      JSON.stringify({ reported: true, updatedAt: Date.now() }, null, 2),
      'utf-8',
    )
  } catch {
    // 标记写入失败不影响上报功能：下次仍按首次处理，最多多报一次 install，可接受
  }
}

/** 发起一次上报请求，成功返回 true，失败返回 false（由调用方决定是否重试）。 */
async function postReport(payload: DeviceReportPayload): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS)
  try {
    const resp = await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!resp.ok) {
      console.warn('[device-report] 上报失败 HTTP', resp.status, resp.statusText)
      return false
    }
    return true
  } catch (err) {
    console.warn('[device-report] 上报请求异常：', err instanceof Error ? err.message : err)
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 启动上报入口：主进程 ready 后 fire-and-forget 调用，绝不阻塞启动。 */
export async function reportDeviceStartup(): Promise<void> {
  try {
    const info = getRuntime().getDeviceInfo()
    const reportedBefore = await hasReportedBefore()
    const event: ReportEvent = reportedBefore ? 'startup' : 'install'

    const payload: DeviceReportPayload = {
      device_id: info.deviceId,
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      event,
      app_name: 'shanhai',
      os_version: osRelease(),
      device_model: osCpus()[0]?.model ?? osHostname(),
      os_arch: process.arch,
    }

    console.log('[device-report] [request]', { url: REPORT_URL, ...payload })

    let ok = await postReport(payload)
    for (let i = 0; i < MAX_RETRY && !ok; i += 1) {
      ok = await postReport(payload)
    }

    if (ok) {
      console.log('[device-report] 上报成功', event)
      // 首次（install）上报成功后才落盘标记；startup 无需写
      if (event === 'install') await markReported()
    } else {
      console.warn('[device-report] 上报失败，已静默丢弃（不阻塞启动）')
    }
  } catch (err) {
    console.warn('[device-report] 上报异常：', err instanceof Error ? err.message : err)
  }
}
