import { WebSocket } from 'ws'
import { BrowserWindow } from 'electron'
import { safeSend } from './safe-send'
import { getMainLocale } from './locale-store'
import { tIn } from '../shared/i18n'
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

/**
 * 【任务197 S2-2】待发 cmd_result 队列上限（relay 全局一份）。
 * 取值理由同 remote-server：单条 cmd_result 是一小段 JSON，手机端同时在途的命令通常个位数，
 * 50 条给足冗余，同时把最坏内存占用限制在「50 × 单条最大 payload」以内。
 */
const PENDING_RESULT_LIMIT = 50

/**
 * 【任务197 S2-2】补发有效期：超过手机端等待窗口（60s）的结果再补发已无意义
 * （手机端此时必已 remove 并报「命令超时」），且可能落到**另一台**同账号设备的同号命令上（id 冲突，手机端 `_cmdSeq` 是实例内自增）。
 * 因此只在有效期内的结果才补发，过期的丢弃并 warn。
 * ★注意：本值不改变手机端 60s 超时（那属 S3），只是「补发的有效期」。
 */
const PENDING_RESULT_TTL_MS = 60 * 1000

/**
 * 【任务197 S2-2】待发 cmd_result 队列（模块级一份：网关 host 连接断开后会重建新 socket，
 * 队列必须跨 socket 存活，才能在新连接 open 后补发）。
 * 改前：`hostWs` 非 OPEN 时 `sendToRelay()` 直接什么都不做 ⇒ cmd_result 静默蒸发 ⇒ 手机端白等满 60s。
 * 改后：记 warn + 入队，`ws.on('open')` 与每次成功发送前按 id 顺序补发。
 * `Map<id, {payload, at}>` 天然按 cmd id 去重，并保持插入序（Map 迭代序 = 插入序）。
 */
const pendingResults = new Map<number, { payload: string; at: number }>()

/** 入队（同 id 覆盖 = 去重；溢出丢弃最旧一条并 warn） */
function queuePendingResult(id: number, payload: string): void {
  if (pendingResults.has(id)) {
    pendingResults.set(id, { payload, at: Date.now() })
    return
  }
  if (pendingResults.size >= PENDING_RESULT_LIMIT) {
    const oldest = pendingResults.keys().next().value as number | undefined
    if (oldest !== undefined) pendingResults.delete(oldest)
    console.warn(`[relay] 待发结果队列已满(${PENDING_RESULT_LIMIT})，丢弃最旧一条 id=${oldest}；本条 id=${id} 已入队`)
  }
  pendingResults.set(id, { payload, at: Date.now() })
}

/** 网关连接可用时按 id（插入顺序）补发积压结果；过期的丢弃并 warn */
function flushPendingResults(): void {
  if (pendingResults.size === 0) return
  if (!hostWs || hostWs.readyState !== WebSocket.OPEN) return
  const now = Date.now()
  const items = [...pendingResults.entries()]
  pendingResults.clear()
  let sent = 0
  let expired = 0
  for (const [id, item] of items) {
    if (now - item.at > PENDING_RESULT_TTL_MS) {
      expired += 1
      console.warn(`[relay] 待发结果 id=${id} 已过期(>${PENDING_RESULT_TTL_MS}ms)，丢弃不补发`)
      continue
    }
    try {
      hostWs.send(item.payload)
      sent += 1
    } catch (err) {
      console.error(`[relay] 补发结果 id=${id} 失败:`, err instanceof Error ? err.message : err)
    }
  }
  if (sent > 0) console.log(`[relay] 网关连接恢复，已补发 ${sent} 条待发 cmd_result`)
  if (expired > 0) console.log(`[relay] 本次补发共丢弃 ${expired} 条过期结果（见上 warn）`)
}

function sendToRelay(obj: unknown): void {
  if (hostWs && hostWs.readyState === WebSocket.OPEN) {
    // 连接可用：先把此前积压的待发结果按 id 顺序补发，再发本条
    flushPendingResults()
    hostWs.send(JSON.stringify(obj))
    return
  }
  // 非 OPEN：不再静默丢弃 —— 仅 cmd_result 入队补发（事件是状态同步，手机端重连后会重新拉取，维持既有「跳过」语义不刷日志）
  const rec = obj as { type?: string; id?: number }
  if (rec && rec.type === 'cmd_result' && typeof rec.id === 'number') {
    queuePendingResult(rec.id, JSON.stringify(obj))
    console.warn(
      `[relay] 网关连接不可用(readyState=${hostWs ? hostWs.readyState : 'null'})，cmd_result id=${rec.id} 未能发送，已入待发队列(size=${pendingResults.size})`,
    )
    return
  }
  if (rec && rec.type === 'event') return
  console.warn(`[relay] 网关连接不可用(readyState=${hostWs ? hostWs.readyState : 'null'})，消息 type=${rec?.type ?? '?'} 未能发送(不入队)`)
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
    // 【任务197 S2-2】网关连接恢复：补发断线期间积压的 cmd_result（按 id 顺序，幂等）
    flushPendingResults()
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
      // msg 是 ws/Node 的原始错误文本：按口径④作为 {msg} 原样带入，不建映射表
      relayError = tIn(getMainLocale(), 'relay.connFailed', { msg })
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
  // 【期5C】改前是「中文前缀硬编码 + 已本地化的 describeCredentialState()」拼在一起，
  // 英文界面会出现半中半英。整句做成词条，凭证状态作为 {state} 参数带入（它自己已按语言取词）。
  relayError = code
    ? tIn(getMainLocale(), 'relay.rejectedCode', { status: status || 401, code, state: describeCredentialState(snap) })
    : tIn(getMainLocale(), 'relay.rejected', { status: status || 401, state: describeCredentialState(snap) })
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
    relayError = tIn(getMainLocale(), 'relay.credentialInvalid')
    broadcastRelayStatus()
    return
  }
  // transient / no_token：保留登录态，继续按退避重连（不误登出）
  relayError = tIn(getMainLocale(), 'relay.renewPending', { state: describeCredentialState(getCredentialSnapshot()) })
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
  // 【任务197 S2-2】中继停止：积压结果无法再送达，清空并 warn（不静默滞留）
  if (pendingResults.size > 0) {
    console.warn(`[relay] 网关中继已停止，丢弃 ${pendingResults.size} 条未能补发的 cmd_result`)
    pendingResults.clear()
  }
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
