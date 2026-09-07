import { WebSocket } from 'ws'
import { app, BrowserWindow } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeSend } from './safe-send'
import { getRuntime } from './runtime'
import { getWindowType } from './window-manager'
import { notifyDmMessage, notifyFriendRequest } from './notifications'
// 附件引用消息的解码（与渲染层共用一份，避免两套标准）：私信 content 里可能是 {"t":"image",…} 这种引用，
// 系统通知正文与「引用到会话」的落地文本都不能把这段 JSON 原样甩给用户。
import { DM_MAX_CONTENT_BYTES, decodeDmContent, dmContentPreview, dmContentToPlainText } from '../shared/dm-attachment'
// 【i18n 期5B】本模块的用户可见文案全部走词条，语言只认 main/locale-store.ts 的 getMainLocale()
// （全仓唯一真相源；本模块绝不读 settings.locale 原文、不读 config.json、不把语言决策渗回渲染层）。
// ⚠️ 取词时机见下面 ErrSpec 的注释：**存结构、出口求值**，不在模块加载期求值（历轮 9 次同一个坑）。
import { getMainLocale, onMainLocaleChange } from './locale-store'
import { tIn } from '../shared/i18n'
// 【期5B-补漏·用户裁决】会员显示名的判定抽到 shared 层，主进程与渲染层共用同一份实现：
// 主进程六条路径原先在拿不到昵称/用户名时兜底成对端 memberId，其中 notifyDmMessage /
// notifyFriendRequest 的标题**根本不经过渲染层** → 英文界面里通知会是一个纯数字 memberId。
// 分工：落盘/跨进程载荷用 realNameOrEmpty（拿不到就空串，绝不写译文，避免把语言烘进磁盘）；
//       即时显示（系统通知标题）用 displayNameOf（当前语言的「未知会员」）。
import { displayNameOf, realNameOrEmpty } from '../shared/member-display'
import {
  getMemberAccessToken,
  handleAuthRejected,
  readRejectBody,
  getCredentialSnapshot,
  describeCredentialState,
  markCredentialInvalid,
} from './member-credentials'

/**
 * 会员实时通讯底座（L2 通道代理）——山海「会员私信」的主进程侧唯一实现。
 *
 * ── 与 remote-relay.ts 的关系（为什么必须是【第二条独立连接】）────────────────
 * remote-relay.ts 是「同一会员账号下：自己的手机端 ↔ 自己的桌面端」的远程控制通道，
 * 身份空间钉死为 role=host + deviceId，连接语义与远程控制强耦合：
 *   · clientCount 驱动 ensureSyncSubscribed / unsubscribeSync（runtime 事件转发订阅开关）
 *   · 收到 client_connected / client_disconnected 会改同步订阅
 *   · close 会级联 stopRemoteRelay 语义
 * 把「会员↔会员」的业务消息挤进那条连接，会让「手机一连上/断开」扰动私信通道（反之亦然），
 * 且其入向解析器对未知 type 一律丢弃，混用需改核心分支、回归风险波及远程控制主链路。
 * 因此这里新建一条 role=member 的独立连接，只承载业务信封（契约 v1），与远程控制零耦合。
 *
 * ── 安全红线（产品硬性要求，改动前务必读）────────────────────────────────
 * 外部消息（别的会员发来的）【绝不自动进入任何 Agent 上下文】、【绝不自动触发工具执行】、
 * 【绝不自动批准任何东西】。本模块对收到的私信只做三件事：
 *   ① 落盘到本地私信库（userData/dm-store.json，仅用于展示/历史/未读）
 *   ② 广播 member:message 给「已订阅该 channelId」的窗口（只给人看）
 *   ③ 系统通知提醒
 * 「把某条私信作为需求上下文交给某个会话」必须由本地用户 B 显式点击触发
 * （quoteDmToSession → 主进程定向发 dm:quote-to-session → 聊天窗口只写进输入框，等 B 自己按发送）。
 * 本模块【不 import runtime 的 run / injectMessage / respondApproval】，从依赖上就不可能自动执行。
 *
 * ── 凭证边界 ────────────────────────────────────────────────────────────
 * memberToken 只在主进程内使用（runtime.getMemberToken()），既不下发渲染层，也不给插件。
 * 本轮插件完全不接入：本模块不暴露任何插件白名单能力，插件物理上拿不到这条通道
 * （插件窗口挂 plugin.cjs，见 window-manager.ts 的 isPlugin 分支）。
 */

/**
 * 网关会员通道地址（与远程控制同一网关、同一 JWT，但 role=member 走业务消息语义）。
 * 联调期可用环境变量 SHANHAI_MEMBER_WS_URL 覆盖（本轮网关未部署，需要指向测试环境时用）。
 */
const DEFAULT_MEMBER_URL = process.env.SHANHAI_MEMBER_WS_URL?.trim() || 'wss://aisocket.bjctykj.com/ws'
/**
 * 会员 HTTP 基址（好友操作 / 私信历史 / 会话列表 / 未读计数全部走 HTTP，契约 v1 定稿）。
 * 与插件市场、版本检查同一 AI 网关（路径前缀 /api/v1/*），鉴权用会员 JWT（Bearer memberToken）。
 * ⚠️ 需网关确认：friends / messages 接口是否挂在 aigateway 域（见回传「需网关确认」清单）。
 */
const MEMBER_API_BASE = process.env.SHANHAI_MEMBER_API_BASE?.trim() || 'https://aigateway.bjctykj.com'
/** HTTP 请求超时（避免连接挂起长期占住调用） */
/**
 * 会员 HTTP 超时。这些接口都是轻量 CRUD（实测 friends/search/history 都在 57~74ms 量级），
 * 不存在「网关要跑几分钟」的场景，所以**不跟着模型链路一起放大**（真正的阈值倒挂在 packages/llm，已单独修）。
 * 这里保持 10s，配合下面的重试；最坏总耗时 = 10 + 0.8 + 10 + 1.6 + 10 + 3.2 + 10 ≈ 45.6s，有界可控。
 */
const HTTP_TIMEOUT_MS = 10_000

/** 网关超时/不可用的自动重试上限（用户拍板：最多 3 次） */
const GATEWAY_RETRY_MAX = 3
/** 指数退避基数（毫秒）：800 → 1600 → 3200 */
const GATEWAY_RETRY_BASE_MS = 800
/**
 * 【识别条件①③】网关把 Go 原生 `context deadline exceeded` 放在 HTTP body 的 message 里透出；
 * 另有 nginx/网关自己给的 502/503/504（【识别条件②】）。措辞里既没有「超时」也没有 timed out，
 * 所以必须单独匹配 —— 与 packages/llm、packages/agent 里那两处保持同一组特征。
 */
const GATEWAY_DEADLINE_TEXT = /context\s+deadline\s+exceeded|deadline\s+exceeded\s+while\s+reading\s+body|Client\.Timeout\s+exceeded|net\/http:\s+request\s+canceled/i
/** 【识别条件②】网关门面 5xx：请求没被上游完成，重试安全 */
const GATEWAY_BAD_GATEWAY = new Set([502, 503, 504])

function isGatewayDeadlineText(text: string | null | undefined): boolean {
  return !!text && GATEWAY_DEADLINE_TEXT.test(text)
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
/** 协议版本（契约 v1） */
const PROTOCOL_V = 1
/** 断线重连基础间隔（指数退避，上限 60s，带 ±20% 抖动） */
const RECONNECT_DELAY_MS = 5000
const RECONNECT_MAX_DELAY_MS = 60000
/** WebSocket 协议层 ping 保活 */
const PING_INTERVAL_MS = 30000
/** 应用层心跳（契约 heartbeat） */
const HEARTBEAT_INTERVAL_MS = 25000
/**
 * 单条内容字节上限。【任务113】不再在本文件写字面量：数值与口径的唯一真相源是
 * src/shared/dm-attachment.ts 的 DM_MAX_CONTENT_BYTES（渲染层 MemberPanel / DmComposer 也 import 同一份），
 * 改前这里 4000、渲染层再写一个 4000，两份必然漂开（连词条与参数名都不一样）。
 * 保留 MAX_MSG_BYTES 这个别名只为少改动点，**不含任何数字**；放宽只改 shared 那一行
 * （任务115 已按用户授权把该值从 4000 放宽到 40000）。
 * 【纠正一条不实记载（任务115）】网关超限实际只回 **message_too_large** 一个码；
 *  旧注释写的 content_too_long 经网关侧全仓实证**零命中、该码从不存在**，不要再照它排查。
 *  （下方 ERROR_COPY 里那条映射作为防御性冗余保留，见其行内注释。）
 */
const MAX_MSG_BYTES = DM_MAX_CONTENT_BYTES
/** 每个会话线程本地持久化的消息上限（超出丢弃最早的历史；更早的历史走 HTTP 分页拉） */
const MAX_PERSIST_MESSAGES = 500
/** 发送限流（契约 v1 定稿：按 memberID 30 条 / 10 秒）。本地同口径预检，避免把注定被拒的请求发出去。 */
const RATE_LIMIT_PER_WINDOW = 30
const RATE_WINDOW_MS = 10_000
/**
 * 网关 HTTP 路径（契约 v1 定稿：好友操作 / 会员检索 / 会话列表 / 历史 / 标记已读 **全部走 HTTP**，
 * 不再走 ws 上行；ws 只负责实时收发 message 与好友事件通知）。
 */
const PATH_FRIENDS = '/api/v1/friends'
const PATH_FRIEND_REQUESTS = '/api/v1/friends/requests'
const PATH_FRIEND_REQUESTS_COUNT = '/api/v1/friends/requests/count'
const PATH_FRIEND_REQUEST = '/api/v1/friends/request'
const PATH_FRIEND_ACCEPT = '/api/v1/friends/accept'
const PATH_FRIEND_REJECT = '/api/v1/friends/reject'
const PATH_FRIEND_DELETE = '/api/v1/friends/delete'
const PATH_MEMBER_SEARCH = '/api/v1/members/search'
const PATH_CONVERSATIONS = '/api/v1/messages/conversations'
/**
 * 会话历史（契约 v1.1 定稿）：GET /api/v1/messages/conversations/:peerId?page=&pageSize=
 * —— 注意是「对方 memberId」做路径参数、page/pageSize 偏移分页（page=1 是最新一页，加载更早=page 递增），
 * 不是时间戳游标；旧写法 /messages/history?channelId&before 网关不存在，已废弃。
 */
const PATH_MESSAGE_READ = '/api/v1/messages/read'
/** 全局未读数（契约 v1.1：GET /api/v1/messages/unread → {count}，比本地累加更权威，作红点主源） */
const PATH_MESSAGES_UNREAD = '/api/v1/messages/unread'
/** 历史分页默认值（网关默认 page=1、pageSize=20；这里取 30 条一屏更够用，上限按网关习惯不超 100） */
const HISTORY_PAGE_SIZE = 30
/** 会话管家内置超级会话 id（与 @shanhai/runtime 的 SUPERVISOR_ID 同值；主进程侧写常量避免跨包耦合） */
const SUPERVISOR_SESSION_ID = 'supervisor'
/** 审计日志滚动阈值（字节）：超过则保留末尾若干行 */
const AUDIT_MAX_BYTES = 512 * 1024

// ————————————————————————————— 类型 —————————————————————————————

/**
 * 统一信封（契约 v1）：{v,type,seq,channelId,from,to?,payload,ts}
 * ⚠️ from / to 用 `string | number`：网关下行是**数值**（Go uint），而本模块内部 memberId 是字符串；
 *    上行则刻意不带 from（见 out() 的联调修正说明）。读取处一律走 idStr() 归一，禁止直接参与 === 比较。
 */
export interface MemberEnvelope {
  v: number
  type: string
  seq: number
  channelId: string | null
  from?: string | number | null
  to?: string | number | null
  payload?: Record<string, unknown>
  ts: number
}

/** 会员通道状态（主进程 → 渲染层，广播 member:status） */
export interface MemberChannelStatus {
  /** 是否已开启（登录态驱动） */
  enabled: boolean
  /** ws 是否已连上网关 */
  connected: boolean
  /** 能否收发：connected 且已知本账号 memberId */
  ready: boolean
  url: string
  username: string | null
  /** 本账号会员 id（私信 channelId 计算用；来源见 resolveSelfMemberId） */
  memberId: string | null
  /** 最近一次错误的人类可读文案，null 表示无错误 */
  error: string | null
  /** 是否因登录凭证失效（401 / auth_failed）被拒：此时不再重连，且已联动全局登录态 */
  authFailed: boolean
  /** 当前已订阅的通道（调试/设置页展示用） */
  subscribedChannels: string[]
  updatedAt: number
}

/** 好友条目 */
export interface DmFriend {
  memberId: string
  username: string
  nickname?: string
  /** 网关若下发在线标记则用于展示，未下发为 undefined（如实显示「未知」） */
  online?: boolean
  /**
   * 【真头像】网关下发的头像 URL。实测 /members/search 与 conversations 的 peer 对象里都有该字段，
   * 但值常为**空字符串** → pickStr 把空串归 null → 这里存 undefined，界面按「无头像」处理（回落首字占位）。
   * ⚠️ 只做显示：它不参与任何请求参数、不进消息体、不进日志。
   */
  avatar?: string
}

/** 待处理的好友申请（别人发给我的） */
export interface DmFriendRequest {
  requestId: string
  fromMemberId: string
  fromUsername: string
  fromNickname?: string
  /** 【真头像】申请方的头像 URL（网关空串 → undefined），仅用于申请列表显示 */
  fromAvatar?: string
  /** 对方申请时写的附言（定稿载荷 requestMsg） */
  message?: string
  ts: number
}

/** 一条私信（mine=true 表示本端发出的） */
export interface DmMessage {
  msgId: string
  channelId: string
  /** 发送者会员 id */
  from: string
  /** 发送者展示名 */
  fromName: string
  to?: string
  text: string
  ts: number
  mine: boolean
  /** 对方是否已读（逐条已读回执网关未实现时保持 false，UI 不谎报） */
  read?: boolean
  /**
   * 网关下发的 messageId（契约 v1 去重键）。
   * 网关按 memberID 投递给该会员**所有**活跃连接 —— 自己发的消息自己的其它设备也会收到，
   * 因此本地乐观气泡先以 msgId 为键、serverId 留空，回声到达后回填；同一 serverId 只认一次。
   */
  serverId?: string
  /** 本地已入队、尚未确认送达 */
  pending?: boolean
  /** 发送失败原因（如实展示，不静默吞掉） */
  failed?: string | null
  /**
   * 消息来源（解耦点②）：本轮内置私信恒为 'dm'。
   * 将来插件接入同一条通道时只是多一个枚举值（如 'plugin:<id>'），消费端按 origin 区分展示即可，
   * 不需要改消息结构，也不用回填历史数据 —— 保证插件接入是纯增量、不返工。
   */
  origin?: 'dm' | string
}

/** 一个私信会话线程（与某个好友的 1v1） */
export interface DmThread {
  channelId: string
  peerId: string
  peerName: string
  /** 【真头像】对端头像 URL（会话列表 peer 对象，拿不到时用本地好友表兜底）；空串按无头像处理 */
  peerAvatar?: string
  messages: DmMessage[]
  unread: number
  lastTs: number
}

/** 未读汇总（低频小数据，独立事件广播，不进 ui:state 全量快照） */
export interface DmUnread {
  total: number
  byChannel: Record<string, number>
}

/** 「引用到会话」载荷（原文 + 来源元信息，渲染层据此做输入区引用卡片） */
export interface DmQuotePayload {
  sessionId: string
  channelId: string
  msgId: string
  fromName: string
  fromMemberId: string
  /** 私信原文（不含任何拼接的来源前缀） */
  text: string
  /** 私信自身时间 */
  ts: number
  /** 本次投递时间 */
  at: number
}

/** 统一返回体 */
export interface MemberResult {
  ok: boolean
  message: string
}

// ————————————————————————————— 模块状态 —————————————————————————————

let memberUrl = DEFAULT_MEMBER_URL
let enabled = false
let connected = false
let authFailed = false
/**
 * 【i18n 期5B 取词时机】通道错误在状态里存的是**未翻译的结构**（词条 key + 参数），
 * 不是已经取好的文案。原因：channelError 会进 broadcastStatus 的内容指纹 lastStatusFp ——
 * 一旦把译文烘进去，就只有两种坏结果：① 切语言后译文还是旧的、界面停在旧语言；
 * ② 或者每次重连重新求值让指纹变化，把任务59 刚消掉的重复广播请回来。
 * 现在：指纹用 errFp（结构串，与语言无关）→ 重连风暴照旧被去重；
 *       译文在出口 errText 现取 → 切语言后由 onMainLocaleChange 强制推一次，界面跟上。
 */
type ErrSpec = { k: string; p?: Record<string, string | number> }

/** 发送失败原因落盘用的**词条 key**（不是文案）：见 sendDm 里的注释 */
const FAILED_CHANNEL_CLOSED = 'dm.failedChannelClosed'
let channelErrorSpec: ErrSpec | null = null
let seq = 0
let ws: WebSocket | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let pingTimer: NodeJS.Timeout | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let reconnectAttempts = 0
/** 是否正在「401 → 续签 → 重连」恢复中：期间抑制 close 的自动重连，避免用旧 token 空转 */
let pendingAuthRecovery = false
/** 本账号会员 id：只认网关下发值（契约 v1.1，见 resolveSelfMemberId） */
let selfMemberId: string | null = null
let selfMemberIdFromGateway = false
let statusUpdatedAt = Date.now()

/** 好友表（权威来自网关 friends_list，本地缓存供离线展示） */
let friends: DmFriend[] = []
/** 待我处理的好友申请 */
let requests: DmFriendRequest[] = []
/** 会话线程（按 channelId） */
const threads = new Map<string, DmThread>()
/** 订阅表：channelId → 订阅该通道的窗口 webContents.id（未订阅的窗口收不到该通道的实时推送） */
const subscribers = new Map<string, Set<number>>()
/**
 * 发送时间戳滑动窗口，按 caller 维度分桶：内置私信侧 caller='builtin'。
 * 网关限流口径是「按 memberID 30 条/10 秒」，所以 builtin 桶就是全部额度；
 * 将来插件接入时同一会员会多出一个 caller='plugin:<id>' 桶，这里天然按调用方隔离，不用重写。
 */
const sendWindows = new Map<string, number[]>()
/** 未读变化的进程内订阅者（index.ts 用来刷新托盘菜单文案与 macOS Dock 角标） */
const unreadWatchers = new Set<(u: DmUnread) => void>()
/** HTTP 补拉并发去重标记 */
let pulling = false
/**
 * 【闪烁修复·广播去重】会员通道每 ~80 秒被网关断开重连一次（见 close 审计），每次重连都会推
 * status + 每通道 subscribed + 全量 HTTP 补拉（friends/requests/count/conversations/history/unread），
 * 于是渲染层每秒收到多条**内容完全一样**的快照 → 反复 setState → 提示条反复出现/消失（肉眼＝闪烁）。
 * 这里给三类广播加「内容指纹」：指纹没变就不推，从源头掐掉无意义重渲染。
 * 指纹刻意排除 updatedAt / ts 这类每次都变的时间戳。
 */
let lastStatusFp = ''
let lastUnreadFp = ''
let lastFriendsFp = ''
/** 上一次全量补拉时间：重连风暴时最多每 BACKFILL_MIN_INTERVAL_MS 做一次，避免每 80 秒 6 个 HTTP */
let lastBackfillAt = 0
const BACKFILL_MIN_INTERVAL_MS = 20000
/** 用户主动点开会话（渲染层 subscribeChannel）时登记，subscribed 回执才值得提示；重连自动订阅不提示 */
const userInitiatedSubscribe = new Map<string, number>()
/** read_update 提示去重：同一会话 5 秒内只提示一次（网关 HTTP 与 ws 各推一次，多端还会叠加） */
const lastReadUpdateNoticeAt = new Map<string, number>()
/** 待处理好友申请数（红点权威来自 HTTP /friends/requests/count） */
let requestsCount = 0

// ————————————————————————————— 工具 —————————————————————————————

function storePath(): string {
  return join(app.getPath('userData'), 'dm-store.json')
}

function auditPath(): string {
  return join(app.getPath('userData'), 'member-channel-audit.jsonl')
}

/** 本地审计日志：记录「谁（caller）在什么时候通过哪个通道发了什么」，不落消息正文（只落字节数） */
function audit(entry: { dir: 'in' | 'out'; caller: string; topic: string; channelId?: string | null; to?: string | null; bytes: number; result: string }): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(auditPath(), JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf8')
    const st = statSync(auditPath())
    if (st.size > AUDIT_MAX_BYTES) {
      const lines = readFileSync(auditPath(), 'utf8').split('\n').filter(Boolean)
      writeFileSync(auditPath(), lines.slice(-300).join('\n') + '\n', 'utf8')
    }
  } catch (err) {
    console.warn('[member-channel] 写审计日志失败（不影响功能）:', err)
  }
}

