import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WindowTitleBar } from '../components/WindowTitleBar'
import { IconChat, IconCheck, IconChevronDown, IconClose, IconPlus, IconRefresh, IconSearch, IconTrash, IconUsers, IconWarn } from '../components/icons'
import { btn, smallIconBtn } from '../components/ui'
import { ImagePreview } from '../components/ImagePreview'
import { DmComposer } from './DmComposer'
import { DmQuotePicker, type DmQuoteTarget } from './DmQuotePicker'
import { DmToast, useDmToast } from './dm-toast'
import { dmContentPreview } from '../../shared/dm-attachment'
import { DM_MAX_CONTENT_BYTES, encodeDmContent, utf8Bytes } from '../../shared/dm-attachment'
import type { DmAttachmentPayload } from '../../shared/dm-attachment'
import { patchUiStore, useUiStoreSelector } from '../store-client'
import { DmAvatar, DmMessageRow, DmTimeDivider, DmUnreadDivider, LEFT_WIDTH_NARROW_PX, LEFT_WIDTH_PX, NARROW_WIDTH_PX, buildChatRows, fmtListTime, statusLabelOf, threadPreview } from './DmIm'
// 【i18n 期1】取词函数导入成 tKey：本文件多处把会话条目命名为 t（visibleThreads.map((t) => …) 等），
// 直接 import { t } 会在那些回调里被遮蔽。用别名最稳，不去改既有回调的形参名。
import { getLocale, t as tKey, tf as tfKey } from '../../shared/i18n'
// 【期5B-补漏】显示名判定从本文件**搬到 shared/member-display.ts**：主进程的通知标题也要用
// 同一份判定（用户裁决：任何位置都不出现纯数字 memberId）。这里保留同名局部函数只做转发，
// 是为了 17 处调用点一字不改；判定逻辑只有 shared 那一份，不存在第二套真相。
import { displayNameOf as displayNameOfShared } from '../../shared/member-display'
import { renderRich, useLocaleSync } from '../locale'
import { useDmMessageScroll } from './useDmMessageScroll'
import type { DmRow } from './DmIm'
import type { CredentialSnapshot, DmDraftStore, DmFriend, DmFriendRequest, DmMessage, DmThread, DmUnread, MemberChannelStatus, MemberNotice, MemberResult } from '../types'

/**
 * 「私信」应用窗口（会员实时通讯底线的内置 UI）：两个分区 —— 私信 / 好友。
 *
 * 挂载形态选择理由：走内置 App 窗口注册表（apps/registry.tsx + app/AppWindow.tsx 的 appId 路由），
 * 与「创意空间 / 设置 / 记忆 / 轨迹」完全同构，可复用现成的 WindowTitleBar、主题同步、
 * 多窗口生命周期与 Dock 图标机制，成本最低；同时它不是插件窗口（挂 index.cjs 而非 plugin.cjs），
 * 因此天然能直接用 window.shanhai 的 member:* 接口，不需要为它开任何插件白名单。
 *
 * 契约 v1 定稿对齐：
 *  - 好友操作（检索 / 申请 / 同意 / 拒绝 / 删除）与历史 / 会话列表 / 未读 **全部走 HTTP**（由主进程代发），
 *    本面板只调 window.shanhai.member* 接口，拿不到任何凭证；
 *  - 实时收发走 ws（role=member），到达即插进气泡；自发消息会被回显，去重由主进程按 messageId 处理；
 *  - 网关未实现 member_online/offline，故本面板 **不显示「在线」状态**，不谎报。
 *
 * 【安全红线】本面板显示的私信内容只用于「给人看」。
 * 唯一能把外部消息送进会话的入口是用户显式点击「引用到会话」，
 * 且该动作只把原文追加进聊天/管家窗口的输入框（不自动发送、不自动执行、不自动批准）。
 */

type Tab = 'dm' | 'friends'

/**
 * 【任务113】单条私信 content 字节上限不再在本文件写字面量：与主进程同取 src/shared/dm-attachment.ts
 * 的 DM_MAX_CONTENT_BYTES（改前这里 4000、主进程再写 4000，两份会漂，连词条与参数名都不同）。
 * 判定口径 = **编码后的 content**（encodeDmContent 产物）的 UTF-8 字节数，与主进程 sendDm 入参同口径
 * （渲染层传给主进程的 text 本身就是编码后的 content）。
 */

/** utf8Bytes 改用 src/shared/dm-attachment.ts 里那一份：输入区（DmComposer）与面板都要按**编码后的
 *  content** 计数，两处各写一份必然漂开（主进程 Buffer.byteLength 是同口径）。 */

/** 时间戳 → 简短时间（今天显示 HH:MM，跨天显示 M月D日 HH:MM） */
/**
 * 【闪烁修复·配套】内容级比较：主进程每次广播/每次 IPC 返回的都是**新引用**（数组与对象都是重新构造的），
 * 直接 setState(新引用) 必然触发重渲染。会员通道每 ~80 秒重连一次，重连会连着推好几条内容完全一样的快照，
 * 于是界面反复重绘 + 提示条反复出现/消失 = 用户看到的「一闪一闪」。这里用序列化指纹判断「内容真的变了没」。
 * 私信面板的数据量很小（好友/会话/单页消息），JSON.stringify 的开销远小于一次整树重渲染。
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm
  // 【i18n 期1】日期形态走词条，代码侧不再拼「月/日」
  return tKey('dm.time.mdAt', { md: tKey('dm.time.md', { m: d.getMonth() + 1, d: d.getDate() }), time: hm })
}

/** 会员通道状态 → 如实的横幅文案与色调（未登录 / 凭证三态 / 连接中 / 正常） */
function statusBanner(
  ui: { loggedIn: boolean; username: string | null },
  st: MemberChannelStatus | null,
  cred: CredentialSnapshot | null,
): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!ui.loggedIn) {
    // 凭证被判失效时主进程已把全局登录态翻成未登录，这里给出原因，不让用户以为「莫名其妙掉登录」
    const why = cred?.state === 'expired' ? tKey('dm.banner.credReason', { reason: cred.text ?? tKey('dm.banner.credExpired') }) : ''
    return { text: tKey('dm.banner.notLoggedIn', { why }), tone: 'bad' }
  }
  // 【三态如实呈现】已登录但凭证已过期 / 即将到期：不得只显示「已登录」而不说明
  if (cred && (cred.state === 'expired' || cred.state === 'unknown' || cred.state === 'renewing')) {
    return { text: cred.text ?? tKey('dm.banner.credAbnormal'), tone: cred.state === 'expired' ? 'bad' : 'warn' }
  }
  if (st?.authFailed) return { text: cred?.text ?? tKey('dm.banner.authFailed'), tone: 'bad' }
  if (!st) return { text: tKey('dm.banner.reading'), tone: 'warn' }
  if (!st.enabled) return { text: tKey('dm.banner.disabled'), tone: 'warn' }
  if (!st.connected) return { text: tKey('dm.banner.notConnected', { error: st.error ?? tKey('dm.banner.retrying') }), tone: 'warn' }
  if (!st.memberId) return { text: tKey('dm.banner.noIdentity'), tone: 'warn' }
  return { text: st.username ? tKey('dm.banner.connectedAs', { username: st.username }) : tKey('dm.banner.connected'), tone: 'ok' }
}

/**
 * 【2026-09-04 用户要求：私信界面不再显示会员ID】
 * 界面上所有「人」的展示名统一走这里：昵称 → 用户名 → 「未知会员」，**绝不回落到 memberId**。
 * 【期5B-补漏】主进程原先也在拿不到昵称/用户名时兜底成对端 id（peerName / fromName / 通知标题），
 * 现已在源头改掉；判定逻辑同时抽到 shared/member-display.ts 双端共用，本函数只做转发。
 * ⚠️ 只影响显示：memberId 仍原样用于发申请/同意/拒绝/删除、开会话、发私信、去重与 React key。
 */
function displayNameOf(name: string | undefined | null, id?: string): string {
  // 【期5B-补漏】判定本体已抽到 shared/member-display.ts（主进程共用），这里只是转发，
  // 保持 17 处调用点与函数签名一字不变。任务58 的两条早退语义（空 / 名字等于 id 都算无真名）
  // 由 shared 那份实现保证，不在这里重复一遍。
  return displayNameOfShared(name, id)
}

const DRAFT_KEY = 'shanhai:dm:drafts'

/** 【P6】读本地草稿缓存（容错：JSON 坏 / localStorage 不可用都回退空表，不崩溃） */
function loadDrafts(): DmDraftStore {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as DmDraftStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 【P6】写本地草稿缓存（try/catch 容错：隐私模式下 localStorage 可抛异常，不因此崩） */
function saveDrafts(store: DmDraftStore): void {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(store))
  } catch {
    // 草稿只是便利功能，写盘失败不应打断使用
  }
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border-soft)',
  borderRadius: 12,
  background: 'var(--bg-panel)',
  padding: 14,
}

export interface MemberPanelProps {
  onClose: () => void
}

