/**
 * 插件实时通讯代理（L2 通道代理）——「按插件隔离」的房间帧收发中枢。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────────
 * 插件要做「真·跨网对战」（两台不同电脑上的同一对会员互打），需要一条实时双向通道。
 * 山海已有的会员通道（member-channel.ts，role=member）本身就是**会员↔会员对等**的，
 * 同一对会员在两台电脑上算出的 channelId 天然相同（computeDmChannelId：chat:1v1:{小}-{大}），
 * 所以对战无需新房间协议 —— 但**插件不能直接拿到那条连接**：
 *   · memberToken 只在主进程（member-channel.ts 头部「凭证边界」），插件物理拿不到；
 *   · 若让插件窗口直连 ws，就必须把账号凭证交给插件 ⇒ 等于把账号钥匙发给所有插件，绝不可接受。
 * 因此这里做**代理**：插件只说「往哪条通道发什么」，连接、鉴权、好友校验、限流全在主进程完成。
 *
 * ── 按插件隔离（本文件的核心不变量）────────────────────────────────────────────
 * 订阅表是**双键**：`(pluginId, channelId) → Set<webContents.id>`。
 *   · pluginId 由调用方（ipc-handlers）**从发起窗口反查**得到，插件**无法传入**、无法伪造；
 *   · 下行投递只走「该 pluginId 名下的订阅」⇒ A 插件订阅的通道，B 插件收不到其帧。
 *
 * ── 与私信的关系（重要）──────────────────────────────────────────────────────
 * 插件订阅**不写进** member-channel 的 `subscribers`（那张表决定 `member:message` 投给谁）。
 * 否则插件窗口会收到该通道上的**私信正文** —— 那是用户隐私，插件不得见。
 * 插件帧走独立事件名 `plugin:net-frame`，与 `member:message` 完全分离。
 *
 * ── 安全红线（改动前务必读）─────────────────────────────────────────────────
 *  ① 凭证不出主进程：本模块**不返回也不持有任何 token/凭证**，只搬运 payload。
 *  ② 插件帧**绝不进 Agent 上下文**：不落盘、不写会话历史、不广播 member:message、不触发任何执行。
 *  ③ 仅互为好友可发：好友校验复用 member-channel 的既有本地好友表 + 网关 friend_required。
 *  ④ 限流与尺寸：房间帧与私信帧**各自独立额度**（房间帧远高于私信，不能共用同一个桶）。
 *
 * ── 部署前提（如实告知，非本模块可解）──────────────────────────────────────────
 * ⚠️ 当前实现**仅单实例可用**：通道与订阅都是本进程内存态，且网关侧帧路由是「在线连接直投」。
 *    多实例 / 多开场景需要网关侧提供房间层（房间成员表 + 跨实例投递，如 Redis pub/sub），
 *    山海侧不承担该职责（见与网关的接口约定）。
 */

import { BrowserWindow } from 'electron'
import { safeSend } from './safe-send'

/** 单帧上限（JSON 序列化后的 UTF-8 字节数）：对局状态帧是小的，8KB 足够且挡住滥用 */
export const PLUGIN_FRAME_MAX_BYTES = 8 * 1024
/** 房间帧限流：每插件每 10 秒 900 帧（≈90 帧/秒，覆盖 60fps 对局状态帧） */
export const PLUGIN_FRAME_RATE_MAX = 900
export const PLUGIN_FRAME_RATE_WINDOW_MS = 10_000
/** 单个插件最多同时订阅的通道数（防刷爆订阅表） */
export const PLUGIN_MAX_CHANNELS_PER_PLUGIN = 8
/**
 * 订阅请求限流：每插件每 10 秒最多 20 次。
 *
 * 为什么必须有它（本轮新增用户名/昵称解析后才需要）：用户名在本地好友表查不到时，会员通道会
 * **只读查一次网关**，用它区分「查无此人」与「还不是好友」。没有这道闸，插件就能拿两种错误码的
 * 差异去**枚举哪些账号在网关上存在**（会员枚举）—— 那是我们替第三方代码开的一个探测口。
 * 帧上行另有 900/10s 的独立额度（PLUGIN_FRAME_RATE_MAX），两者互不挤占。
 */
