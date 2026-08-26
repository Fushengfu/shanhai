import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir, hostname as osHostname } from 'node:os'
import type { GatewayModel } from '@shanhai/auth'
import { DEFAULT_SETTINGS } from './types'
import type { AppSettings } from './types'

// —— config.json 串行写（互斥锁）——
// 所有 config.json 的持久化都走「读 → 改 → 写」三步；若不串行化，多个 void 异步写会基于同一份旧快照落盘，
// 后写者覆盖先写者，导致登录凭证（gateway.apiKey）或设置（settings）偶发丢失（表现为「重启后登录失效 / 设置重置」）。
let configWriteChain: Promise<unknown> = Promise.resolve()

/** 串行化地读-改-写 config.json：mutate 在锁内执行，返回其返回值；读失败不落盘；写入用临时文件 + rename 保证原子性 */
export async function withConfigFile<T>(mutate: (cfg: Record<string, unknown>) => T | Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const path = join(homedir(), '.shanhai', 'config.json')
    let cfg: Record<string, unknown> = {}
    try {
      cfg = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
    } catch {
      // 新文件 / 损坏：从空对象开始
    }
    const result = await mutate(cfg)
    const tmp = `${path}.tmp`
    await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
    await fs.rename(tmp, path)
    return result
  }
  const p = configWriteChain.then(run)
  configWriteChain = p.catch(() => undefined)
  return p
}

// —— 设备标识（远程连接多设备用，持久化到 config.json 顶层 deviceId/deviceName）——
let deviceInfo: { deviceId: string; deviceName: string; hostname: string; os: string } | null = null

/** 初始化设备标识：读 config.json 的 deviceId/deviceName，缺失则生成 UUID + 主机名并落盘（串行写，幂等） */
export async function ensureDeviceInfo(): Promise<void> {
  if (deviceInfo) return
  const hostname = osHostname()
  const osName = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
  const generatedId = randomUUID()
  await withConfigFile((cfg) => {
    const existingId = typeof cfg.deviceId === 'string' && cfg.deviceId ? cfg.deviceId : ''
    const existingName = typeof cfg.deviceName === 'string' && cfg.deviceName ? cfg.deviceName : ''
    if (!existingId) cfg.deviceId = generatedId
    if (!existingName) cfg.deviceName = hostname
    deviceInfo = {
      deviceId: existingId || generatedId,
      deviceName: existingName || hostname,
      hostname,
      os: osName,
    }
  })
}

/** 持久化选中模型到 config.json（下次打开不再重复选择） */
export async function persistSelectedModel(modelId: string): Promise<void> {
  try {
    await withConfigFile((cfg) => {
      const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
      g.selectedModelId = modelId
      cfg.gateway = g
    })
  } catch {
    // 忽略持久化失败
  }
}

/** 持久化上次激活的会话 id 到 config.json 顶层（重启恢复到上次关闭前激活的那个会话） */
export async function persistLastActiveSessionId(sessionId: string): Promise<void> {
  try {
    await withConfigFile((cfg) => {
      cfg.lastActiveSessionId = sessionId
    })
  } catch {
    // 忽略持久化失败
  }
}

/** 读取上次激活的会话 id（重启恢复用；无记录或会话已删除时返回 null） */
export async function readLastActiveSessionId(): Promise<string | null> {
  try {
    const path = join(homedir(), '.shanhai', 'config.json')
    const raw = await fs.readFile(path, 'utf8')
    const cfg = JSON.parse(raw) as { lastActiveSessionId?: string }
    return typeof cfg.lastActiveSessionId === 'string' ? cfg.lastActiveSessionId : null
  } catch {
    return null
  }
}

/** 持久化用户自定义模型列表（独立于系统内置模型，登录态无关） */
export async function persistCustomModels(models: GatewayModel[]): Promise<void> {
  try {
    await withConfigFile((cfg) => {
      const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
      g.customModels = models
      cfg.gateway = g
    })
  } catch {
    // 忽略持久化失败
  }
}

/** 登录成功后合并保存凭证（更新 memberToken + account + 网关模型凭证，密码不落盘） */
export async function persistLoginToken(
  token: string,
  username: string,
  member: { nickname?: string; avatar?: string } | undefined,
  gateway: { apiKey: string; baseUrl: string; selectedModelId: string },
): Promise<void> {
  try {
    await withConfigFile((cfg) => {
      const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
      g.memberToken = token
      g.account = { username, ...(member ?? {}) }
      g.apiKey = gateway.apiKey
      g.baseUrl = gateway.baseUrl
      g.selectedModelId = gateway.selectedModelId
      cfg.gateway = g
    })
  } catch {
    // 忽略持久化失败
  }
}