/** 从对象里按候选键名取第一个非空字符串/数字（防御式解析网关字段命名差异） */
function pickStr(obj: Record<string, unknown> | undefined | null, keys: string[]): string | null {
  if (!obj) return null
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

/** 把信封上的 from / to（网关是数值、本地是字符串）归一成字符串，供比较与展示；空值返回空串 */
function idStr(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  return value.trim()
}

function pickNum(obj: Record<string, unknown> | undefined | null, keys: string[]): number | null {
  if (!obj) return null
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

function pickBool(obj: Record<string, unknown> | undefined | null, keys: string[]): boolean | undefined {
  if (!obj) return undefined
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'boolean') return v
  }
  return undefined
}

/**
 * 本账号会员 id：**只认网关下发值**（契约 v1.1：role=member 握手成功后的 connected 下行必带 payload.selfMemberId）。
 * 已删除「本地解码 memberToken 的 user_id claim」兜底 —— 那是对网关 JWT claim 命名的隐性耦合，
 * v1.1 显式下发后不再需要猜。取不到时如实返回 null（私信会提示「尚未取得本账号身份」），
 * 绝不用猜出来的 id 去算 channelId，避免算出错误通道把消息发给陌生人。
 */
function resolveSelfMemberId(): string | null {
  return selfMemberId
}

/** channelId 确定性规范（契约 v1）：chat:1v1:{较小memberId}-{较大memberId}，双方各自可算出同一 id */
export function computeDmChannelId(a: string, b: string): string {
  const na = Number(a)
  const nb = Number(b)
  let smaller: string
  let larger: string
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    smaller = na <= nb ? a : b
    larger = na <= nb ? b : a
  } else {
    const cmp = a.localeCompare(b)
    smaller = cmp <= 0 ? a : b
    larger = cmp <= 0 ? b : a
  }
  return `chat:1v1:${smaller}-${larger}`
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 【时间单位归一（契约 v1.1 硬要求）】HTTP 侧时间字段（createdAt / readAt / requestAt / lastMsgAt）是 Unix **秒**，
 * ws 侧（ts / timestamp）是**毫秒**。本地一律以毫秒存储/排序/展示，任何跨来源时间都必须先过这个函数，
 * 否则差 1000 倍（表现为「x 分钟前」算成几十年前、历史排序错乱、未读判定失效）。
 * 判定按位数：>=1e12 视为毫秒，否则视为秒（秒级时间戳要到公元 33 世纪才越界，安全）。
 */
function toMs(value: number | null | undefined, fallback = Date.now()): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return value >= 1e12 ? value : value * 1000
}

/** 客户端消息关联 id（契约 v1.1：send.payload.clientMsgId 会被原样回显到 message 下行） */
function newClientMsgId(peer: string): string {
  return `local-${peer}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 限流：按 caller 维度 30 条 / 10 秒滑动窗口（与网关按 memberID 的口径同量，本地先拦下 UI 才能如实提示） */
function takeSendToken(caller = 'builtin'): boolean {
  const now = Date.now()
  const win = sendWindows.get(caller) ?? []
  while (win.length > 0 && now - (win[0] ?? 0) > RATE_WINDOW_MS) win.shift()
  if (win.length >= RATE_LIMIT_PER_WINDOW) {
    sendWindows.set(caller, win)
    return false
  }
  win.push(now)
  sendWindows.set(caller, win)
  return true
}

// ————————————————————————————— 网关 HTTP（好友 / 检索 / 会话列表 / 历史 / 已读）—————————————————————————————

/** HTTP 调用结果（统一形态：失败也带人类可读 message，绝不静默当成功） */
interface HttpResult {
  ok: boolean
  code: string | null
  message: string
  data: unknown
  /**
   * 网关返回的 HTTP 状态码（仅 readHttpJson 的两条返回路径会带上；未登录 / 网络错误 / 鉴权分支不带）。
   * 存在的理由：业务 code 一律是 -1，光看 code 分不清「404 没这个人」和「400 参数错」「500 服务坏了」，
   * 而界面上这两类必须给不同的话（见 searchMembers 的 notFound）。
   */
  status?: number
  /** 本次失败是「网关超时 / 网关不可用」：上层据此决定是否自动重试，不靠猜文案 */
  gatewayTimeout?: boolean
}

/**
 * 会员 HTTP 调用：Authorization: Bearer <memberToken>。
 * 凭证只在主进程取用（getRuntime().getMemberToken()），既不下发渲染层也不给插件；带 10s 超时；
 * 401/403 直接走 handleCredentialRejected 联动全局登录态（不重犯 remote-relay 只改自己状态的老问题）。
 */
/**
 * 【网关超时自动重试 · 幂等策略（本轮定稿，逐条对应真实行为）】
 *  - GET（好友 / 申请 / 计数 / 会话 / 未读 / 历史 / 检索）：无副作用 → 网关超时、5xx、网络错误一律重试，最多 3 次。
 *  - POST 且「没收到任何响应」（连接失败 / DNS / 10s 内无响应被 abort）：请求没到达网关 → 重试安全。
 *  - POST 且 HTTP 502/503/504：网关门面明确没把请求转完 → 重试；并且这些写接口本身有幂等保护
 *    （实测重复 friends/request 回 400「你们已经是好友」，重复 accept/reject/delete 同样只回业务错误，
 *     messages/read 重复标记已读无害）。
 *  - POST 且 HTTP 200 但 body 里带 deadline exceeded：**不重试** —— 无法确定副作用是否已落库，
 *    重放可能造出重复申请/重复记录；改成如实提示（不静默、也不假装成功）。
 *  - 私信发送本身走 ws（不在这里），由 clientMsgId 去重，见 sendDm。
 * 重试每次都是全新请求：重新取凭证（getMemberAccessToken 在每次 attempt 内取，续签过就用新 token）、
 * 重新 fetch（新 AbortController），不复用已失败的连接。
 */
async function httpJson(path: string, init: { method?: 'GET' | 'POST'; body?: Record<string, unknown> } = {}): Promise<HttpResult> {
  const method = init.method ?? 'GET'
  let last: HttpResult | null = null
  for (let attempt = 0; attempt <= GATEWAY_RETRY_MAX; attempt += 1) {
    last = await httpOnce(path, init)
    if (!shouldRetryGatewayTimeout(method, last)) return last
    if (attempt === GATEWAY_RETRY_MAX) break
    // 【重试必须可见】走既有 member:notice 通道（私信面板顶部那条恒定占位的提示条），不新增 IPC/handler
    broadcast('member:notice', {
      kind: 'gateway_retry',
      peer: '',
      message: tIn(getMainLocale(), 'dm.retryNotice', { n: attempt + 1, max: GATEWAY_RETRY_MAX, req: `${method} ${path.split('?')[0]}` }),
      ts: Date.now(),
    })
    await sleepMs(GATEWAY_RETRY_BASE_MS * 2 ** attempt)
  }
  // 耗尽：给准确的**当前语言**文案，不透传网关英文原文（期5B 前是写死中文）
  audit({ dir: 'out', caller: 'builtin', topic: `http ${method} ${path.split('?')[0]}`, channelId: null, to: null, bytes: 0, result: `gateway_timeout_exhausted:${GATEWAY_RETRY_MAX}` })
  return {
    ok: false,
    code: 'gateway_timeout',
    message: tIn(getMainLocale(), 'dm.retryExhausted', { max: GATEWAY_RETRY_MAX }),
    data: null,
    gatewayTimeout: true,
  }
}

/** 这次失败该不该自动重试（幂等策略见 httpJson 注释） */
function shouldRetryGatewayTimeout(method: string, r: HttpResult): boolean {
  if (r.ok) return false
  // 网络层错误 = 请求根本没到达网关（含山海自己 10s abort），任何方法都可以安全重发
  if (r.code === 'network') return true
  if (!r.gatewayTimeout) return false
  if (method === 'GET') return true
  // POST：只有「网关门面明确没完成转发」（502/503/504）才重放；200 里带 deadline 的不重放
  return r.status !== undefined && GATEWAY_BAD_GATEWAY.has(r.status)
}

/** 单次 HTTP 请求（含既有的「401 → 续签 → 重试一次」逻辑，那部分语义完全不变） */
async function httpOnce(path: string, init: { method?: 'GET' | 'POST'; body?: Record<string, unknown> } = {}): Promise<HttpResult> {
  const method = init.method ?? 'GET'
  // 401 时最多「续签一次 + 重试一次」，避免在网关异常时反复打
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = getMemberAccessToken()
    if (!token) return { ok: false, code: 'auth_failed', message: tIn(getMainLocale(), 'dm.noTokenHttp'), data: null }
    let res: Response
    try {
      res = await fetch(`${MEMBER_API_BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
    } catch (err) {
      const msg = err instanceof Error ? (err.name === 'TimeoutError' ? tIn(getMainLocale(), 'dm.httpNoResponse', { sec: HTTP_TIMEOUT_MS / 1000 }) : err.message) : String(err)
      audit({ dir: 'out', caller: 'builtin', topic: `http ${method} ${path}`, channelId: null, to: null, bytes: 0, result: 'network_error' })
      // 归一：山海自己 10s abort 时 msg 已是当前语言；网关侧偶发把 Go 原文塞进 err.message，这里一并转掉
      return {
        ok: false,
        code: 'network',
        message: isGatewayDeadlineText(msg)
          ? tIn(getMainLocale(), 'dm.gwNoResult', { sec: HTTP_TIMEOUT_MS / 1000 })
          : tIn(getMainLocale(), 'dm.netFail', { msg }),
        data: null,
        gatewayTimeout: isGatewayDeadlineText(msg),
      }
    }
    if (res.status === 401 || res.status === 403) {
      if (attempt === 0) {
        // 【与 relay 同一套 401 语义】先试续签：成功就带着新 token 重试本次请求，失败才判凭证失效
        const outcome = await handleAuthRejected({ source: 'member-http', status: res.status })
        if (outcome === 'rotated') continue
        if (outcome === 'transient') {
          return { ok: false, code: 'auth_transient', message: tIn(getMainLocale(), 'dm.credExpiredTransient', { reason: describeCredentialState(getCredentialSnapshot()) }), data: null }
        }
      }
      handleCredentialRejected({ k: 'dm.credInvalidHttp', p: { status: res.status } })
      return { ok: false, code: 'auth_failed', message: tIn(getMainLocale(), 'dm.credInvalid'), data: null }
    }
    return await readHttpJson(res, method, path)
  }
  return { ok: false, code: 'auth_failed', message: tIn(getMainLocale(), 'dm.credInvalid'), data: null }
}

