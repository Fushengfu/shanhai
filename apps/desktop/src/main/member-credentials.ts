/**
 * 会员登录凭证（JWT）续签复用点 —— 单一实现，两条出网连接（remote-relay / member-channel）共用。
 *
 * 【为什么单独一个模块】
 * 网关会员 JWT 原 TTL=24h（现调整为 720h=30 天，并新增 7 天 refresh 宽限期）。在改造前，
 * 山海的真实故障链是：已建立的 ws 不受过期影响（网关只在握手时校验一次），但断线重连时旧 token 过期
 * → 网关握手回 401 → remote-relay 遇 401 是「停止重连」（remote-relay.ts 旧 :152-167）
 * → 电脑关机过夜后回来，远程控制与私信都永久掉线，只能手动重新登录。
 * 本模块把「取凭证 + 到期主动续签 + 401 被动续签 + 失败分类」收敛成一处，relay 与私信通道都调它，
 * 避免两套定时器 / 两套 401 处理互相漂移（历史教训：relay 的 401 不联动全局登录态）。
 *
 * 【安全边界】
 * - token 与续签能力一律留在主进程：本模块不向渲染层广播 token 本体，只广播「状态快照」
 *   （state / expiresAt / remainingMs / 错误文案），渲染层与插件都拿不到凭证。
 * - 插件零接入：本模块不注册任何 plugin:invoke 能力，插件物理上不可达（见 window-manager 的 preload 隔离）。
 *
 * 【与既有计时的关系（避免多套重复计时）】
 * - app-updater 的 setInterval（版本检查，10 分钟）：与本模块无关，不合并（不同关注点、不同失败面）。
 * - remote-relay / member-channel 各自的「断线重连指数退避」：那是「连接层」计时器，
 *   本模块是「凭证层」计时器；两者只在 401 处交汇（本模块决定「值得重连」还是「该登出了」）。
 * - 本模块的定时器只在「已登录」时运行，退出登录 / 应用退出时清理。
 */
import { BrowserWindow } from 'electron'
import { safeSend } from './safe-send'
import { getRuntime } from './runtime'
// 【i18n 期5B】凭证状态文案会显示到私信面板顶部条与设置页「连接」分区，必须跟随界面语言。
// 语言只认 main/locale-store.ts 的 getMainLocale()（全仓唯一真相源），取词一律 tIn(getMainLocale(), …)
// —— **不在模块加载期求值**（历轮 9 次同一个坑），每次调用现取，所以切语言后下一次广播就是新语言。
import { getMainLocale } from './locale-store'
import { tIn } from '../shared/i18n'
import { patchUiState } from './ui-store'

/**
 * 续签接口基址（定稿契约：POST https://aisocket.bjctykj.com/api/bridge/refresh_token，无 body，
 * 鉴权头 Authorization: Bearer <会员JWT>）。与 bridge ws 同域，故默认从 ws 地址推导。
 * ⚠️ 生产需 nginx 暴露该路径才可达（网关侧已确认「未暴露前返回 404」），故可用环境变量覆盖便于联调。
 */
const BRIDGE_API_BASE = (process.env.SHANHAI_BRIDGE_API_BASE?.trim() || 'https://aisocket.bjctykj.com').replace(/\/+$/, '')
const REFRESH_PATH = '/api/bridge/refresh_token'
/** refresh 请求超时（避免挂起占住定时器） */
const REFRESH_TIMEOUT_MS = 10_000

/**
 * 主动续签阈值：剩余时间 < min(20% × TTL, 72 小时)，且不低于 5 分钟下限。
 * 为什么不用现成的「到期前 5 分钟」：笔记本经常整几天不合盖运行、也可能在到期前 5 分钟根本没开机，
 * 5 分钟窗口极易被错过（错过后只能等 401 兜底）；按剩余比例（30 天 TTL → 提前约 72 小时）能覆盖
 * 「开机跑一会儿就顺手续上」的常态。同时保留 5 分钟下限，防止 TTL 极短时算出 0 阈值。
 */