/** 读取通用设置（config.json 顶层 settings 字段，缺字段回退默认值） */
export async function readSettings(): Promise<AppSettings> {
  try {
    const path = join(homedir(), '.shanhai', 'config.json')
    const raw = await fs.readFile(path, 'utf8')
    const cfg = JSON.parse(raw) as { settings?: Partial<AppSettings> }
    const s = cfg.settings
    return {
      browser: {
        showOnCreate: s?.browser?.showOnCreate ?? DEFAULT_SETTINGS.browser.showOnCreate,
        enableWebBridge: s?.browser?.enableWebBridge ?? DEFAULT_SETTINGS.browser.enableWebBridge,
      },
      messageSubmit: { mode: s?.messageSubmit?.mode ?? DEFAULT_SETTINGS.messageSubmit.mode },
      debug: { traceLlm: s?.debug?.traceLlm ?? DEFAULT_SETTINGS.debug.traceLlm },
      voice: { enabled: s?.voice?.enabled ?? DEFAULT_SETTINGS.voice.enabled },
      supervisorApproval: { enabled: s?.supervisorApproval?.enabled ?? DEFAULT_SETTINGS.supervisorApproval.enabled },
      supervisorAsk: { enabled: s?.supervisorAsk?.enabled ?? DEFAULT_SETTINGS.supervisorAsk.enabled },
      compaction: { modelId: s?.compaction?.modelId ?? DEFAULT_SETTINGS.compaction.modelId },
    }
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      browser: { ...DEFAULT_SETTINGS.browser },
      messageSubmit: { ...DEFAULT_SETTINGS.messageSubmit },
      debug: { ...DEFAULT_SETTINGS.debug },
      voice: { ...DEFAULT_SETTINGS.voice },
      supervisorApproval: { ...DEFAULT_SETTINGS.supervisorApproval },
      supervisorAsk: { ...DEFAULT_SETTINGS.supervisorAsk },
      compaction: { ...DEFAULT_SETTINGS.compaction },
    }
  }
}

/** 持久化通用设置到 config.json 顶层 settings 字段（合并，不影响 gateway 等其它字段） */
export async function writeSettings(patch: Partial<AppSettings>): Promise<void> {
  try {
    await withConfigFile((cfg) => {
      const cur = (cfg.settings as Partial<AppSettings> | undefined) ?? {}
      const merged: AppSettings = {
        browser: { ...DEFAULT_SETTINGS.browser, ...(cur.browser ?? {}), ...(patch.browser ?? {}) },
        messageSubmit: { ...DEFAULT_SETTINGS.messageSubmit, ...(cur.messageSubmit ?? {}), ...(patch.messageSubmit ?? {}) },
        debug: { ...DEFAULT_SETTINGS.debug, ...(cur.debug ?? {}), ...(patch.debug ?? {}) },
        voice: { ...DEFAULT_SETTINGS.voice, ...(cur.voice ?? {}), ...(patch.voice ?? {}) },
        supervisorApproval: { ...DEFAULT_SETTINGS.supervisorApproval, ...(cur.supervisorApproval ?? {}), ...(patch.supervisorApproval ?? {}) },
        supervisorAsk: { ...DEFAULT_SETTINGS.supervisorAsk, ...(cur.supervisorAsk ?? {}), ...(patch.supervisorAsk ?? {}) },
        compaction: { ...DEFAULT_SETTINGS.compaction, ...(cur.compaction ?? {}), ...(patch.compaction ?? {}) },
      }
      cfg.settings = merged
    })
  } catch {
    // 忽略持久化失败
  }
}

/** 获取设备标识（ensureDeviceInfo 后非空；未初始化返回 null），供 runtime.getDeviceInfo 使用 */
export function getDeviceInfoState(): { deviceId: string; deviceName: string; hostname: string; os: string } | null {
  return deviceInfo
}

/** 更新设备显示名（持久化后同步内存），供 runtime.setDeviceName 使用 */
export function setDeviceInfoName(name: string): void {
  if (deviceInfo) deviceInfo.deviceName = name
}