export function MemberPanel(p: MemberPanelProps): React.JSX.Element {
  /**
   * 【闪烁修复·主因】这里此前用 useUiStore() 全量订阅共享快照：主进程每 16ms 就广播一次
   * ui:state（push.ts 合并窗口），而**任何会话**的工具步骤 / token 统计 / 审批 / 当前会话变化都会广播。
   * 私信面板只用到 loggedIn / loginOpen / currentSessionId / username 四个字段，却跟着快照一起
   * 以最高约 60 次/秒的频率整树重渲染 —— 管家或别的会话在跑任务时，私信窗口就是用户说的「一闪一闪」。
   * 改用项目里既有的窄订阅范式（App.tsx / SupervisorApp.tsx 都这么用）：四个字段浅相等就不重渲染。
   */
  // 【i18n 期1】订阅语言变化：本组件（及其子件 DmComposer / DmQuotePicker / DmIm 显示件）
  // 都是在 render 期直接调 tKey() 取词的，没有订阅就不会在切换语言时重渲染 → 界面会停在旧语言。
  // 用 useSyncExternalStore 订阅（值不变不重渲染），不会把任务59 消掉的重复渲染请回来。
  useLocaleSync()
  const ui = useUiStoreSelector((s) => ({
    loggedIn: s.loggedIn,
    loginOpen: s.loginOpen,
    currentSessionId: s.currentSessionId,
    username: s.username,
  }))
  const [tab, setTab] = useState<Tab>('dm')
  const [status, setStatus] = useState<MemberChannelStatus | null>(null)
  const [friends, setFriends] = useState<DmFriend[]>([])
  const [requests, setRequests] = useState<DmFriendRequest[]>([])
  /** 红点权威：HTTP /friends/requests/count 下发值（列表可能被分页截断，不能只看 requests.length） */
  const [requestCount, setRequestCount] = useState(0)
  const [threads, setThreads] = useState<DmThread[]>([])
  const [unread, setUnread] = useState<DmUnread>({ total: 0, byChannel: {} })
  const [active, setActive] = useState<DmThread | null>(null)
  /** 图片大图预览遮罩（与聊天窗口 / 管家窗口同一个 ImagePreview） */
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)
  // 添加好友：定稿只做「用户名精确匹配」（不做邀请码入口），故拆成 搜索 → 结果 → 发申请 两步
  const [searchInput, setSearchInput] = useState('')
  const [searchMsg, setSearchMsg] = useState('')
  const [searchResults, setSearchResults] = useState<DmFriend[]>([])
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  /**
   * 检索结果的四种结局必须可区分（此前只有「有结果 / 空列表」两态，把「请求失败」也渲染成
   * 「没有找到这个用户名」，用户会以为是自己的关键词不对，实际是链路坏了 —— 这正是「点了搜不到」
   * 最难自查的那一层）。none=还没查 / found=搜到 / notfound=确实没这个人 / failed=请求本身失败。
   */
  const [searchOutcome, setSearchOutcome] = useState<'none' | 'found' | 'notfound' | 'failed'>('none')
  /** 正在发送好友申请的会员 id：按钮期间禁用，防连点撞网关 5 次/分钟限流（实测第 6 次回 HTTP 429） */
  const [requestingId, setRequestingId] = useState<string>('')
  /** 发送中标记已下沉到 DmComposer（它才知道附件传完没有），面板这里不再重复持一份 */
  /** 凭证三态快照（未登录 / 已登录有效 / 已登录但已过期 / 有效期未知），主进程 credential:status 实时推送 */
  const [cred, setCred] = useState<CredentialSnapshot | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  /**
   * 【P4·切会话不闪】正在读某个会话的第一页历史。为的是把「确实没有消息」与「还没读到」分开：
   * 改前只有一句空态文案，点开一个没有本地缓存的会话会先闪「还没有消息」再刷成真实气泡（就是白一下）。
   */
  const [threadLoading, setThreadLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  /** 管家接管开关（私信 IM 化·管家接管）：默认 false，跟随 settings.dmAutoReply（主进程读它做发消息总开关） */
  const [dmAutoReply, setDmAutoReply] = useState(false)
  /** 首次开启的确认框只弹一次（会话内），不是每次开都问 */
  const dmConfirmShownRef = useRef(false)
  /** 【P6】跨会话草稿保留：按 channelId 存 {channelId: text}，localStorage 持久化。
   *  为什么落盘：任务54 记录「去登录让位用 closeApp 是 destroy 非 hide → 面板重挂载 state 清空」，
   *  只用组件 state 面板被 destroy 后草稿全丢；localStorage（同 origin 跨窗口/跨重启）才保得住。 */
  const [drafts, setDrafts] = useState<DmDraftStore>(loadDrafts)
  const draftsRef = useRef<DmDraftStore>(drafts)
  useEffect(() => { draftsRef.current = drafts; saveDrafts(drafts) }, [drafts])
  const { toast, show: showToast, dismiss: dismissToast } = useDmToast()
  /** 当前已加载到的历史页码（定稿 v1.1：page=1 是最新一页，「加载更早」= page 递增） */
  const [historyPage, setHistoryPage] = useState(1)
  /**
   * 【任务63】「引用到会话」的目标：改前是一条**常驻下拉**（要先在下拉里选对目标、再点消息旁 ＋，
   * 选择成本前置且不明显），现在改成「点 ＋ → 弹出会话选择器 → 选定才落地」。
   * quoteFor = 正在被引用的那条私信（非空即弹层打开）。
   */
  const [quoteFor, setQuoteFor] = useState<DmMessage | null>(null)
  const [quotePending, setQuotePending] = useState(false)
  /** 弹层内的失败原因：不靠面板顶部那条 4 秒自动消失的提示条承载（弹层一关就丢了） */
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [quoteHint, setQuoteHint] = useState<string | null>(null)
  /** 本次面板生命周期内已成功引用过的 (目标会话, 通道, 消息) —— 用于「重复引用只塞一遍」 */
  const quotedOnceRef = useRef<Set<string>>(new Set())
  /**
   * 重复引用的「强制位」：第一次点重复只提示、不塞；用户再点同一个会话才真的再塞一次。
   * 为什么必须有：输入框里那份可能已被用户发掉或删掉，此时「永远不许再引用同一条」会把人锁死。
   * 反过来说，提示文案必须与代码行为一致 —— 没有这个强制位，提示里那句「再点一次」就是假出路。
   */
  const quoteForceRef = useRef<string>('')
  /** 可选目标：listSessions() 的全部普通会话 + 会话管家（沿用既有能力，不新增 IPC） */
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; lastActiveAt?: number; busy?: boolean }>>([])
  const activeChannelRef = useRef<string>('')
  activeChannelRef.current = active?.channelId ?? ''


  /** 统一提示：成功走 notice，失败走 errorText（两者都如实展示，不静默吞掉） */
  const showResult = useCallback((r: MemberResult | null | undefined): void => {
    if (!r) return
    if (r.ok) {
      setNotice(r.message)
      setErrorText(null)
    } else {
      setErrorText(r.message)
      setNotice(null)
    }
  }, [])

  /**
   * 【闪烁修复】列表/快照类 state 一律走这个守卫：主进程每次都返回**新数组引用**（内容常常完全一样），
   * 直接 setThreads(新引用) 会让整棵子树重渲染；配合通道重连就成了持续抖动。
   * 内容指纹相同 → 保留旧引用，React 直接跳过重渲染。
   */
  const setThreadsIfChanged = useCallback((next: DmThread[] | null | undefined): void => {
    if (!next) return
    setThreads((prev) => (sameJson(prev, next) ? prev : next))
  }, [])
  const setFriendsIfChanged = useCallback((snap: { friends: DmFriend[]; requests: DmFriendRequest[] } | null | undefined): void => {
    if (!snap) return
    setFriends((prev) => (sameJson(prev, snap.friends) ? prev : snap.friends))
    setRequests((prev) => (sameJson(prev, snap.requests) ? prev : snap.requests))
  }, [])

  const reloadThreads = useCallback((): void => {
    void window.shanhai?.memberThreads().then(setThreadsIfChanged)
  }, [setThreadsIfChanged])

  const reloadAll = useCallback(async (): Promise<void> => {
    const [st, fr, th, un] = await Promise.all([
      window.shanhai?.memberStatus(),
      window.shanhai?.memberFriends(),
      window.shanhai?.memberThreads(),
      window.shanhai?.memberUnread(),
    ])
    if (st) setStatus(st)
    if (fr) {
      setFriendsIfChanged(fr)
      setRequestCount(fr.requestCount ?? fr.requests.length)
    }
    if (th) setThreadsIfChanged(th)
    if (un) setUnread(un)
  }, [setThreadsIfChanged, setFriendsIfChanged])

  // 管家接管开关：写 settings.dmAutoReply（主进程 member-channel 在「管家发消息」出站前读它做总开关）。
  // 开启前弹一次确认框（明白「发出去无法撤回」）；关闭直接写 false 不确认。
  const setDmAutoReplySetting = useCallback(async (next: boolean): Promise<void> => {
    if (!next) {
      await window.shanhai?.setSettings?.({ dmAutoReply: false })
      setDmAutoReply(false)
      return
    }
    if (!dmConfirmShownRef.current) {
      dmConfirmShownRef.current = true
      const ok = window.confirm(tKey('dm.autoReplyConfirm'))
      if (!ok) return
    }
    const s = await window.shanhai?.setSettings?.({ dmAutoReply: true })
    if (s) setDmAutoReply(!!s.dmAutoReply)
  }, [])

  /**
   * 【任务63】拉「引用到会话」的可选目标：`listSessions()` 的全部普通会话 + 会话管家。
   * 每次打开弹层、每次落地前都会重拉一次 —— 会话可能在面板开着的时候被删掉，
   * 拿旧列表落地就会「以为引用成功了」而实际什么都没写进去（静默失败，本项目反复踩的坑）。
   * 不新增任何 IPC：listSessions 是既有通道，主进程 quoteDmToSession 也只投 chat / supervisor 两类窗口。
   */
  const refreshQuoteTargets = useCallback(
    async (): Promise<Array<{ id: string; title: string; lastActiveAt?: number; busy?: boolean }>> => {
      if (!window.shanhai?.listSessions) {
        setSessions([])
        return []
      }
      const list = await window.shanhai.listSessions()
      const items: Array<{ id: string; title: string; lastActiveAt?: number; busy?: boolean }> = (list ?? []).map((s) => ({
        id: s.id,
        title: s.title,
        lastActiveAt: s.lastActiveAt,
        busy: s.busy,
      }))
      // 会话管家是固定内置会话，listSessions 里若没带上，这里补一个可选项
      if (!items.some((s) => s.id === 'supervisor')) items.unshift({ id: 'supervisor', title: tKey('common.supervisorSession') })
      setSessions(items)
      return items
    },
    [],
  )

  /**
   * 「去登录」：复用山海既有的会员登录入口，不在本窗口另造登录 UI。
   *
   * 既有登录入口的真实形态：登录弹窗 components/LoginModal 只挂在**聊天窗口**的 overlays 插槽
   * （plugins/OverlaysPlugin.tsx:11，由共享 store 的 loginOpen 驱动，App.tsx:81 写入）。
   * Dock 的登录项走的就是这一套（desktop/DockApp.tsx:58-63：先 patchUiStore({loginOpen:true})
   * 再 openApp('chat')）。本按钮此前**漏了第一步**，只把聊天窗口带到前台 → 登录框根本没打开。
   *
   * 另一个必须一起处理的点：本面板是 app 类型窗口，主进程给它设了 alwaysOnTop
   * （main/window-manager.ts:161），层级高于普通聊天窗口 → 即使登录框弹出来也会被本窗口盖住，
   * 用户仍然什么都看不见。故下面用「登录弹窗一被打开就让位（关闭本窗口）」统一解决，
   * 见紧邻的 useEffect：这样无论从本按钮、Dock 还是侧边栏触发登录，遮挡都不存在。
   */
  const goLogin = useCallback(async (): Promise<void> => {
    if (!window.shanhai?.openApp) {
      // 可选链会把「桥不存在」吞成静默 undefined，这里显式兜住并给出可见原因
      setErrorText(tKey('dm.login.noBridge'))
      return
    }
    try {
      // 第一步（此前缺失的关键一步）：把共享 store 的 loginOpen 置真 → 聊天窗口才会渲染登录弹窗
      patchUiStore({ loginOpen: true })
      // 第二步：把聊天窗口带到前台（本窗口会由下面的 effect 自动关闭让位）
      const ok = await window.shanhai.openApp('chat')
      if (ok === false) {
        setErrorText(tKey('dm.login.chatNotOpened'))
      }
    } catch (e) {
      setErrorText(tKey('dm.login.exception', { error: e instanceof Error ? e.message : String(e) }))
    }
  }, [])

  // 登录弹窗被打开（false → true 的那次翻转）时本窗口让位关闭：alwaysOnTop 会盖住聊天窗口的登录框
  const prevLoginOpenRef = useRef<boolean>(ui.loginOpen)
  useEffect(() => {
    const was = prevLoginOpenRef.current
    prevLoginOpenRef.current = ui.loginOpen
    if (!was && ui.loginOpen) p.onClose()
  }, [ui.loginOpen])

  // 初次挂载：读本地快照 + 主动走一次 HTTP 刷新（好友列表/会话列表/未读权威都在 HTTP，不能只等 ws 被动下发）
  useEffect(() => {
    void reloadAll()
    void window.shanhai?.memberRefreshFriends()
    void window.shanhai?.memberPullThreads()
    void refreshQuoteTargets()
  }, [reloadAll, refreshQuoteTargets])

  // 管家接管开关：挂载拉一次当前值（主进程读它做发消息总开关，这里只用来渲染选中态）
  useEffect(() => {
    let live = true
    void window.shanhai?.getSettings?.().then((s) => {
      if (live && s) setDmAutoReply(!!s.dmAutoReply)
    }).catch(() => undefined)
    return () => { live = false }
  }, [])

  // 订阅主进程广播（低频小事件，不进 ui:state 全量快照）
  useEffect(() => {
    const offStatus = window.shanhai?.onMemberStatus((s) => setStatus(s))
    // 凭证状态：挂载先拉一次快照，之后靠主进程广播（续签成功/失败/判失效都会推）
    void window.shanhai?.getCredentialStatus().then((c) => setCred(c)).catch(() => undefined)
    const offCred = window.shanhai?.onCredentialStatus((c) => setCred(c))
    const offFriends = window.shanhai?.onMemberFriends((snap) => {
      setFriendsIfChanged(snap)
      setRequestCount(snap.requestCount ?? snap.requests.length)
    })
    const offUnread = window.shanhai?.onMemberUnread((u) => setUnread(u))
    const offError = window.shanhai?.onMemberError((e) => setErrorText(`${e.message}${e.code ? tKey('common.codeSuffix', { code: e.code }) : ''}`))
    const offNotice = window.shanhai?.onMemberNotice((n: MemberNotice) => setNotice(n.message))
    const offHistory = window.shanhai?.onMemberHistory((payload) => {
      if (payload.channelId !== activeChannelRef.current) return
      // 【闪烁修复】补拉回来的整条会话若与当前完全一致，就不要生成新对象（重连时会反复触发）
      setActive((prev) => {
        if (!prev || prev.channelId !== payload.channelId) return prev
        if (sameJson(prev.messages, payload.messages) && prev.unread === 0) return prev
        return { ...prev, messages: payload.messages }
      })
      setHasMore(payload.hasMore)
    })
    const offOpen = window.shanhai?.onMemberOpenThread((payload) => {
      // 点系统通知直达对应会话：切到私信分区并打开那个线程
      // 【闪烁修复】这里读 threadsRef 而不是闭包里的 threads —— 否则必须把 threads 放进依赖数组，
      // 而列表每变一次就要把下面 10 个监听全摘一遍再挂一遍（既抖动，又有丢事件的窗口）。
      const t = threadsRef.current.find((x) => x.channelId === payload.channelId)
      setTab('dm')
      if (t) void openThreadRef.current?.(t)
    })
    const offTab = window.shanhai?.onMemberOpenTab((payload) => setTab(payload.tab))
    const offMessage = window.shanhai?.onMemberMessage((msg: DmMessage) => {
      // 只把「当前打开的会话」的消息实时插进气泡；其它会话靠列表 + 未读体现
      if (msg.channelId === activeChannelRef.current) {
        setActive((prev) => {
          if (!prev || prev.channelId !== msg.channelId) return prev
          const idx = prev.messages.findIndex((m) => m.msgId === msg.msgId || (!!msg.serverId && m.serverId === msg.serverId))
          // 同一条（含乐观气泡被回显认领的情况）→ 原位替换，绝不追加第二遍
          if (idx >= 0) {
            const next = [...prev.messages]
            next[idx] = msg
            return { ...prev, messages: next, lastTs: Math.max(prev.lastTs, msg.ts) }
          }
          return { ...prev, messages: [...prev.messages, msg], unread: 0, lastTs: Math.max(prev.lastTs, msg.ts) }
        })
      }
      reloadThreads()
    })
    return () => {
      offStatus?.()
      offCred?.()
      offFriends?.()
      offUnread?.()
      offError?.()
      offNotice?.()
      offHistory?.()
      offOpen?.()
      offTab?.()
      offMessage?.()
    }
  }, [reloadThreads, setThreadsIfChanged, setFriendsIfChanged])

  // 提示条自动消失
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  /**
   * 【P4·默认打开第一个会话】两个守卫 ref：
   *  - didAutoOpenRef：自动打开在本次挂载内**最多发生一次**（列表每次刷新都会跑这个 effect，靠它挡住重复触发）；
   *  - selectionTouchedRef：只要「选过会话」这件事发生过（用户手点 / 通知直达 / 自动打开 / **用户点关闭**），
   *    就永不再自动切 —— 否则表现就是「关不掉、一点关闭又弹回一个对话」。
   */
  const didAutoOpenRef = useRef(false)
  const selectionTouchedRef = useRef(false)
  /** 打开会话的序号：快速连切会话时，只有最后一次才允许关「正在读取…」，否则会错显成「还没有消息」 */
  const threadLoadSeqRef = useRef(0)

  const openThread = useCallback(async (t: DmThread): Promise<void> => {
    // 【P4】选过会话（手点 / 通知直达 / 自动打开）→ 本次挂载不再自动切
    selectionTouchedRef.current = true
    if (active && active.channelId !== t.channelId) void window.shanhai?.memberUnsubscribe(active.channelId)
    setTab('dm')
    // 【P4·切会话不闪】先用本地已缓存的消息就地显示（没缓存时靠 threadLoading 显示「正在读取…」，
    // 而不是先渲染空态再刷成真实内容），HTTP 权威结果回来后再一次性替换。
    setActive({ ...t, messages: t.messages ?? [] })
    const seq = (threadLoadSeqRef.current += 1)
    setThreadLoading(true)
    // 弹层是按「当前打开的会话」落地的，切会话时必须一起关掉，否则会拿旧消息配新 channelId 去引用
    setQuoteFor(null)
    setQuoteError(null)
    setQuoteHint(null)
    setHasMore(false)
    setHistoryPage(1)
    // 订阅即拉一页历史（HTTP 权威），并把未读清零（任一设备读过即已读）
    const snapshot = (await window.shanhai?.memberSubscribe(t.channelId)) ?? t
    // 只有「这次打开仍然是最新一次」才关加载态（连点两个会话时，先返回的那个不许把后一个的加载态关掉）
    if (seq === threadLoadSeqRef.current) setThreadLoading(false)
    if (snapshot.channelId === t.channelId) {
      // 【真头像】主进程快照没带头像时保留本地已有值（网关该字段常为空串，不能让空值把已显示的头像抹掉）
      setActive((prev) => {
        if (!prev || prev.channelId !== snapshot.channelId) return prev
        const next: DmThread = { ...snapshot, peerId: snapshot.peerId || t.peerId, peerName: snapshot.peerName || t.peerName, peerAvatar: snapshot.peerAvatar ?? t.peerAvatar, messages: snapshot.messages ?? [] }
        // 【P4·不闪】权威结果与本地缓存内容完全一致 → 保留旧引用，React 直接跳过这一轮重渲染
        // （任务59 的 sameJson 口径；少了这层守卫，每次点会话都至少白刷一次）
        return sameJson(prev, next) ? prev : next
      })
      setHasMore((snapshot.messages?.length ?? 0) >= (t.messages?.length ?? 0) && (snapshot.messages?.length ?? 0) > 0)
    }
    void window.shanhai?.memberMarkRead(t.channelId)
    reloadThreads()
  }, [active, reloadThreads])

  // 供订阅回调调用（避免把 openThread 放进它的依赖里造成反复重订阅）
  const openThreadRef = useRef<(t: DmThread) => Promise<void>>(openThread)
  openThreadRef.current = openThread
  // 同理：订阅回调里读列表用 ref，不进依赖数组
  const threadsRef = useRef<DmThread[]>(threads)
  threadsRef.current = threads

  const closeThread = useCallback((): void => {
    // 【P4】用户主动关闭 = 他已经做过选择：置守卫位，自动打开绝不能再把他刚关掉的那个（或别的）会话弹回来
    selectionTouchedRef.current = true
    if (active) void window.shanhai?.memberUnsubscribe(active.channelId)
    setActive(null)
    // 同上：会话都关了，引用弹层没有意义，一起收掉（不静默——它本来就没有结果可丢）
    setQuoteFor(null)
    setQuoteError(null)
    setQuoteHint(null)
  }, [active])

  /**
   * 【P4】消息流滚动。喂给 hook 的是**四个原始值**（不是数组引用）：面板因会员通道广播重渲染时
   * 这四个值不变 → hook 里的 layout effect 根本不跑 → 不会有「每次重渲染都滚一次」的抖动。
   */
  const msgSig = useMemo(() => {
    const ms = active?.messages ?? []
    const first = ms[0]
    const last = ms[ms.length - 1]
    return {
      channelId: active?.channelId ?? '',
      count: ms.length,
      firstKey: first?.msgId ?? '',
      lastKey: last?.msgId ?? '',
    }
  }, [active])
  const dmScroll = useDmMessageScroll(msgSig)

  /**
   * 加载更早的历史（定稿 v1.1：GET /messages/conversations/:peerId?page=&pageSize=，
   * page=1 是最新一页，「加载更早」= page 递增；旧的时间戳游标 before 网关不支持，已废弃）。
   * 主进程返回的是「合并去重后的整条会话」，所以这里整体替换 messages 而不是拼接。
   */
  const onLoadMore = useCallback(async (): Promise<void> => {
    if (!active || loadingMore) return
    const next = historyPage + 1
    setLoadingMore(true)
    try {
      const page = await window.shanhai?.memberHistory({ channelId: active.channelId, page: next, pageSize: 30 })
      if (!page) return
      if (page.error) setErrorText(page.error)
      // 【P4】把消息换成「合并去重后的更长整条会话」→ 顶部插入内容。滚动容器靠上一次记录的几何
      // 补回这段高度差，用户原来看的那条不动（不会跳回底部，也不会跳飞）。
      setActive((prev) => (prev ? { ...prev, messages: page.messages } : prev))
      setHistoryPage((prev) => Math.max(prev, page.page ?? next))
      setHasMore(page.hasMore && page.messages.length > 0)
    } finally {
      setLoadingMore(false)
    }
  }, [active, historyPage, loadingMore])

  /**
   * 【P3】发送一条私信：正文 + 附件引用一起交给主进程。
   * 附件**只带云存储公网 URL**（content 里是紧凑 JSON 引用），绝不带 base64 —— 单条上限见 DM_MAX_CONTENT_BYTES，
   * 且本项目已因 base64 撑爆请求踩过 context deadline exceeded。
   * 返回 true = 已发出（输入区据此清空）；false = 没发出去（用户已写的正文与已选的附件一律保留）。
   */
  const onSend = useCallback(
    async (text: string, atts: DmAttachmentPayload[]): Promise<boolean> => {
      if (!active) return false
      if (!window.shanhai?.memberSend) {
        // 可选链会把「桥不存在」吞成 undefined，若当成成功就会白清空输入框
        setErrorText(tKey('dm.send.noBridge'))
        setNotice(null)
        return false
      }
      const content = encodeDmContent(text, atts)
      const bytes = utf8Bytes(content)
      if (bytes > DM_MAX_CONTENT_BYTES) {
        // 本地就拦住，不等网关回 content_too_long（省一次往返，也避免用户以为发出去了）
        // 【任务113】超限文案收敛成共享词条 dm.contentTooLong（与主进程同一份文案、同一组参数名）
        setErrorText(tKey('dm.contentTooLong', { bytes, max: DM_MAX_CONTENT_BYTES }))
        setNotice(null)
        return false
      }
      // 【P4】点发送 → 立刻贴底，保证「自己刚发出去的那条」可见（不等对方回复、不用手动滚）。
      // 放在 await 之前：乐观气泡可能在回执之前就到（那时 atBottomRef 已经是 true → 直接跟随）。
      dmScroll.scrollToBottom(false)
      const r = await window.shanhai.memberSend({ peerMemberId: active.peerId, channelId: active.channelId, text: content, peerName: active.peerName })
      if (r && !r.ok) {
        // 发送失败：保留输入内容 + 如实提示原因（好友前提 / 超限 / 限流 / 未连接）
        setErrorText(r.message)
        setNotice(null)
        return false
      }
      setNotice(r?.message ?? (atts.length > 0 ? tKey('dm.sentWithAttachment') : tKey('dm.sent')))
      showToast({ type: 'success', text: r?.message ?? (atts.length > 0 ? tKey('dm.sentWithAttachment') : tKey('dm.sent')) })
      reloadThreads()
      return true
    },
    [active, reloadThreads],
  )

  /**
   * 【任务63·第一步】点消息上的「引用」：**只打开会话选择器，不落地**。
   * 改前是「先在常驻下拉里选目标 → 再点 ＋ 直接落地」，用户很容易在没注意下拉的情况下引用错会话。
   * 这里的前置检查只拦「根本不可能成功」的两种情况，并把原因说清楚（不静默）。
   */
  const openQuotePicker = useCallback(
    (msg: DmMessage): void => {
      if (!active) return
      if (!window.shanhai?.memberQuoteToSession) {
        // 可选链会把「桥不存在」吞成静默 undefined → 点了像没反应，这里显式给原因
        setErrorText(tKey('dm.quote.noBridge'))
        setNotice(null)
        return
      }
      setQuoteError(null)
      setQuoteHint(null)
      quoteForceRef.current = ''
      setQuoteFor(msg)
      // 弹层打开时重拉一次目标列表：面板可能开着很久，期间新建/删除的会话要能反映出来
      void refreshQuoteTargets()
    },
    [active, refreshQuoteTargets],
  )

  /** 关闭弹层：连同弹层内的失败原因一起清掉（原因已经看过/不想再看了） */
  const closeQuotePicker = useCallback((): void => {
    setQuoteFor(null)
    setQuoteError(null)
    setQuoteHint(null)
  }, [])

  /**
   * 【任务63·第二步】选定目标后才真正落地。五条失败分支各给各的可见原因，全部留在弹层内：
   *  ① 桥不存在  ② 未登录  ③ 凭证已失效  ④ 目标会话已被删（落地前重拉列表校验）  ⑤ 调用抛异常
   * 另外「目标窗口未打开」由主进程 quoteDmToSession 返回 ok=false + 原因，这里原样透出。
   * 重复引用：同一条私信引用到**不同**会话允许；引用到**同一**会话只塞一遍，第二次给「已追加过」提示。
   */
  const doQuoteTo = useCallback(
    async (msg: DmMessage, target: DmQuoteTarget): Promise<void> => {
      if (!active || quotePending) return
      const label = (target.title ?? '').trim() || (target.id === 'supervisor' ? tKey('common.supervisorSession') : tKey('common.unnamedSession'))
      if (!window.shanhai?.memberQuoteToSession) {
        setQuoteError(tKey('dm.quote.noBridge'))
        return
      }
      if (!ui.loggedIn) {
        setQuoteError(tKey('dm.quote.notLoggedIn'))
        return
      }
      if (cred?.state === 'expired') {
        setQuoteError(tKey('dm.quote.credFailed', { reason: cred.text ?? tKey('dm.quote.credExpired') }))
        return
      }
      const key = `${target.id}|${active.channelId}|${msg.msgId}`
      if (quotedOnceRef.current.has(key) && quoteForceRef.current !== key) {
        // 不静默吞掉，也不重复塞两遍：第一次只提示，并把「再点一次」这条出路给到位（下一次真的放行）
        quoteForceRef.current = key
        setQuoteError(null)
        setQuoteHint(tKey('dm.quote.alreadyAppended', { target: label }))
        return
      }
      quoteForceRef.current = ''
      setQuotePending(true)
      setQuoteHint(null)
      try {
        // 落地前再拉一次列表：面板开着期间目标会话可能已被删除，用陈旧列表会「假成功」
        const fresh = await refreshQuoteTargets()
        if (!fresh.some((s) => s.id === target.id)) {
          setQuoteError(tKey('dm.quote.sessionGone', { target: label }))
          return
        }
        const r = await window.shanhai.memberQuoteToSession({ sessionId: target.id, channelId: active.channelId, msgId: msg.msgId })
        if (!r) {
          setQuoteError(tKey('dm.quote.noReturn'))
          return
        }
        if (r.ok) {
          quotedOnceRef.current.add(key)
          setNotice(r.message ?? tKey('dm.quote.appended', { target: label }))
          setErrorText(null)
          setQuoteFor(null)
        } else {
          // 目标窗口未打开等原因：留在弹层里，用户看得见，不用去猜
          setQuoteError(r.message)
        }
      } catch (e) {
        setQuoteError(tKey('dm.quote.exception', { error: e instanceof Error ? e.message : String(e) }))
      } finally {
        setQuotePending(false)
      }
    },
    [active, quotePending, refreshQuoteTargets, ui.loggedIn, cred],
  )

  /** 弹层可选目标：把「用户当前正在看的会话」标出来（改前常驻下拉的默认值就是它，语义在这里以「当前」徽标保留） */
  const quoteTargets = useMemo(
    (): DmQuoteTarget[] =>
      sessions.map((s) => ({
        id: s.id,
        title: s.title,
        lastActiveAt: s.lastActiveAt,
        busy: s.busy,
        current: s.id === ui.currentSessionId,
      })),
    [sessions, ui.currentSessionId],
  )

  /** 第一步：按用户名精确检索（定稿：不做邀请码入口，防会员枚举） */
  const onSearch = useCallback(async (): Promise<void> => {
    const name = searchInput.trim()
    // 这三种情况都还没真正发出请求：只给一条红色原因，不渲染结果区（避免把「没发请求」说成「请求失败」）
    if (!name) {
      setErrorText(tKey('dm.search.emptyName'))
      return
    }
    if (!ui.loggedIn) {
      // 输入框里按回车不会经过被禁用的「查找」按钮，这条路径得自己给原因（不能静默发一次注定失败的请求）
      setErrorText(tKey('dm.search.notLoggedIn'))
      return
    }
    if (!window.shanhai?.memberSearch) {
      // 可选链会把「桥不存在」吞成 undefined，进而被下面当成「没搜到人」→ 这里显式区分开
      setErrorText(tKey('dm.search.noBridge'))
      return
    }
    setSearching(true)
    try {
      const r = await window.shanhai.memberSearch(name)
      const members = r?.members ?? []
      setSearchResults(members)
      setSearched(true)
      if (members.length > 0) {
        setSearchOutcome('found')
        setErrorText(null)
        setNotice(r?.message ?? tKey('dm.search.found', { n: members.length }))
      } else if (r?.notFound) {
        // 查无此人：中性空态呈现，不弹红色报错（这不是故障）
        setSearchOutcome('notfound')
        setErrorText(null)
        setNotice(null)
      } else {
        // 请求失败 / 结构与预期不符：红色提示 + 明确说明「这不是没找到人」
        setSearchOutcome('failed')
        setNotice(null)
        setErrorText(r?.message ?? tKey('dm.search.failed'))
      }
    } catch (e) {
      setSearchOutcome('failed')
      setSearched(true)
      setErrorText(tKey('dm.search.exception', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSearching(false)
    }
  }, [searchInput, ui.loggedIn])

  /** 第二步：对检索到的会员发好友申请（带申请附言） */
  const onRequestFriend = useCallback(
    async (m: DmFriend): Promise<void> => {
      if (!window.shanhai?.memberRequestFriend) {
        setErrorText(tKey('dm.request.noBridge'))
        return
      }
      if (!m.memberId) {
        // 检索结果缺 memberId 会让申请带着空 target 发出去，这里提前拒掉并说清原因
        setErrorText(tKey('dm.requestIncomplete'))
        return
      }
      if (requestingId) return
      setRequestingId(m.memberId)
      try {
        const r = await window.shanhai.memberRequestFriend({ targetMemberId: m.memberId, message: searchMsg.trim() })
        showResult(r)
        if (r?.ok) {
          setSearchResults([])
          setSearchInput('')
          setSearchMsg('')
          setSearched(false)
          setSearchOutcome('none')
        }
      } catch (e) {
        setErrorText(tKey('dm.requestException', { error: e instanceof Error ? e.message : String(e) }))
      } finally {
        setRequestingId('')
      }
    },
    [searchMsg, showResult, requestingId],
  )

  const onAccept = useCallback(
    async (req: DmFriendRequest): Promise<void> => {
      const r = await window.shanhai?.memberAcceptFriend(req.fromMemberId)
      showResult(r)
    },
    [showResult],
  )

  const onReject = useCallback(
    async (req: DmFriendRequest): Promise<void> => {
      const r = await window.shanhai?.memberRejectFriend(req.fromMemberId)
      showResult(r)
    },
    [showResult],
  )

  const onDeleteFriend = useCallback(
    async (f: DmFriend): Promise<void> => {
      // 定稿语义是硬删 + 历史保留但不可再发，属不可逆操作，先二次确认
      const ok = window.confirm(tKey('dm.deleteFriendConfirm', { name: displayNameOf(f.nickname || f.username) }))
      if (!ok) return
      const r = await window.shanhai?.memberDeleteFriend(f.memberId)
      showResult(r)
    },
    [showResult],
  )

  // 【i18n 期4C 重扫补修 · 真缺陷】statusBanner 的返回值里含**已取好的文案**，
  // 而 useMemo 的依赖只有登录态与状态对象 —— 切语言时本组件会因 useLocaleSync 重渲染，
  // 但 useMemo 依赖没变 → 直接拿回旧语言那条缓存，顶部提示条会停在中文/英文不动。
  // 修法：把当前语言纳入依赖（不新增 setState、不改任何判定分支）。
  const locale = getLocale()
  const banner = useMemo(
    () => statusBanner({ loggedIn: ui.loggedIn, username: ui.username }, status, cred),
    [ui.loggedIn, ui.username, status, cred, locale],
  )
  const bannerBg = banner.tone === 'ok' ? 'var(--tint-green-soft, rgba(34,197,94,0.12))' : banner.tone === 'warn' ? 'rgba(245,158,11,0.14)' : 'rgba(239,68,68,0.12)'
  const bannerColor = banner.tone === 'ok' ? 'var(--success-text, var(--text-secondary))' : banner.tone === 'warn' ? 'var(--warning-text, var(--text-secondary))' : 'var(--danger-text, var(--text))'
  /** 能不能发：通道就绪 + 已知对方。字节与附件状态由 DmComposer 自己判（它手里才有附件清单） */
  const channelReady = Boolean(status?.ready) && Boolean(active?.peerId)

  /**
   * 【P1 双栏骨架】左列常驻，右列聊天区。
   * tab 语义保持不变（'dm' = 聊天 / 'friends' = 通讯录），因为它同时是主进程
   * member:open-tab 的载荷值（系统通知点「好友申请」时会推 'friends'）—— 只换显示文案，不换值。
   */
  const [leftQuery, setLeftQuery] = useState('')
  /** 通讯录里的「添加朋友」表单：改为左列内联展开，不再占独立整页 */
  const [addOpen, setAddOpen] = useState(false)
  /**
   * 窄窗口降级：窗口宽 < 640 时左列压到 220 并隐藏「最后一条消息」预览行（用户拍板的降级口径）。
   * 只在布尔真的翻转时才 setState（相同值 React 自己会跳过），避免 resize 期间反而引入新的重渲染。
   */
  const [narrow, setNarrow] = useState<boolean>(() => (typeof window === 'undefined' ? false : window.innerWidth < NARROW_WIDTH_PX))
  useEffect(() => {
    const onResize = (): void => {
      const next = window.innerWidth < NARROW_WIDTH_PX
      setNarrow((prev) => (prev === next ? prev : next))
    }
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /** 左列顶部搜索：只做**本地过滤**（不发请求、不打网关），按显示名匹配 */
  const q = leftQuery.trim().toLowerCase()
  // 期4C：过滤用 displayNameOf，其兜底串随语言变（未知会员 / Unknown member）→ 语言变化时结果应重算
  const visibleThreads = useMemo(
    () => (q ? threads.filter((t) => displayNameOf(t.peerName, t.peerId).toLowerCase().includes(q)) : threads),
    [threads, q, locale],
  )
  const visibleFriends = useMemo(
    () => (q ? friends.filter((f) => displayNameOf(f.nickname || f.username).toLowerCase().includes(q)) : friends),
    [friends, q, locale],
  )
  const visibleRequests = useMemo(
    () => (q ? requests.filter((r) => displayNameOf(r.fromNickname || r.fromUsername).toLowerCase().includes(q)) : requests),
    [requests, q, locale],
  )

  /**
   * 【P4·默认打开第一个会话】用户拍板的稳妥口径：会话列表加载完、且当前没有任何被选中的会话时，
   * 自动打开「聊天」列表的**第一个会话**（visibleThreads[0]，即主进程按 last_msg_at DESC 排的最近聊过的那个人；
   * 面板刚打开时本地过滤词为空，visibleThreads 与 threads 同序）。
   * 三条反效果的守卫逐条对应：
   *  ① 列表为空 → 直接 return，保持居中引导页，**绝不凭空构造会话、绝不回落到好友列表**
   *     （网关 D1 缺陷：读路径会凭空建会话行，生产库里那条垃圾数据就是这么来的）；
   *  ② 不覆盖已有选择 → selectionTouchedRef 为真（手点 / 通知直达 / 已自动打开过 / 面板已带选中会话）就不动；
   *  ③ 关掉后不弹回 → closeThread 里也置 selectionTouchedRef，且 didAutoOpenRef 保证本次挂载只发生一次。
   * 复用既有 openThread 路径：不新增任何 IPC / 主进程能力，目标必须是列表里**已存在**的会话。
   * ⚠️ 如实说明副作用：openThread 自带 memberSubscribe + memberMarkRead，所以自动打开会把那个会话的未读清零
   *    —— 这是「复用既有打开会话路径」的既有行为，不是本轮新增的写行为（本轮没有为“凑出一个对话框”发任何请求）。
   */
  useEffect(() => {
    if (didAutoOpenRef.current || selectionTouchedRef.current) return
    if (active) {
      selectionTouchedRef.current = true
      return
    }
    // 左列停在「通讯录」时不去抢用户眼前正在看的东西（例如从系统通知点「好友申请」进来的）
    if (tab !== 'dm') return
    const first = visibleThreads[0]
    if (!first) return
    didAutoOpenRef.current = true
    selectionTouchedRef.current = true
    void openThreadRef.current?.(first)
  }, [visibleThreads, active, tab])

  /**
   * 【P2 时间分隔线】把消息流摊平成「分隔线 / 气泡」两种行：
   * 第一条、跨天、或与前一条间隔 > 5 分钟时，插一条居中时间线（参照微信口径）。
   */
  const chatRows = useMemo((): DmRow[] => buildChatRows(active?.messages), [active])

  /** 显示名一律走 displayNameOf（昵称 → 用户名 → 「未知会员」），绝不回落成会员ID */
  const peerName = displayNameOf(active?.peerName, active?.peerId)
  const myName = displayNameOf(status?.username ?? ui.username ?? undefined, status?.memberId ?? undefined)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--bg-app)', color: 'var(--text)', fontFamily: 'system-ui, sans-serif' }}>
      <WindowTitleBar
        icon={<IconChat />}
        title={tKey('dm.title')}
        subtitle={tKey('dm.subtitle')}
        extra={unread.total > 0 ? <span style={{ marginLeft: 8, padding: '1px 7px', borderRadius: 10, background: 'var(--danger, #ef4444)', color: '#fff', fontSize: 11 }}>{unread.total}</span> : undefined}
        onClose={p.onClose}
      />

      {/*
        提示 / 错误条（成功与失败都显示，不静默）。
        【任务107】由「容器恒定占一行 + 只切透明度」改为条件渲染：提示消失后它占的 30px
        一并回收、下方聊天区回填，不再残留空白条。任务59 的防闪烁现在完全由数据层收敛承担
        （sameJson / 广播指纹去重 / threadsRef，均原样在位）—— notice 是低频事件且 4s 自动
        消失，挂载/卸载只发生一次布局变化，正是用户要的「消失即回收」。
        原 opacity/transition 两行与按钮内层条件在新结构下恒真/恒 1，属死代码，一并移除（行为等价）。
        （浮层 toast 属 P6，position:fixed 不占文档流，无同类留白，保持不动。）
      */}
      {(notice || errorText) && (
        <div style={{ height: 30, flexShrink: 0, overflow: 'hidden' }}>
          <div
            style={{
              padding: '6px 20px',
              fontSize: 12,
              background: errorText ? 'rgba(239,68,68,0.10)' : 'rgba(34,197,94,0.10)',
              color: errorText ? 'var(--danger-text, #b91c1c)' : 'var(--success-text, #15803d)',
              borderBottom: '1px solid var(--border-soft)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxSizing: 'border-box',
              height: '100%',
            }}
          >
            <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{errorText ?? notice ?? ''}</span>
            <button onClick={() => { setErrorText(null); setNotice(null) }} style={{ ...smallIconBtn, width: 20, height: 20 }}>
              <IconClose />
            </button>
          </div>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* ——————————————————————— 左列（常驻）——————————————————————— */}
        <div style={{ width: narrow ? LEFT_WIDTH_NARROW_PX : LEFT_WIDTH_PX, minWidth: LEFT_WIDTH_NARROW_PX, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--bg-sidebar)', minHeight: 0 }}>
          {/* 顶部搜索框：只做本地过滤，不打网关 */}
          <div style={{ padding: '10px 10px 8px', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-input)' }}>
              <span style={{ color: 'var(--text-muted)', display: 'inline-flex' }}><IconSearch /></span>
              <input
                value={leftQuery}
                onChange={(e) => setLeftQuery(e.target.value)}
                placeholder={tab === 'dm' ? tKey('dm.searchPlaceholderThreads') : tKey('dm.searchPlaceholderFriends')}
                title={tKey('dm.searchTitle')}
                style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12 }}
              />
              {!!leftQuery && (
                <button onClick={() => setLeftQuery('')} title={tKey('common.clear')} style={{ ...smallIconBtn, width: 18, height: 18 }}>
                  <IconClose />
                </button>
              )}
            </div>
          </div>

          {/* 两个 tab：只切左列内容，右列聊天区不会消失 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 10px 8px', flexShrink: 0 }}>
            {([
              { k: 'dm', label: tKey('dm.tabChat'), dot: unread.total },
              { k: 'friends', label: tKey('dm.tabContacts'), dot: requestCount },
            ] as Array<{ k: Tab; label: string; dot: number }>).map((t) => (
              <button
                key={t.k}
                onClick={() => setTab(t.k)}
                style={{
                  padding: '5px 12px',
                  borderRadius: 15,
                  border: '1px solid ' + (tab === t.k ? 'var(--accent)' : 'var(--border)'),
                  background: tab === t.k ? 'var(--tint-blue-soft, rgba(59,130,246,0.12))' : 'transparent',
                  color: tab === t.k ? 'var(--accent)' : 'var(--text-secondary)',
                  fontSize: 12,
                  fontWeight: tab === t.k ? 600 : 500,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                {t.label}
                {t.dot > 0 && (
                  <span style={{ minWidth: 15, padding: '0 4px', borderRadius: 8, background: 'var(--danger, #ef4444)', color: '#fff', fontSize: 10, lineHeight: '15px', textAlign: 'center' }}>
                    {t.dot > 99 ? '99+' : t.dot}
                  </span>
                )}
              </button>
            ))}
            <button
              onClick={async () => {
                // 必须真的打网关：memberFriends 只是主进程本地快照，memberRefreshFriends / memberPullThreads 才是 HTTP 拉取
                const fr = await window.shanhai?.memberRefreshFriends()
                await reloadAll()
                const th = await window.shanhai?.memberPullThreads()
                if (th) setThreadsIfChanged(th)
                showResult(fr)
              }}
              title={tKey('dm.refreshTitle')}
              style={{ ...smallIconBtn, width: 24, height: 24, marginLeft: 'auto' }}
            >
              <IconRefresh />
            </button>
          </div>

          {/* 左列内容区 */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 10px' }}>
            {tab === 'dm' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {threads.length === 0 && (
                  <div style={{ padding: '18px 8px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>{tKey('dm.noThreads')}<br />{tKey('dm.noThreadsTail')}</div>
                )}
                {threads.length > 0 && visibleThreads.length === 0 && (
                  <div style={{ padding: '18px 8px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>{tKey('dm.noMatchThreads', { q: leftQuery.trim() })}</div>
                )}
                {visibleThreads.map((t) => {
                  const isActive = active?.channelId === t.channelId
                  const name = displayNameOf(t.peerName, t.peerId)
                  const preview = threadPreview(t)
                  return (
                    <button
                      key={t.channelId}
                      onClick={() => void openThread(t)}
                      title={name}
                      style={{
                        textAlign: 'left',
                        padding: '8px',
                        borderRadius: 10,
                        border: '1px solid ' + (isActive ? 'var(--accent)' : 'transparent'),
                        background: isActive ? 'var(--tint-blue-soft, rgba(59,130,246,0.12))' : 'transparent',
                        color: 'var(--text)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                      }}
                    >
                      <DmAvatar name={name} size={36} src={t.peerAvatar} />
                      <span style={{ flex: 1, minWidth: 0, display: 'block' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600 }}>{name}</span>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{fmtListTime(t.lastTs)}</span>
                        </span>
                        {/* 窄窗口降级：压到 220 时隐藏预览行，只留头像 + 名 + 未读角标 */}
                        {!narrow && (
                          <span style={{ display: 'block', marginTop: 2, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview}</span>
                        )}
                      </span>
                      {t.unread > 0 && <span style={{ minWidth: 18, flexShrink: 0, textAlign: 'center', padding: '0 5px', borderRadius: 9, background: 'var(--danger, #ef4444)', color: '#fff', fontSize: 11, lineHeight: '18px' }}>{t.unread > 99 ? '99+' : t.unread}</span>}
                    </button>
                  )
                })}
              </div>
            ) : (
              /* 通讯录：添加朋友（内联展开）+ 待处理申请 + 好友列表（全部 HTTP，由主进程代发） */
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button
                  onClick={() => setAddOpen((v) => !v)}
                  title={tKey('dm.addFriendTitle')}
                  style={{ ...btn('var(--accent)', '#fff'), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, width: '100%' }}
                >
                  <IconPlus />
                  {tKey('dm.addFriend')}
                </button>

                {addOpen && (
                  <div style={{ ...cardStyle, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                      {renderRich(tfKey('dm.rule.friendOnly'), { b1: <b>{tKey('dm.rule.bMutual')}</b>, b2: <b>{tKey('dm.rule.bExact')}</b> })}
                    </div>
                    {/* 未登录这类「整块功能不可用」必须有一眼能看到的一行，不能只把按钮变灰 */}
                    {!ui.loggedIn && (
                      <div style={{ fontSize: 11, color: 'var(--danger-text, #b91c1c)', background: 'rgba(239,68,68,0.10)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '5px 8px', lineHeight: 1.6 }}>
                        {renderRich(tfKey('dm.rule.notLoggedIn'), { b: <b>{tKey('dm.rule.bNotLoggedIn')}</b> })}
                      </div>
                    )}
                    <input
                      value={searchInput}
                      onChange={(e) => setSearchInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void onSearch()
                      }}
                      placeholder={tKey('dm.searchNamePlaceholder')}
                      style={{ width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-app)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }}
                    />
                    <input
                      value={searchMsg}
                      onChange={(e) => setSearchMsg(e.target.value)}
                      placeholder={tKey('dm.searchMessagePlaceholder')}
                      style={{ width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-app)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }}
                    />
                    <button
                      onClick={() => void onSearch()}
                      disabled={!ui.loggedIn || searching}
                      title={!ui.loggedIn ? tKey('dm.searchBtnTitleNoLogin') : searching ? tKey('dm.searchBtnTitleBusy') : tKey('dm.searchBtnTitleIdle')}
                      style={{ ...btn('var(--accent)', '#fff'), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, opacity: !ui.loggedIn || searching ? 0.5 : 1 }}
                    >
                      <IconSearch />
                      {searching ? tKey('dm.searching') : tKey('dm.searchBtn')}
                    </button>
                    {searched && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {searchResults.length === 0 && searchOutcome === 'notfound' && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                            {renderRich(tfKey('dm.search.notFoundHint'), { b: <b>{tKey('dm.search.bExactOnly')}</b> })}
                          </div>
                        )}
                        {searchResults.length === 0 && searchOutcome === 'failed' && (
                          <div style={{ fontSize: 11, color: 'var(--danger-text, #b91c1c)', lineHeight: 1.6 }}>
                            {renderRich(tfKey('dm.search.failedHint'), { b: <b>{tKey('dm.search.bFailed')}</b> })}
                          </div>
                        )}
                        {searchResults.map((m) => (
                          <div key={m.memberId} style={{ padding: '7px 8px', borderRadius: 8, border: '1px solid var(--border-soft)', background: 'var(--bg-app)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                              <DmAvatar name={displayNameOf(m.nickname || m.username)} size={28} src={m.avatar} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayNameOf(m.nickname || m.username)}</div>
                                {m.username && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{tKey('common.usernameLine', { u: m.username })}</div>}
                              </div>
                            </div>
                            <button
                              onClick={() => void onRequestFriend(m)}
                              disabled={Boolean(requestingId)}
                              title={requestingId === m.memberId ? tKey('dm.requestBtnTitleBusy') : requestingId ? tKey('dm.requestBtnTitlePrev') : ui.loggedIn ? tKey('dm.requestBtnTitleIdle') : tKey('dm.requestBtnTitleNoLogin')}
                              style={{ ...btn('var(--accent)', '#fff'), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 12, padding: '5px 10px', opacity: requestingId === m.memberId ? 0.55 : 1 }}
                            >
                              <IconPlus />
                              {requestingId === m.memberId ? tKey('dm.requesting') : tKey('dm.requestSend')}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 待处理申请（红点已挂在「通讯录」tab 上，权威来自 /friends/requests/count） */}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, padding: '4px 2px 0' }}>{tKey('dm.pendingRequests', { n: requestCount || requests.length })}</div>
                {requests.length === 0 && <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 2px 4px' }}>{tKey('dm.noRequests')}</div>}
                {requests.length > 0 && visibleRequests.length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 2px 4px' }}>{tKey('dm.noMatchRequests', { q: leftQuery.trim() })}</div>
                )}
                {visibleRequests.map((r) => (
                  <div key={r.requestId || r.fromMemberId} style={{ ...cardStyle, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <DmAvatar name={displayNameOf(r.fromNickname || r.fromUsername)} size={28} src={r.fromAvatar} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayNameOf(r.fromNickname || r.fromUsername)}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{r.fromUsername ? tKey('common.usernameLine', { u: r.fromUsername }) + tKey('dm.requestDot') : ''}{fmtTime(r.ts)}</div>
                      </div>
                    </div>
                    {r.message && <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{tKey('dm.requestMessage', { text: r.message })}</div>}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => void onAccept(r)} title={tKey('dm.acceptTitle')} style={{ ...btn('var(--success, #22c55e)', '#fff'), flex: 1, fontSize: 12, padding: '4px 8px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                        <IconCheck />
                        {tKey('dm.accept')}
                      </button>
                      <button onClick={() => void onReject(r)} title={tKey('dm.rejectTitle')} style={{ ...btn('transparent', 'var(--text-secondary)', '1px solid var(--border)'), flex: 1, fontSize: 12, padding: '4px 8px' }}>
                        {tKey('dm.reject')}
                      </button>
                    </div>
                  </div>
                ))}

                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, padding: '4px 2px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <IconUsers />
                  {tKey('dm.myFriends', { n: friends.length })}
                </div>
                {friends.length === 0 && <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 2px 4px', lineHeight: 1.6 }}>{tKey('dm.noFriends')}</div>}
                {friends.length > 0 && visibleFriends.length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 2px 4px' }}>{tKey('dm.noMatchFriends', { q: leftQuery.trim() })}</div>
                )}
                {visibleFriends.map((f) => {
                  const name = displayNameOf(f.nickname || f.username)
                  return (
                    <div key={f.memberId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 10, border: '1px solid var(--border-soft)', background: 'var(--bg-panel)' }}>
                      <DmAvatar name={name} size={30} src={f.avatar} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                        {/* 网关未实现 member_online/member_offline，这里不显示在线状态，避免谎报 */}
                        {f.username && <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tKey('common.usernameLine', { u: f.username })}</div>}
                      </div>
                      <button
                        onClick={async () => {
                          const cid = await window.shanhai?.memberChannelId(f.memberId)
                          if (!cid) {
                            setErrorText(tKey('dm.openThread.noIdentity'))
                            return
                          }
                          const t: DmThread = threads.find((x) => x.channelId === cid) ?? { channelId: cid, peerId: f.memberId, peerName: displayNameOf(f.nickname || f.username, f.memberId), peerAvatar: f.avatar, messages: [], unread: 0, lastTs: Date.now() }
                          void openThread(t)
                        }}
                        disabled={!status?.ready}
                        title={status?.ready ? tKey('dm.dmBtnTitleReady') : tKey('dm.dmBtnTitleNotReady')}
                        style={{ ...btn('var(--accent)', '#fff'), fontSize: 12, padding: '4px 10px', opacity: status?.ready ? 1 : 0.5 }}
                      >
                        {tKey('dm.dmBtn')}
                      </button>
                      <button onClick={() => void onDeleteFriend(f)} title={tKey('dm.deleteFriendTitle')} style={{ ...smallIconBtn, color: 'var(--danger-text, #b91c1c)' }}>
                        <IconTrash />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 底部：通道状态一行（绿/黄/红点 + 文案 + 去登录 / 重试）*/}
          <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)', background: bannerBg, color: bannerColor, padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flexShrink: 0,
                background: banner.tone === 'ok' ? 'var(--success, #22c55e)' : banner.tone === 'warn' ? 'var(--warning, #f59e0b)' : 'var(--danger, #ef4444)',
              }}
            />
            <span title={banner.text} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>
              {statusLabelOf(banner.tone)}
            </span>
            {!ui.loggedIn ? (
              <button
                onClick={() => void goLogin()}
                title={tKey('dm.loginTitle')}
                style={{ ...btn('var(--accent)', '#fff'), fontSize: 11, padding: '3px 9px' }}
              >
                {tKey('common.goLogin')}
              </button>
            ) : (
              <button
                onClick={async () => {
                  const s = await window.shanhai?.memberRetry()
                  if (s) setStatus(s)
                  void reloadAll()
                }}
                title={tKey('dm.retryConnectTitle')}
                style={{ ...smallIconBtn, ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties), width: 22, height: 22 }}
              >
                <IconRefresh />
              </button>
            )}
          </div>

          {/* 管家接管开关（私信 IM 化·管家接管期）：只改 settings.dmAutoReply，不改任何收发/审批逻辑。
              三态下拉：关 / 开-全自动 / 半自动（未开放·占位）；本期只实现前两态可用。
              说明文字放 tooltip，窄列不占行；开关状态与主进程「管家发消息总开关」同源（settings）。 */}
          <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-panel)' }}>
            <span
              title={tKey('dm.autoReplyDesc')}
              style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--text-secondary)' }}
            >
              {tKey('dm.autoReply')}
            </span>
            <select
              value={dmAutoReply ? 'auto' : 'off'}
              onChange={(e) => void setDmAutoReplySetting(e.target.value === 'auto')}
              style={{ fontSize: 11, padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text)', maxWidth: 100, flexShrink: 0 }}
            >
              <option value="off">{tKey('dm.autoReplyState.off')}</option>
              <option value="auto">{tKey('dm.autoReplyState.on')}</option>
              <option value="half" disabled>{tKey('dm.autoReplyState.half')}</option>
            </select>
          </div>
        </div>

        {/* ——————————————————————— 右列：聊天区（常驻）——————————————————————— */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {!active ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, padding: 24, textAlign: 'center' }}>
              <span style={{ color: 'var(--text-faint)' }}><IconChat /></span>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{tKey('dm.rightPaneGuide')}</div>
              {/*
                整句通道状态在窄列里放不下，这里给完整版（含未登录 / 凭证失效的具体原因），不静默。
                按钮放在文案右侧：statusBanner 的原文案写的是「点右侧『去登录』」，位置必须对得上，否则又是一处误导。
              */}
              {banner.tone !== 'ok' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 520, fontSize: 12, lineHeight: 1.7, color: bannerColor, background: bannerBg, border: '1px solid var(--border-soft)', borderRadius: 10, padding: '8px 12px' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>{banner.text}</span>
                  {!ui.loggedIn ? (
                    <button onClick={() => void goLogin()} style={{ ...btn('var(--accent)', '#fff'), flexShrink: 0, fontSize: 12 }}>{tKey('common.goLogin')}</button>
                  ) : (
                    <button
                      onClick={async () => {
                        const s2 = await window.shanhai?.memberRetry()
                        if (s2) setStatus(s2)
                        void reloadAll()
                      }}
                      title={tKey('dm.retryConnectTitle')}
                      style={{ ...smallIconBtn, flexShrink: 0 }}
                    >
                      <IconRefresh />
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              {/*
                通道异常时把整句原因摊在聊天区顶部：左列底部那一行只放得下短标签，
                只靠 tooltip 等于把「为什么发不出去」藏起来 —— 本项目反复踩过的静默失败不允许重演。
                它只在 tone 真的翻转时才出现/消失（不是每次广播都变），所以不会重新引入闪烁。
              */}
              {banner.tone !== 'ok' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: bannerBg, color: bannerColor, fontSize: 11, lineHeight: 1.5, flexShrink: 0, borderBottom: '1px solid var(--border-soft)' }}>
                  <span style={{ display: 'inline-flex', flexShrink: 0 }}><IconWarn /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>{banner.text}</span>
                  {!ui.loggedIn ? (
                    <button onClick={() => void goLogin()} style={{ ...btn('var(--accent)', '#fff'), fontSize: 11, padding: '3px 9px', flexShrink: 0 }}>{tKey('common.goLogin')}</button>
                  ) : (
                    <button
                      onClick={async () => {
                        const st2 = await window.shanhai?.memberRetry()
                        if (st2) setStatus(st2)
                        void reloadAll()
                      }}
                      title={tKey('dm.retryConnectTitle')}
                      style={{ ...smallIconBtn, width: 22, height: 22, flexShrink: 0 }}
                    >
                      <IconRefresh />
                    </button>
                  )}
                </div>
              )}
              {/* 会话头部：头像 + 显示名（不显示会员ID）+ 关闭 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border-soft)', flexShrink: 0, background: 'var(--bg-panel)' }}>
                <DmAvatar name={peerName} size={30} src={active?.peerAvatar} />
                <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{peerName}</span>
                <button onClick={closeThread} title={tKey('dm.closeThreadTitle')} style={{ ...smallIconBtn, marginLeft: 'auto' }}>
                  <IconClose />
                </button>
              </div>

              {/*
                【P4】消息流。外层这个 position:relative 的壳只为承载「↓ N 条新消息」浮标：
                浮标是绝对定位、不参与列表布局 → 不会出现任务59 消掉的那种「顶一下再弹回来」。
                ref / onScroll 都挂在真正的滚动容器上；effect 只在四个原始值组成的签名变化时跑。
              */}
              <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
                <div
                  ref={dmScroll.scrollRef}
                  onScroll={dmScroll.handleScroll}
                  style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '10px 16px 14px', display: 'flex', flexDirection: 'column' }}
                >
                  {hasMore && (
                    <div style={{ textAlign: 'center', padding: '6px 0 2px' }}>
                      <button onClick={() => void onLoadMore()} disabled={loadingMore} style={{ ...btn('transparent', 'var(--text-secondary)', '1px solid var(--border)'), fontSize: 12 }}>
                        {loadingMore ? tKey('common.loading') : tKey('dm.loadEarlier')}
                      </button>
                    </div>
                  )}
                  {chatRows.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '22px 0', textAlign: 'center' }}>
                      {threadLoading ? tKey('dm.reading') : tKey('dm.emptyThread')}
                    </div>
                  )}
                  {(() => {
                    const msgCount = chatRows.filter((r) => r.kind === 'msg').length
                    const unread = active?.unread ?? 0
                    const firstUnread = Math.max(0, msgCount - unread)
                    let seen = 0
                    return chatRows.map((row) => {
                      if (row.kind === 'divider') return <DmTimeDivider key={row.key} ts={row.ts} />
                      const showDiv = unread > 0 && seen === firstUnread
                      seen += 1
                      return showDiv
                        ? (
                            <React.Fragment key={row.key}>
                              <DmUnreadDivider count={unread} />
                              <DmMessageRow msg={row.msg} peerName={peerName} mineName={myName} peerAvatar={active.peerAvatar} narrow={narrow} onQuote={(x) => openQuotePicker(x)} onPreviewImage={(src) => setPreviewImage(src)} />
                            </React.Fragment>
                          )
                        : (
                            <DmMessageRow key={row.key} msg={row.msg} peerName={peerName} mineName={myName} peerAvatar={active.peerAvatar} narrow={narrow} onQuote={(x) => openQuotePicker(x)} onPreviewImage={(src) => setPreviewImage(src)} />
                          )
                    })
                  })()}
                </div>
                {dmScroll.newCount > 0 && (
                  <button
                    onClick={() => dmScroll.scrollToBottom(true)}
                    title={tKey('dm.newMessagesBadgeTitle', { n: dmScroll.newCount })}
                    style={{
                      position: 'absolute',
                      left: '50%',
                      transform: 'translateX(-50%)',
                      bottom: 14,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '5px 12px',
                      borderRadius: 16,
                      border: '1px solid var(--border)',
                      background: 'var(--bg-panel)',
                      color: 'var(--text-secondary)',
                      fontSize: 12,
                      cursor: 'pointer',
                      boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
                    }}
                  >
                    <IconChevronDown />
                    {tKey('dm.newMessagesBadge', { n: dmScroll.newCount })}
                  </button>
                )}
              </div>

              {/*
                【任务63】这里原来是常驻的「引用到会话」下拉，已移除：
                改成点消息旁 ＋ 时弹出会话选择器（见文件末尾的 DmQuotePicker），选定目标才落地。
                原来那条「不会自动发送」的红线说明没有丢 —— 它搬进了弹层底部，就在用户做选择的那一刻显示。
              */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 16px', borderTop: '1px solid var(--border-soft)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                <span>{tKey('dm.quote.hint')}</span>
              </div>

              {/*
                【P3】输入区：照抄会话/管家共用的 Composer.tsx 容器与按钮常量（框内发送按钮、
                附件条 56×56 + 上传中转圈 + 绿勾 + 红点重试、textarea 自适应高度、IME 双重保护），
                三处输入区同一个样子。附件走既有云存储通道，消息里只放 URL 引用。
              */}
              {/*
                key=会话通道：切会话时让输入区整体重挂载（正文与已选附件各会话独立）。
                为什么这么做：不隔离的话「给 A 写了一半 → 点开会话 B → 按 Enter」会把 A 的话发给 B，
                而私信没有撤回能力，错发不可回收；相比之下「切会话后输入框清空」是看得见、可重来的代价。
                （会话内草稿持久化属 P6，本轮不做。）
              */}
              <DmComposer
                key={active.channelId}
                ready={channelReady}
                loggedIn={ui.loggedIn}
                peerName={peerName}
                maxContentBytes={DM_MAX_CONTENT_BYTES}
                initialText={drafts[active.channelId] ?? ''}
                onTextChange={(text) => setDrafts((prev) => ({ ...prev, [active.channelId]: text }))}
                onSent={() => setDrafts((prev) => { const n = { ...prev }; delete n[active.channelId]; return n })}
                onSend={onSend}
                onBlocked={(reason) => {
                  if (reason) {
                    setErrorText(reason)
                    setNotice(null)
                  } else {
                    setErrorText(null)
                  }
                }}
                onPreviewImage={(src) => setPreviewImage(src)}
              />
            </>
          )}
        </div>
      </div>

      {/* 图片大图预览：遮罩层与聊天窗口 / 管家窗口共用同一个组件（Esc 或点背景关闭） */}
      {previewImage && <ImagePreview src={previewImage} onClose={() => setPreviewImage(null)} />}

      {toast && <DmToast toast={toast} onDismiss={dismissToast} />}

      {/*
        【任务63】点消息旁 ＋ 后弹出的「引用到哪个会话」选择器。
        传进来的两个字段都已归一：来源名走 displayNameOf（绝不是会员ID），
        预览走 dmContentPreview（附件消息显示成「[图片] 名字」，不会把引用 JSON 印进弹层）。
      */}
      {quoteFor && (
        <DmQuotePicker
          fromLabel={quoteFor.mine ? myName : peerName}
          preview={dmContentPreview(quoteFor.text)}
          targets={quoteTargets}
          errorText={quoteError}
          hintText={quoteHint}
          pending={quotePending}
          onPick={(t) => void doQuoteTo(quoteFor, t)}
          onClose={closeQuotePicker}
        />
      )}
    </div>
  )
}