const RENEW_AHEAD_RATIO = 0.2
const RENEW_AHEAD_MIN_MS = 5 * 60_000
const RENEW_AHEAD_MAX_MS = 72 * 3600_000
/** 凭证检查定时器：每 10 分钟看一次「是否进入续签窗口」（远小于任何合理 TTL，不会漏窗） */
const CREDENTIAL_TICK_MS = 10 * 60_000
/** 续签失败退避：基础 1 分钟，指数翻倍，上限 6 小时（网络/网关故障期间不刷屏、不打爆网关） */
const REFRESH_RETRY_BASE_MS = 60_000
const REFRESH_RETRY_MAX_MS = 6 * 3600_000
/** 日志节流：连续失败时，只在第 1 次、之后每 10 次、或错误码变化时打印一条（避免 6 小时里刷屏） */
const REFRESH_LOG_EVERY = 10
/** 同一份新 token 拿到后，多长时间内再遇 401 不再白试 refresh（防 refresh 成功但网关仍拒的死循环） */
const POST_REFRESH_REJECT_COOLDOWN_MS = 60_000

/** 凭证三态（第 5 项「已登录判定升级」的核心） */
export type CredentialState =
  /** 未登录：本地无会员 JWT */
  | 'anonymous'
  /** 已登录且凭证有效（未进入续签窗口） */
  | 'valid'
  /** 已登录、凭证有效但已接近过期（定时器会主动续签） */
  | 'renewing'
  /** 已登录但凭证已过期：仍在 refresh 宽限期内，可免密续期（界面须如实提示，不得显示「已登录」而不说明） */
  | 'expired'
  /** 已登录但过期时间未知（老 config 无 expires_at 且 JWT 解不出）：保持现判定（视为可用），并在界面标注「有效期未知」 */
  | 'unknown'

/** 凭证状态快照（可安全下发渲染层：不含 token 本体） */
export interface CredentialSnapshot {
  state: CredentialState
  username: string | null
  /** 绝对过期时间（毫秒）；null = 未知 */
  expiresAt: number | null
  /** TTL（秒）；null = 未知 */
  ttlSeconds: number | null
  /** 距过期剩余毫秒；已过期为负数；未知为 null */
  remainingMs: number | null
  /** 过期时间来源：config=网关下发并落盘 / jwt=本地解码 JWT exp / none=未知（用于界面如实标注） */
  expiresAtSource: 'config' | 'jwt' | 'none'
  /** 续签定时器是否在跑 */
  renewalActive: boolean
  /** 最近一次成功续签时间（毫秒），null = 本次运行内没成功过 */
  lastRotatedAt: number | null
  /** 最近一次续签失败的错误码（token_expired / token_invalid / network / http_5xx …），null = 无失败 */
  lastErrorCode: string | null
  /** 最近一次失败的中文文案 */
  lastError: string | null
  /** 连续失败次数（成功后清零），供界面/日志判断「重试中」 */
  failureCount: number
  updatedAt: number
}

/** 续签结果分类：调用方据此决定「重连 / 登出 / 只重试」 */
export type RefreshOutcome =
  /** 已拿到新 token 并落盘，使用方应带新 token 重连 */
  | 'rotated'
  /** 凭证不可恢复（token_expired 超宽限 / token_invalid / token_missing）→ 必须重新登录 */
  | 'invalid'
  /** 暂时性失败（网络/超时/5xx/404/网关未部署）→ 保留登录态，稍后重试，不得误登出 */
  | 'transient'
  /** 本地没有 token（未登录）：什么都不做 */
  | 'no_token'

/** 401 来源标识（日志与审计用） */
export interface AuthRejectHint {
  /** 触发方：远程控制通道 / 私信通道 / 会员 HTTP */
  source: 'relay' | 'member-channel' | 'member-http'
  /** HTTP 状态码（握手 401 / 接口 401、403） */
  status?: number
  /** 网关结构化错误码：token_expired / token_missing / token_invalid（未升级的网关可能没有） */
  code?: string | null
  /** 原始错误文本（排查用，不外发） */
  message?: string
}

// ————————————————————————————— 内部状态 —————————————————————————————

let tickTimer: NodeJS.Timeout | null = null
let retryTimer: NodeJS.Timeout | null = null
let inflight: Promise<RefreshOutcome> | null = null
let failureCount = 0
let lastErrorCode: string | null = null
let lastError: string | null = null
let lastRotatedAt: number | null = null
let lastUpdatedAt = Date.now()
/** 上次成功续签的时间戳（用于「刚续签完又 401」的冷却判定） */
let lastRotationTs = 0
/** 上一次打印失败日志的错误码（错误码变化时立即打印，便于发现故障性质转变） */
let loggedCode: string | null = null