export const PLUGIN_SUBSCRIBE_RATE_MAX = 20
/** 下行帧投递给插件窗口的 IPC 事件名（与 member:message 严格分离） */
export const PLUGIN_FRAME_EVENT = 'plugin:net-frame'

/** 通道 id 结构：chat:1v1:{较小 memberId}-{较大 memberId}（与 computeDmChannelId 同规范） */
const CHANNEL_RE = /^chat:1v1:(\d+)-(\d+)$/

/**
 * 插件给的「对端身份」——三选一，**优先级固定**：`peerMemberId` > `peerUsername` > `peerNickname`。
 *
 * 为什么必须支持用户名/昵称：山海的显示口径是「昵称 → 用户名 → 未知会员」，**任何界面都不向用户
 * 回显纯数字 memberId**。若联网插件让用户填「对方的会员号」，那是在要一个系统刻意不给出的数字
 * ⇒ 这条路永远走不通（桌球 0.6.1 的真机反馈正是卡在这里）。所以插件侧把**用户看得懂的用户名/昵称**
 * 交进来，由主进程换成 memberId；换出来的 memberId 一路留在主进程，**绝不回给插件**。
 *
 * 类型写 unknown：入参来自第三方代码，形态不可信，一律在本文件里归一（trim / number→string），
 * 语义校验全部交给会员通道（本模块不判好友、不判存在性）。
 */
export interface PluginPeerInput {
  peerMemberId?: unknown
  peerUsername?: unknown
  peerNickname?: unknown
}

/**
 * 传输委托：由 member-channel.ts 在模块加载时注入（`setPluginNetTransport`）。
 *
 * 为什么用注入而不是直接 import：成员通道要 import 本模块来投递下行帧（deliverPluginFrame），
 * 本模块若再 import 它取 `sendPluginFrame` 就形成循环依赖。注入把依赖方向固定为
 * 「member-channel → plugin-net」单向，规避循环，也让本模块可被单独测试。
 */
export interface PluginNetTransport {
  /** 上行：把一帧交付到会员通道（内部做鉴权/好友/落库策略；对端身份由会员通道解析成 memberId） */
  send(input: { pluginId: string; channelId: string; peer: PluginPeerInput; payload: unknown }): Promise<{
    ok: boolean
    message?: string
    channelId?: string
  }>
  /** 让会员通道对某 channelId 补发一次 ws subscribe（插件订阅不写进私信订阅表） */
  ensureSubscribed(channelId: string): void
  /**
   * 【身份补全】按「对端身份」（会员号 / 用户名 / 昵称三选一）算「本账号 ↔ 该好友」的 1v1 通道 id。
   *
   * 为什么必须由会员通道（而非本模块）算：本机 memberId 是**凭证边界内的信息**
   * （只在 member-channel 内，插件拿不到），而「用户名/昵称 → memberId」的查表依据是它持有的
   * **好友表**。本模块若自己拼通道，要么得读本机身份/好友表（越界），要么得信任插件给的字符串
   * （可伪造）—— 都不可接受。所以把「解析 + 算」整个委托回去，本模块只消费结果，
   * 并把失败原样透出（不兜底、不降级、绝不把 memberId 转交给插件）。
   *
   * 为什么是 Promise：用户名在本地好友表查不到时，会员通道会**只读查一次网关**，
   * 用它把「查无此人」与「有此人但还不是好友」分开（否则只能给出一句误导性的「没找到」）。
   */
  resolveChannel(peer: PluginPeerInput): Promise<{ ok: boolean; channelId?: string; error?: string; message?: string }>
  /**
   * 【兼容口径】该通道是否属于「本账号 ↔ 某人」（插件直接给完整 channelId 时的归属校验）。
   * 只回布尔：既能让本模块挡住「订阅别人的通道」，又不会把本机 memberId 反向暴露给插件。
   */
  ownsChannel(channelId: string): boolean
}

let transport: PluginNetTransport | null = null
/** 由 member-channel.ts 在模块加载末尾注入；测试可注入替身或置空 */
export function setPluginNetTransport(next: PluginNetTransport | null): void {
  transport = next
}

