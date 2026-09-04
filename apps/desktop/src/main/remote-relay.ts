import { WebSocket } from 'ws'
import { BrowserWindow } from 'electron'
import { safeSend } from './safe-send'
import { getRuntime } from './runtime'
import { handleCommand, subscribeRuntimeEvents } from './remote-protocol'
import {
  getMemberAccessToken,
  handleAuthRejected,
  readRejectBody,
  getCredentialSnapshot,
  describeCredentialState,
} from './member-credentials'

/**
 * 远程连接（方式二：网关中继，外网可达）。
 *
 * 桌面端登录后作为「Host」连网关 bridge（wss://…/ws?role=host&token=JWT），
 * 手机端用同一会员账号登录后作为「Client」连同一网关，网关按 memberID 自动配对，
 * 双向透明转发消息。命令路由 / 事件转发逻辑复用 remote-protocol.ts。
 *
 * 网关 bridge 的协议：Host 发的消息原样转发给所有 Client；Client 发的消息原样转发给 Host；
 * 网关自身会下发控制消息（connected / host_disconnected / client_connected / client_disconnected 等，字段名为 Type）。
 *
 * 生命周期与登录态绑定：登录后自动开启（startRemoteRelay），退出登录自动关闭（stopRemoteRelay），
 * 不再依赖手动开关。数据同步（runtime 事件转发）延迟到有手机连上后才建立，避免无手机时无谓订阅。
 */

const DEFAULT_RELAY_URL = 'wss://aisocket.bjctykj.com/ws'
/** Host 断线后自动重连间隔（基础值，实际按指数退避） */
const RECONNECT_DELAY_MS = 5000
/** 心跳间隔：空闲期发 ping 保活，避免 NAT 静默断开 */
const PING_INTERVAL_MS = 30000

export interface RelayStatus {
  enabled: boolean
  connected: boolean
  url: string
  username: string | null
  clientCount: number
  /** 最近一次连接错误文案（401 未授权 / 其它连接失败），null 表示无错误 */
  error: string | null
  /** 是否因登录凭证失效（401）被网关拒绝，此时不再重连，需用户重新登录 */
  authFailed: boolean
}

let relayUrl = DEFAULT_RELAY_URL
let enabled = false
let connected = false
let clientCount = 0
let hostWs: WebSocket | null = null
let unsubs: Array<() => void> = []
let reconnectTimer: NodeJS.Timeout | null = null
let pingTimer: NodeJS.Timeout | null = null
let reconnectAttempts = 0
/** 最近一次连接错误文案（含 401 认证失效），null 表示无错误 */
let relayError: string | null = null
/** 是否因登录凭证失效（401）被网关拒绝：true 时不再自动重连，避免反复 401 刷屏 */
let authFailed = false
/**
 * 是否正在「401 → 续签 → 重连」的恢复流程中：期间抑制 close 触发的自动重连，
 * 避免续签还没完成就用旧 token 再握手一次（旧 token 必然再 401，形成退避期内的空转）。
 */
let pendingAuthRecovery = false

function sendToRelay(obj: unknown): void {
  if (hostWs && hostWs.readyState === WebSocket.OPEN) {
    hostWs.send(JSON.stringify(obj))
  }
}

/** 事件转发：发给网关（网关再转发给已配对的 Client） */
function broadcastEvent(event: string, payload: unknown): void {
  sendToRelay({ type: 'event', event, payload })
}

/** 建立 runtime 事件订阅（数据同步）：仅在有手机连上后调用，避免无客户端时的无谓订阅 */
function ensureSyncSubscribed(): void {
  if (unsubs.length > 0) return
  unsubs = subscribeRuntimeEvents(getRuntime(), broadcastEvent)
}

/** 取消 runtime 事件订阅（数据同步） */
function unsubscribeSync(): void {
  unsubs.forEach((u) => u())
  unsubs = []
}

/** 把当前 relay 状态（含连接错误）推送给所有渲染进程窗口，让 UI 能实时感知网关连接失败 */
function broadcastRelayStatus(): void {
  const status = getRelayStatus()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    safeSend(win, 'relay:status', status)
  }
}