type CredentialListener = (snap: CredentialSnapshot) => void
const listeners = new Set<CredentialListener>()

/** 过期时间来源标记：config（网关下发落盘）优先于 jwt（本地解码），只为界面如实展示 */
let expiresAtSource: 'config' | 'jwt' | 'none' = 'none'

/** 解码 JWT payload 的 exp/iat（只读本地已有 token，不验签、不外发）；解不出返回 null */
function decodeJwtExpiry(token: string): { expiresAt: number | null; ttlSeconds: number | null } {
  const payload = typeof token === 'string' ? token.split('.')[1] : undefined
  if (!payload) return { expiresAt: null, ttlSeconds: null }
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
    const exp = typeof json.exp === 'number' && Number.isFinite(json.exp) ? json.exp : null
    const iat = typeof json.iat === 'number' && Number.isFinite(json.iat) ? json.iat : null
    return {
      expiresAt: exp !== null ? exp * 1000 : null,
      ttlSeconds: exp !== null && iat !== null && exp > iat ? exp - iat : null,
    }
  } catch {
    return { expiresAt: null, ttlSeconds: null }
  }
}

/**
 * 读取当前凭证有效期（带「老 config 无字段」降级）：
 * 1) runtime 落盘值（登录/续签时写入，权威）→ source='config'
 * 2) 缺失则本地解码 JWT exp → source='jwt'
 * 3) 仍拿不到 → null（未知）：state='unknown'，⚠️ 绝不因未知就判过期（否则老用户升级即被踢登出）
 */
function readExpiry(token: string): { expiresAt: number | null; ttlSeconds: number | null } {
  const runtime = getRuntime()
  let persisted: { expiresAt: number | null; ttlSeconds: number | null } = { expiresAt: null, ttlSeconds: null }
  try {
    persisted = runtime.getMemberTokenExpiry()
  } catch {
    // facade 未就绪（极端启动时序）：按未知处理，走 JWT 降级
  }
  if (typeof persisted.expiresAt === 'number' && Number.isFinite(persisted.expiresAt)) {
    expiresAtSource = 'config'
    return { expiresAt: persisted.expiresAt, ttlSeconds: typeof persisted.ttlSeconds === 'number' ? persisted.ttlSeconds : null }
  }
  const derived = decodeJwtExpiry(token)
  if (derived.expiresAt !== null) {
    expiresAtSource = 'jwt'
    return derived
  }
  expiresAtSource = 'none'
  return { expiresAt: null, ttlSeconds: null }
}

/** 当前应使用的会员 JWT（两条连接与所有会员 HTTP 调用的唯一取凭证入口） */
export function getMemberAccessToken(): string {
  try {
    return getRuntime().getMemberToken()
  } catch {
    return ''
  }
}

/** 续签提前量（毫秒）：min(20% TTL, 72h)，TTL 未知时退化为 5 分钟下限 */
function renewAheadMs(ttlSeconds: number | null): number {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return RENEW_AHEAD_MIN_MS
  const byRatio = ttlSeconds * 1000 * RENEW_AHEAD_RATIO
  return Math.min(Math.max(byRatio, RENEW_AHEAD_MIN_MS), RENEW_AHEAD_MAX_MS)
}

/** 计算当前三态（纯函数，便于单测/复刻验证） */
export function computeCredentialState(token: string, expiresAt: number | null, ttlSeconds: number | null, now = Date.now()): CredentialState {
  if (!token) return 'anonymous'
  if (expiresAt === null) return 'unknown'
  const remaining = expiresAt - now
  if (remaining <= 0) return 'expired'
  if (remaining <= renewAheadMs(ttlSeconds)) return 'renewing'
  return 'valid'
}

/** 凭证状态快照（供 IPC / 广播 / 各连接状态里嵌入，不含 token 本体） */
export function getCredentialSnapshot(): CredentialSnapshot {
  const token = getMemberAccessToken()
  const { expiresAt, ttlSeconds } = readExpiry(token)
  const now = Date.now()
  return {
    state: computeCredentialState(token, expiresAt, ttlSeconds, now),
    username: (() => {
      try {
        return getRuntime().username
      } catch {
        return null
      }
    })(),
    expiresAt,
    ttlSeconds,
    remainingMs: expiresAt === null ? null : expiresAt - now,
    expiresAtSource,
    renewalActive: tickTimer !== null,
    lastRotatedAt,
    lastErrorCode,
    lastError,
    failureCount,
    updatedAt: lastUpdatedAt,
  }
}