/** 订阅表：`pluginId\u0000channelId` → 订阅该通道的窗口 id 集合（双键隔离的核心） */
const subscriptions = new Map<string, Set<number>>()
/** 反查：窗口 id → 它持有的订阅键（窗口销毁时按此回收，避免死 id 堆积） */
const windowSubs = new Map<number, Set<string>>()
/** 通道 → 订阅它的插件 id 集合（投递时按插件分流；同时用于「还有没有插件订阅」判定） */
const channelIndex = new Map<string, Set<string>>()
/** 已向会员通道补发过 subscribe 的通道（去重，避免每加一个订阅者就发一帧） */
const upstreamSubscribed = new Set<string>()
/** 房间帧限流桶：插件 id → 发送时间戳滑动窗口（与私信桶完全独立） */
const frameWindows = new Map<string, number[]>()
/** 订阅请求限流桶：插件 id → 时间戳滑动窗口（与房间帧桶**再分开一枚**，互不挤占） */
const subscribeWindows = new Map<string, number[]>()

function subKey(pluginId: string, channelId: string): string {
  return `${pluginId}\u0000${channelId}`
}

function parseChannelId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  return CHANNEL_RE.test(id) ? id : null
}

function normalizePluginId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  return id ? id : null
}

/**
 * 从入参里取「对端身份」三件套（会员号 / 用户名 / 昵称），做**纯形态归一**。
 *
 * 为什么接受 number：网关侧 memberId 是数值（Go uint），用户名也常是手机号形态，插件从自己那侧
 * 拿到的可能是 number；若只认 string，插件就得自己转一次（漏转就变成一个看不懂的 invalid_peer）。
 * 这里**不校验存在性、不判好友**（那些语义全在会员通道），只做「取字段 + trim + number→string」。
 *
 * 只认对象形态：**裸字符串/数字一律不当作对端身份** —— 旧口径里裸字符串是「完整 channelId 句柄」
 * （`netSubscribe('chat:1v1:1001-1002')`），把它当成会员号会让兼容路径凭空失效。
 * 返回 null = 入参里没有任何对端身份（调用方再走 channelId 兼容口径或报 invalid_peer）。
 */
function pickPeerInput(raw: unknown): PluginPeerInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const src = raw as Record<string, unknown>
  const out: PluginPeerInput = {}
  for (const key of ['peerMemberId', 'peerUsername', 'peerNickname'] as const) {
    const v = src[key]
    if (typeof v === 'string' && v.trim()) out[key] = v.trim()
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = String(v)
  }
  return out.peerMemberId || out.peerUsername || out.peerNickname ? out : null
}

/**
 * 【身份补全】把「对端身份」交给会员通道换回「本账号 ↔ 该好友」的通道 id。
 *
 * 本模块**不自己拼**通道 id：那需要本机 memberId（凭证边界内，插件与本模块都不该持有），
 * 而「用户名/昵称 → memberId」要查的好友表也在会员通道里。
 * 传输未注入 / 解析失败一律**原样透出**，绝不兜底猜一个通道出来（宁可让插件用不了，
 * 也不能把帧发到一条来路不明的通道上）。
 */
async function resolveChannelByPeer(peer: PluginPeerInput): Promise<{ ok: boolean; channelId?: string; error?: string; message?: string }> {
  if (!transport) return { ok: false, error: 'not_connected' }
  return transport.resolveChannel(peer)
}

/** 回收已销毁窗口的订阅（窗口关闭没有可靠 app 级事件，改为投递前惰性回收） */
function pruneDeadWindows(): void {
  const alive = new Set<number>()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) alive.add(win.webContents.id)
  }
  for (const [wcId, keys] of [...windowSubs]) {
    if (alive.has(wcId)) continue
    for (const key of keys) dropKeyWindow(key, wcId)
  }
}

function dropKeyWindow(key: string, wcId: number): void {
  const ids = subscriptions.get(key)
  if (!ids) return
  ids.delete(wcId)
  if (ids.size === 0) {
    subscriptions.delete(key)
    const sep = key.indexOf('\u0000')
    const channelId = key.slice(sep + 1)
    // 通道上是否还有插件订阅：没有就把它从 channelIndex 摘掉（本模块**不发 leave**：
    // 同一条 chat:1v1 通道可能同时被私信订阅，发 leave 会把用户的私信实时推送一起关掉）
    let still = false
    for (const k of subscriptions.keys()) {
      if (k.slice(k.indexOf('\u0000') + 1) === channelId) {
        still = true
        break
      }
    }
    if (!still) channelIndex.delete(channelId)
  }
  const owned = windowSubs.get(wcId)
  if (owned) {
    owned.delete(key)
    if (owned.size === 0) windowSubs.delete(wcId)
  }
}