/** 解析 HTTP 响应体（从 httpJson 拆出，便于「401 → 续签 → 重试」复用同一段解析） */
async function readHttpJson(res: Response, method: string, path: string): Promise<HttpResult> {
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  const env = (json ?? {}) as Record<string, unknown>
  const code = pickStr(env, ['code', 'error_code', 'errcode'])
  const msg = pickStr(env, ['message', 'msg', 'error']) ?? ''
  // 【识别条件①】body 的 message 字段里是 Go 原文；【识别条件②】或状态码是 502/503/504
  const gatewayTimeout = isGatewayDeadlineText(msg) || GATEWAY_BAD_GATEWAY.has(res.status)
  const bizFail = code !== null && code !== '0'
  if (!res.ok || bizFail) {
    // 定稿：HTTP 侧错误码是 {code:-1,message}，限流靠状态码 429 表达 → 单独给如实文案，不混成「请求失败」
    const known = res.status === 429 ? errText({ k: 'dm.err.rateLimitedHttp' }) : errText(errorCodeSpec(code))
    audit({ dir: 'out', caller: 'builtin', topic: `http ${method} ${path}`, channelId: null, to: null, bytes: 0, result: `fail:${res.status}${code ? ':' + code : ''}${gatewayTimeout ? ':gateway_timeout' : ''}` })
    // 网关超时/不可用一律换成当前语言文案，**不把 Go 原文透到界面上**（用户看到的「context deadline exceeded」就是这里漏的）
    const gwCopy = tIn(getMainLocale(), 'dm.gwUnavailable', { status: res.status })
    return {
      ok: false,
      code: gatewayTimeout ? 'gateway_timeout' : res.status === 429 ? 'rate_limited' : code ?? String(res.status),
      message: gatewayTimeout ? gwCopy : known ?? (msg || tIn(getMainLocale(), 'dm.httpFailStatus', { status: res.status })),
      data: null,
      status: res.status,
      gatewayTimeout,
    }
  }
  audit({ dir: 'out', caller: 'builtin', topic: `http ${method} ${path}`, channelId: null, to: null, bytes: 0, result: 'ok' })
  return { ok: true, code: null, message: msg || 'ok', data: env.data !== undefined ? env.data : json, status: res.status }
}

/** 从 HTTP data 里取数组（兼容裸数组 / {friends} / {list} / {items} / {data} / 再套一层 data） */
function listOf(data: unknown, keys: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>
  const obj = data as Record<string, unknown> | null
  if (!obj || typeof obj !== 'object') return []
  const all = [...keys, 'list', 'items', 'records', 'data']
  for (const k of all) {
    const v = obj[k]
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>
  }
  const inner = obj.data as Record<string, unknown> | undefined
  if (inner && typeof inner === 'object') {
    for (const k of all) {
      const v = inner[k]
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>
    }
  }
  return []
}

/**
 * 【2026-09-04 修复「查找好友点了搜不到」】会员检索专用行归一。
 *
 * 根因：网关 /api/v1/members/search 的 data 是**单个会员对象**，而 /friends、/messages/conversations
 * 的 data 是**裸数组**。真机原文（测试号 A 检索 B）：
 *   GET /api/v1/members/search?keyword=19236419923 → 200
 *   {"code":0,"data":{"memberId":8,"username":"19236419923","nickname":"符生富","avatar":""},"message":"success"}
 * 旧实现复用了 listOf()：它对「对象且不含任何数组字段」一律 return [] → 检索**永远 0 结果**，
 * 且 r.ok 仍是 true（HTTP 200）→ 上层不报错 → 界面表现就是「点了查找搜不到」，一句提示都没有。
 * 用户本机审计日志同样实证：keyword=18688859706 的 search 记的是 result:"ok"（200 成功），界面却说没找到。
 *
 * 归一规则（宁多判一条也不静默吞）：数组直接用 → 含数组字段取该字段 → 本身像会员对象就包成一条。
 */
function memberRows(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>
  const obj = data as Record<string, unknown> | null
  if (!obj || typeof obj !== 'object') return []
  for (const k of ['members', 'users', 'result', 'list', 'items', 'records']) {
    const v = obj[k]
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>
  }
  // 网关若哪天改成再套一层 {data:{memberId…}}，这里也接得住
  const inner = obj.data
  if (inner && typeof inner === 'object' && pickStr(inner as Record<string, unknown>, ['memberId', 'member_id', 'id'])) {
    return [inner as Record<string, unknown>]
  }
  if (pickStr(obj, ['memberId', 'member_id', 'id'])) return [obj]
  return []
}

function mapFriend(raw: Record<string, unknown>): DmFriend {
  return {
    memberId: pickStr(raw, ['memberId', 'member_id', 'targetMemberId', 'user_id', 'id']) ?? '',
    username: pickStr(raw, ['username', 'account', 'name', 'userName']) ?? '',
    nickname: pickStr(raw, ['nickname', 'nick', 'displayName']) ?? undefined,
    online: pickBool(raw, ['online', 'isOnline', 'active']),
    // 【真头像】网关字段名实测为 avatar（空串已被 pickStr 归成 null）；顺带兼容几种常见别名写法。
    // 好友列表 / 检索结果 / 申请方 requester 都走这里 → 一处解析，三处受益。
    avatar: pickStr(raw, ['avatar', 'avatarUrl', 'avatar_url', 'headImgUrl', 'headimgurl', 'portrait']) ?? undefined,
  }
}

function mapRequest(raw: Record<string, unknown>): DmFriendRequest {
  // 定稿契约：通知载荷是 {requester:{memberId,...}, requestMsg, requestAt}；HTTP 列表字段名需网关确认，两种都兼容
  const req = (raw.requester && typeof raw.requester === 'object' ? raw.requester : raw) as Record<string, unknown>
  const from = mapFriend(req)
  return {
    requestId: pickStr(raw, ['requestId', 'request_id', 'id']) ?? `${from.memberId}-${pickNum(raw, ['requestAt', 'createdAt', 'ts']) ?? Date.now()}`,
    fromMemberId: from.memberId,
    // 【期5B-补漏】`|| from.memberId` 会把 memberId 直接印到好友申请列表的「账号：X」行
    // （MemberPanel 的 common.usernameLine）与好友申请通知标题上 → 去掉，拿不到就是空串。
    fromUsername: realNameOrEmpty(from.username, from.memberId),
    fromNickname: from.nickname,
    fromAvatar: from.avatar, // 【真头像】requester 里带的头像透传给申请列表
    message: pickStr(raw, ['requestMsg', 'message', 'msg']) ?? undefined,
    // requestAt 走 HTTP 是 Unix 秒、走 ws 通知是毫秒 → 统一归一到毫秒
    ts: toMs(pickNum(raw, ['requestAt', 'createdAt', 'ts', 'time'])),
  }
}

/** 拉好友列表 + 待处理申请 + 红点数（HTTP，契约 v1 定稿：好友操作不走 ws） */
async function pullFriends(): Promise<HttpResult> {
  const fr = await httpJson(PATH_FRIENDS)
  if (fr.ok) friends = listOf(fr.data, ['friends']).map(mapFriend).filter((f) => f.memberId)
  const rq = await httpJson(PATH_FRIEND_REQUESTS)
  if (rq.ok) requests = listOf(rq.data, ['requests']).map(mapRequest).filter((r) => r.fromMemberId)
  const cn = await httpJson(PATH_FRIEND_REQUESTS_COUNT)
  if (cn.ok) {
    const n = pickNum((cn.data ?? {}) as Record<string, unknown>, ['count', 'total', 'num']) ?? (typeof cn.data === 'number' ? cn.data : null)
    if (n !== null) requestsCount = n
  }
  saveStore()
  broadcastFriends()
  return fr.ok ? (rq.ok ? fr : rq) : fr
}

/** 拉会话列表（含每会话未读，HTTP）：与本地缓存合并，未读以网关为权威 */
async function pullConversations(): Promise<HttpResult> {
  const r = await httpJson(PATH_CONVERSATIONS)
  if (!r.ok) return r
  for (const raw of listOf(r.data, ['conversations', 'threads'])) {
    const channelId = pickStr(raw, ['channelId', 'channel_id']) ?? ''
    if (!channelId) continue
    // 定稿 v1.1 结构：{channelId, peer:{memberId,username,nickname,avatar}, lastMsg, lastMsgAt, unreadCount}
    const peerObj = (raw.peer && typeof raw.peer === 'object' ? raw.peer : raw) as Record<string, unknown>
    const peerId = pickStr(peerObj, ['memberId', 'member_id', 'peerMemberId', 'peerId', 'targetMemberId']) ?? ''
    // 【期5B-补漏】去掉末位 `?? peerId`：peerName 会落盘 dm-store.json 并显示在会话列表，
    // 之前昵称/用户名/好友表三处都拿不到时就把 memberId 当名字存下来。现在拿不到 → 空串，
    // 渲染层 displayNameOf(空串, peerId) 显示「未知会员」；peerId 单独存，定位/比对不受影响。
    const peerName = realNameOrEmpty(pickStr(peerObj, ['nickname', 'username', 'peerName', 'peerNickname']) ?? friendNameOf(peerId) ?? undefined, peerId)
    // 【真头像】peer.avatar（定稿 v1.1 结构里本来就有这个字段，实测常为空串）→ 空串视为无头像，
    // 再从本地好友表兜一次；两处都拿不到就交给界面回落首字占位，不猜图。
    const peerAvatar = pickStr(peerObj, ['avatar', 'avatarUrl', 'avatar_url', 'headImgUrl', 'portrait']) ?? friendAvatarOf(peerId)
    const t = ensureThread(channelId, peerId, peerName, peerAvatar)
    const unread = pickNum(raw, ['unreadCount', 'unread', 'unread_count'])
    if (unread !== null) t.unread = unread
    // lastMsgAt 是 Unix 秒 → 归一到毫秒后再参与排序（会话列表按 lastTs 倒序）
    const lastTs = toMs(pickNum(raw, ['lastMsgAt', 'lastTs', 'lastActiveAt', 'updatedAt', 'ts']), 0)
    if (lastTs > t.lastTs) t.lastTs = lastTs
  }
  saveStore()
  broadcastUnread()
  return r
}

/** 上线补拉（契约 v1：网关无消息队列、member_online/offline 未实现，离线数据只能靠主动 pull） */
async function backfillFromHttp(): Promise<void> {
  if (pulling) return
  // 【闪烁修复】重连一次就全量补拉 6+ 个接口并把结果广播出去；通道每 ~80 秒重连时会形成持续风暴。
  // 距上次补拉不足 BACKFILL_MIN_INTERVAL_MS 直接跳过（数据已在内存/落盘，界面不会因此变旧）。
  const since = Date.now() - lastBackfillAt
  if (lastBackfillAt > 0 && since < BACKFILL_MIN_INTERVAL_MS) {
    audit({ dir: 'out', caller: 'backfill', topic: 'backfill', bytes: 0, result: `skipped_throttle_${Math.round(since)}ms` })
    return
  }
  lastBackfillAt = Date.now()
  pulling = true
  try {
    await pullFriends()
    await pullConversations()
    const targets = [...threads.values()].filter((t) => t.unread > 0).sort((a, b) => b.lastTs - a.lastTs).slice(0, 10)
    for (const t of targets) await pullHistory({ channelId: t.channelId, peerId: t.peerId, page: 1, pageSize: HISTORY_PAGE_SIZE })
    // 全局未读以网关为权威（定稿新增 GET /api/v1/messages/unread → {count}）
    await pullGlobalUnread()
  } finally {
    pulling = false
  }
}

// ————————————————————————————— 持久化 —————————————————————————————

interface PersistedStore {
  schemaVersion: number
  self: { memberId: string | null; username: string | null }
  friends: DmFriend[]
  requests: DmFriendRequest[]
  threads: DmThread[]
  updatedAt: number
}

function loadStore(): void {
  try {
    const raw = readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedStore>
    friends = Array.isArray(parsed.friends) ? parsed.friends : []
    requests = Array.isArray(parsed.requests) ? parsed.requests : []
    threads.clear()
    for (const t of Array.isArray(parsed.threads) ? parsed.threads : []) {
      if (t && typeof t.channelId === 'string') threads.set(t.channelId, { ...t, messages: Array.isArray(t.messages) ? t.messages : [] })
    }
  } catch {
    // 无文件 / 损坏：以空库启动（不影响重新拉取好友与历史）
  }
}

let saveTimer: NodeJS.Timeout | null = null

/** 落盘（合并写：高频到达时最多 300ms 写一次，避免每条消息都同步写文件） */
function saveStore(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void doSave()
  }, 300)
  saveTimer.unref?.()
}

async function doSave(): Promise<void> {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const list: DmThread[] = []
    for (const t of threads.values()) {
      const trimmed = t.messages.length > MAX_PERSIST_MESSAGES ? t.messages.slice(-MAX_PERSIST_MESSAGES) : t.messages
      list.push({ ...t, messages: trimmed.map((m) => ({ ...m, pending: false })) })
    }
    const snapshot: PersistedStore = {
      schemaVersion: 1,
      self: { memberId: selfMemberId, username: getRuntime().username },
      friends,
      requests,
      threads: list,
      updatedAt: Date.now(),
    }
    writeFileSync(storePath(), JSON.stringify(snapshot), 'utf8')
  } catch (err) {
    console.warn('[member-channel] 私信库落盘失败:', err)
  }
}

// ————————————————————————————— 广播 —————————————————————————————

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win, channel, payload)
  }
}

/** 清理已销毁窗口的订阅 id（窗口关闭没有可靠的 app 级事件，改为投递前惰性回收，避免死 id 堆积） */
function pruneDeadSubscribers(): void {
  const alive = new Set<number>()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) alive.add(win.webContents.id)
  }
  for (const [channelId, ids] of subscribers) {
    for (const id of ids) {
      if (!alive.has(id)) ids.delete(id)
    }
    if (ids.size === 0) subscribers.delete(channelId)
  }
}

/** 定向投递给「订阅了该 channelId」的窗口（未订阅一律不投；落盘/未读/通知不依赖订阅，见文件头说明） */
function deliverToSubscribers(channelId: string, event: string, payload: unknown): void {
  pruneDeadSubscribers()
  const ids = subscribers.get(channelId)
  if (!ids || ids.size === 0) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    if (ids.has(win.webContents.id)) safeSend(win, event, payload)
  }
}

export function getMemberStatus(): MemberChannelStatus {
  const memberId = resolveSelfMemberId()
  return {
    enabled,
    connected,
    ready: connected && Boolean(memberId),
    url: memberUrl,
    username: getRuntime().username,
    memberId,
    error: errText(channelErrorSpec),
    authFailed,
    subscribedChannels: [...subscribers.keys()],
    updatedAt: statusUpdatedAt,
  }
}

/** 出口取词：按当前主进程语言把结构还原成文案（null 原样回 null，不造空串） */
function errText(spec: ErrSpec | null): string | null {
  return spec ? tIn(getMainLocale(), spec.k, spec.p) : null
}

/** 内容指纹用的结构串：**与语言无关**，所以切语言不会让指纹变化（去重语义不受影响） */
function errFp(spec: ErrSpec | null): string {
  return spec ? `${spec.k}|${JSON.stringify(spec.p ?? {})}` : ''
}

/**
 * @param force 语言变化时用：指纹不变也必须推一次，否则界面停在旧语言的错误文案。
 *              只有「用户主动切语言」会传 true，重连风暴仍走指纹去重。
 */
function broadcastStatus(force = false): void {
  const st = getMemberStatus()
  const fp = [
    st.enabled, st.connected, st.ready, st.authFailed,
    st.username ?? '', st.memberId ?? '', errFp(channelErrorSpec),
    [...subscribers.keys()].sort().join(','),
  ].join('|')
  if (fp === lastStatusFp && !force) return // 内容未变：不推（时间戳不算变化）
  lastStatusFp = fp
  statusUpdatedAt = Date.now()
  broadcast('member:status', { ...st, updatedAt: statusUpdatedAt })
}

/**
 * 【i18n 期5B】语言变化时把通道状态重推一次。
 * 为什么必须推：顶部那条提示条的文字是主进程给的（st.error / cred.text），渲染层没有原文，
 * 不重推就会一直停在旧语言。为什么不会闪：只有用户主动切语言才走到这里（一次），
 * 重连风暴仍被 errFp 结构指纹去重 —— 任务59 消掉的重复广播不会被这次改动请回来。
 */