function connect(): void {
  // 凭证统一从 member-credentials 取（续签后的新 token 会自动生效，不需要本模块感知）
  const token = getMemberAccessToken()
  if (!token) {
    // 未登录：无法鉴权，等待用户登录后重新开启
    connected = false
    return
  }

  // 多设备：带上设备标识，网关按 memberID + deviceId 双维索引，同账号多台电脑互不顶替
  const info = getRuntime().getDeviceInfo()
  const params = new URLSearchParams({
    role: 'host',
    token,
    deviceId: info.deviceId ?? '',
    deviceName: info.deviceName ?? '',
    hostname: info.hostname ?? '',
    os: info.os ?? '',
  })
  const ws = new WebSocket(`${relayUrl}?${params.toString()}`)
  hostWs = ws

  ws.on('open', () => {
    connected = true
    reconnectAttempts = 0 // 连接成功，重置退避计数
    clientCount = 0 // 重连后重置客户端计数，等网关重新下发 client_connected 再同步
    relayError = null // 连接成功，清除上次错误
    authFailed = false
    pendingAuthRecovery = false
    startPing() // 心跳保活
    unsubscribeSync() // 数据同步延迟到手机连上后再建立
    broadcastRelayStatus()
  })

  ws.on('message', (raw) => {
    let msg: { type?: string; cmd?: string; id?: number; payload?: Record<string, unknown> }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.type === 'cmd') {
      // 手机端发来的命令（经网关原样转发），路由到 runtime
      void handleCommand(sendToRelay, { type: 'cmd', id: msg.id ?? 0, cmd: msg.cmd ?? '', payload: msg.payload ?? {} })
    } else if (msg.type === 'client_connected') {
      clientCount += 1
      ensureSyncSubscribed() // 第一台手机连上 → 开始同步数据
    } else if (msg.type === 'client_disconnected') {
      clientCount = Math.max(0, clientCount - 1)
      if (clientCount === 0) unsubscribeSync() // 最后一台手机断开 → 停止同步
    }
    // 网关控制消息（connected / host_disconnected / error 等）忽略
  })

  /**
   * 【握手被 HTTP 拒绝（含 401）】网关已把 ws 401 从纯文本改成 JSON body {code: token_missing|token_expired|token_invalid}。
   * Node ws 客户端在升级响应非 101 时触发 'unexpected-response'，此时可以读到 body（err.message 只有
   * 「Unexpected server response: 401」，不含 code，所以必须走这条路径才能区分「可续签的过期」与「无效凭证」）。
   * 注意：注册了本监听后 ws 不再自行 abort 握手，必须自己 abort（否则连接卡在 CONNECTING）。
   */
  ws.on('unexpected-response', (req, res) => {
    void readRejectBody(res).then(({ status, code }) => {
      try {
        req.abort()
      } catch {
        // 忽略：连接已由 ws 内部清理
      }
      void onRejected(status, code)
    })
  })

  ws.on('close', () => {
    connected = false
    hostWs = null
    stopPing()
    unsubscribeSync()
    if (enabled) scheduleReconnect()
  })

  ws.on('error', (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[relay] 网关连接错误:', msg)
    // 走到这里的常见情形：网络错误、或握手被拒后 abort 触发的 aborted。
    // 401 的权威判定在 unexpected-response（能读到 JSON body 的 code）；这里只做兜底分类。
    const is401 = /401|unauthorized/i.test(msg)
    if (is401) {
      void onRejected(401, null)
      return
    }
    if (!pendingAuthRecovery) {
      relayError = `网关连接失败：${msg}`
      broadcastRelayStatus()
    }
  })
}

/**
 * 【401 处理状态机（改造前：401 → 直接 authFailed 停止重连 → 关机过夜必死）】
 * 现在：401 → 置 pendingAuthRecovery 抑制本次自动重连 → 交给 member-credentials 先试 refresh
 *   - rotated  → 带新 token 立即重连（重置退避计数）
 *   - invalid  → authFailed=true，如实提示「凭证失效，请重新登录」（member-credentials 已联动全局登录态）
 *   - transient（网关未部署 / 断网 / 5xx）→ 不登出，按原有指数退避继续重连
 */