/** 人类可读的凭证状态文案（界面直接展示，如实区分三态） */
export function describeCredentialState(snap: CredentialSnapshot): string {
  switch (snap.state) {
    case 'anonymous':
      return tIn(getMainLocale(), 'common.cred.anonymous')
    case 'expired':
      return snap.lastErrorCode === 'token_expired'
        ? tIn(getMainLocale(), 'common.cred.expiredHard')
        : tIn(getMainLocale(), 'common.cred.expiredGrace')
    case 'renewing':
      return tIn(getMainLocale(), 'common.cred.renewing')
    case 'unknown':
      return tIn(getMainLocale(), 'common.cred.unknown')
    case 'valid':
    default: {
      if (snap.expiresAt === null) return tIn(getMainLocale(), 'common.cred.valid')
      const days = Math.floor((snap.expiresAt - Date.now()) / 86400_000)
      const hours = Math.floor(((snap.expiresAt - Date.now()) % 86400_000) / 3600_000)
      // 【量词进词典】原来在代码里拼 `${days} 天 ${hours} 小时` —— 英文没有量词，拼出来就是病句。
      // 【两个独立计数必须两条词条】一条 plural 只能按一个计数选形态：旧写法把「天」「小时」塞进
      //   同一条 {n}{h} 词条，英文态必出 "2 days 1 hours"（h=1 时 hours 不会变单数）。
      //   现拆成 dhDays + dhHours 两条各自带复数，用 cred.durJoin 连接（zh 空格 / en 逗号+空格）。
      const when = days > 0
        ? [tIn(getMainLocale(), 'common.cred.dhDays', { n: days }),
           tIn(getMainLocale(), 'common.cred.dhHours', { n: hours })].join(tIn(getMainLocale(), 'common.cred.durJoin'))
        : tIn(getMainLocale(), 'common.cred.dhHours', { n: hours })
      // 「按 JWT exp 估算」是整句变体而不是前导逗号片段：英文语序与标点不同，碎片拼会顶错位
      return snap.expiresAtSource === 'jwt'
        ? tIn(getMainLocale(), 'common.cred.validDaysJwt', { when })
        : tIn(getMainLocale(), 'common.cred.validDays', { when })
    }
  }
}

// ————————————————————————————— 广播与订阅 —————————————————————————————

function broadcastCredentialStatus(): void {
  lastUpdatedAt = Date.now()
  const snap = getCredentialSnapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    safeSend(win, 'credential:status', snap)
  }
  for (const cb of listeners) {
    try {
      cb(snap)
    } catch (err) {
      console.warn('[credential] 状态订阅回调异常:', err)
    }
  }
}

/** 订阅凭证状态变化（index.ts 用于「续签成功 → 通知两条连接带新 token 重连」的接线） */
export function onCredentialSnapshot(cb: CredentialListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// ————————————————————————————— 续签核心 —————————————————————————————

/** 把网关的 expires_at/expires_in 归一成「绝对毫秒 + TTL 秒」。兼容秒/毫秒两种量纲 */
function normalizeExpiry(data: Record<string, unknown>): { expiresAt: number | null; ttlSeconds: number | null } {
  const rawAt = data.expires_at ?? data.expiresAt
  const rawIn = data.expires_in ?? data.expiresIn
  const atNum = typeof rawAt === 'number' ? rawAt : typeof rawAt === 'string' ? Number(rawAt) : NaN
  const inNum = typeof rawIn === 'number' ? rawIn : typeof rawIn === 'string' ? Number(rawIn) : NaN
  let expiresAt: number | null = null
  if (Number.isFinite(atNum) && atNum > 0) {
    // 定稿说 unix 秒；但 >1e12 只能是毫秒，按位数判定，避免把毫秒当秒算出 4.5 万年后
    expiresAt = atNum > 1e12 ? atNum : atNum * 1000
  }
  const ttlSeconds = Number.isFinite(inNum) && inNum > 0 ? inNum : null
  if (expiresAt === null && ttlSeconds !== null) expiresAt = Date.now() + ttlSeconds * 1000
  return { expiresAt, ttlSeconds }
}

/** 从 401 响应体里取结构化错误码（网关已改 JSON；未升级时是纯文本 → 返回 null 走降级） */
function pickRejectCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const obj = body as Record<string, unknown>
  for (const k of ['code', 'error_code', 'errcode']) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  const data = obj.data
  if (data && typeof data === 'object') {
    const c = (data as Record<string, unknown>).code
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
}

/** 失败日志节流：首次 / 每 N 次 / 错误码变化才打印，避免长时间断网刷屏 */
function logRefreshFailure(code: string, message: string): void {
  if (loggedCode !== code || failureCount === 1 || failureCount % REFRESH_LOG_EVERY === 0) {
    loggedCode = code
    console.warn(`[credential] 续签失败（第 ${failureCount} 次，code=${code}）：${message}`)
  }
}

function scheduleRetry(): void {
  if (retryTimer) return
  const exp = Math.min(REFRESH_RETRY_BASE_MS * Math.pow(2, Math.max(0, failureCount - 1)), REFRESH_RETRY_MAX_MS)
  const jitter = exp * (0.85 + Math.random() * 0.3)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void refreshMemberToken('retry')
  }, Math.round(jitter))
  retryTimer.unref?.()
}

