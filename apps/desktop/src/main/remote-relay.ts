import { WebSocket } from 'ws'
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
    startPing() // 心跳保活
    // 订阅事件转发（重连时先清理旧订阅）
    unsubs.forEach((u) => u())
    unsubs = subscribeRuntimeEvents(runtime, broadcastEvent)
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
    } else if (msg.type === 'client_disconnected') {
      clientCount = Math.max(0, clientCount - 1)
    }
    // 网关控制消息（connected / host_disconnected / error 等）忽略
  })

  ws.on('close', () => {
    connected = false
    hostWs = null
    stopPing()
    unsubs.forEach((u) => u())
    unsubs = []
    if (enabled) scheduleReconnect()
  })

  ws.on('error', (err) => {
    console.error('[relay] 网关连接错误:', err instanceof Error ? err.message : err)
    // close 随后触发，统一在 close 里重连
  })
}

/** 启动心跳：定时发 ping 保活（发一条网关会透传、对端会忽略的轻量消息，让 TCP 保持数据流动） */
function startPing(): void {
  stopPing()
  pingTimer = setInterval(() => {
    if (hostWs && hostWs.readyState === WebSocket.OPEN) {
      sendToRelay({ type: 'ping' })
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
  persistRelayPreference(true)
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
  persistRelayPreference(false)
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopPing()
  reconnectAttempts = 0
  unsubs.forEach((u) => u())
  unsubs = []
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

/** 中继偏好持久化文件路径（userData/relay.json，参考壁纸 wallpaper.json 的做法，独立于 runtime config） */
function relayPreferencePath(): string {
  return join(app.getPath('userData'), 'relay.json')
}

/** 读取上次是否开启过网关中继；无文件/损坏返回 false（默认关闭，与现状一致） */
export function getRelayPreference(): boolean {
  try {
    const raw = readFileSync(relayPreferencePath(), 'utf8')
    const parsed = JSON.parse(raw) as { enabled?: unknown }
    return parsed.enabled === true
  } catch {
    return false
  }
}

/** 持久化中继开关偏好；失败只告警，不中断主流程 */
function persistRelayPreference(enabled: boolean): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(relayPreferencePath(), JSON.stringify({ enabled }), 'utf8')
  } catch (err) {
    console.warn('[山海] 保存中继开关偏好失败：', err)
  }
}