onMainLocaleChange(() => {
  if (!enabled) return // 通道没启用：没有可刷新的文案，也不该凭空推一条 status
  broadcastStatus(true)
})

/** 清掉系统级角标（退出登录 / 通道关闭时调用，避免「已退出还挂着未读数」） */
function clearUnreadBadge(): void {
  try {
    if (process.platform === 'darwin' && app.dock) void app.dock.setBadge('')
    else void app.setBadgeCount(0)
  } catch {
    // 平台不支持角标：忽略
  }
}

function broadcastUnread(): void {
  const byChannel: Record<string, number> = {}
  let total = 0
  for (const t of threads.values()) {
    if (t.unread > 0) {
      byChannel[t.channelId] = t.unread
      total += t.unread
    }
  }
  const snapshot = { total, byChannel } satisfies DmUnread
  const fp = `${total}|${Object.keys(byChannel).sort().map((k) => `${k}:${byChannel[k]}`).join(',')}`
  if (fp !== lastUnreadFp) {
    lastUnreadFp = fp
    broadcast('member:unread', snapshot)
  }
  // 系统级徽标：macOS Dock 角标显示未读总数（Windows/Linux 的 setBadgeCount 不支持时静默忽略）
  try {
    if (process.platform === 'darwin' && app.dock) void app.dock.setBadge(total > 0 ? (total > 99 ? '99+' : String(total)) : '')
    else void app.setBadgeCount(total)
  } catch {
    // 平台不支持角标：不影响私信功能，忽略
  }
  // 进程内订阅者：托盘菜单文案 + macOS Dock 角标（渲染层之外的系统级提醒）
  for (const cb of unreadWatchers) {
    try {
      cb(snapshot)
    } catch (err) {
      console.warn('[member-channel] 未读订阅者回调异常:', err)
    }
  }
}

/** 订阅未读变化（index.ts 注册：刷新托盘「私信未读」菜单项与 macOS Dock 角标） */
export function subscribeMemberUnread(cb: (u: DmUnread) => void): () => void {
  unreadWatchers.add(cb)
  cb(getUnread())
  return () => {
    unreadWatchers.delete(cb)
  }
}

function broadcastFriends(): void {
  // 红点单独带上 requestCount：列表可能被分页截断，红点以 /friends/requests/count 为权威
  // 【真头像·必须纳入指纹】avatar 不在指纹里的话，「好友换了头像」会被判成内容未变而**永不推送**，
  // 界面头像就再也不更新（任务59 的广播去重反噬）。requests 同理带上 fromAvatar。
  const fp = [
    friends.map((f) => `${f.memberId}:${f.nickname ?? ''}:${f.username ?? ''}:${f.avatar ?? ''}`).join(','),
    requests.map((r) => `${r.requestId}:${r.fromMemberId}:${r.ts}:${r.fromAvatar ?? ''}`).join(','),
    requestsCount,
  ].join('#')
  if (fp === lastFriendsFp) return // 内容未变：不推（ts 不算变化）
  lastFriendsFp = fp
  broadcast('member:friends', { friends, requests, requestCount: requestsCount, ts: Date.now() })
}

// ————————————————————————————— 连接 —————————————————————————————

function sendEnvelope(env: MemberEnvelope): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  try {
    ws.send(JSON.stringify(env))
    return true
  } catch (err) {
    console.warn('[member-channel] 发送失败:', err)
    return false
  }
}

/**
 * 组装并发送一个上行信封。
 *
 * 【2026-09-04 真机联调修正 —— 阻断级 bug】网关信封的 `from` / `to` 是**数值类型**（Go uint），
 * 而本模块内部 memberId 一律以字符串存储（便于拼 channelId、对齐 HTTP DTO）。
 * 旧实现把字符串直接塞进信封（from:"1" / to:"999999"），网关 JSON 反序列化失败，回的是
 * `error{code:"protocol_unsupported", message:"invalid message payload"}` —— 实测后果是
 * **所有上行帧全被拒**（send / subscribe / leave / mark_read / heartbeat 无一幸免），
 * 也就是私信完全发不出去、订阅不上、已读上报无效（上轮审计日志里 heartbeat 与 error 1:1
 * 共 68 对，真因就是这个，与 payload 内容无关）。
 * 同一连接上逐字段隔离实证（每次只改一个字段）：
 *   from:"1"    → ❌ invalid message payload   ｜ from:1 或不带 from → ✅
 *   to:"999999" → ❌ invalid message payload   ｜ to:999999 → ✅（走到 friend_required 业务判定）
 *   payload:{ts:…} / {reconnect:true} / {messageId:…} → 均 ✅（证明与 payload 字段无关）
 * 因此：① **不再上行 from**（契约 v1.1 明确「from 一律以连接鉴权身份为准，客户端传了也无效」，
 * 传了只会踩类型坑）；② `to` 能转数字就转、转不了就不带，让网关按业务错误如实回，
 * 而不是把脏字符串塞进信封导致整帧解析失败。
 */
function toNumericId(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 【2026-09-04 真机联调修正】HTTP 侧的 memberId 同样必须是**数值**。
 * 网关 friends 接口的 targetMemberId 是 Go uint，山海原本传字符串，实测被拒：
 *   POST /api/v1/friends/request {targetMemberId:"8"}
 *   → HTTP 400 {"code":-1,"message":"请求参数错误: json: cannot unmarshal string into Go struct field .targetMemberId of type uint"}
 * （与 ws 信封 from/to 是同一类「字符串 vs uint」问题，故一并收紧。）
 * 转不成正整数时直接拒发并给如实文案，绝不把脏字符串发出去。
 */
function requireNumericMemberId(value: string): number {
  const n = toNumericId(value)
  if (n === null) {
    // 【2026-09-04 用户要求：私信界面不再显示会员ID】原始值只进日志，不进用户可见文案
    console.warn(`[member] 会员标识不是合法正整数，已拒绝发送：${value}`)
    throw new Error(tIn(getMainLocale(), 'dm.memberIdRejected'))
  }
  return n
}

function out(type: string, channelId: string | null, payload?: Record<string, unknown>, to?: string | null, caller = 'builtin'): boolean {
  seq += 1
  const env: MemberEnvelope = {
    v: PROTOCOL_V,
    type,
    seq,
    channelId,
    // from 故意不下发：网关以连接鉴权身份为准（字符串类型会让整帧解析失败，见上方说明）
    to: toNumericId(to),
    payload: payload ?? {},
    ts: Date.now(),
  }
  const ok = sendEnvelope(env)
  audit({ dir: 'out', caller, topic: type, channelId, to, bytes: byteLen(JSON.stringify(env)), result: ok ? 'sent' : 'not_connected' })
  return ok
}

function startPing(): void {
  stopPing()
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.ping()
  }, PING_INTERVAL_MS)
  pingTimer.unref?.()
}

function stopPing(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

function startHeartbeat(): void {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    // 心跳不带 channelId、payload 留空即可（契约 heartbeat 只用于续读超时，无回包）。
    out('heartbeat', null)
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()
}



function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function scheduleReconnect(): void {
  if (authFailed) return // 凭证失效：不再重连，等用户重新登录
  if (reconnectTimer) return
  const exp = Math.min(RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_DELAY_MS)
  const jitter = exp * (0.8 + Math.random() * 0.4)
  reconnectAttempts += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, Math.round(jitter))
}

/**
 * 连接建立后：① 重新订阅本地已知通道（恢复实时推送）；② 走 HTTP 主动补拉好友 / 会话列表 / 未读 /
 * 离线期间的消息（契约 v1：网关无消息队列，member_online/offline 也未实现，只能主动 pull）。
 */
function resubscribeAll(): void {
  // 重连自动订阅：不登记到 userInitiatedSubscribe → subscribed 回执保持静默（否则每次重连都冒一条提示）
  for (const channelId of threads.keys()) out('subscribe', channelId, { reconnect: true })
  void backfillFromHttp()
}

function connect(): void {
  // 凭证统一从 member-credentials 取（与远程控制同一份会员 JWT，续签后自动读到新值）
  const token = getMemberAccessToken()
  if (!token) {
    connected = false
    channelErrorSpec = { k: 'dm.notLoggedInChannel' }
    return
  }
  const snap = getCredentialSnapshot()
  if (snap.state === 'expired') {
    // 【启动即已过期】不直接拿过期 token 去握手（必 401），先交给续签模块试一次宽限期续签
    channelErrorSpec = { k: 'dm.credExpiredRenewing', p: { reason: describeCredentialState(snap) } }
    broadcastStatus()
    void handleAuthRejected({ source: 'member-channel', status: 401, code: 'token_expired' }).then((outcome) => {
      if (outcome === 'rotated' && enabled) connect()
    })
    return
  }
  selfMemberId = resolveSelfMemberId()
  const info = getRuntime().getDeviceInfo()
  const params = new URLSearchParams({
    role: 'member',
    token,
    deviceId: info.deviceId ?? '',
    deviceName: info.deviceName ?? '',
    hostname: info.hostname ?? '',
    os: info.os ?? '',
    v: String(PROTOCOL_V),
  })
  // 【闪烁修复·socket 泄漏】connect() 此前不关旧连接：任何重复调用（重连与续签重连交叠、
  // 上一次握手未完成的窗口里又被调一次）都会留下一个「没人持有但仍在收 ping」的旧 socket。
  // 同账号同 deviceId 的两条 member 连接会被网关逐条替换 → 表现为每 ~80 秒断一次、
  // 审计里 ping 间隔从 30 秒变成 13-17 秒（两条连接的 ping 交错），每次断连又触发一轮
  // 状态广播 + 订阅回执 + 全量补拉 → 界面反复重绘与提示条反复出现（用户看到的「一闪一闪」）。
  if (ws) {
    const stale = ws
    ws = null
    try {
      stale.removeAllListeners()
      if (stale.readyState === WebSocket.OPEN || stale.readyState === WebSocket.CONNECTING) stale.terminate()
    } catch {
      // 忽略：旧连接清理失败不能挡住新连接建立
    }
  }
  let sock: WebSocket
  try {
    sock = new WebSocket(`${memberUrl}?${params.toString()}`)
  } catch (err) {
    channelErrorSpec = { k: 'dm.channelCreateFailed', p: { msg: err instanceof Error ? err.message : String(err) } }
    broadcastStatus()
    return
  }
  ws = sock

  sock.on('open', () => {
    connected = true
    reconnectAttempts = 0
    authFailed = false
    channelErrorSpec = null
    startPing()
    startHeartbeat()
    resubscribeAll()
    broadcastStatus()
  })

  sock.on('message', (raw) => {
    let env: MemberEnvelope
    try {
      env = JSON.parse(raw.toString()) as MemberEnvelope
    } catch {
      return // 非 JSON：丢弃（不猜测语义）
    }
    handleDownstream(env, Buffer.byteLength(raw as never))
  })

  /**
   * 握手被 HTTP 拒绝（含 401）：定稿已把 ws 401 改为 JSON body {code: token_missing|token_expired|token_invalid}。
   * Node ws 在升级响应非 101 时触发 unexpected-response，此时能读到 body（err.message 不含 code），
   * 因此「启动即过期」与「无效凭证」可以区分对待；注册本监听后需自行 abort 握手。
   */
  sock.on('unexpected-response', (req, res) => {
    void readRejectBody(res).then(({ status, code }) => {
      try {
        req.abort()
      } catch {
        // 忽略：连接已由 ws 内部清理
      }
      void onRejected(status, code)
    })
  })

  sock.on('close', (code, reason) => {
    // 【诊断】此前 close 不写审计，导致「通道每 ~80 秒断一次」在日志里完全看不到原因
    audit({
      dir: 'in',
      caller: 'ws',
      topic: 'close',
      bytes: 0,
      result: `code=${code} reason=${(reason?.toString?.() ?? '').slice(0, 80) || '-'}`,
    })
    connected = false
    ws = null
    stopPing()
    stopHeartbeat()
    if (enabled && !pendingAuthRecovery) scheduleReconnect()
    broadcastStatus()
  })

  sock.on('error', (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[member-channel] 会员通道连接错误:', msg)
    if (/401|unauthorized/i.test(msg)) {
      void onRejected(401, null)
      return
    }
    if (!pendingAuthRecovery) {
      channelErrorSpec = { k: 'dm.channelConnectFailed', p: { msg } }
      broadcastStatus()
    }
  })
}

/**
 * 【401 状态机（与 remote-relay 同一套语义、共用 member-credentials 的续签实现）】
 * 401 → 先试 refresh（宽限期内必成）→ 成功带新 token 立即重连 → 只有 refresh 也失败才落到「凭证失效，请重新登录」。
 * token_missing / token_invalid 由 member-credentials 直接判「不可恢复」，不白试 refresh。
 */
async function onRejected(status: number, code: string | null): Promise<void> {
  if (pendingAuthRecovery) return
  pendingAuthRecovery = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  channelErrorSpec = { k: 'dm.channelRejected', p: { detail: `HTTP ${status || 401}${code ? ` ${code}` : ''}` } }
  broadcastStatus()
  const outcome = await handleAuthRejected({ source: 'member-channel', status, code })
  pendingAuthRecovery = false
  if (outcome === 'rotated') {
    authFailed = false
    channelErrorSpec = null
    reconnectAttempts = 0
    if (enabled) connect()
    return
  }
  if (outcome === 'invalid') {
    authFailed = true
    return
  }
  // transient：网关未部署 / 断网 / 5xx → 保留登录态，按退避继续重连
  channelErrorSpec = { k: 'dm.renewIncomplete', p: { reason: describeCredentialState(getCredentialSnapshot()) } }
  if (enabled) scheduleReconnect()
  broadcastStatus()
}

/** 凭证轮换后的立即重连（index.ts 订阅 credential 状态时调用） */
export function reconnectMemberChannelWithFreshCredential(): MemberChannelStatus {
  if (!enabled || pendingAuthRecovery) return getMemberStatus()
  return retryMemberChannel()
}

/**
 * 【401 与全局登录态联动】——刻意避免重犯 remote-relay 的老问题
 * （remote-relay.ts 未 import ui-store，401 只改自己的 authFailed，Dock/桌面壳仍显示「已登录」）。
 * 这里凭证被网关判定失效时，直接把全局登录态翻成未登录（与 ui-store 的 runtime.onAuthExpired
 * 处理保持同一形态：loggedIn=false + username=null + models=[]），并停掉本通道重连。
 * 不调用 runtime.logout()：那会删除本地凭证，用户重开应用就得重新输账号密码；
 * 现状 onAuthExpired 同样只翻 UI 状态、保留本地凭证，行为一致。
 */
function handleCredentialRejected(reason: ErrSpec, code: string | null = 'auth_failed'): void {
  authFailed = true
  reconnectAttempts = 0
  channelErrorSpec = reason
  // markCredentialInvalid 要的是字符串（它 own 的 lastError 字段属 member-credentials 的文案面）：
  // 这里在**调用那一刻**求值，与下面 member:error 广播同源同刻，不会出现两条文案打架
  const reasonText = errText(reason) ?? ''
  // 翻转全局登录态 + 广播一律走 member-credentials 的同一处实现（避免 relay/私信两套行为漂移）
  markCredentialInvalid(reasonText, code)
  broadcastStatus()
  broadcast('member:error', { code: code ?? 'auth_failed', message: reasonText, channelId: null } satisfies MemberErrorPayload)
}

/**
 * 错误码 → 词条 key（如实分类，不统一塞成「连不上服务器」）。
 * 【i18n 期5B】原来这张表存的是**已取好的中文文案**，模块加载期就固化 —— 与历轮 STATUS_LABEL /
 * TOOL_META / SUPERVISOR_ARG_LABELS 是同一个坑（第 9 次）。现在表里只存 key，
 * 由 errorCodeSpec/errText 在出口按当前语言求值；带数量的两条（字节上限）走 {n} 参数，
 * 不在代码里拼「N 字节」（英文无量词，拼出来就是病句）。
 */
