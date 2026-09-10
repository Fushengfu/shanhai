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

/**
 * 【任务197 S2-1】待发 cmd_result 队列上限（每条连接一份）。
 * 取值理由：单条 cmd_result 是一小段 JSON（结构：id/ok/data|error），手机端同一时刻在途的命令通常只有个位数
 * （UI 多为串行调用：list_sessions / get_history / get_pending_requests…），50 条给足冗余，
 * 同时把最坏内存占用限制在「50 × 单条最大 payload（历史快照量级）」以内，不会无限堆积。
 */
const PENDING_RESULT_LIMIT = 50

/**
 * 【任务197 S2-1】补发有效期：超过手机端等待窗口（60s）的结果再补发已无意义
 * （手机端此时必已 remove 并报「命令超时」），且可能落到**另一台**同账号设备的同号命令上（id 冲突）。
 * 因此只在有效期内的结果才补发，过期的丢弃并 warn（丢弃事实必须可审计）。
 * ★注意：本值不改变手机端 60s 超时（那属 S3），只是「补发的有效期」。
 */
const PENDING_RESULT_TTL_MS = 60 * 1000

/**
 * 【任务197 S2-1】每条连接各有一个「待发 cmd_result」队列。
 * 改前：连接非 OPEN 时 `send()` 直接什么都不做 ⇒ cmd_result 静默蒸发 ⇒ 手机端白等满 60s 报「命令超时」。
 * 改后：非 OPEN 时记 warn 并入队，连接回到 OPEN 时按 id 补发。
 * 用 `Map<id, 序列化串>` 天然按 cmd id 去重（同 id 只保留一份），并保持插入顺序（Map 迭代序 = 插入序）。
 */
const pendingResults = new Map<WebSocket, Map<number, { payload: string; at: number }>>()

/** 入队一条待发 cmd_result（同 id 覆盖 = 去重；溢出丢弃最旧一条并 warn） */
function queuePendingResult(sock: WebSocket, id: number, payload: string): void {
  let q = pendingResults.get(sock)
  if (!q) {
    q = new Map()
    pendingResults.set(sock, q)
  }
  if (q.has(id)) {
    // 同 id 重复回包：覆盖内容即幂等，不新增条目（手机端收到即 remove，重复回包本就无效）
    q.set(id, { payload, at: Date.now() })
    return
  }
  if (q.size >= PENDING_RESULT_LIMIT) {
    const oldest = q.keys().next().value as number | undefined
    if (oldest !== undefined) q.delete(oldest)
    console.warn(
      `[remote] 待发结果队列已满(${PENDING_RESULT_LIMIT})，丢弃最旧一条 id=${oldest}；本条 id=${id} 已入队`,
    )
  }
  q.set(id, { payload, at: Date.now() })
}

/** 连接可用时按 id（插入顺序）补发积压结果；过期的丢弃并 warn */
function flushPendingResults(sock: WebSocket): void {
  const q = pendingResults.get(sock)
  if (!q || q.size === 0) return
  if (sock.readyState !== WebSocket.OPEN) return
  const now = Date.now()
  const items = [...q.entries()]
  q.clear()
  let sent = 0
  let expired = 0
  for (const [id, item] of items) {
    if (now - item.at > PENDING_RESULT_TTL_MS) {
      expired += 1
      console.warn(`[remote] 待发结果 id=${id} 已过期(>${PENDING_RESULT_TTL_MS}ms)，丢弃不补发`)
      continue
    }
    try {
      sock.send(item.payload)
      sent += 1
    } catch (err) {
      console.error(`[remote] 补发结果 id=${id} 失败:`, err instanceof Error ? err.message : err)
    }
  }
  if (sent > 0) console.log(`[remote] 连接恢复，已补发 ${sent} 条待发 cmd_result`)
  if (expired > 0) console.log(`[remote] 本次补发共丢弃 ${expired} 条过期结果（见上 warn）`)
}

/** 丢弃某连接的全部待发结果（连接彻底关闭/服务停止时调用，避免内存滞留） */
function dropPendingResults(sock: WebSocket, reason: string): void {
  const q = pendingResults.get(sock)
  if (!q || q.size === 0) {
    pendingResults.delete(sock)
    return
  }
  console.warn(`[remote] ${reason}，丢弃 ${q.size} 条未能补发的 cmd_result`)
  pendingResults.delete(sock)
}

function send(sock: WebSocket, obj: unknown): void {
  if (sock.readyState === WebSocket.OPEN) {
    // 连接可用：先把此前积压的待发结果按 id 顺序补发，再发本条
    flushPendingResults(sock)
    sock.send(JSON.stringify(obj))
    return
  }
  // 非 OPEN：不再静默丢弃 —— 记 warn + 入队（仅 cmd_result 可补发，其余消息只告警不出队）
  const rec = obj as { type?: string; id?: number }
  if (rec && rec.type === 'cmd_result' && typeof rec.id === 'number') {
    queuePendingResult(sock, rec.id, JSON.stringify(obj))
    const size = pendingResults.get(sock)?.size ?? 0
    console.warn(
      `[remote] 连接不可用(readyState=${sock.readyState})，cmd_result id=${rec.id} 未能发送，已入待发队列(size=${size})`,
    )
    return
  }
  console.warn(`[remote] 连接不可用(readyState=${sock.readyState})，消息 type=${rec?.type ?? '?'} 未能发送(不入队)`)
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
      // 【任务197 S2-1】连接彻底关闭：该连接不可能再回到 OPEN，待发结果无法补发，丢弃并 warn（不静默滞留）
      dropPendingResults(sock, '连接已关闭')
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
  // 【任务197 S2-1】服务停止：所有连接的待发结果都无法再送达，清空并 warn（避免内存滞留 + 丢弃可审计）
  for (const [sock] of pendingResults) dropPendingResults(sock, '远程服务已停止')
  pendingResults.clear()
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