async function onRejected(status: number, code: string | null): Promise<void> {
  if (pendingAuthRecovery) return
  pendingAuthRecovery = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const snap = getCredentialSnapshot()
  relayError = `网关拒绝连接（HTTP ${status || 401}${code ? ` ${code}` : ''}），正在尝试自动续签凭证；当前凭证状态：${describeCredentialState(snap)}`
  broadcastRelayStatus()
  const outcome = await handleAuthRejected({ source: 'relay', status, code })
  pendingAuthRecovery = false
  if (outcome === 'rotated') {
    console.log('[relay] 凭证续签成功，带新 token 立即重连')
    authFailed = false
    relayError = null
    reconnectAttempts = 0
    if (enabled) connect()
    return
  }
  if (outcome === 'invalid') {
    authFailed = true
    relayError = '登录凭证已失效且无法自动续签（超出宽限期或凭证无效），请重新登录后再使用外网远程'
    broadcastRelayStatus()
    return
  }
  // transient / no_token：保留登录态，继续按退避重连（不误登出）
  relayError = `凭证自动续签未完成（网络或网关异常），稍后随重连继续尝试；${describeCredentialState(getCredentialSnapshot())}`
  if (enabled) scheduleReconnect()
  broadcastRelayStatus()
}

/**
 * 凭证轮换后的重连入口（index.ts 订阅 credential 状态变化时调用）：
 * 主动续签成功时连接可能仍是「用旧 token 建立的、还活着」或「正在退避等待」，
 * 这里取消排队、立即用新 token 重连，避免等到下一次退避才生效。
 */
export function reconnectWithFreshCredential(): RelayStatus {
  if (!enabled) return getRelayStatus()
  if (pendingAuthRecovery) return getRelayStatus()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  authFailed = false
  const old = hostWs
  hostWs = null
  connected = false
  if (old) {
    try {
      old.close()
    } catch {
      // 忽略关闭旧连接的异常
    }
  }
  connect()
  return getRelayStatus()
}

/** 启动心跳：定时发 WebSocket 协议层 ping 帧保活（网关协议栈自动回 pong，不进入应用层消息解析，因此不会被误转发、不会触发 host_offline 报错） */
function startPing(): void {
  stopPing()
  pingTimer = setInterval(() => {
    if (hostWs && hostWs.readyState === WebSocket.OPEN) {
      hostWs.ping()
    }
  }, PING_INTERVAL_MS)
}

function stopPing(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

function scheduleReconnect(): void {
  if (authFailed) return // 登录凭证失效（401）：不再自动重连，避免反复 401 刷屏
  if (reconnectTimer) return
  // 指数退避 + 随机抖动：多台电脑同时断线时不惊群重连，避免反复触发网关踢 Client
  const exp = Math.min(RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts), 60000)
  const jitter = exp * (0.8 + Math.random() * 0.4) // ±20%
  reconnectAttempts += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, Math.round(jitter))
}

/** 开启网关中继：拿会员 token 作为 Host 连网关。未登录时返回错误信息。幂等。 */
export function startRemoteRelay(url: string = DEFAULT_RELAY_URL): RelayStatus {
  if (url) relayUrl = url
  if (enabled && hostWs) return getRelayStatus()

  enabled = true
  if (!getRuntime().getMemberToken()) {
    // 未登录：保持 enabled 但连接不建立，登录后需重新 start
    connected = false
    return getRelayStatus()
  }
  // 主动（重新）开启：清除上一次的 401 失效标记，允许重新建立连接
  authFailed = false
  relayError = null
  connect()
  return getRelayStatus()
}

/** 关闭网关中继：断开 Host 连接并停止重连。幂等。 */
export function stopRemoteRelay(): void {
  enabled = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopPing()
  reconnectAttempts = 0
  unsubscribeSync()
  if (hostWs) {
    hostWs.close()
    hostWs = null
  }
  connected = false
  clientCount = 0
  relayError = null
  authFailed = false
}

/** 查询网关中继状态（供设置面板展示连接状态） */
export function getRelayStatus(): RelayStatus {
  return {
    enabled,
    connected,
    url: relayUrl,
    username: getRuntime().username,
    clientCount,
    error: relayError,
    authFailed,
  }
}