const ERROR_COPY: Record<string, string> = {
  auth_failed: 'dm.err.authFailed',
  friend_required: 'dm.err.friendRequired',
  rate_limited: 'dm.err.rateLimited',
  member_not_found: 'dm.err.memberNotFound',
  message_too_large: 'dm.err.messageTooLarge',
  // 网关当前不返回此码（任务115 实证：网关全仓 content_too_long 零命中）；保留映射以防将来新增
  content_too_long: 'dm.err.contentTooLong',
  protocol_unsupported: 'dm.err.protocolUnsupported',
  channel_not_found: 'dm.err.channelNotFound',
  token_expired: 'dm.err.tokenExpired',
  token_missing: 'dm.err.tokenMissing',
  token_invalid: 'dm.err.tokenInvalid',
  rate_limited_http: 'dm.err.rateLimitedHttp',
}

/** 网关 code → 未翻译的错误结构（未知 code 返回 null，交给调用方兜底原样呈现网关 msg） */
function errorCodeSpec(code: string | null): ErrSpec | null {
  const k = code ? ERROR_COPY[code] : undefined
  if (!k) return null
  // 只有这两条要带字节上限参数；其余无参
  return code === 'message_too_large' || code === 'content_too_long' ? { k, p: { n: MAX_MSG_BYTES } } : { k }
}

/** 下行 error 事件载荷 */
export interface MemberErrorPayload {
  code: string
  message: string
  channelId: string | null
}

/**
 * 解析网关 error 下行。
 * 【2026-09-04 真机联调修正】网关实际帧形是**平铺在信封顶层**、且不带 payload：
 *   {"type":"error","code":"friend_required","message":"需要先成为好友","timestamp":1788490189102}
 * 旧实现只从 env.payload 取 code/message → 恒为 'unknown'，后果有两层：
 *   ① 所有业务错误（friend_required / rate_limited / message_too_large / channel_not_found /
 *      protocol_unsupported）在界面上都退化成笼统的「会员通道返回错误」，用户看不到真实原因；
 *   ② 更要命的是 auth_failed / token_missing / token_invalid 的 in-band 分支永远进不去，
 *      「凭证失效联动全局登录态」这条路径形同死代码。
 * 现按「顶层优先、payload 兜底」双取，两种帧形都兼容（网关若改回 payload 也不破）。
 */
function normalizeErrorPayload(env: MemberEnvelope): { payload: MemberErrorPayload; spec: ErrSpec } {
  const p = (env.payload ?? {}) as Record<string, unknown>
  const top = env as unknown as Record<string, unknown>
  const code = pickStr(top, ['code', 'errcode', 'error_code']) ?? pickStr(p, ['code', 'errcode', 'error_code', 'reason']) ?? 'unknown'
  const raw = pickStr(top, ['message', 'msg', 'error', 'detail']) ?? pickStr(p, ['message', 'msg', 'error', 'detail']) ?? ''
  // 【识别条件③】ws 下行 error 的**顶层** code/message 里可能就是网关的 Go 原文（顶层优先取，这条本项目踩过）。
  // 命中就换成当前语言文案，绝不透传英文、也绝不退化成「会员通道返回错误」这种笼统话。
  const gwTimeout = isGatewayDeadlineText(raw) || isGatewayDeadlineText(code)
  // 先算**结构**：payload 里的译文是「发出那一刻」的语言（一次性事件，渲染层直接显示）；
  // spec 则会被 channelError 长期持有，切语言时由 onMainLocaleChange 重新求值。
  const spec: ErrSpec = gwTimeout
    ? { k: 'dm.err.gwUpstreamTimeout' }
    : errorCodeSpec(code) ?? (raw ? { k: 'dm.netFail', p: { msg: raw } } : { k: 'dm.err.channelGeneric' })
  const payload: MemberErrorPayload = {
    code: gwTimeout ? 'gateway_timeout' : code,
    message: errText(spec) ?? '',
    channelId: env.channelId ?? pickStr(p, ['channelId', 'channel_id']) ?? null,
  }
  return { payload, spec }
}

// ————————————————————————————— 下行处理 —————————————————————————————

function ensureThread(channelId: string, peerId: string, peerName: string, peerAvatar?: string): DmThread {
  let t = threads.get(channelId)
  if (!t) {
    t = { channelId, peerId, peerName, messages: [], unread: 0, lastTs: 0 }
    threads.set(channelId, t)
  }
  if (peerName && t.peerName !== peerName) t.peerName = peerName
  // 【真头像】只在拿到非空 URL 时覆盖：网关该字段实测常为空串，若让空串也覆盖会把已有头像抹掉，
  // 表现为「头像在图与首字之间来回跳」—— 正是任务59 刚消掉的那类闪烁，不能重演。
  if (peerAvatar && t.peerAvatar !== peerAvatar) t.peerAvatar = peerAvatar
  return t
}

function friendNameOf(memberId: string): string | null {
  const f = friends.find((x) => x.memberId === memberId)
  if (!f) return null
  // 【期5B-补漏】末位 `|| f.memberId` 是**所有 ID 泄漏的源头**：好友昵称与用户名都为空时，
  // 它把 memberId 当名字返回，再被下面各条路径写进 peerName / fromName / 通知标题。
  // 改成拿不到真名就返回 null（语义「不知道是谁」），由调用方决定显示兜底。
  return realNameOrEmpty(f.nickname || f.username, f.memberId) || null
}

/** 【真头像】从本地好友表取头像（会话/消息路径上没有 peer 对象时兜底）；空串按「无头像」返回 undefined */
function friendAvatarOf(memberId: string): string | undefined {
  const f = friends.find((x) => x.memberId === memberId)
  return f?.avatar || undefined
}

function handleDownstream(env: MemberEnvelope, rawBytes: number): void {
  const p = (env.payload ?? {}) as Record<string, unknown>
  const type = env.type ?? ''
  // bytes = 这一帧的**真实字节数**（旧实现记的是 payload 对象 JSON 长度，ping 会被记成 2，不可用于流量/配额判断）
  audit({ dir: 'in', caller: 'gateway', topic: type, channelId: env.channelId ?? null, to: idStr(env.to) || null, bytes: rawBytes, result: 'recv' })

  // 网关若在任意回执里下发本账号 memberId，以它为准（权威覆盖本地解码值）
  const selfFromGateway = pickStr(p, ['selfMemberId', 'self_member_id', 'selfId', 'self'])
  if (selfFromGateway && !selfMemberIdFromGateway) {
    selfMemberId = selfFromGateway
    selfMemberIdFromGateway = true
  }

  switch (type) {
    // ↓↓↓ 定稿契约 v1：好友列表 / 会话列表 / 未读 / 离线补拉一律走 HTTP（见 pullFriends / pullConversations /
    //     pullHistory），ws 只承载 message 与三类好友事件通知。member_online / member_offline / ack / notify /
    //     seq_gap 网关未实现，本模块一律不解析、不依赖，收到也只会走 default 记日志。
    case 'friend_request_received': {
      // 载荷 {requester:{memberId,...}, requestMsg, requestAt}；兼容旧式平铺字段
      const req = mapRequest(p)
      if (!req.fromMemberId) return
      if (!requests.some((r) => r.requestId === req.requestId)) requests = [req, ...requests]
      requestsCount = requests.length
      saveStore()
      broadcastFriends()
      // 【期5B-补漏】同上：申请方两个名字字段都空时，原先会把 memberId 当标题发进系统通知
      // （fromUsername 现在虽已不含 memberId，这里仍统一过一层 displayNameOf，判定只留一份实现）。
      notifyFriendRequest(displayNameOf(req.fromNickname || req.fromUsername, req.fromMemberId), () =>
        broadcast('member:open-tab', { tab: 'friends', ts: Date.now() }),
      )
      // 红点策略：事件驱动 —— 收到申请通知后立刻用 HTTP 权威列表校正一次（不轮询，见回传说明）
      void pullFriends()
      return
    }

    case 'friend_request_result': {
      // 载荷 {addressee, accepted}：我发出的申请被受理/拒绝，如实广播并拉一次好友列表
      const accepted = pickBool(p, ['accepted', 'ok', 'success']) ?? true
      const peer = pickStr(p, ['addressee', 'memberId', 'username']) ?? ''
      broadcast('member:notice', {
        kind: 'friend_request_result',
        ok: accepted,
        peer,
        // 「（对方名）」是中文全角括号包裹，英文要半角 → 括号也进词条，不在代码里拼
        message: accepted
          ? tIn(getMainLocale(), 'dm.notice.friendAccepted', { peer: peer ? tIn(getMainLocale(), 'dm.notice.friendAcceptedParen', { peer }) : '' })
          : tIn(getMainLocale(), 'dm.notice.friendRejected'),
        ts: Date.now(),
      })
      void pullFriends()
      return
    }

    case 'friend_removed': {
      // 载荷 {removedBy}：硬删、双向解除；本地历史保留（只是不能再发），如实告知
      const by = pickStr(p, ['removedBy', 'memberId', 'from']) ?? ''
      if (!by) return
      friends = friends.filter((f) => f.memberId !== by)
      saveStore()
      broadcastFriends()
      broadcast('member:notice', {
        kind: 'friend_removed',
        peer: by,
        message: tIn(getMainLocale(), 'dm.notice.friendRemoved'),
        ts: Date.now(),
      })
      return
    }

    case 'connected': {
      // 定稿 v1.1：role=member 握手成功后【必带】payload.selfMemberId —— 本账号会员 id 的唯一权威来源
      const sid = pickStr(p, ['selfMemberId', 'self_member_id'])
      if (sid && sid !== selfMemberId) {
        selfMemberId = sid
        selfMemberIdFromGateway = true
        // 握手前本地缓存的线程可能因 self 未知而被误判归属，这里补一次订阅 + 补拉
        resubscribeAll()
      }
      broadcastStatus()
      return
    }

    case 'subscribed':
    case 'left': {
      // subscribed：订阅成功；left：取消订阅回执（定稿已实现，无需额外动作，静默处理避免刷屏）
      if (type === 'subscribed') {
        // 只有「用户主动点开某个会话」触发的 subscribed 才提示；重连自动订阅一律静默
        const sid = env.channelId ?? ''
        const at = sid ? userInitiatedSubscribe.get(sid) : undefined
        if (at !== undefined) {
          userInitiatedSubscribe.delete(sid)
          broadcast('member:notice', { kind: 'subscribed', peer: threads.get(sid)?.peerName ?? '', message: tIn(getMainLocale(), 'dm.notice.subscribed'), ts: Date.now() })
        }
      }
      return
    }

    case 'ping': {
      // 网关每 30 秒一次的应用层 ping：只用于证明连接活着，无需回包（我们另有 heartbeat）
      return
    }

    case 'read_update': {
      // 定稿 v1.1：read_update 会同时推给「对端」和「自己其它设备」→ 必须按 from 区分语义，
      // 否则自己在手机上读过，桌面端会谎报成「对方已读」。
      const channelId = env.channelId ?? pickStr(p, ['channelId', 'channel_id']) ?? ''
      if (!channelId) return
      const thread = threads.get(channelId)
      if (!thread) return
      const from = pickStr(p, ['from']) ?? idStr(env.from)
      const bySelf = from !== '' && from === selfMemberId
      if (bySelf) {
        if (thread.unread > 0) {
          thread.unread = 0
          saveStore()
          broadcastUnread()
        }
        // 网关对同一次已读会推多条（HTTP 与 ws 各一次 × 自己的每条连接）→ 不去重就是连弹提示条
        const last = lastReadUpdateNoticeAt.get(channelId) ?? 0
        if (Date.now() - last > 5000) {
          lastReadUpdateNoticeAt.set(channelId, Date.now())
          broadcast('member:notice', { kind: 'read_update', peer: thread.peerName, message: tIn(getMainLocale(), 'dm.notice.readUpdateSelf'), ts: Date.now() })
        }
        return
      }
      // 对端已读：逐条回执网关未实现，这里按「整会话已读」把自己发出的气泡标已读（如实、不过度承诺到条）
      thread.messages = thread.messages.map((m) => (m.mine ? { ...m, read: true } : m))
      saveStore()
      deliverToSubscribers(channelId, 'member:read', { channelId, byPeer: true, ts: Date.now() })
      return
    }

    case 'message': {
      // 定稿载荷：{content, messageId}；from / to / channelId / ts 在信封上
      const from = pickStr(p, ['from', 'fromMemberId']) ?? idStr(env.from)
      const to = pickStr(p, ['to', 'toMemberId']) ?? idStr(env.to)
      const content = pickStr(p, ['content', 'text', 'body']) ?? ''
      const serverId = pickStr(p, ['messageId', 'message_id', 'msgId']) ?? ''
      // 自己发的消息被回显时带的客户端关联 id（定稿 v1.1：send.payload.clientMsgId 原样回显）
      const clientMsgId = pickStr(p, ['clientMsgId', 'client_msg_id']) ?? ''
      // ws 侧 ts 是毫秒；仍过一遍 toMs 防网关实现漂移
      const ts = toMs(pickNum(env as unknown as Record<string, unknown>, ['ts']) ?? pickNum(p, ['ts', 'time', 'createdAt']))
      // 定稿载荷带 channelId；万一没带，也能用「本账号 memberId + 对方 memberId」本地算出同一 id
      const self = resolveSelfMemberId()
      const channelId = env.channelId ?? pickStr(p, ['channelId', 'channel_id']) ?? (self && from && from !== self ? computeDmChannelId(self, from) : '')
      if (!channelId || !content) {
        console.info(`[member-channel] message 缺少 channelId/content，已忽略（serverId=${serverId || '无'}）`)
        return
      }
      const mine = from !== '' && from === self
      const peerId = mine ? to : from
      // 【期5B-补漏】原来 mine 分支 `friendNameOf(to) ?? to`、对方分支 `… ?? from`、外层 `|| peerId`
      // 三层都会把 memberId 当名字；这个值同时进 peerName（落盘）、msg.fromName（落盘）与
      // **系统通知标题**（下面 notifyDmMessage）→ 三层全去掉，拿不到真名就是空串。
      const peerName = realNameOrEmpty(
        mine ? friendNameOf(to) ?? undefined : friendNameOf(from) ?? pickStr(p, ['fromName', 'nickname', 'username']) ?? undefined,
        peerId,
      )
      const thread = ensureThread(channelId, peerId, peerName, friendAvatarOf(peerId))
      // 【自发消息去重】网关按 memberID 投递给该会员所有活跃连接：自己发的会被回显给自己（含其它设备）。
      // 去重键 = 网关 messageId；本地乐观气泡先占位（serverId 空），回显到达时按「同通道 + 同内容 + 未确认」认领。
      if (serverId && thread.messages.some((m) => m.serverId === serverId)) {
        return // 同一 messageId 只认一次（重连补推 / HTTP 已拉过）
      }
      if (mine) {
        // 【1:1 精确认领】优先按 clientMsgId 命中本地乐观气泡；命中不了再退「同内容+未确认」FIFO
        // （并发发两条内容完全相同的消息时，clientMsgId 保证各自认领自己那条，不会串）
        const echo =
          (clientMsgId ? thread.messages.find((m) => m.msgId === clientMsgId && !m.serverId) : undefined) ??
          thread.messages.find((m) => !m.serverId && m.pending && m.text === content)
        if (echo) {
          echo.serverId = serverId
          echo.pending = false
          echo.failed = null
          echo.ts = ts
          saveStore()
          deliverToSubscribers(channelId, 'member:message', { ...echo })
          return
        }
      }
      const msg: DmMessage = { msgId: serverId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, serverId, channelId, from: from || selfMemberId || '', fromName: peerName, to: to || undefined, text: content, ts, mine, read: false, pending: false, failed: null, origin: 'dm' }
      thread.messages = [...thread.messages, msg].slice(-(MAX_PERSIST_MESSAGES + 100))
      thread.lastTs = Math.max(thread.lastTs, ts)
      if (!mine) {
        // 未读：任一设备读过即已读（mark_read 走 HTTP 上报，本端拉取时以网关未读为权威）
        thread.unread += 1
        saveStore()
        broadcastUnread()
        // 附件消息的通知正文取可读预览（「[图片] 截图.png」），不能是 {"t":"image","u":"http… 这种串码
        // 【期5B-补漏·用户裁决】通知标题走「昵称→用户名→未知会员」，与界面同一真相源
        // （选 common.unknownMember 而不是 5A 的 native.notify.memberFallback「一位会员」：
        //  同一个人不能界面上叫「未知会员」、通知里叫「一位会员」，两套谓词会互相打脸）。
        notifyDmMessage(displayNameOf(peerName, peerId), dmContentPreview(content), () => {
          broadcast('member:open-thread', { channelId, ts: Date.now() })
        })
        // 【管家接管·t6 入站路由】好友发来消息 → 若「管家接管」开关开着，广播一条 auto-route 事件给
        // 管家窗口，由管家的 handleDmAutoRoute 订阅后触发一轮「理解 → 决定（回复/安排会话/忽略）」。
        // 铁则①：dmAutoReply === false 时根本不诞生这条事件（好友消息绝不自动进管家上下文）。
        // 这里只做「把对方消息原样交给管家」的搬运，不做任何判断；判断（要不要回、怎么回）全在管家的那一轮里。
        if (getRuntime().getSettings().dmAutoReply) {
          broadcast('member:dm:auto-route', {
            from: idStr(from),
            fromName: displayNameOf(peerName, peerId),
            content,
            channelId,
            ts,
          })
        }
      } else {
        saveStore()
      }
      deliverToSubscribers(channelId, 'member:message', msg)
      return
    }

    case 'error': {
      const { payload: err, spec: errSpec } = normalizeErrorPayload(env)
      // 审计的 topic/result 一律 ASCII 枚举（code），**不写译文** → 切语言不会让审计日志换语言，
      // 也不存在「一份常量两处用」的冲突（期5B 逐条核实结论）
      audit({ dir: 'in', caller: 'gateway', topic: 'error:' + err.code, channelId: err.channelId, to: null, bytes: 0, result: 'error' })
      channelErrorSpec = errSpec
      if (err.code === 'auth_failed' || err.code === 'token_missing' || err.code === 'token_invalid') {
        // 无效/缺失类：refresh 也救不回来，直接判失效（不白试）
        handleCredentialRejected(errSpec, err.code)
        return
      }
      if (err.code === 'token_expired') {
        // 过期类：先试宽限期续签，成功就带新 token 重连
        void onRejected(401, 'token_expired')
        return
      }
      broadcast('member:error', err)
      broadcastStatus()
      return
    }

    default: {
      // 契约 v1 未列出的下行 type：如实记录，不猜测语义、不静默当成功
      console.info(`[member-channel] 收到未处理的下行 type=${type}（契约 v1 未定义，已忽略）`)
      return
    }
  }
}