function channelsOfPlugin(pluginId: string): Set<string> {
  const out = new Set<string>()
  for (const key of subscriptions.keys()) {
    const sep = key.indexOf('\u0000')
    if (key.slice(0, sep) === pluginId) out.add(key.slice(sep + 1))
  }
  return out
}

function busyChannels(): Set<string> {
  const out = new Set<string>()
  for (const key of subscriptions.keys()) out.add(key.slice(key.indexOf('\u0000') + 1))
  return out
}

/** 房间帧限流：按**插件 id**分桶（与私信 builtin 桶各自独立额度） */
function takeFrameToken(pluginId: string): boolean {
  const now = Date.now()
  const bucketKey = `plugin:${pluginId}`
  const win = frameWindows.get(bucketKey) ?? []
  while (win.length > 0 && now - (win[0] ?? 0) > PLUGIN_FRAME_RATE_WINDOW_MS) win.shift()
  if (win.length >= PLUGIN_FRAME_RATE_MAX) {
    frameWindows.set(bucketKey, win)
    return false
  }
  win.push(now)
  frameWindows.set(bucketKey, win)
  return true
}

/** 订阅请求限流（独立桶；见 PLUGIN_SUBSCRIBE_RATE_MAX 的「防会员枚举」理由） */
function takeSubscribeToken(pluginId: string): boolean {
  const now = Date.now()
  const bucketKey = `plugin:${pluginId}`
  const win = subscribeWindows.get(bucketKey) ?? []
  while (win.length > 0 && now - (win[0] ?? 0) > PLUGIN_FRAME_RATE_WINDOW_MS) win.shift()
  if (win.length >= PLUGIN_SUBSCRIBE_RATE_MAX) {
    subscribeWindows.set(bucketKey, win)
    return false
  }
  win.push(now)
  subscribeWindows.set(bucketKey, win)
  return true
}

/**
 * 订阅一条通道（插件 client 半 `netSubscribe`）。
 *
 * 入参两种形态，**推荐第一种**（也是唯一推荐给最终用户看的那一种）：
 *  ① 对端身份对象 `{ peerMemberId }` / `{ peerUsername }` / `{ peerNickname }`（三者可混给，
 *     优先级固定 memberId > username > nickname）—— 插件只说「我要跟谁通信」，**本机那一半
 *     与「名字→会员号」全部由主进程补全**（`transport.resolveChannel`），返回的 `channelId`
 *     只是一个**不透明句柄**，插件原样拿去做 `netSend` 即可，**无需也无法**知道自己的 memberId。
 *     ★ 面向用户时请优先要**用户名/昵称**：山海的界面从不显示 memberId，让用户填那串数字
 *       等于要一个系统刻意不给出的东西（协议 §6.3 已把这句写成硬口径）。
 *  ② `'chat:1v1:{小}-{大}'`（旧口径，保留兼容）—— 主进程会校验它确实是「本账号 ↔ 某人」的通道，
 *     否则返回 `channel_forbidden`（不能拿别人的通道当订阅目标）。
 *
 * 失败错误码（原样透出，不兜底）：`not_connected` / `no_self` / `invalid_peer` / `self_peer` /
 * `not_friends` / `peer_not_found` / `peer_ambiguous` / `peer_lookup_failed` / `channel_forbidden`
 * / `invalid_channel` / `too_many_channels` / `rate_limited` / `missing_plugin` / `invalid_window`。
 *
 * @param appId  插件 id。**必须**由调用方从发起窗口反查得到，绝不能从插件入参取
 *               （否则插件可冒充他人身份订阅他人通道）。
 * @param webContentsId 发起窗口 id（主进程从 event.sender 取，插件无法伪造）。
 */