/**
 * 执行一次续签（单飞：并发调用共享同一个 in-flight Promise，不会重复打网关）。
 * 成功：runtime.applyMemberToken 更新内存 + 落盘 → 广播状态 → 返回 'rotated'（使用方带新 token 重连）。
 * 失败：按错误码分类，只有「不可恢复」才清登录态；网络/5xx/404 一律 transient 只重试。
 */
export function refreshMemberToken(trigger: string): Promise<RefreshOutcome> {
  if (inflight) return inflight
  const run = async (): Promise<RefreshOutcome> => {
    const token = getMemberAccessToken()
    if (!token) {
      // 未登录：不是错误，什么都不做（等登录后 startCredentialRenewal 自然接管）
      return 'no_token'
    }
    let res: Response
    try {
      res = await fetch(`${BRIDGE_API_BASE}${REFRESH_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // 定稿：无 body
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      })
    } catch (err) {
      const msg = err instanceof Error ? (err.name === 'TimeoutError' ? tIn(getMainLocale(), 'common.cred.refreshTimeout', { sec: REFRESH_TIMEOUT_MS / 1000 }) : err.message) : String(err)
      failureCount += 1
      lastErrorCode = 'network'
      lastError = tIn(getMainLocale(), 'common.cred.refreshReqFailed', { msg })
      logRefreshFailure(lastErrorCode, msg)
      broadcastCredentialStatus()
      scheduleRetry()
      return 'transient'
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    if (res.status === 200) {
      const obj = (body ?? {}) as Record<string, unknown>
      const data = (obj.data && typeof obj.data === 'object' ? obj.data : obj) as Record<string, unknown>
      const newToken = typeof data.token === 'string' ? data.token.trim() : ''
      if (!newToken) {
        // 200 但没给 token：视为暂时性异常（网关实现与契约不符），不误登出
        failureCount += 1
        lastErrorCode = 'bad_response'
        lastError = tIn(getMainLocale(), 'common.cred.refreshNoToken')
        logRefreshFailure(lastErrorCode, lastError)
        broadcastCredentialStatus()
        scheduleRetry()
        return 'transient'
      }
      const { expiresAt, ttlSeconds } = normalizeExpiry(data)
      try {
        await getRuntime().applyMemberToken(newToken, expiresAt, ttlSeconds)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failureCount += 1
        lastErrorCode = 'persist_failed'
        lastError = tIn(getMainLocale(), 'common.cred.persistFailed', { msg })
        logRefreshFailure(lastErrorCode, lastError)
        broadcastCredentialStatus()
        scheduleRetry()
        return 'transient'
      }
      failureCount = 0
      lastErrorCode = null
      lastError = null
      lastRotatedAt = Date.now()
      lastRotationTs = lastRotatedAt
      loggedCode = null
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      console.log(`[credential] 续签成功（触发方=${trigger}），新凭证有效期至 ${new Date(ctxExpiresAt()).toLocaleString()}；等待各连接带新 token 重连`)
      broadcastCredentialStatus()
      return 'rotated'
    }
    const code = pickRejectCode(body) ?? (res.status === 401 ? 'token_expired' : `http_${res.status}`)
    const rawMsg = (() => {
      const obj = (body ?? {}) as Record<string, unknown>
      for (const k of ['error', 'message', 'msg']) {
        const v = obj[k]
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
      return `HTTP ${res.status}`
    })()
    // 【识别条件①】网关偶尔把 Go 原文 `context deadline exceeded` 放进 body 的 message 里；
    // 这个值会经 credential 状态快照显示到界面（私信面板/设置页），不能透传英文。
    // 只改文案，**不改分类与重试逻辑**：5xx 本来就落到下面的「暂时性 + 指数退避重试」分支。
    const shownMsg = /context\s+deadline\s+exceeded|Client\.Timeout\s+exceeded|net\/http:\s+request\s+canceled/i.test(rawMsg)
      ? tIn(getMainLocale(), 'common.cred.gwTimeoutRetry', { code })
      : rawMsg
    // 分类：只有「凭证本身不可恢复」才登出
    if (code === 'token_expired' || code === 'token_invalid' || code === 'token_missing' || res.status === 403) {
      failureCount += 1
      lastErrorCode = code
      lastError = shownMsg
      logRefreshFailure(code, rawMsg)
      markCredentialInvalid(tIn(getMainLocale(), 'common.cred.invalid', { code }), code)
      return 'invalid'
    }
    // 404（网关未部署 / nginx 未暴露）/ 5xx / 其它：暂时性，保留登录态，退避重试
    failureCount += 1
    lastErrorCode = code
    lastError = shownMsg
    logRefreshFailure(code, rawMsg)
    broadcastCredentialStatus()
    scheduleRetry()
    return 'transient'
  }
  const p = run().finally(() => {
    if (inflight === p) inflight = null
  })
  inflight = p
  return p
}

/** 当前落盘/解码得到的过期时间（仅日志用） */
function ctxExpiresAt(): number {
  const snap = getCredentialSnapshot()
  return snap.expiresAt ?? Date.now()
}

/**
 * 【401 统一入口】两条连接与会员 HTTP 调用被网关拒绝时都调这里。
 * 语义（定稿）：401 → 先尝试 refresh → 成功则带新 token 重连 → 只有 refresh 也失败才落到「凭证失效，请重新登录」。
 * 错误码区分：
 *  - token_missing / token_invalid → 直接引导重登，不白试 refresh（refresh 也救不回来）
 *  - token_expired → 试 refresh（宽限期内必成；超宽限 refresh 会回 token_expired 再登出）
 *  - 拿不到结构化 code（未部署网关的纯文本 401 / ws 升级失败读不到 body）→ 降级：一律先试一次 refresh
 */
export async function handleAuthRejected(hint: AuthRejectHint): Promise<RefreshOutcome> {
  const code = (hint.code ?? '').trim()
  const snap = getCredentialSnapshot()
  // 刚续签成功不到 1 分钟又被拒：说明问题不在过期时间，别再 refresh（防 refresh↔401 死循环）
  if (lastRotationTs > 0 && Date.now() - lastRotationTs < POST_REFRESH_REJECT_COOLDOWN_MS && code !== 'token_expired') {
    markCredentialInvalid(tIn(getMainLocale(), 'common.cred.rejectedAfterRotation', { code: code || `HTTP ${hint.status ?? 401}` }), code || 'rejected_after_rotation')
    return 'invalid'
  }
  if (code === 'token_missing' || code === 'token_invalid') {
    markCredentialInvalid(tIn(getMainLocale(), 'common.cred.invalidOrMissing'), code)
    return 'invalid'
  }
  if (snap.state === 'anonymous') return 'no_token'
  console.warn(`[credential] ${hint.source} 通道被拒（401${code ? ` code=${code}` : ''}），先尝试续签再重连`)
  const outcome = await refreshMemberToken(`401:${hint.source}${code ? `:${code}` : ''}`)
  if (outcome === 'rotated') return 'rotated'
  if (outcome === 'invalid') return 'invalid'
  // transient：refresh 没成但不是凭证问题（网关挂了/未部署/断网）→ 不登出，让连接层继续按退避重连
  return 'transient'
}

/**
 * 凭证确认不可恢复时的统一收尾：翻转全局登录态（Dock/桌面壳/顶栏立刻不再显示「已登录：xxx」）
 * + 广播凭证状态 + 停掉续签定时器（等用户重新登录）。
 * 与 ui-store 的 runtime.onAuthExpired 同形态：只翻 UI 与内存态，不删本地凭证（避免用户被迫重输密码，
 * 且与现状一致；真要重登时登录框会覆盖旧凭证）。
 */
export function markCredentialInvalid(reason: string, code: string | null = null): void {
  lastErrorCode = code ?? lastErrorCode
  lastError = reason
  stopCredentialRenewal()
  try {
    patchUiState({ loggedIn: false, username: null, models: [] })
  } catch (err) {
    console.warn('[credential] 翻转全局登录态失败:', err)
  }
  broadcastCredentialStatus()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    safeSend(win, 'credential:invalid', { message: reason, code: lastErrorCode })
  }
}

/**
 * 定时器主体：每 10 分钟检查一次是否进入续签窗口；进入即续签。
 * 【补的缺口】启动时就已过期（关机超过 TTL）的场景：本函数在 startCredentialRenewal 里立即跑一次，
 * 不依赖 ws 是否连上（旧实现只在 ws open 后才启动定时器 → 握手 401 永远不触发续签）。
 */
async function tick(trigger: string): Promise<void> {
  const snap = getCredentialSnapshot()
  if (snap.state === 'anonymous') return
  if (snap.state === 'unknown') {
    // 过期时间未知：不主动续签（无依据），但保留定时器；一旦网关返回 401 会走 handleAuthRejected 兜底
    return
  }
  if (snap.state === 'valid') return
  await refreshMemberToken(trigger)
}

/** 启动凭证续签（登录后调用；幂等）。启动即刻检查一次，覆盖「开机时凭证已过期」 */
export function startCredentialRenewal(): void {
  if (tickTimer) return
  failureCount = 0
  lastErrorCode = null
  lastError = null
  tickTimer = setInterval(() => {
    void tick('timer')
  }, CREDENTIAL_TICK_MS)
  tickTimer.unref?.()
  broadcastCredentialStatus()
  // 启动即检查：已过期/进入窗口就马上续签（不等 ws 连上，否则 401 死锁）
  void tick('startup')
}

/** 停止凭证续签（退出登录 / 应用退出时调用）：清理定时器，杜绝「登出后还在打网关续签」 */
export function stopCredentialRenewal(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  inflight = null
  failureCount = 0
  lastErrorCode = null
  lastError = null
  lastRotatedAt = null
  lastRotationTs = 0
  loggedCode = null
  broadcastCredentialStatus()
}

/**
 * 供连接层在「握手失败」时读取 401 的结构化错误码（定稿：网关已把 ws 401 改成 JSON body）。
 * Node ws 客户端在升级响应非 101 时触发 'unexpected-response'，此时 res 是 IncomingMessage，可读 body；
 * 但读完必须自己 abort 请求（否则 ws 内部状态停在 CONNECTING）。
 */
export function readRejectBody(res: unknown): Promise<{ status: number; code: string | null; message: string }> {
  return new Promise((resolve) => {
    const r = res as { statusCode?: number; on?: (ev: string, cb: (chunk: unknown) => void) => void; resume?: () => void }
    const status = typeof r?.statusCode === 'number' ? r.statusCode : 0
    let text = ''
    if (!r || typeof r.on !== 'function') {
      resolve({ status, code: null, message: '' })
      return
    }
    const done = (): void => {
      let code: string | null = null
      try {
        code = pickRejectCode(JSON.parse(text) as unknown)
      } catch {
        code = null
      }
      resolve({ status, code, message: text.slice(0, 200) })
    }
    r.on('data', (chunk) => {
      if (text.length < 4096) text += String(chunk)
    })
    r.on('end', done)
    r.on('error', done)
    // 兜底：1 秒内没读完就按「读不到 body」降级（调用方会走「401 一律先试 refresh」路径）
    const t = setTimeout(done, 1000)
    t.unref?.()
    try {
      r.resume?.()
    } catch {
      // 忽略：某些实现下 resume 不可用
    }
  })
}

/** 已知的网关错误码集合（供连接层判断 body 里的 code 是否可信） */
export const GATEWAY_AUTH_CODES = new Set(['token_missing', 'token_expired', 'token_invalid'])