// ————————————————————————————— 对外 API（内置侧直调，不经插件白名单）—————————————————————————————

/** 开启会员通道（登录态驱动）。幂等。 */
export function startMemberChannel(url: string = DEFAULT_MEMBER_URL): MemberChannelStatus {
  if (url) memberUrl = url
  if (enabled && ws) return getMemberStatus()
  loadStore()
  enabled = true
  authFailed = false
  channelErrorSpec = null
  if (!getRuntime().getMemberToken()) {
    connected = false
    channelErrorSpec = { k: 'dm.notLoggedInChannel' }
    return getMemberStatus()
  }
  connect()
  // 不阻塞连接：HTTP 与 ws 互不依赖，ws 握手慢时好友/会话列表照样能出来
  void backfillFromHttp()
  return getMemberStatus()
}

/** 关闭会员通道（退出登录时调用）：断开连接、清空订阅与内存态（本地私信库保留） */
export function stopMemberChannel(): void {
  enabled = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopPing()
  stopHeartbeat()
  reconnectAttempts = 0
  subscribers.clear()
  if (ws) {
    ws.close()
    ws = null
  }
  connected = false
  authFailed = false
  channelErrorSpec = null
  selfMemberId = null
  selfMemberIdFromGateway = false
  void doSave()
  clearUnreadBadge()
  broadcastStatus()
}

/** 手动重连（失败态里的「重试」按钮）：清除 401 标记并立即握手 */
export function retryMemberChannel(): MemberChannelStatus {
  authFailed = false
  channelErrorSpec = null
  reconnectAttempts = 0
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    const old = ws
    ws = null
    connected = false
    try {
      old.close()
    } catch {
      // 忽略关闭旧连接的异常
    }
  }
  if (!enabled) {
    enabled = true
    loadStore()
  }
  connect()
  broadcastStatus()
  return getMemberStatus()
}

/** 好友列表 + 待处理申请 + 红点数（本地缓存；权威来自 HTTP pullFriends） */
export function getFriendsSnapshot(): { friends: DmFriend[]; requests: DmFriendRequest[]; requestCount: number } {
  return { friends, requests, requestCount: requestsCount }
}

/** 拉好友列表 + 待处理申请 + 红点数（打开面板 / 收到好友事件 / 重连时调用） */
export async function refreshFriends(): Promise<MemberResult> {
  const r = await pullFriends()
  return { ok: r.ok, message: r.ok ? tIn(getMainLocale(), 'dm.friendsUpdated') : r.message }
}

/**
 * 会员检索（定稿：只支持用户名精确匹配，不做邀请码入口，防会员枚举）。
 * 返回空数组是正常结果（没人叫这个名字），如实说，不报成网络错误。
 */
export async function searchMembers(username: string): Promise<MemberResult & { members: DmFriend[]; notFound?: boolean }> {
  const name = (username ?? '').trim()
  if (!name) return { ok: false, members: [], message: tIn(getMainLocale(), 'dm.searchNeedName') }
  // 定稿 v1.1：真实参数是 keyword=（username= 只是兼容别名，正式写法用 keyword）；仍是精确匹配，防会员枚举
  const r = await httpJson(`${PATH_MEMBER_SEARCH}?${new URLSearchParams({ keyword: name }).toString()}`)
  if (!r.ok) {
    // 定稿：查无此人 = HTTP 404 + {code:-1,message:"未找到该用户"}。业务 code 全是 -1，只能靠状态码
    // 把「没有这个人」和「请求本身坏了」分开，否则界面会给出一句误导性的红色报错。
    const notFound = r.status === 404
    return { ok: false, notFound, members: [], message: notFound ? tIn(getMainLocale(), 'dm.searchNotFound', { name }) : r.message }
  }
  const members = memberRows(r.data).map(mapFriend).filter((m) => m.memberId)
  if (members.length === 0) {
    // HTTP 200 但一条都没解析出来 = 响应结构与预期不符，不能骗用户说「没这个人」
    return { ok: false, notFound: false, members: [], message: tIn(getMainLocale(), 'dm.searchBadShape') }
  }
  return {
    ok: true,
    members,
    message: tIn(getMainLocale(), 'dm.searchFound', { n: members.length }),
  }
}