export async function pluginSubscribeChannel(
  appId: string,
  rawInput: unknown,
  webContentsId: number,
): Promise<{ ok: boolean; channelId?: string; error?: string; message?: string }> {
  const pluginId = normalizePluginId(appId)
  if (!pluginId) return { ok: false, error: 'missing_plugin' }
  if (!Number.isFinite(webContentsId)) return { ok: false, error: 'invalid_window' }
  // 【身份补全】优先按对端身份（会员号 / 用户名 / 昵称）解析：本机那一半与名字换号都由主进程做
  let channelId: string | null = null
  const peer = pickPeerInput(rawInput)
  if (peer) {
    // ★闸门在**解析之前**：解析失败会去查网关（区分查无此人 / 还不是好友），不限流就等于给插件
    //   开一条会员枚举的路。放在这里意味着「连解析的资格都要限」。
    if (!takeSubscribeToken(pluginId)) return { ok: false, error: 'rate_limited' }
    const r = await resolveChannelByPeer(peer)
    if (!r.ok || !r.channelId) return { ok: false, error: r.error ?? 'invalid_peer', message: r.message }
    channelId = r.channelId
  } else {
    // 兼容口径：插件直接给完整通道 id —— 但**必须是自己那条**，不能订阅别人的通道
    const raw = parseChannelId(rawInput)
    if (raw) channelId = transport && !transport.ownsChannel(raw) ? null : raw
    if (raw && !channelId) return { ok: false, error: 'channel_forbidden' }
  }
  if (!channelId) return { ok: false, error: 'invalid_channel' }
  pruneDeadWindows()

  const key = subKey(pluginId, channelId)
  const exists = subscriptions.has(key)
  if (!exists && channelsOfPlugin(pluginId).size >= PLUGIN_MAX_CHANNELS_PER_PLUGIN) {
    return { ok: false, error: 'too_many_channels' }
  }
  const ids = subscriptions.get(key) ?? new Set<number>()
  ids.add(webContentsId)
  subscriptions.set(key, ids)
  const owned = windowSubs.get(webContentsId) ?? new Set<string>()
  owned.add(key)
  windowSubs.set(webContentsId, owned)
  const owners = channelIndex.get(channelId) ?? new Set<string>()
  owners.add(pluginId)
  channelIndex.set(channelId, owners)
  // 补发一次 ws subscribe（插件订阅**不写进**私信订阅表，见文件头）
  if (!upstreamSubscribed.has(channelId)) {
    upstreamSubscribed.add(channelId)
    transport?.ensureSubscribed(channelId)
  }
  return { ok: true, channelId }
}

/**
 * 窗口销毁时回收它持有的全部插件订阅 + 限流桶。
 * ⚠️ 本轮**没有** plugin 侧的「取消订阅」能力（白名单只 +2：netSend / netSubscribe）：
 *   插件要停止收帧，关掉自己的窗口即可（本函数即在该时机被 ipc-handlers 调用）。
 *   这是刻意的**避免死代码**取舍 —— 不为「可能将来要用」先造一个没有调用方的 API。
 */
export function dropPluginWindowSubscriptions(webContentsId: number): void {
  const keys = windowSubs.get(webContentsId)
  if (keys) for (const key of [...keys]) dropKeyWindow(key, webContentsId)
}

/**
 * 上行：插件发一帧（插件 client 半 `netSend`）。
 * 顺序：身份（appId 反查）→ 对端 → 通道（未给则主进程自算）→ 订阅关系 → 尺寸 → 限流
 *       → 交 member-channel（连接态 / 好友校验 / 通道归属 / 鉴权网关）。
 *
 * 对端可以是会员号，也可以是**用户名/昵称**（同 netSubscribe 的三选一与优先级）—— 插件不必
 * 为了发一帧去记那串数字。
 *
 * `channelId` **可省略**：省略时由主进程按对端身份自算（插件不必知道本机 memberId，也就没必要
 * 自己拼那个字符串）；给了则按给的值走，并在 member-channel 侧被再次校验是否恰为
 * 「本账号 ↔ 该对端」那条（`channel_forbidden`）。
 */
