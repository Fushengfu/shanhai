import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WindowTitleBar } from '../components/WindowTitleBar'
import { IconChat, IconCheck, IconClose, IconPlus, IconRefresh, IconSearch, IconSend, IconTrash, IconUsers, IconWarn } from '../components/icons'
import { btn, smallIconBtn } from '../components/ui'
import { patchUiStore, useUiStore } from '../store-client'
import type { CredentialSnapshot, DmFriend, DmFriendRequest, DmMessage, DmThread, DmUnread, MemberChannelStatus, MemberNotice, MemberResult } from '../types'

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

/** 单条私信内容字节上限（与主进程 member-channel.ts 的 MAX_MSG_BYTES 保持一致：契约 v1 定稿 4000 字节） */
const MAX_CONTENT_BYTES = 4000

/** UTF-8 字节数（与主进程 Buffer.byteLength 同口径，用于输入框实时计数） */
function utf8Bytes(text: string): number {
  let n = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80) n += 1
    else if (code < 0x800) n += 2
    else if (code < 0x10000) n += 3
    else n += 4
  }
  return n
}

/** 时间戳 → 简短时间（今天显示 HH:MM，跨天显示 M月D日 HH:MM） */
function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/** 会员通道状态 → 如实的横幅文案与色调（未登录 / 凭证三态 / 连接中 / 正常） */
function statusBanner(
  ui: { loggedIn: boolean; username: string | null },
  st: MemberChannelStatus | null,
  cred: CredentialSnapshot | null,
): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!ui.loggedIn) {
    // 凭证被判失效时主进程已把全局登录态翻成未登录，这里给出原因，不让用户以为「莫名其妙掉登录」
    const why = cred?.state === 'expired' ? `（原因：${cred.text ?? '登录凭证已过期，且超出自动续签宽限期'}）` : ''
    return { text: `未登录会员账号：私信与好友需要登录后才能使用${why}（点右侧「去登录」：本窗口会关闭，登录框在聊天窗口弹出）。`, tone: 'bad' }
  }
  // 【三态如实呈现】已登录但凭证已过期 / 即将到期：不得只显示「已登录」而不说明
  if (cred && (cred.state === 'expired' || cred.state === 'unknown' || cred.state === 'renewing')) {
    return { text: cred.text ?? '登录凭证状态异常', tone: cred.state === 'expired' ? 'bad' : 'warn' }
  }
  if (st?.authFailed) return { text: cred?.text ?? '登录凭证已失效（401），请重新登录后再使用私信。', tone: 'bad' }
  if (!st) return { text: '正在读取会员通道状态…', tone: 'warn' }
  if (!st.enabled) return { text: '会员通道未开启（登录后会自动开启）。', tone: 'warn' }
  if (!st.connected) return { text: `会员通道未连接：${st.error ?? '正在重试连接…'}`, tone: 'warn' }
  if (!st.memberId) return { text: '已连接，但网关未下发本账号会员 id，暂时无法收发消息（需网关在回执里带上 memberId）。', tone: 'warn' }
  return { text: `会员通道已连接（账号 ${st.username ?? st.memberId}，会员 id ${st.memberId}）`, tone: 'ok' }
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
  const ui = useUiStore()
  const [tab, setTab] = useState<Tab>('dm')
  const [status, setStatus] = useState<MemberChannelStatus | null>(null)
  const [friends, setFriends] = useState<DmFriend[]>([])
  const [requests, setRequests] = useState<DmFriendRequest[]>([])
  /** 红点权威：HTTP /friends/requests/count 下发值（列表可能被分页截断，不能只看 requests.length） */
  const [requestCount, setRequestCount] = useState(0)
  const [threads, setThreads] = useState<DmThread[]>([])
  const [unread, setUnread] = useState<DmUnread>({ total: 0, byChannel: {} })
  const [active, setActive] = useState<DmThread | null>(null)
  const [draft, setDraft] = useState('')
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
  const [busy, setBusy] = useState(false)
  /** 凭证三态快照（未登录 / 已登录有效 / 已登录但已过期 / 有效期未知），主进程 credential:status 实时推送 */
  const [cred, setCred] = useState<CredentialSnapshot | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  /** 当前已加载到的历史页码（定稿 v1.1：page=1 是最新一页，「加载更早」= page 递增） */
  const [historyPage, setHistoryPage] = useState(1)
  // 「引用到会话」：目标会话下拉（本机会话 + 会话管家）
  const [quoteTarget, setQuoteTarget] = useState<string>('')
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([])
  const activeChannelRef = useRef<string>('')
  activeChannelRef.current = active?.channelId ?? ''

  const draftBytes = useMemo(() => utf8Bytes(draft), [draft])
  const overLimit = draftBytes > MAX_CONTENT_BYTES

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

  const reloadThreads = useCallback((): void => {
    void window.shanhai?.memberThreads().then((th) => th && setThreads(th))
  }, [])

  const reloadAll = useCallback(async (): Promise<void> => {
    const [st, fr, th, un] = await Promise.all([
      window.shanhai?.memberStatus(),
      window.shanhai?.memberFriends(),
      window.shanhai?.memberThreads(),
      window.shanhai?.memberUnread(),
    ])
    if (st) setStatus(st)
    if (fr) {
      setFriends(fr.friends)
      setRequests(fr.requests)
      setRequestCount(fr.requestCount ?? fr.requests.length)
    }
    if (th) setThreads(th)
    if (un) setUnread(un)
  }, [])

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
      setErrorText('本窗口拿不到登录通道（window.shanhai.openApp 不可用）：请在聊天窗口侧边栏或 Dock 的「登录」项完成登录后重开私信')
      return
    }
    try {
      // 第一步（此前缺失的关键一步）：把共享 store 的 loginOpen 置真 → 聊天窗口才会渲染登录弹窗
      patchUiStore({ loginOpen: true })
      // 第二步：把聊天窗口带到前台（本窗口会由下面的 effect 自动关闭让位）
      const ok = await window.shanhai.openApp('chat')
      if (ok === false) {
        setErrorText('未能打开聊天窗口，登录框无法显示：请点 Dock 的「登录」项，或用托盘「显示主窗口」后重试')
      }
    } catch (e) {
      setErrorText(`打开登录窗口异常：${e instanceof Error ? e.message : String(e)}`)
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
    void window.shanhai?.listSessions().then((list) => {
      const items = (list ?? []).map((s) => ({ id: s.id, title: s.title }))
      // 会话管家是固定内置会话，listSessions 里若没带上，这里补一个可选项
      if (!items.some((s) => s.id === 'supervisor')) items.unshift({ id: 'supervisor', title: '会话管家' })
      setSessions(items)
    })
  }, [reloadAll])

  // 订阅主进程广播（低频小事件，不进 ui:state 全量快照）
  useEffect(() => {
    const offStatus = window.shanhai?.onMemberStatus((s) => setStatus(s))
    // 凭证状态：挂载先拉一次快照，之后靠主进程广播（续签成功/失败/判失效都会推）
    void window.shanhai?.getCredentialStatus().then((c) => setCred(c)).catch(() => undefined)
    const offCred = window.shanhai?.onCredentialStatus((c) => setCred(c))
    const offFriends = window.shanhai?.onMemberFriends((snap) => {
      setFriends(snap.friends)
      setRequests(snap.requests)
      setRequestCount(snap.requestCount ?? snap.requests.length)
    })
    const offUnread = window.shanhai?.onMemberUnread((u) => setUnread(u))
    const offError = window.shanhai?.onMemberError((e) => setErrorText(`${e.message}${e.code ? `（${e.code}）` : ''}`))
    const offNotice = window.shanhai?.onMemberNotice((n: MemberNotice) => setNotice(n.message))
    const offHistory = window.shanhai?.onMemberHistory((payload) => {
      if (payload.channelId !== activeChannelRef.current) return
      setActive((prev) => (prev && prev.channelId === payload.channelId ? { ...prev, messages: payload.messages } : prev))
      setHasMore(payload.hasMore)
    })
    const offOpen = window.shanhai?.onMemberOpenThread((payload) => {
      // 点系统通知直达对应会话：切到私信分区并打开那个线程
      const t = threads.find((x) => x.channelId === payload.channelId)
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
  }, [reloadThreads, threads])

  // 提示条自动消失
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  const openThread = useCallback(async (t: DmThread): Promise<void> => {
    if (active && active.channelId !== t.channelId) void window.shanhai?.memberUnsubscribe(active.channelId)
    setTab('dm')
    setActive({ ...t, messages: t.messages ?? [] })
    setQuoteTarget(ui.currentSessionId || 'supervisor')
    setHasMore(false)
    setHistoryPage(1)
    // 订阅即拉一页历史（HTTP 权威），并把未读清零（任一设备读过即已读）
    const snapshot = (await window.shanhai?.memberSubscribe(t.channelId)) ?? t
    if (snapshot.channelId === t.channelId) {
      setActive({ ...snapshot, peerId: snapshot.peerId || t.peerId, peerName: snapshot.peerName || t.peerName, messages: snapshot.messages ?? [] })
      setHasMore((snapshot.messages?.length ?? 0) >= (t.messages?.length ?? 0) && (snapshot.messages?.length ?? 0) > 0)
    }
    void window.shanhai?.memberMarkRead(t.channelId)
    reloadThreads()
  }, [active, reloadThreads, ui.currentSessionId])

  // 供订阅回调调用（避免把 openThread 放进它的依赖里造成反复重订阅）
  const openThreadRef = useRef<(t: DmThread) => Promise<void>>(openThread)
  openThreadRef.current = openThread

  const closeThread = useCallback((): void => {
    if (active) void window.shanhai?.memberUnsubscribe(active.channelId)
    setActive(null)
  }, [active])

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
      setActive((prev) => (prev ? { ...prev, messages: page.messages } : prev))
      setHistoryPage((prev) => Math.max(prev, page.page ?? next))
      setHasMore(page.hasMore && page.messages.length > 0)
    } finally {
      setLoadingMore(false)
    }
  }, [active, historyPage, loadingMore])

  const onSend = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text || !active) return
    if (utf8Bytes(text) > MAX_CONTENT_BYTES) {
      // 本地就拦住，不等网关回 content_too_long（省一次往返，也避免用户以为发出去了）
      setErrorText(`内容过长：当前 ${utf8Bytes(text)} 字节，单条上限 ${MAX_CONTENT_BYTES} 字节，请分段发送`)
      return
    }
    setBusy(true)
    try {
      const r = await window.shanhai?.memberSend({ peerMemberId: active.peerId, channelId: active.channelId, text, peerName: active.peerName })
      if (r && !r.ok) {
        // 发送失败：保留输入内容 + 如实提示原因（好友前提 / 超限 / 限流 / 未连接）
        setErrorText(r.message)
        setNotice(null)
        return
      }
      setDraft('')
      setNotice(r?.message ?? '已发送')
      reloadThreads()
    } finally {
      setBusy(false)
    }
  }, [active, draft, reloadThreads])

  const onQuote = useCallback(
    async (msg: DmMessage): Promise<void> => {
      if (!active) return
      if (!quoteTarget) {
        setErrorText('请先选择要引用到的会话')
        return
      }
      const r = await window.shanhai?.memberQuoteToSession({ sessionId: quoteTarget, channelId: active.channelId, msgId: msg.msgId })
      showResult(r)
    },
    [active, quoteTarget, showResult],
  )

  /** 第一步：按用户名精确检索（定稿：不做邀请码入口，防会员枚举） */
  const onSearch = useCallback(async (): Promise<void> => {
    const name = searchInput.trim()
    // 这三种情况都还没真正发出请求：只给一条红色原因，不渲染结果区（避免把「没发请求」说成「请求失败」）
    if (!name) {
      setErrorText('请输入要查找的用户名（必须与对方账号完全一致）')
      return
    }
    if (!ui.loggedIn) {
      // 输入框里按回车不会经过被禁用的「查找」按钮，这条路径得自己给原因（不能静默发一次注定失败的请求）
      setErrorText('未登录会员账号：请先点上方横幅右侧「去登录」完成登录，再查找好友')
      return
    }
    if (!window.shanhai?.memberSearch) {
      // 可选链会把「桥不存在」吞成 undefined，进而被下面当成「没搜到人」→ 这里显式区分开
      setErrorText('本窗口拿不到检索通道（window.shanhai.memberSearch 不可用），请重启山海')
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
        setNotice(r?.message ?? `找到 ${members.length} 个会员`)
      } else if (r?.notFound) {
        // 查无此人：中性空态呈现，不弹红色报错（这不是故障）
        setSearchOutcome('notfound')
        setErrorText(null)
        setNotice(null)
      } else {
        // 请求失败 / 结构与预期不符：红色提示 + 明确说明「这不是没找到人」
        setSearchOutcome('failed')
        setNotice(null)
        setErrorText(r?.message ?? '查找失败（未获得网关结果）')
      }
    } catch (e) {
      setSearchOutcome('failed')
      setSearched(true)
      setErrorText(`查找异常：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSearching(false)
    }
  }, [searchInput, ui.loggedIn])

  /** 第二步：对检索到的会员发好友申请（带申请附言） */
  const onRequestFriend = useCallback(
    async (m: DmFriend): Promise<void> => {
      if (!window.shanhai?.memberRequestFriend) {
        setErrorText('本窗口拿不到好友申请通道（window.shanhai.memberRequestFriend 不可用），请重启山海')
        return
      }
      if (!m.memberId) {
        // 检索结果缺 memberId 会让申请带着空 target 发出去，这里提前拒掉并说清原因
        setErrorText('这条检索结果缺少会员 id，无法发送申请（请重新查找）')
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
        setErrorText(`发送申请异常：${e instanceof Error ? e.message : String(e)}`)
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
      const ok = window.confirm(`确定删除好友「${f.nickname || f.username || f.memberId}」？\n\n删除后双方立即解除好友关系，不能再互发私信；\n已有的历史私信仍保留在本机，要再发必须重新加好友。`)
      if (!ok) return
      const r = await window.shanhai?.memberDeleteFriend(f.memberId)
      showResult(r)
    },
    [showResult],
  )

  const banner = useMemo(
    () => statusBanner({ loggedIn: ui.loggedIn, username: ui.username }, status, cred),
    [ui.loggedIn, ui.username, status, cred],
  )
  const bannerBg = banner.tone === 'ok' ? 'var(--tint-green-soft, rgba(34,197,94,0.12))' : banner.tone === 'warn' ? 'rgba(245,158,11,0.14)' : 'rgba(239,68,68,0.12)'
  const bannerColor = banner.tone === 'ok' ? 'var(--success-text, var(--text-secondary))' : banner.tone === 'warn' ? 'var(--warning-text, var(--text-secondary))' : 'var(--danger-text, var(--text))'
  const canSend = Boolean(status?.ready) && Boolean(active?.peerId) && !overLimit && draftBytes > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--bg-app)', color: 'var(--text)', fontFamily: 'system-ui, sans-serif' }}>
      <WindowTitleBar
        icon={<IconChat />}
        title="私信"
        subtitle="会员之间的实时通讯（需互为好友）"
        extra={unread.total > 0 ? <span style={{ marginLeft: 8, padding: '1px 7px', borderRadius: 10, background: 'var(--danger, #ef4444)', color: '#fff', fontSize: 11 }}>{unread.total}</span> : undefined}
        onClose={p.onClose}
      />

      {/* 分区切换（好友带红点：权威来自 /friends/requests/count） */}
      <div style={{ display: 'flex', gap: 4, padding: '0 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {([
          { k: 'dm', label: '私信', dot: unread.total },
          { k: 'friends', label: '好友', dot: requestCount },
        ] as Array<{ k: Tab; label: string; dot: number }>).map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            style={{
              padding: '10px 14px',
              border: 'none',
              borderBottom: tab === t.k ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'transparent',
              color: tab === t.k ? 'var(--text)' : 'var(--text-muted)',
              fontSize: 13,
              fontWeight: tab === t.k ? 600 : 500,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {t.label}
            {t.dot > 0 && (
              <span style={{ minWidth: 16, padding: '0 5px', borderRadius: 8, background: 'var(--danger, #ef4444)', color: '#fff', fontSize: 10, lineHeight: '16px', textAlign: 'center' }}>
                {t.dot > 99 ? '99+' : t.dot}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* 通道状态横幅：如实反映未登录 / 未连接 / 凭证失效 / 未就绪 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 20px', background: bannerBg, color: bannerColor, fontSize: 12, flexShrink: 0, borderBottom: '1px solid var(--border-soft)' }}>
        {banner.tone !== 'ok' && <IconWarn />}
        <span style={{ flex: 1 }}>{banner.text}</span>
        {!ui.loggedIn ? (
          <button
            onClick={() => void goLogin()}
            title="复用山海既有的登录入口：打开聊天窗口的登录弹窗（本窗口会自动让位关闭，登录完成后从顶栏/Dock 重新进入私信）"
            style={btn('var(--accent)', '#fff')}
          >
            去登录
          </button>
        ) : (
          <button
            onClick={async () => {
              const s = await window.shanhai?.memberRetry()
              if (s) setStatus(s)
              void reloadAll()
            }}
            title="重试连接会员通道"
            style={{ ...smallIconBtn, ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
          >
            <IconRefresh />
          </button>
        )}
      </div>

      {/* 提示 / 错误条（成功与失败都显示，不静默） */}
      {(notice || errorText) && (
        <div
          style={{
            padding: '6px 20px',
            fontSize: 12,
            flexShrink: 0,
            background: errorText ? 'rgba(239,68,68,0.10)' : 'rgba(34,197,94,0.10)',
            color: errorText ? 'var(--danger-text, #b91c1c)' : 'var(--success-text, #15803d)',
            borderBottom: '1px solid var(--border-soft)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{errorText ?? notice}</span>
          <button onClick={() => { setErrorText(null); setNotice(null) }} style={{ ...smallIconBtn, width: 20, height: 20 }}>
            <IconClose />
          </button>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {tab === 'dm' ? (
          <>
            {/* 左：会话列表 */}
            <div style={{ width: 240, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, padding: '4px 6px' }}>会话</span>
                <button
                  onClick={async () => {
                    const th = await window.shanhai?.memberPullThreads()
                    if (th) setThreads(th)
                  }}
                  title="从网关重新拉取会话列表"
                  style={{ ...smallIconBtn, width: 22, height: 22 }}
                >
                  <IconRefresh />
                </button>
              </div>
              {threads.length === 0 && <div style={{ padding: '18px 8px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>还没有私信会话。<br />先到「好友」里添加好友，再回来发消息。</div>}
              {threads.map((t) => {
                const isActive = active?.channelId === t.channelId
                return (
                  <button
                    key={t.channelId}
                    onClick={() => void openThread(t)}
                    style={{
                      textAlign: 'left',
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: isActive ? '1px solid var(--accent)' : '1px solid transparent',
                      background: isActive ? 'var(--tint-blue-soft, rgba(59,130,246,0.12))' : 'transparent',
                      color: 'var(--text)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{t.peerName || t.peerId}</span>
                    {t.unread > 0 && <span style={{ minWidth: 18, textAlign: 'center', padding: '0 5px', borderRadius: 9, background: 'var(--danger, #ef4444)', color: '#fff', fontSize: 11 }}>{t.unread}</span>}
                  </button>
                )
              })}
            </div>

            {/* 右：对话区 */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              {!active ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13, flexDirection: 'column', gap: 10 }}>
                  <IconChat />
                  <div>选择左侧一个会话，或到「好友」里给好友发起私信</div>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{active.peerName || active.peerId}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>会员 id {active.peerId}</span>
                    <button onClick={closeThread} title="关闭会话" style={{ ...smallIconBtn, marginLeft: 'auto' }}>
                      <IconClose />
                    </button>
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {hasMore && (
                      <div style={{ textAlign: 'center' }}>
                        <button onClick={() => void onLoadMore()} disabled={loadingMore} style={{ ...btn('transparent', 'var(--text-secondary)', '1px solid var(--border)'), fontSize: 12 }}>
                          {loadingMore ? '加载中…' : '加载更早的消息'}
                        </button>
                      </div>
                    )}
                    {active.messages.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>还没有消息。发送的第一条私信只有你们两方可见。</div>}
                    {active.messages.map((m) => (
                      <div key={m.msgId} style={{ display: 'flex', flexDirection: m.mine ? 'row-reverse' : 'row', gap: 8, alignItems: 'flex-end' }}>
                        <div
                          style={{
                            maxWidth: '70%',
                            padding: '8px 12px',
                            borderRadius: 12,
                            background: m.mine ? 'var(--accent)' : 'var(--bg-panel)',
                            color: m.mine ? '#fff' : 'var(--text)',
                            border: m.mine ? 'none' : '1px solid var(--border-soft)',
                            fontSize: 13,
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'break-word',
                          }}
                        >
                          {m.text}
                          <div style={{ marginTop: 4, fontSize: 10, opacity: 0.75, display: 'flex', gap: 6 }}>
                            <span>{fmtTime(m.ts)}</span>
                            {/* 定稿无逐条已读回执：只显示「发送中 / 已送达 / 失败」，不谎报已读 */}
                            {m.mine && <span>{m.failed ? `失败：${m.failed}` : m.pending ? '发送中…' : '已送达'}</span>}
                          </div>
                        </div>
                        {/* 【红线】只有本地用户点这个按钮，才会把该条私信原文追加进会话输入框 */}
                        <button onClick={() => void onQuote(m)} title="把这条私信原文追加到所选会话的输入框（不会自动发送）" style={{ ...smallIconBtn, width: 24, height: 24 }}>
                          <IconPlus />
                        </button>
                      </div>
                    ))}
                  </div>
                  {/* 引用目标会话选择器 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px', borderTop: '1px solid var(--border-soft)', fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>
                    <span>引用到会话：</span>
                    <select value={quoteTarget} onChange={(e) => setQuoteTarget(e.target.value)} style={{ fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text)', maxWidth: 260 }}>
                      {sessions.length === 0 && <option value="">（没有可选会话）</option>}
                      {sessions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title || s.id}
                        </option>
                      ))}
                    </select>
                    <span style={{ opacity: 0.8 }}>点消息右侧 ＋ 只追加到输入框，山海不会自动发送</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border)', flexShrink: 0, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            void onSend()
                          }
                        }}
                        placeholder={status?.ready ? '输入私信内容，Enter 发送（Shift+Enter 换行）' : '会员通道未就绪，暂时无法发送'}
                        rows={2}
                        style={{ resize: 'none', padding: 10, borderRadius: 8, border: overLimit ? '1px solid var(--danger, #ef4444)' : '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text)', fontSize: 13 }}
                      />
                      {/* 定稿：单条 4000 字节纯文本上限 → 实时字节计数，超限直接禁用发送 */}
                      <div style={{ fontSize: 11, color: overLimit ? 'var(--danger-text, #b91c1c)' : 'var(--text-muted)' }}>
                        {draftBytes} / {MAX_CONTENT_BYTES} 字节{overLimit ? ' · 已超出上限，请分段发送' : ''}
                      </div>
                    </div>
                    <button onClick={() => void onSend()} disabled={busy || !canSend} style={{ ...btn('var(--accent)', '#fff'), opacity: canSend ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <IconSend />
                      发送
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          /* 好友分区：检索添加 + 待处理申请 + 好友列表（全部 HTTP，由主进程代发） */
          <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>添加好友</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.7 }}>
                会员之间必须<b>互为好友</b>才能互发私信：先按<b>用户名精确查找</b>对方，发送申请，对方同意后你们才能通讯。
              </div>
              {/* title 提示要悬停才看得见，未登录这种「整块功能不可用」必须有一眼能看到的一行 */}
              {!ui.loggedIn && (
                <div style={{ fontSize: 12, color: 'var(--danger-text, #b91c1c)', background: 'rgba(239,68,68,0.10)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '6px 10px', marginBottom: 8, lineHeight: 1.6 }}>
                  当前<b>未登录会员账号</b>，查找与添加好友都不可用（所以「查找」按钮是灰的）：请点上方横幅右侧「去登录」完成后重试。
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onSearch()
                  }}
                  placeholder="对方用户名（需完全一致）"
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-app)', color: 'var(--text)', fontSize: 13 }}
                />
                {/* 未登录时禁用是刻意的，但必须给出原因（不能只把按钮变灰让人对着它「点了没反应」） */}
                <button onClick={() => void onSearch()} disabled={!ui.loggedIn || searching} title={!ui.loggedIn ? '未登录会员账号：请先用上方横幅右侧「去登录」登录后再查找' : searching ? '正在查找…' : '按用户名精确查找对方'} style={{ ...btn('var(--accent)', '#fff'), display: 'inline-flex', alignItems: 'center', gap: 6, opacity: !ui.loggedIn || searching ? 0.5 : 1 }}>
                  <IconSearch />
                  {searching ? '查找中…' : '查找'}
                </button>
              </div>
              <input
                value={searchMsg}
                onChange={(e) => setSearchMsg(e.target.value)}
                placeholder="申请附言（可选，告诉对方你是谁）"
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-app)', color: 'var(--text)', fontSize: 13, boxSizing: 'border-box' }}
              />
              {searched && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {searchResults.length === 0 && searchOutcome === 'notfound' && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                      没有找到这个用户名。检索<b>只支持用户名精确匹配</b>（昵称、手机号、部分关键字都搜不到，也不会做模糊匹配），注意大小写与空格。
                    </div>
                  )}
                  {searchResults.length === 0 && searchOutcome === 'failed' && (
                    <div style={{ fontSize: 12, color: 'var(--danger-text, #b91c1c)', lineHeight: 1.7 }}>
                      上面这条是<b>请求失败</b>，不是「没有这个人」——请按提示排查（未登录 / 网络 / 网关异常）后再试。
                    </div>
                  )}
                  {searchResults.map((m) => (
                    <div key={m.memberId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-soft)', background: 'var(--bg-app)' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13 }}>{m.nickname || m.username || m.memberId}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>会员 id {m.memberId}{m.username ? ` · ${m.username}` : ''}</div>
                      </div>
                      <button
                        onClick={() => void onRequestFriend(m)}
                        disabled={Boolean(requestingId)}
                        title={requestingId === m.memberId ? '正在发送申请…' : requestingId ? '上一条申请正在处理中' : '向该会员发送好友申请（对方同意后你们才能互发私信）'}
                        style={{ ...btn('var(--accent)', '#fff'), display: 'inline-flex', alignItems: 'center', gap: 4, opacity: requestingId === m.memberId ? 0.55 : 1 }}
                      >
                        <IconPlus />
                        {requestingId === m.memberId ? '发送中…' : '发送申请'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={cardStyle}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>待处理申请（{requestCount || requests.length}）</div>
              {requests.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>暂无待处理的好友申请。</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {requests.map((r) => (
                  <div key={r.requestId || r.fromMemberId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-soft)', background: 'var(--bg-app)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>{r.fromNickname || r.fromUsername || r.fromMemberId}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>会员 id {r.fromMemberId} · {fmtTime(r.ts)}</div>
                      {r.message && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>附言：{r.message}</div>}
                    </div>
                    <button onClick={() => void onAccept(r)} title="同意" style={{ ...btn('var(--success, #22c55e)', '#fff'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <IconCheck />
                      同意
                    </button>
                    <button onClick={() => void onReject(r)} title="拒绝" style={{ ...btn('transparent', 'var(--text-secondary)', '1px solid var(--border)') }}>
                      拒绝
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <IconUsers />
                <span style={{ fontSize: 13, fontWeight: 600 }}>我的好友（{friends.length}）</span>
                <button
                  onClick={async () => {
                    const r = await window.shanhai?.memberRefreshFriends()
                    showResult(r)
                    void window.shanhai?.memberFriends().then((fr) => {
                      if (!fr) return
                      setFriends(fr.friends)
                      setRequests(fr.requests)
                      setRequestCount(fr.requestCount ?? fr.requests.length)
                    })
                  }}
                  title="从网关重新拉取好友与申请"
                  style={{ ...smallIconBtn, marginLeft: 'auto' }}
                >
                  <IconRefresh />
                </button>
              </div>
              {friends.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>还没有好友。上面查用户名发申请，对方同意后就会出现在这里。</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {friends.map((f) => (
                  <div key={f.memberId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-soft)', background: 'var(--bg-app)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>{f.nickname || f.username || f.memberId}</div>
                      {/* 网关未实现 member_online/member_offline，这里不显示在线状态，避免谎报 */}
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>会员 id {f.memberId}{f.username ? ` · ${f.username}` : ''}</div>
                    </div>
                    <button
                      onClick={async () => {
                        const cid = await window.shanhai?.memberChannelId(f.memberId)
                        if (!cid) {
                          setErrorText('还拿不到本账号会员 id，暂时无法打开会话（请重试连接）')
                          return
                        }
                        const t: DmThread = threads.find((x) => x.channelId === cid) ?? { channelId: cid, peerId: f.memberId, peerName: f.nickname || f.username || f.memberId, messages: [], unread: 0, lastTs: Date.now() }
                        void openThread(t)
                      }}
                      disabled={!status?.ready}
                      title={status?.ready ? '发起私信' : '会员通道未就绪'}
                      style={btn('var(--accent)', '#fff', undefined)}
                    >
                      私信
                    </button>
                    <button onClick={() => void onDeleteFriend(f)} title="删除好友（历史私信保留，但需重新加好友才能再发）" style={{ ...smallIconBtn, color: 'var(--danger-text, #b91c1c)' }}>
                      <IconTrash />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