/** 发起好友申请（HTTP POST /api/v1/friends/request，带 requestMsg 附言） */
export async function requestFriend(input: { targetMemberId: string; message?: string }): Promise<MemberResult> {
  try {
    const target = (input.targetMemberId ?? '').trim()
    if (!target) return { ok: false, message: tIn(getMainLocale(), 'dm.needTargetSearch') }
    const r = await httpJson(PATH_FRIEND_REQUEST, { method: 'POST', body: { targetMemberId: requireNumericMemberId(target), message: (input.message ?? '').trim() } })
    return { ok: r.ok, message: r.ok ? tIn(getMainLocale(), 'dm.friendRequestSent') : r.message }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** 同意好友申请（HTTP） */
export async function acceptFriend(targetMemberId: string): Promise<MemberResult> {
  try {
    const target = (targetMemberId ?? '').trim()
    if (!target) return { ok: false, message: tIn(getMainLocale(), 'dm.needTargetAccept') }
    const r = await httpJson(PATH_FRIEND_ACCEPT, { method: 'POST', body: { targetMemberId: requireNumericMemberId(target) } })
    if (r.ok) {
      requests = requests.filter((x) => x.fromMemberId !== target)
      saveStore()
      broadcastFriends()
      void pullFriends()
    }
    return { ok: r.ok, message: r.ok ? tIn(getMainLocale(), 'dm.friendAcceptedOk') : r.message }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** 拒绝好友申请（HTTP） */
export async function rejectFriend(targetMemberId: string): Promise<MemberResult> {
  try {
    const target = (targetMemberId ?? '').trim()
    if (!target) return { ok: false, message: tIn(getMainLocale(), 'dm.needTargetReject') }
    const r = await httpJson(PATH_FRIEND_REJECT, { method: 'POST', body: { targetMemberId: requireNumericMemberId(target) } })
    if (r.ok) {
      requests = requests.filter((x) => x.fromMemberId !== target)
      saveStore()
      broadcastFriends()
      void pullFriends()
    }
    return { ok: r.ok, message: r.ok ? tIn(getMainLocale(), 'dm.friendRejectedOk') : r.message }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** 删除好友（HTTP；定稿语义：硬删双向解除，历史保留但不可再发） */
export async function deleteFriend(memberId: string): Promise<MemberResult> {
  try {
    const target = (memberId ?? '').trim()
    if (!target) return { ok: false, message: tIn(getMainLocale(), 'dm.needTargetDelete') }
    const r = await httpJson(PATH_FRIEND_DELETE, { method: 'POST', body: { targetMemberId: requireNumericMemberId(target) } })
    if (r.ok) {
      friends = friends.filter((f) => f.memberId !== target)
      saveStore()
      broadcastFriends()
    }
    return { ok: r.ok, message: r.ok ? tIn(getMainLocale(), 'dm.friendDeleted') : r.message }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** 与某个好友的 1v1 通道 id（本账号 memberId 由主进程权威持有，渲染层不自己拼字符串，避免量纲/排序规则漂移） */
export function resolveDmChannelId(peerMemberId: string): string | null {
  const self = resolveSelfMemberId()
  if (!self || !peerMemberId) return null
  return computeDmChannelId(self, peerMemberId)
}

/** 把网关历史条目映射为本地消息（字段名兼容多种命名） */
function mapHistoryMessage(raw: Record<string, unknown>, channelId: string): DmMessage | null {
  const content = pickStr(raw, ['content', 'text', 'body']) ?? ''
  const serverId = pickStr(raw, ['messageId', 'message_id', 'msgId', 'id']) ?? ''
  if (!content) return null
  const from = pickStr(raw, ['from', 'fromMemberId', 'senderId', 'senderMemberId']) ?? ''
  const to = pickStr(raw, ['to', 'toMemberId', 'receiverId', 'targetMemberId']) ?? ''
  // 主动解析（resolveSelfMemberId 会顺带缓存），否则 ws 尚未连上时 selfMemberId 为空、自己发的会被误判成别人发的
  const self = resolveSelfMemberId() ?? ''
  const mine = from !== '' && from === self
  const peerId = mine ? to : from
  // 定稿：历史条目 createdAt / readAt 均为 Unix 秒 → 归一到毫秒；readAt 非空即视为已读
  const createdAt = toMs(pickNum(raw, ['createdAt', 'ts', 'time']))
  const readAt = pickNum(raw, ['readAt', 'read_at'])
  return {
    msgId: serverId || `local-h-${from}-${createdAt}`,
    serverId,
    channelId,
    from: from || self,
    // 【期5B-补漏】历史消息的 fromName 与 :1532 同源（三层 ID 兜底全去掉）：它会落盘，
    // 并且是「引用到会话」载荷的第二兜底（quoteDmToSession），不能带 ID。
    fromName: realNameOrEmpty(
      mine ? getRuntime().username : friendNameOf(from) ?? pickStr(raw, ['fromName', 'nickname', 'username']) ?? undefined,
      // 比对用的 id 必须与名字**同侧**：mine 时名字是自己的用户名 → 该拿 self 比（历史上这里
      // 兜底过 self）；非 mine 时名字是对端的 → 拿 peerId 比。第一版我两处都传了 peerId，
      // mine 分支等于拿「我的用户名」去和「对端 id」比，判据错位（自查抓到，已修）。
      mine ? self : peerId,
    ),
    to: to || undefined,
    text: content,
    ts: createdAt,
    mine,
    read: pickBool(raw, ['read', 'isRead']) ?? (readAt !== null && readAt > 0),
    pending: false,
    failed: null,
    origin: 'dm',
  }
}

/**
 * 从 HTTP 拉一页历史并合并进本地（定稿：会话历史 / 离线补拉走 HTTP，ws 只负责实时增量）。
 * 去重键 = 网关 messageId；命中已有 serverId 只补齐状态，不重复追加（自发消息多端同步靠这个）。
 */
async function pullHistory(input: { channelId: string; peerId?: string; page?: number; pageSize?: number }): Promise<{ messages: DmMessage[]; hasMore: boolean; total: number; page: number; error: string | null }> {
  const channelId = (input.channelId ?? '').trim()
  const page = Math.max(1, Math.floor(input.page ?? 1))
  const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize ?? HISTORY_PAGE_SIZE)))
  const empty = { messages: [] as DmMessage[], hasMore: false, total: 0, page, error: null as string | null }
  if (!channelId) return { ...empty, error: tIn(getMainLocale(), 'dm.missingChannelId') }
  // 定稿：历史以「对方 memberId」为路径参数（不是 channelId）；channelId 只用于本地线程归属与实时订阅
  const peerId = (input.peerId ?? '').trim() || threads.get(channelId)?.peerId || peerOfChannel(channelId)
  if (!peerId) return { ...empty, error: tIn(getMainLocale(), 'dm.historyNoPeer') }
  const r = await httpJson(`${PATH_CONVERSATIONS}/${encodeURIComponent(peerId)}?${new URLSearchParams({ page: String(page), pageSize: String(pageSize) }).toString()}`)
  if (!r.ok) return { ...empty, error: r.message }
  const raws = listOf(r.data, ['list', 'messages', 'history', 'records'])
  const incoming: DmMessage[] = []
  for (const raw of raws) {
    const m = mapHistoryMessage(raw, channelId)
    if (m) incoming.push(m)
  }
  // 空页不建线程：否则订阅一个尚无任何消息的 channelId 会在会话列表里留下 peerName 为空的幽灵会话
  const existing = threads.get(channelId)
  // 分页权威：data.total / data.size（定稿 {list,total,page,size}）；拿不到就按「本页满页则可能还有」估
  const totalRemote = pickNum((r.data ?? {}) as Record<string, unknown>, ['total'])
  const sizeRemote = pickNum((r.data ?? {}) as Record<string, unknown>, ['size', 'pageSize']) ?? pageSize
  const hasMore = totalRemote !== null ? page * sizeRemote < totalRemote : incoming.length >= pageSize
  if (incoming.length === 0) {
    if (existing) deliverToSubscribers(channelId, 'member:history', { channelId, messages: existing.messages, hasMore: false, total: existing.messages.length, page })
    return { messages: existing?.messages ?? [], hasMore: false, total: existing?.messages.length ?? 0, page, error: null }
  }
  // 上面已保证 incoming 非空，这里取最后一条作为「最新一条」的参照
  const newest = incoming[incoming.length - 1] as DmMessage
  const peerIdFromMsg = newest.mine ? newest.to ?? '' : newest.from
  // 【期5B-补漏】`?? (peerId || peerIdFromMsg)` 去掉：分页拉历史时若好友表还没到位，
  // 原先会把 memberId 写进 peerName 并落盘。ensureThread 只在非空时覆盖，所以这里传空串
  // 不会把后续拿到的真名冲掉。
  const thread = ensureThread(
    channelId,
    peerId || peerIdFromMsg,
    realNameOrEmpty(friendNameOf(peerId || peerIdFromMsg) ?? undefined, peerId || peerIdFromMsg),
    friendAvatarOf(peerId || peerIdFromMsg),
  )
  const byServerId = new Map(thread.messages.filter((m) => m.serverId).map((m) => [m.serverId as string, m]))
  for (const m of incoming) {
    const hit = m.serverId ? byServerId.get(m.serverId) : undefined
    if (hit) {
      hit.read = hit.read || m.read
      hit.pending = false
      continue
    }
    if (m.mine) {
      // 本地乐观气泡认领：同内容 + 未确认 + 自己发的 → 回填 messageId，不新增一条（否则会显示两遍）
      const echo = thread.messages.find((x) => !x.serverId && x.pending && x.text === m.text)
      if (echo) {
        echo.serverId = m.serverId
        echo.pending = false
        echo.failed = null
        echo.ts = m.ts
        continue
      }
    }
    thread.messages = [...thread.messages, m]
    if (m.serverId) byServerId.set(m.serverId, m)
  }
  thread.messages = thread.messages.sort((a, b) => a.ts - b.ts).slice(-MAX_PERSIST_MESSAGES)
  const last = thread.messages[thread.messages.length - 1]
  if (last && last.ts > thread.lastTs) thread.lastTs = last.ts
  saveStore()
  deliverToSubscribers(channelId, 'member:history', { channelId, messages: thread.messages, hasMore, total: totalRemote ?? thread.messages.length, page })
  return { messages: thread.messages, hasMore, total: totalRemote ?? thread.messages.length, page, error: null }
}

/** 从 channelId（chat:1v1:{小}-{大}）里取出「不是本账号」的那一方 memberId；拿不到返回空串 */
function peerOfChannel(channelId: string): string {
  const self = selfMemberId
  const m = /^chat:1v1:(\d+)-(\d+)$/.exec(channelId)
  if (!m) return ''
  const a = m[1] ?? ''
  const b = m[2] ?? ''
  if (self && a === self) return b
  if (self && b === self) return a
  return ''
}

/**
 * 订阅通道（渲染层打开某好友会话时调用）：ws subscribe 恢复实时推送 + HTTP 拉一页历史，
 * 返回给 UI 的是「HTTP 权威 + 本地缓存」合并后的会话。
 */
export async function subscribeChannel(channelId: string, webContentsId: number): Promise<DmThread | null> {
  const id = (channelId ?? '').trim()
  if (!id) return null
  const set = subscribers.get(id) ?? new Set<number>()
  set.add(webContentsId)
  subscribers.set(id, set)
  userInitiatedSubscribe.set(id, Date.now()) // 用户主动点开会话 → subscribed 回执值得给一条提示
  out('subscribe', id)
  const page = await pullHistory({ channelId: id, page: 1, pageSize: HISTORY_PAGE_SIZE })
  if (page.error) broadcast('member:error', { code: 'history_failed', message: tIn(getMainLocale(), 'dm.historyFailed', { msg: page.error }), channelId: id } satisfies MemberErrorPayload)
  return threads.get(id) ?? null
}

export function unsubscribeChannel(channelId: string, webContentsId: number): void {
  const set = subscribers.get(channelId)
  if (!set) return
  set.delete(webContentsId)
  if (set.size === 0) {
    subscribers.delete(channelId)
    out('leave', channelId)
  }
}

/** 窗口销毁时清理其订阅（避免死窗口 id 堆积） */
export function dropWindowSubscriptions(webContentsId: number): void {
  for (const [channelId, set] of subscribers) {
    if (!set.delete(webContentsId)) continue
    if (set.size === 0) {
      subscribers.delete(channelId)
      out('leave', channelId)
    }
  }
}

export function listThreads(): DmThread[] {
  return [...threads.values()].sort((a, b) => b.lastTs - a.lastTs)
}

/** 主动从网关 HTTP 拉会话列表（含每会话未读），返回合并后的会话；失败也回本地缓存并广播 error */
export async function pullThreads(): Promise<DmThread[]> {
  const r = await pullConversations()
  if (!r.ok) broadcast('member:error', { code: 'threads_failed', message: tIn(getMainLocale(), 'dm.threadsFailed', { msg: r.message }), channelId: null } satisfies MemberErrorPayload)
  return listThreads()
}

/**
 * 历史分页（渲染层「加载更早」用）。契约 v1.1 定稿：page/pageSize 偏移分页，
 * page=1 是最新一页，「加载更早」= page 递增（旧实现的时间戳游标 before 网关不支持，已废弃）。
 * HTTP 失败时退回本地缓存按页切片，并如实带上 error（不静默当成「没有更多」）。
 */
export async function getHistory(input: { channelId: string; page?: number; pageSize?: number }): Promise<{ messages: DmMessage[]; hasMore: boolean; total: number; page: number; error: string | null }> {
  const page = await pullHistory(input)
  if (page.error) {
    const thread = threads.get(input.channelId)
    const p = Math.max(1, Math.floor(input.page ?? 1))
    const size = Math.max(1, Math.min(100, Math.floor(input.pageSize ?? HISTORY_PAGE_SIZE)))
    if (!thread) return { messages: [], hasMore: false, total: 0, page: p, error: page.error }
    const sorted = [...thread.messages].sort((a, b) => a.ts - b.ts)
    // 本地兜底也按「page=1 取最新一页」的语义切片，与网关口径一致
    const end = Math.max(0, sorted.length - (p - 1) * size)
    const start = Math.max(0, end - size)
    return { messages: sorted.slice(start, end), hasMore: start > 0, total: sorted.length, page: p, error: page.error }
  }
  return page
}

/** 全局未读数（定稿 GET /api/v1/messages/unread → {count}）：作为红点主源覆盖本地累加值 */
async function pullGlobalUnread(): Promise<void> {
  const r = await httpJson(PATH_MESSAGES_UNREAD)
  if (!r.ok) return
  const count = pickNum((r.data ?? {}) as Record<string, unknown>, ['count', 'total'])
  if (count === null) return
  // 网关权威总数 > 本地累加：说明有离线消息未落到本地线程，补拉一次会话列表（其中带每会话未读）
  if (count > getUnread().total) await pullConversations()
  else if (count === 0) {
    for (const t of threads.values()) t.unread = 0
    saveStore()
    broadcastUnread()
  }
}

/**
 * 发送私信（内置侧身份 caller='builtin'）。
 * 定稿载荷：{v,type,seq,to,channelId,payload:{content},ts}；messageId 由网关生成，本地先占乐观气泡。
 * 本地预检：好友前提 / DM_MAX_CONTENT_BYTES 字节上限 / 按 memberID 30 条每 10 秒限流，失败一律如实回报不静默。
 */
// ── 管家接管私信：出站敏感信息过滤器（硬拦截，宁可误拦不漏放）─────────────────
// 只拦「管家/Agent 代用户外发」这一条路径（sendDmFromAgent）。用户手动发的 sendDm
// 不经过这里（用户有权发出含路径/凭据的内容，这是自己的私信）。
// 用正则 + 规则做，**不用 LLM** 语义判断：可 review、可测试、不被 prompt injection 绕过。
/** 【任务116】占位/示例值判定：`KEY=xxx`、`PASSWORD=***`、`<你的密钥>`、`your_key_here`、`test123`
 *  这类教学示例不该被当成真凭据（用户分享「.env 该怎么写」的对话是高频正常场景）。
 *  ★只放宽「右侧值是占位形态」这一件事：右侧一旦是真实长度 + 真实字符集，照旧拦。
 *  判定保守（宁可认不出占位 → 走拦截），放宽面严格限定在示例形态。 */
function looksLikePlaceholderValue(v: string): boolean {
  const s = String(v ?? '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
  if (!s) return true
  if (s.length <= 3) return true // KEY=abc
  if (/^[x*#.\-、\s]+$/i.test(s)) return true // xxxx / **** / ---- / …
  if (/^<[^>]*>$/.test(s)) return true // <your-key>
  if (/^\$\{[^}]*\}$/.test(s)) return true // ${API_KEY}
  if (/^(?:your|my|the|some)[_-][a-z0-9_-]*$/i.test(s)) return true // your_key_here / my-key
  if (/^(?:placeholder|sample|example|changeme|replace[_-]?me|dummy|fake|redacted|todo|tbd|n\/a|null|undefined|empty|示例|占位)$/i.test(s)) return true
  if (/^(?:test|demo|foo|bar|sample)[_-]?(?:\d{1,6}|key|token|secret|abc|123)?$/i.test(s)) return true // test / test123 / demo_key
  if (/^(.)\1{3,}$/.test(s)) return true // aaaaa / 11111（单一字符重复的示意串）
  if (/^(?:sk|ghp|gho|ghs|api|key|token)[_-](?:x{3,}|\*{3,}|[yoursample]{4,})$/i.test(s)) return true // sk-xxxx
  return false
}

/** 【任务116】规则表：命中即拒发。带 guard 的规则还要看捕获组（用于「值是不是占位」这类判定）。 */
interface FilterRule {
  name: string
  re: RegExp
  guard?: (m: RegExpExecArray) => boolean
}

/**
 * 【任务120 · 停用开关】用户裁决原话（2026-09-07）：
 *   「可以不限制这个，账号密码、密钥这些可以拦截，其他的可以不拦截」
 *  ⇒ 地址类（internal_addr）/ 路径类（internal_path）/ 报错堆栈类（internal_error）**不再拦截**；
 *    凭证类（jwt / api_key_prefix / env_secret）与 base64 类（inline_base64 / long_base64）照旧拦，一道不减。
 * ★停用 ≠ 删除：DISABLED_FILTER_RULES 保留正则原文与类名，重新启用只需把本开关置 true（回退成本＝一行）。
 * ★为什么地址/路径算低危：路径只是字符串，好友拿到 `/Users/xxx` 也读不到用户机器；IP / 域名同理。
 *   而凭证（密钥 / 令牌 / 真实口令）拿到即可用，故这条底线不因「用户嫌麻烦」让路。
 * ★base64 两条保留**不是**因为怕泄露，而是因为技术危害：本项目实测过 base64 图片原文被塞进请求
 *   撑爆体积导致 context deadline exceeded；一条 data:image 动辄数百 KB，放开等于把已知事故重新打开。
 *   分享路径另有 shareableImageUrl 分流（data: 图不带图 + 出可见提示），故拦它不会造成「点了没反应」。
 */
const ADDRESS_PATH_ERROR_FILTER_ENABLED = false

/** 【任务120 停用表】以下 9 条**当前不参与拦截**；原文照抄自任务116 生效表（含任务116 补的
 *  RFC1918 四段与栈帧结构两条），一字未改，便于把开关置 true 即零成本回退。 */
const DISABLED_FILTER_RULES: FilterRule[] = [
  // 【任务120 停用】路径类三条（macOS / Windows / 山海配置目录）——原文照抄，未做任何修改
  { name: 'internal_path', re: /\/(Users|Applications|Volumes|System)\/[^\s,'"):]+/ },
  { name: 'internal_path', re: /[A-Z]:\\[^\s,'"):]+/ },
  { name: 'internal_path', re: /~\/\.shanhai\/[^\s,'"):]+/ },
  // 【任务120 停用】地址类前三条（生产 IP / 端口 / 内部域名）——原文照抄，未做任何修改
  { name: 'internal_addr', re: /39\.106\.82\.55\b/ },
  { name: 'internal_addr', re: /:\s*6033\b/ },
  { name: 'internal_addr', re: /(?:git\.)?huiyuanjia\.net\b/ },
  // 【任务116 补一处漏放】改前 /\b(?:192\.168\.|10\.)\d+\.\d+\.\d+\b/ 实际要求 **5 段**
  // （`192.168.` 之后还要再接 \d+.\d+.\d+），所以 192.168.1.20 / 172.16.x.x 一条都不命中 —— 内网地址根本没拦住。
  // 现在改成标准 RFC1918 四段，并补 127.0.0.1 / localhost:端口（本机服务地址同样不该外发）。
  { name: 'internal_addr', re: /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})\b|\blocalhost:\d{2,5}\b/i },
  // 内部报错：★只拦「栈帧结构」（两行以上连续的 at 函数 (文件:行:列)）与山海自身服务短语；
  //  改前 /\bENOENT\b/、/\bECONNREFUSED\b/ 把「这个 ENOENT 是路径拼错了」这种正常技术讨论判成敏感内容。
  { name: 'internal_error', re: /The service was stopped/ },
  { name: 'internal_error', re: /(?:^|\n)[ \t]*at\s+[^\n(]*\([^\n)]*:\d+:\d+\)[ \t]*(?:\n[ \t]*at\s+[^\n(]*\([^\n)]*:\d+:\d+\)[ \t]*)+/ },
]

export function outboundContentFilter(text: string): string | null {
  const t = String(text ?? '')
  const rules: FilterRule[] = [
    // JWT 三段式（★保留照拦：带签名的完整令牌本就不该外发）
    { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
    // 密钥前缀：★要求「前缀 + 完整长度 + 真实字符集」，单纯提到 sk- / ghp_ 这个词不拦；
    //  形态够但值是占位（sk-xxxxxxxx）也不拦。前缀集比改前更宽（补 ghp_/gho_/ghs_/glpat/xox*/AKIA），
    //  这是**收紧**不是放松：改前只认 sk- 一种，GitHub/Slack/AWS 的真 token 反而漏放。
    {
      name: 'api_key_prefix',
      re: /\b(?:sk|ghp|gho|ghs|glpat|xox[baprs])[._-][A-Za-z0-9]{16,}\b|\bAKIA[0-9A-Z]{12,}\b/,
      guard: (m) => !looksLikePlaceholderValue(m[0] ?? ''),
    },
    // 内嵌 base64（截图/资源直传）——★保留照拦（放在 long_base64 之前，归因更具体）
    { name: 'inline_base64', re: /data:image\/[a-z0-9]+;base64,/ },
    // 长 base64：★本轮主因。改前 /[A-Za-z0-9+/]{30,}={0,2}/ 的字符类**含 `/`**，
    //  于是任何长 URL 的 path 段（如 docs/Web/JavaScript/Reference/Global_Objects）都算「base64」，
    //  用户分享一段带文档链接的 AI 回复必然被误拦。现在只在两种明确特征下才算：
    //  ① 紧跟 base64 语境标记（data:...;base64, / base64, / base64:）；② ≥200 连续且带 padding。
    { name: 'long_base64', re: /(?:data:[a-z]+\/[a-z0-9.+-]+;base64|base64[,:])\s*["'`]?[A-Za-z0-9+/]{24,}/i },
    { name: 'long_base64', re: /(^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{200,}={1,2}(?![A-Za-z0-9+/])/ },
    // 【任务120】地址类 / 路径类 / 报错堆栈类共 9 条已按用户裁决**停用**（不再拦），
    //   正则原文与类名**原样**搬进下方 DISABLED_FILTER_RULES —— 停用 ≠ 删除。
    //   重新启用只需把 ADDRESS_PATH_ERROR_FILTER_ENABLED 置 true，不需要重写任何正则。
    // 配置/环境变量/口令赋值：★只在「右侧是真实值」时才算（改前只看左键名，分享 .env 写法示例必被误拦）。
    //  键名集比改前更宽（补 API_SECRET/APP_SECRET/CLIENT_SECRET/PRIVATE_KEY/TOKEN），同样是收紧不是放松。
    {
      name: 'env_secret',
      re: /(?:API_KEY|API_SECRET|APP_SECRET|CLIENT_SECRET|SECRET|DB_PASS|DB_PASSWORD|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|PASSWORD|TOKEN)\s*[:=]\s*([^\s,;"'`)]{1,200})/i,
      guard: (m) => !looksLikePlaceholderValue(m[1] ?? ''),
    },
    // 【任务120】停用表按开关并入：默认 false ⇒ 地址/路径/堆栈放行；置 true ⇒ 一行回到任务116 口径
    ...(ADDRESS_PATH_ERROR_FILTER_ENABLED ? DISABLED_FILTER_RULES : []),
  ]
  for (const rule of rules) {
    const m = rule.re.exec(t)
    if (!m) continue
    if (rule.guard && !rule.guard(m)) continue
    return rule.name
  }
  return null
}

/** 命中规则 → 面向用户的**分类**（渲染层据此取词典文案）。
 *  ★这是给界面的唯一额外信息：不含命中片段、不含内部规则名标识符。
 *  【任务120】addr / path / error 三类**当前不会触发**（规则已停用，见 ADDRESS_PATH_ERROR_FILTER_ENABLED），
 *   但映射条目与词典四条分类提示词条**全部保留不删**：① 回退成本最低（开关一拨即生效）；
 *   ② 本表仍被代码引用 ⇒ 那四条词条不构成死键。 */
export const FILTER_RULE_KIND: Record<string, 'secret' | 'path' | 'addr' | 'error'> = {
  jwt: 'secret',
  api_key_prefix: 'secret',
  long_base64: 'secret',
  inline_base64: 'secret',
  env_secret: 'secret',
  internal_path: 'path',
  internal_addr: 'addr',
  // 【任务120】地址类停用后，attachment_url 只剩「query 带签名参数」一条会触发（签名 URL＝临时钥匙，
  //  属凭证类），故分类由 addr 改归 secret —— 措辞纠偏，不是放松：拦与不拦的判定一行未改。
  attachment_url: 'secret',
  internal_error: 'error',
}

/** 【任务116】附件引用 URL 的独立判定：不再走 base64 规则（七牛随机 key 动辄 32 位字母数字，
 *  改前「只要带图就必被拦」是确定性 bug）。
 *  【任务120 分档】附件 URL 现在只拦**两档，都是凭证/base64 类**：
 *    ① data: 内联 base64（技术危害类，见上方开关注释）；② query 带签名参数（token/sign/AK 等＝临时钥匙）。
 *  ★原任务116 的另三档（非 http(s) 协议 / 主机名解析不出 / 回环与内网主机）属**地址类**，
 *   已按用户裁决一并停用，原文包在 ADDRESS_PATH_ERROR_FILTER_ENABLED 分支里保留，置 true 即回退。
 *  ★未做「已知可信图床域名」静态白名单：图床域名由网关上传凭证接口运行时下发（public_base_url，
 *  见 packages/storage/src/storage.ts:188），山海侧没有可依赖的常量，硬编一份就成了会漂的第二真相源
 *  —— 已登记为待用户裁决项。 */
function outboundAttachmentRule(atts: Array<{ u?: string }>): string | null {
  for (const a of atts) {
    const u = String(a?.u ?? '').trim()
    // 【任务120 停用】下面三条属**地址类**（非 http(s) 协议 / 主机解析不出 / 回环与内网主机），
    //  按用户裁决「其他的可以不拦截」一并放行；原文保留在此，开关置 true 即一行回退。
    if (ADDRESS_PATH_ERROR_FILTER_ENABLED) {
      if (!/^https?:\/\//i.test(u)) return 'attachment_url'
      let host = ''
      try {
        host = new URL(u).hostname.toLowerCase()
      } catch {
        return 'attachment_url'
      }
      if (/^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1)/.test(host)) return 'attachment_url'
    }
    // 【任务120 保留】data: 内联 base64 **不属地址类**，属上面明确保留的 base64 类（撑爆请求前科）⇒ 照旧拦。
    if (/^data:[^,;]*;base64,/i.test(u)) return 'inline_base64'
    // 【任务116 补一处放松风险】把正文从附件 JSON 里摘出来检之后，「凭证藏在附件 URL 的 query 里」
    //  会变成新的外带通道（签名URL 常带 token/signature/AK）。山海自己的图链是 public_base_url + '/' + key，
    //  **不带 query**（packages/storage/src/storage.ts:126 buildPublicUrl），所以这条几乎不误伤正常图链。
    if (/[?&](?:token|sign|signature|q-sign[a-z_-]*|access[_-]?key|accesskey|api[_-]?key|credential|auth|pwd|password|x-amz-credential)=/i.test(u)) return 'attachment_url'
  }
  return null
}

/** 管家接管：以当前会员身份给好友发消息（走出站安全门）。
 *  只在 dmAutoReply == true 时才放行；命中出站敏感词则拒绝并返回 filterRule 供管家换措辞重试。
 *  与 IPC handler `member:send-from-agent` 共用同一份实现（宿主 dmUse 桥也调这里），避免两条路行为漂移。 */
export function sendDmFromAgent(input: { channelId?: string; peerMemberId?: string; text: string; replyTo?: string; fromUserShare?: boolean }): MemberResult & { msgId?: string; channelId?: string; reason?: string; filterRule?: string; filterKind?: 'secret' | 'path' | 'addr' | 'error' } {
  const settings = getRuntime().getSettings()
  // 【任务109】fromUserShare=true：用户在消息卡片上当面点「分享」，不是管家代发 —— 那扇
  // 「管家接管」开关是给 Agent 自动回复用的，用户主动动作不该被它拦，故此分支**不查开关**；
  // 但下面的出站敏感信息过滤**一道不减**（分享内容同样可能夹带密钥/内部路径/内网地址）。
  if (!input.fromUserShare && !settings.dmAutoReply) {
    console.warn('[dm-agent] 管家发消息被拒：dmAutoReply 未开启')
    return { ok: false, message: tIn(getMainLocale(), 'dm.agentNotEnabled'), reason: 'not_enabled' }
  }
  // 【任务116 根因修复】改前把 input.text **整串**喂给过滤器，而分享路径传进来的是 encodeDmContent
  // 之后的 content（带图时是 {"t":"atts","x":正文,"a":[{"u":"https://…随机key…"}]}）——
  // 附件 JSON 里的直链天然命中 long_base64，等于「只要带图就必被拦」的确定性 bug。
  // 现在：过滤器只看**人类可读正文**（atts 的 x 字段；无附件时 decodeDmContent 原样返回，行为不变），
  //      附件引用 URL 走 outboundAttachmentRule 的独立判定（【任务120】只看是否 data: 内联 base64
  //      与 query 里的签名参数，地址类判定已随停用开关一并关掉）。
  const parsed = decodeDmContent(input.text ?? '')
  const rule = outboundContentFilter(parsed.text) ?? outboundAttachmentRule(parsed.atts)
  if (rule) {
    console.warn(`[dm-agent] 出站内容被敏感信息过滤器拦截 rule=${rule}`)
    return {
      ok: false,
      message: tIn(getMainLocale(), 'dm.agentFiltered'),
      reason: 'content_filtered',
      filterRule: rule,
      // 给界面的分类（★不回显规则名与命中原文），渲染层按它取词典词条
      filterKind: FILTER_RULE_KIND[rule] ?? 'secret',
    }
  }
  const r = sendDm({ channelId: input.channelId, peerMemberId: input.peerMemberId, text: input.text })
  if (r.ok) return { ...r }
  return { ...r, reason: 'send_failed' }
}

export function sendDm(input: { peerMemberId?: string; channelId?: string; text: string; peerName?: string }): MemberResult & { msgId?: string; channelId?: string } {
  const text = (input.text ?? '').trim()
  if (!text) return { ok: false, message: tIn(getMainLocale(), 'dm.sendEmpty') }
  if (!connected) return { ok: false, message: tIn(getMainLocale(), 'dm.sendNotConnected') }
  const self = resolveSelfMemberId()
  if (!self) return { ok: false, message: tIn(getMainLocale(), 'dm.sendNoSelf') }
  const peer = (input.peerMemberId ?? '').trim()
  if (!peer) return { ok: false, message: tIn(getMainLocale(), 'dm.sendNoPeer') }
  if (peer === self) return { ok: false, message: tIn(getMainLocale(), 'dm.sendToSelf') }
  // 【硬性前提】互为好友才允许通讯：本地好友表里没有就直接拒发（网关也会回 friend_required）
  if (!friends.some((f) => f.memberId === peer)) {
    audit({ dir: 'out', caller: 'builtin', topic: 'send:rejected', channelId: null, to: peer, bytes: byteLen(text), result: 'not_friends' })
    return { ok: false, message: tIn(getMainLocale(), 'dm.sendNotFriends') }
  }
  const bytes = byteLen(text)
  if (bytes > MAX_MSG_BYTES) {
    return { ok: false, message: tIn(getMainLocale(), 'dm.contentTooLong', { bytes, max: MAX_MSG_BYTES }) }
  }
  const channelId = input.channelId?.trim() || computeDmChannelId(self, peer)
  if (!takeSendToken('builtin')) {
    audit({ dir: 'out', caller: 'builtin', topic: 'send:rejected', channelId, to: peer, bytes, result: 'rate_limited' })
    return { ok: false, message: tIn(getMainLocale(), 'dm.sendRateLimited', { n: RATE_LIMIT_PER_WINDOW, sec: RATE_WINDOW_MS / 1000 }) }
  }
  // clientMsgId（契约 v1.1 采纳项）：随 send 上行、被网关原样回显在 message 下行 → 乐观气泡可按它 1:1 认领
  const msgId = newClientMsgId(peer)
  // 【期5B-补漏】`?? peer` 去掉。input.peerName 由渲染层传入（active.peerName 原值，
  // 本期起不再含 ID），但仍要防插件经 member:send 桥传任意字符串当名字 → 过一层判定。
  const thread = ensureThread(channelId, peer, realNameOrEmpty(input.peerName ?? friendNameOf(peer) ?? undefined, peer), friendAvatarOf(peer))
  // 【第 7 处，同类问题，一并改掉并单独登记】`?? self` 会把**自己的** memberId 落盘进 fromName。
  // 渲染层不显示 mine 消息的 fromName，故不是当前泄漏点，但它是同一族兜底，留着迟早漏。
  const msg: DmMessage = { msgId, serverId: '', channelId, from: self, fromName: realNameOrEmpty(getRuntime().username, self), to: peer, text, ts: Date.now(), mine: true, read: false, pending: true, failed: null, origin: 'dm' }
  thread.messages = [...thread.messages, msg]
  thread.lastTs = msg.ts
  saveStore()
  deliverToSubscribers(channelId, 'member:message', msg)
  const ok = out('send', channelId, { content: text, clientMsgId: msgId }, peer)
  if (!ok) {
    // 【期5B 取词时机】failed 会随消息落盘到 dm-store.json，存已翻译文案等于把语言烘进磁盘
    // （切语言后历史气泡的失败原因永远停在旧语言）。现在落盘的是词条 key，渲染层按当前语言还原；
    // 老数据里已经是中文的（历史遗留）由渲染层兜底原样显示，不做迁移（本期边界禁止动渲染层）。
    thread.messages = thread.messages.map((m) => (m.msgId === msgId ? { ...m, pending: false, failed: FAILED_CHANNEL_CLOSED } : m))
    saveStore()
    deliverToSubscribers(channelId, 'member:message', { ...msg, pending: false, failed: FAILED_CHANNEL_CLOSED })
    return { ok: false, message: tIn(getMainLocale(), 'dm.sendFailedDisconnected'), msgId, channelId }
  }
  // 送达确认靠 message 下行回显（定稿无 ack）：这里只代表「已提交网关」，UI 显示「发送中」直到认领到 messageId
  return { ok: true, message: tIn(getMainLocale(), 'dm.sendSubmitted'), msgId, channelId }
}

/**
 * 标记会话已读（本端读过 → 上报网关；多设备按会员维度共享，任一设备读过即已读）。
 * 定稿：未读权威在 HTTP，故走 POST /api/v1/messages/read；ws mark_read 作为实时通知尽力补发。
 */
export async function markChannelRead(channelId: string): Promise<MemberResult> {
  const id = (channelId ?? '').trim()
  const thread = threads.get(id)
  if (!thread) return { ok: false, message: tIn(getMainLocale(), 'dm.threadMissing') }
  const last = thread.messages[thread.messages.length - 1]
  thread.unread = 0
  saveStore()
  broadcastUnread()
  out('mark_read', id, { messageId: last?.serverId ?? '', ts: last?.ts ?? Date.now() })
  const r = await httpJson(PATH_MESSAGE_READ, { method: 'POST', body: { channelId: id, messageId: last?.serverId ?? '', ts: last?.ts ?? Date.now() } })
  // 本地未读已清零（用户体感正确），HTTP 失败只提示未同步的副作用，不回滚
  return r.ok
    ? { ok: true, message: tIn(getMainLocale(), 'dm.markReadOk') }
    : { ok: false, message: tIn(getMainLocale(), 'dm.markReadPartial', { msg: r.message }) }
}

export function getUnread(): DmUnread {
  const byChannel: Record<string, number> = {}
  let total = 0
  for (const t of threads.values()) {
    if (t.unread > 0) {
      byChannel[t.channelId] = t.unread
      total += t.unread
    }
  }
  return { total, byChannel }
}

/**
 * 【红线守卫】把某条私信「引用」到指定会话的输入区。
 * 只做一件事：把「原文 + 来源元信息」定向发给目标窗口，由渲染层追加进输入框（不覆盖草稿）
 * —— 等价于本地用户自己敲进这段话，等他自己按发送。
 * 明确不做：不调 runtime.run / injectMessage / chat:run，不写 sessionMap/items，不碰审批队列。
 * 来源标记放在载荷（fromName / msgId / ts）而不是拼进正文：渲染层用输入区引用卡片呈现，
 * 避免伪装前缀文本被 resendMessage / editResend 重放进模型上下文。
 * 投递面：普通会话只投 chat 窗口、管家会话只投 supervisor 窗口，且跳过发起窗口；插件窗口一律不投。
 */
export function quoteDmToSession(input: { sessionId: string; channelId: string; msgId: string }, senderWebContentsId: number): MemberResult {
  const sessionId = (input.sessionId ?? '').trim()
  const thread = threads.get(input.channelId ?? '')
  const msg = thread?.messages.find((m) => m.msgId === input.msgId || m.serverId === input.msgId)
  if (!thread || !msg) return { ok: false, message: tIn(getMainLocale(), 'dm.quoteMissing') }
  if (!sessionId) return { ok: false, message: tIn(getMainLocale(), 'dm.quoteNeedSession') }
  // 「（本端发出）」与「我」都进词条：英文是 "Me (sent from this device)"，语序与括号都不同
  const fromLabel = msg.mine
    ? tIn(getMainLocale(), 'dm.quoteMineSuffix', { name: getRuntime().username ?? tIn(getMainLocale(), 'dm.quoteSelfName') })
    // 【期5B-补漏】第三层 `|| msg.from` 是 memberId：它进的是跨进程载荷（不是落盘字段），
    // 渲染层 DmQuoteBanner 本来就按 fromMemberId 反查挡了一道；现在源头也不吐 memberId，
    // 载荷里给空串 → 渲染层 !n 分支显示「未知会员」。fromMemberId 仍原样传（它是比对键，不是显示值）。
    : realNameOrEmpty(thread.peerName, msg.from) || realNameOrEmpty(msg.fromName, msg.from)
  const isSupervisor = sessionId === SUPERVISOR_SESSION_ID
  // 附件消息引用到会话时展开成「[图片] 名字 → URL」：模型与用户看到的都是可读文本，且 URL 保留（否则引用图片等于丢了内容）
  const payload: DmQuotePayload = { sessionId, channelId: thread.channelId, msgId: msg.msgId, fromName: fromLabel, fromMemberId: msg.from, text: dmContentToPlainText(msg.text), ts: msg.ts, at: Date.now() }
  let delivered = 0
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    const type = getWindowType(win)
    if (isSupervisor ? type !== 'supervisor' : type !== 'chat') continue
    if (win.webContents.id === senderWebContentsId) continue
    safeSend(win, 'dm:quote-to-session', payload)
    delivered += 1
  }
  audit({ dir: 'out', caller: 'builtin', topic: 'quote_to_session', channelId: thread.channelId, to: sessionId, bytes: byteLen(msg.text), result: delivered > 0 ? 'injected' : 'no_window' })
  const where = tIn(getMainLocale(), isSupervisor ? 'dm.quoteWhereSup' : 'dm.quoteWhereChat')
  return delivered > 0
    ? { ok: true, message: tIn(getMainLocale(), 'dm.quoteAppended', { where }) }
    : { ok: false, message: tIn(getMainLocale(), isSupervisor ? 'dm.quoteNoSupWindow' : 'dm.quoteNoChatWindow') }
}