export async function pluginSendFrame(
  appId: string,
  input: unknown,
  webContentsId: number,
): Promise<{ ok: boolean; channelId?: string; error?: string; message?: string }> {
  const pluginId = normalizePluginId(appId)
  if (!pluginId) return { ok: false, error: 'missing_plugin' }
  if (!transport) return { ok: false, error: 'not_connected' }
  const obj = (input ?? {}) as { channelId?: unknown; payload?: unknown }
  const peer = pickPeerInput(obj)
  if (!peer) return { ok: false, error: 'invalid_peer' }
  // 【身份补全】没给句柄就由主进程按对端身份自算（与 netSubscribe 同一条解析路径，结果必然一致）
  let channelId = parseChannelId(obj.channelId)
  if (!channelId) {
    const r = await resolveChannelByPeer(peer)
    if (!r.ok || !r.channelId) return { ok: false, error: r.error ?? 'invalid_peer', message: r.message }
    channelId = r.channelId
  }
  // 必须先从**本窗口**订阅过该通道：否则等于把任意好友的通道当成广播口
  const key = subKey(pluginId, channelId)
  const ids = subscriptions.get(key)
  if (!ids || !ids.has(webContentsId)) return { ok: false, error: 'not_subscribed' }
  // 尺寸闸门：以「实际会被序列化上行的字节数」计（含 data 包裹）
  let bytes = 0
  try {
    bytes = Buffer.byteLength(JSON.stringify({ data: obj.payload ?? null }), 'utf8')
  } catch {
    return { ok: false, error: 'unserializable' }
  }
  if (bytes > PLUGIN_FRAME_MAX_BYTES) return { ok: false, error: 'frame_too_large' }
  if (!takeFrameToken(pluginId)) return { ok: false, error: 'rate_limited' }
  // 把「对端身份」原样交给会员通道换成 memberId（本模块不查好友表、也不把 memberId 回给插件）
  const r = await transport.send({ pluginId, channelId, peer, payload: obj.payload ?? null })
  return r.ok ? { ok: true, channelId } : { ok: false, error: r.message ?? 'send_failed' }
}

/**
 * 下行：把一条房间帧投给「订阅了该通道」的窗口（由 member-channel 的 `plugin_msg` 分支调用）。
 * 只投该 pluginId 名下的订阅 ⇒ 插件间天然隔离；返回实际投递的窗口数（便于断言与审计）。
 */
export function deliverPluginFrame(channelId: string, fromMemberId: string, payload: unknown, ts = Date.now()): number {
  pruneDeadWindows()
  const owners = channelIndex.get(channelId)
  if (!owners || owners.size === 0) return 0
  let delivered = 0
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    const wcId = win.webContents.id
    for (const pluginId of owners) {
      const ids = subscriptions.get(subKey(pluginId, channelId))
      if (ids?.has(wcId)) {
        // 帧上带 **pluginId**：渲染层（preload）据此再做一次「这帧是不是发给我的」过滤 ——
        // 主进程的投递隔离是第一道，preload 的自校验是第二道（同 plugin:model-stream-event 的 callId 过滤思路）。
        safeSend(win, PLUGIN_FRAME_EVENT, { pluginId, channelId, from: fromMemberId, payload, ts })
        delivered += 1
        break // 同一窗口只投一次（不因多插件共用窗口而重复）
      }
    }
  }
  return delivered
}

/** 通道停用（退出登录 / 关闭通道）时清空全部插件通道态 */
export function clearPluginNet(): void {
  subscriptions.clear()
  windowSubs.clear()
  channelIndex.clear()
  upstreamSubscribed.clear()
  frameWindows.clear()
  subscribeWindows.clear()
}

/** 调试/断言用快照。**只含 id 与计数，绝不返回 token 或帧内容** */
export function getPluginNetSnapshot(): {
  channels: string[]
  subscriptions: Array<{ pluginId: string; channelId: string; windows: number[] }>
  transportBound: boolean
} {
  const subs: Array<{ pluginId: string; channelId: string; windows: number[] }> = []
  for (const [key, ids] of subscriptions) {
    const sep = key.indexOf('\u0000')
    subs.push({ pluginId: key.slice(0, sep), channelId: key.slice(sep + 1), windows: [...ids].sort((a, b) => a - b) })
  }
  return { channels: [...busyChannels()], subscriptions: subs, transportBound: Boolean(transport) }
}
