import { WebSocketServer, WebSocket } from 'ws'
import { networkInterfaces } from 'node:os'
import { randomBytes, randomInt } from 'node:crypto'
import { getRuntime } from './runtime'
import { handleCommand, subscribeRuntimeEvents } from './remote-protocol'

/**
 * 局域网远程服务（手机端跨端连接的桥梁，方式一：局域网直连）。
 *
 * 桌面端主进程起一个 WebSocket 服务（默认 47800，监听 0.0.0.0），手机端 App 连同一 WiFi，
 * 输入配对码配对后，即可远程查看/控制桌面端的会话。命令路由 / 事件转发逻辑在 remote-protocol.ts 复用。
 *
 * 方式二（网关中继，外网可达）见 remote-relay.ts。
 *
 * 生命周期与登录态绑定：登录后自动开启（startRemoteServer），退出登录自动关闭（stopRemoteServer）。
 * 数据同步（runtime 事件转发）延迟到有手机配对成功后才建立，无配对客户端时停止订阅。
 */

const DEFAULT_PORT = 47800
/** 配对码有效期（5 分钟，过期需在桌面端刷新） */
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000

export interface RemoteStatus {
  enabled: boolean
  port: number
  ip: string
  pairingCode: string
  pairingExpiresAt: number
  pairedClients: number
}

interface IncomingPair {
  type: 'pair'
  code: string
}

let wss: WebSocketServer | null = null
let pairingCode = ''
let pairingExpiresAt = 0
/** 已配对（通过配对码校验）的连接，只有它们能发命令、收事件 */
const authedClients = new Set<WebSocket>()
/** 事件转发回调的取消函数，stop 时统一清理，避免重复订阅/内存泄漏 */
let unsubs: Array<() => void> = []

/** 获取本机局域网 IPv4（非 internal 的第一个，拿不到回退 127.0.0.1） */
function getLanIp(): string {
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return '127.0.0.1'
}

function send(sock: WebSocket, obj: unknown): void {
  if (sock.readyState === WebSocket.OPEN) {
    sock.send(JSON.stringify(obj))
  }
}

/** 广播事件给所有已配对连接 */
function broadcastEvent(event: string, payload: unknown): void {
  if (!wss) return
  const msg = JSON.stringify({ type: 'event', event, payload })
  for (const client of authedClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg)
  }
}

/** 建立 runtime 事件订阅（数据同步）：仅在有手机配对成功后才建立，避免无客户端时的无谓订阅 */
function ensureSyncSubscribed(): void {
  if (unsubs.length > 0) return
  unsubs = subscribeRuntimeEvents(getRuntime(), broadcastEvent)
}

/** 取消 runtime 事件订阅（数据同步） */
function unsubscribeSync(): void {
  unsubs.forEach((u) => u())
  unsubs = []
}

function handlePair(sock: WebSocket, code: string): void {
  if (!pairingCode || Date.now() > pairingExpiresAt) {
    send(sock, { type: 'error', message: '配对码已过期，请在桌面端重新开启远程连接' })
    return
  }
  if (code !== pairingCode) {
    send(sock, { type: 'error', message: '配对码错误' })
    return
  }
  const wasEmpty = authedClients.size === 0
  authedClients.add(sock)
  if (wasEmpty) ensureSyncSubscribed() // 第一台手机配对成功 → 开始同步数据
  // 配对成功后发一个短期 token，供后续（可选）断线重连校验；当前以「连接已配对」为准
  const token = randomBytes(24).toString('hex')
  send(sock, { type: 'paired', token })
}

/** 开启远程服务：起 WS 服务 + 生成配对码。幂等（已开启则直接返回状态）。数据同步延迟到有手机配对成功。 */
export function startRemoteServer(port: number = DEFAULT_PORT): RemoteStatus {
  if (wss) return getRemoteStatus()

  wss = new WebSocketServer({ host: '0.0.0.0', port })
  pairingCode = String(randomInt(0, 1000000)).padStart(6, '0')
  pairingExpiresAt = Date.now() + PAIRING_CODE_TTL_MS

  wss.on('connection', (sock) => {
    sock.on('message', (raw) => {
      let msg: IncomingPair | { type: 'cmd'; id: number; cmd: string; payload: Record<string, unknown> }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        send(sock, { type: 'error', message: '无效的 JSON 消息' })
        return
      }
      if (msg.type === 'pair') {
        handlePair(sock, (msg as IncomingPair).code)
      } else if (msg.type === 'cmd') {
        if (!authedClients.has(sock)) {
          send(sock, { type: 'error', message: '未配对，请先发送 pair' })
          return
        }
        void handleCommand((obj) => send(sock, obj), msg)
      } else {
        send(sock, { type: 'error', message: '未知消息类型' })
      }
    })
    sock.on('close', () => {
      authedClients.delete(sock)
      if (authedClients.size === 0) unsubscribeSync() // 最后一台手机断开 → 停止同步
    })
  })

  wss.on('error', (err) => {
    console.error('[remote] WebSocket 服务错误:', err instanceof Error ? err.message : err)
    // 端口占用等启动失败：清空状态，允许用户换端口重试
    wss?.close()
    wss = null
    pairingCode = ''
    pairingExpiresAt = 0
    unsubscribeSync()
  })

  return getRemoteStatus()
}

/** 刷新配对码（默认常开后，5 分钟过期的配对码需要能刷新，供设置面板触发） */
export function refreshPairingCode(): RemoteStatus {
  if (wss) {
    pairingCode = String(randomInt(0, 1000000)).padStart(6, '0')
    pairingExpiresAt = Date.now() + PAIRING_CODE_TTL_MS
  }
  return getRemoteStatus()
}

/** 关闭远程服务：清理事件订阅 + 断开所有连接。幂等。 */
export function stopRemoteServer(): void {
  unsubscribeSync()
  authedClients.clear()
  if (wss) {
    wss.close()
    wss = null
  }
  pairingCode = ''
  pairingExpiresAt = 0
}

/** 查询当前远程服务状态（供设置面板展示 IP/端口/配对码/连接数） */
export function getRemoteStatus(): RemoteStatus {
  return {
    enabled: wss !== null,
    port: DEFAULT_PORT,
    ip: getLanIp(),
    pairingCode,
    pairingExpiresAt,
    pairedClients: authedClients.size,
  }
}
