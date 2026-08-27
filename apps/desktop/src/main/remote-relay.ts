import { WebSocket } from 'ws'
import { getRuntime } from './runtime'
import { handleCommand, subscribeRuntimeEvents } from './remote-protocol'

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

function connect(): void {
  const runtime = getRuntime()
  const token = runtime.getMemberToken()
  if (!token) {
    // 未登录：无法鉴权，等待用户登录后重新开启
    connected = false
    return
  }

  // 多设备：带上设备标识，网关按 memberID + deviceId 双维索引，同账号多台电脑互不顶替
  const info = runtime.getDeviceInfo()
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
    startPing() // 心跳保活
    unsubscribeSync() // 数据同步延迟到手机连上后再建立
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

  ws.on('close', () => {
    connected = false
    hostWs = null
    stopPing()
    unsubscribeSync()
    if (enabled) scheduleReconnect()
  })

  ws.on('error', (err) => {
    console.error('[relay] 网关连接错误:', err instanceof Error ? err.message : err)
    // close 随后触发，统一在 close 里重连
  })
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
}

/** 查询网关中继状态（供设置面板展示连接状态） */
export function getRelayStatus(): RelayStatus {
  return {
    enabled,
    connected,
    url: relayUrl,
    username: getRuntime().username,
    clientCount,
  }
}
