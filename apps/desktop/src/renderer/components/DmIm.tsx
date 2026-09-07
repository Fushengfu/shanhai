import * as React from 'react'
import { useState } from 'react'
import { IconCopy, IconFile, IconImage, IconPlus, IconQuote } from './icons'
import { copyText, formatBytes, smallIconBtn } from './ui'
import { decodeDmContent, dmContentPreview, dmContentToPlainText } from '../../shared/dm-attachment'
import { t } from '../../shared/i18n'
import type { DmMessage } from '../types'
import { useDismissOnClickOutside } from './useDismissOnClickOutside'

/**
 * 私信面板 IM 化（P1 双栏骨架 / P2 气泡与时间）的**纯显示**共用件。
 *
 * 为什么单独成文件：头像占位、时间分隔线判定与文案、发送状态文案这几段只读入参、不碰任何数据，
 * 抽出来后 MemberPanel 的渲染分支更短，也能用 node 复刻单独断言（本项目验收口径要求逻辑可复刻）。
 *
 * 【硬约束（任务 58 的延续）】这里任何一件都不允许把 memberId 当显示文本输出：
 * 传进来的 name 一律先经 MemberPanel 的 displayNameOf（昵称 → 用户名 → 「未知会员」）归一。
 */

/** 左列宽度：常规 280；窗口宽度 < NARROW_WIDTH_PX 时压到 220（用户拍板的双栏数值口径） */
export const LEFT_WIDTH_PX = 280
export const LEFT_WIDTH_NARROW_PX = 220
export const NARROW_WIDTH_PX = 640

/** 两条消息间隔超过这个值就插一条居中时间分隔线（参照微信口径：5 分钟） */
export const TIME_DIVIDER_MS = 5 * 60 * 1000

/**
 * 左列底部「通道状态一行」的短标签：窄列里放不下整句，整句留在 title 与右侧空态里。
 * 【i18n 期1】原来是 `Record<tone,string>` 常量（值在模块加载时就固定成中文，切语言不会变）；
 * 改成函数后每次渲染按当前语言取词。**tone→key 的映射表是固定的，判定逻辑一字未动。**
 */
const STATUS_LABEL_KEY: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'dm.status.ok',
  warn: 'dm.status.warn',
  bad: 'dm.status.bad',
}

export function statusLabelOf(tone: 'ok' | 'warn' | 'bad'): string {
  return t(STATUS_LABEL_KEY[tone] ?? 'dm.status.warn')
}

/** 头像配色对：全部取 theme.css 里暗亮双主题都已定义的变量，不新造颜色 */
const AVATAR_TINTS: Array<{ bg: string; fg: string }> = [
  { bg: 'var(--tint-blue)', fg: 'var(--accent)' },
  { bg: 'var(--tint-purple)', fg: 'var(--purple)' },
  { bg: 'var(--tint-orange)', fg: 'var(--warning-text)' },
  { bg: 'var(--tint-green)', fg: 'var(--success-text)' },
  { bg: 'var(--tint-red)', fg: 'var(--danger-text)' },
]

/** 按名字稳定取一个配色（同名恒定，不随重渲染变化 → 不会出现换色闪烁） */
export function avatarStyleOf(name: string): { bg: string; fg: string } {
  let sum = 0
  for (const ch of name) sum = (sum + (ch.codePointAt(0) ?? 0)) % 997
  const hit = AVATAR_TINTS[sum % AVATAR_TINTS.length]
  return hit ?? { bg: 'var(--tint-blue)', fg: 'var(--accent)' }
}

/**
 * 名字首字（中文取第一个字；代理对按码点取；空名给兜底字）。
 * 【i18n 期1】兜底字改为取词：中文「会」（会员）、英文「M」（member）。
 * ⚠️ 这里只兜底**首字母**，绝不兜成 memberId —— 任务58 的零会员ID口径不变。
 */
export function initialsOf(name: string): string {
  const first = Array.from((name ?? '').trim())[0]
  return (first ?? t('dm.avatarFallback')).toUpperCase()
}

/**
 * 只认 http(s) 绝对地址：
 *  - `data:` 会把图片数据塞进 DOM/日志（本项目已因截图 base64 撑爆请求踩过 context deadline exceeded）；
 *  - `//host/x.png` 这种相对协议在打包后的 file:// 环境里会解析错 → 与其显示破图，不如回落首字；
 *  - 空串 / 空白 = 网关没下发头像（实测常态），按无头像处理。
 */
function usableAvatarUrl(raw: string | undefined | null): string {
  const u = (raw ?? '').trim()
  return /^https?:\/\/\S+$/i.test(u) ? u : ''
}

/**
 * 头像该出真图还是出占位：**返回非空 = 渲染 <img>，返回空串 = 渲染首字占位**。
 * 抽成导出函数是因为这条规则（含「换头像要重新试一次」）必须能被断言，而不是只活在 JSX 的三元里；
 * 组件与验证脚本共用同一份实现，避免「测的是一套、跑的是另一套」。
 */
export function avatarImageSrc(src: string, failedUrl: string): string {
  if (!src) return ''
  // failedUrl 记的是「哪一个 URL 已经失败」：URL 变了（对方换头像）就重新尝试一次
  return failedUrl && failedUrl === src ? '' : src
}

/**
 * 头像：网关 avatar 实测常为空字符串，所以**首字占位是常态、真图是加分项**。
 *  - 无 URL / URL 非 http(s) / 图片加载失败 → 一律显示首字占位，**静默回落**：
 *    绝不允许出现破图图标、空白圆或整块塌掉（onError 里换回占位，alt 留空不出文字标签）；
 *  - 两条分支的 width / height / borderRadius / flexShrink 逐字一致 → 换图或回落都不产生布局位移；
 *  - 配色两条分支同源（占位的 tint 同时当 img 的背景），暗亮双主题都沿用 theme.css 变量口径；
 *  - 远程图只出现在 <img src>，不进消息体、不进日志、不进任何请求。
 */
export function DmAvatar(props: { name: string; size?: number; title?: string; src?: string }): React.JSX.Element {
  const size = props.size ?? 32
  const tint = avatarStyleOf(props.name)
  const src = usableAvatarUrl(props.src)
  /**
   * 记「哪个 URL 失败了」而不是布尔量：对方换头像（URL 变了）时自动重新尝试加载，
   * 不需要 useEffect 去同步状态（引 effect 就等于给高频重渲染的私信面板再加一个变量）。
   */
  const [failedUrl, setFailedUrl] = useState('')
  const showSrc = avatarImageSrc(src, failedUrl)
  if (showSrc) {
    return (
      <img
        src={src}
        alt=""
        title={props.title ?? props.name}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(src)}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          flexShrink: 0,
          display: 'block',
          objectFit: 'cover',
          // 加载中 / 半透明 PNG 都不留白：底色就是该人的占位配色；边框保证圆形在暗亮主题下都看得见
          background: tint.bg,
          border: '1px solid var(--border-soft)',
          boxSizing: 'border-box',
          userSelect: 'none',
        }}
      />
    )
  }
  return (
    <span
      title={props.title ?? props.name}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tint.bg,
        color: tint.fg,
        fontSize: Math.max(11, Math.round(size * 0.42)),
        fontWeight: 600,
        lineHeight: 1,
        userSelect: 'none',
      }}
    >
      {initialsOf(props.name)}
    </span>
  )
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 是否需要在这条消息前插一条时间分隔线：会话第一条 / 跨天 / 间隔 > 5 分钟。
 * prevTs 传 0 表示「没有上一条」。跨天优先于间隔（23:59 → 00:01 只有 2 分钟也要插）。
 */
export function needTimeDivider(prevTs: number, ts: number): boolean {
  if (!prevTs) return true
  if (!sameDay(prevTs, ts)) return true
  return ts - prevTs > TIME_DIVIDER_MS
}

/**
 * 分隔线文案（P2 定稿口径）：当天只显示 HH:MM；跨天显示「昨天 / M月D日」，跨年再补年份。
 * 非当天也带上 HH:MM：只写日期会让同一天的多条分隔线糊成一团，主流 IM 同样是「昨天 14:03」这种形态。
 */
export function fmtDividerTime(ts: number): string {
  if (!ts) return ''
  const now = Date.now()
  const d = new Date(ts)
  if (sameDay(ts, now)) return hhmm(ts)
  // 【i18n 期1】日期形态全部走词条：中文「昨天 14:03 / 8月3日 14:03 / 2025年8月3日 14:03」，
  // 英文由各自词条自己决定语序（Yesterday 14:03 / 8/3 14:03 / 8/3/2025 14:03），代码侧不拼「月/日/年」。
  if (sameDay(ts, now - 24 * 60 * 60 * 1000)) return t('dm.time.yesterdayAt', { time: hhmm(ts) })
  const md = t('dm.time.md', { m: d.getMonth() + 1, d: d.getDate() })
  const withTime = t('dm.time.mdAt', { md, time: hhmm(ts) })
  if (d.getFullYear() === new Date(now).getFullYear()) return withTime
  return t('dm.time.ymd', { y: d.getFullYear(), md: withTime })
}

/** 会话列表右侧的时间：今天只写 HH:MM，昨天写「昨天」，更早写 M月D日（跨年带年份） */
export function fmtListTime(ts: number): string {
  if (!ts) return ''
  const now = Date.now()
  const d = new Date(ts)
  if (sameDay(ts, now)) return hhmm(ts)
  if (sameDay(ts, now - 24 * 60 * 60 * 1000)) return t('common.yesterday')
  const md = t('dm.time.md', { m: d.getMonth() + 1, d: d.getDate() })
  if (d.getFullYear() === new Date(now).getFullYear()) return md
  return t('dm.time.ymd', { y: d.getFullYear(), md })
}

/** 一条自己发出的消息的发送状态（P2：时间挪到消息之间后，状态标记放气泡上方独立一行） */
export interface DmSendStatus {
  text: string
  bad: boolean
  tip: string
}

/**
 * ⚠️「已读」是**近似值，不是真实已读水位线**，三条事实必须一起说清（不许伪装成精确已读）：
 *  1) 历史接口里的 readAt 是逐条的（这部分是权威值）；
 *  2) 但实时 read_update 在主进程走的是**整会话近似**：member-channel.ts:1302 把本会话「我发的」全部标 read=true；
 *  3) 渲染层没有 member:read 订阅通道（preload 未暴露，本轮边界禁止改），所以已读通常要等下次拉历史才刷新。
 * 网关补上 lastReadSeq 之前，UI 上就写「已读（近似）」并把上面三点放进 tooltip，不简写成「已读」。
 */
export function sendStatusOf(m: { pending?: boolean; failed?: string | null; read?: boolean }): DmSendStatus {
  // 【i18n 期1】只换文案来源，四条分支的判定顺序与条件一字未动
  // 【i18n 期5B】m.failed 现在可能是**词条 key**（主进程不再把译文写进 dm-store.json，见
  // member-channel.ts 的 FAILED_CHANNEL_CLOSED）→ 这里再过一次 t()：
  //   · 是 key → 取到当前语言文案，切语言后历史气泡的失败原因也跟着变；
  //   · 是中文原文（老数据）或网关原文 → 词典查不到，lookup 原样返回（不会显示成 dm.xxx）。
  if (m.failed) return { text: t('dm.statusLine.failed', { reason: t(m.failed) }), bad: true, tip: t('dm.statusLine.failedTip') }
  if (m.pending) return { text: t('dm.statusLine.sending'), bad: false, tip: t('dm.statusLine.sendingTip') }
  if (m.read) {
    return {
      text: t('dm.statusLine.readApprox'),
      bad: false,
      tip: t('dm.statusLine.readApproxTip'),
    }
  }
  return { text: t('dm.statusLine.delivered'), bad: false, tip: t('dm.statusLine.deliveredTip') }
}

/** 消息流的一行：居中时间分隔线，或一条气泡（P2 摊平后由渲染层直接 map） */
export type DmRow = { kind: 'divider'; key: string; ts: number } | { kind: 'msg'; key: string; msg: DmMessage }

/**
 * 【P2】把消息流摊平成「居中时间分隔线 / 气泡」两种行。
 * 单独成函数（而不是写在组件里）的目的：这段是 P2 的核心规则，能被 node 直接拿真实消息数组断言，
 * 不需要 DOM、也不需要跑 effect —— 界面观感仍要用户实测，但「什么时候插分隔线」不必靠肉眼。
 */
export function buildChatRows(messages: readonly DmMessage[] | undefined): DmRow[] {
  const out: DmRow[] = []
  let prevTs = 0
  for (const m of messages ?? []) {
    if (needTimeDivider(prevTs, m.ts)) out.push({ kind: 'divider', key: `d-${m.msgId}`, ts: m.ts })
    out.push({ kind: 'msg', key: m.msgId, msg: m })
    prevTs = m.ts
  }
  return out
}

/** 【P2】居中时间分隔线 */
export function DmTimeDivider(props: { ts: number }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 2px' }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-subtle)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '1px 7px' }}>
        {fmtDividerTime(props.ts)}
      </span>
    </div>
  )
}

/** 【P6】未读分割线（会话级近似，非逐条水位）。
 *  ⚠️ 网关无 lastReadSeq（v1.2 未实现），拿不到「逐条已读到哪」——这里用打开会话那一刻的
 *  unread 快照做近似：unread = 这次进入时网关给的未读数，分割线画在消息流倒数第 unread 条之前。
 *  打开会话即 markRead，故 active.unread 在本次会话内保持打开时快照、不随 markRead 移动；
 *  下次再进（未读已归 0）则不再显示 —— 即「看过后消失」的会话级近似。 */
export function DmUnreadDivider(props: { count: number }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, margin: '10px 0 2px' }}>
      <span style={{ flex: '0 0 26px', height: 1, background: 'var(--border-strong, rgba(128,128,128,.4))' }} />
      <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {t('dm.newMessage', { n: props.count })}
      </span>
      <span style={{ flex: '0 0 26px', height: 1, background: 'var(--border-strong, rgba(128,128,128,.4))' }} />
    </div>
  )
}

/** 单个右键菜单项 */
function CtxMenuItem(props: { icon: React.ReactNode; label: string; onClick: () => void }): React.JSX.Element {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '6px 12px',
        border: 'none',
        background: hover ? 'var(--hover-bg, rgba(128,128,128,.12))' : 'transparent',
        color: 'var(--text)',
        cursor: 'pointer',
        fontSize: 13,
        textAlign: 'left',
      }}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  )
}

/**
 * 【P2】一条私信气泡：左右分侧 + 头像 + 状态标记独立一行（时间已挪到消息之间，这里不再显示时间）。
 * ⚠️ 传进来的 peerName / mineName 必须已经是 displayNameOf 归一过的显示名（不许是会员ID）。
 * onQuote 是「引用到会话」的唯一入口 —— 只有本地用户点击才会触发，不会自动发送。
 */
export function DmMessageRow(props: {
  msg: DmMessage
  peerName: string
  mineName: string
  /** 【真头像】对端头像 URL；自己的气泡本轮仍走首字占位（MemberChannelStatus 里没有头像字段，未批准改） */
  peerAvatar?: string
  narrow?: boolean
  onQuote: (msg: DmMessage) => void
  /** 点图片气泡看大图（复用既有 ImagePreview 遮罩） */
  onPreviewImage?: (src: string) => void
}): React.JSX.Element {
  const m = props.msg
  const st = sendStatusOf(m)
  const mine = Boolean(m.mine)
  // 【P3】content 可能是「附件引用 JSON」：解出正文与引用；解不出来时 decode 会原样交回文本，
  // 所以手机端 / 老版本发的普通文本（甚至用户手打的 JSON）都不会被我们吞掉。
  const parsed = decodeDmContent(m.text)
  // ── 右键菜单状态 ──
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null)
  const ctxRef = React.useRef<HTMLDivElement>(null)
  useDismissOnClickOutside({ open: !!ctxPos, containerRef: ctxRef, onDismiss: () => setCtxPos(null) })

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    setCtxPos({ x: e.clientX, y: e.clientY })
  }
  const plainText = dmContentToPlainText(m.text)

  return (
    <div style={{ display: 'flex', flexDirection: mine ? 'row-reverse' : 'row', gap: 8, alignItems: 'flex-start', marginTop: 8 }} onContextMenu={handleContextMenu}>
      {/* 自己的气泡上方多了一行状态，头像往下让一格，保证头像是跟气泡对齐而不是跟状态行对齐 */}
      <span style={{ display: 'inline-flex', marginTop: mine ? 14 : 0, flexShrink: 0 }}>
        <DmAvatar name={mine ? props.mineName : props.peerName} size={30} src={mine ? undefined : props.peerAvatar} />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', minWidth: 0, maxWidth: props.narrow ? '78%' : '68%' }}>
        {mine && (
          <span title={st.tip} style={{ fontSize: 10, color: m.failed ? 'var(--danger-text, #b91c1c)' : 'var(--text-muted)', marginBottom: 3, padding: '0 2px' }}>
            {st.text}
          </span>
        )}
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 12,
            background: mine ? 'var(--accent)' : 'var(--bg-panel)',
            color: mine ? '#fff' : 'var(--text)',
            border: mine ? 'none' : '1px solid var(--border-soft)',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
          }}
        >
          {parsed.text}
          {parsed.atts.map((a, i) => (
            <DmAttachmentBlock key={`${m.msgId}-a${i}`} att={a} narrow={props.narrow} onPreviewImage={props.onPreviewImage} />
          ))}
        </div>
      </div>
      {/* 【红线】只有本地用户点这个按钮，才会走「选目标会话 → 把原文追加进那个会话的输入框」 */}
      <button
        onClick={() => props.onQuote(m)}
        title={t('dm.quote.btnTitle')}
        style={{ ...smallIconBtn, width: 24, height: 24, flexShrink: 0, marginTop: mine ? 14 : 0 }}
      >
        <IconPlus />
      </button>
      {/* 【P5·右键菜单】onContextMenu 挂在外层，气泡+头像+引用按钮都响应右键 */}
      {ctxPos && (
        <div
          ref={ctxRef}
          style={{
            position: 'fixed',
            left: ctxPos.x,
            top: ctxPos.y,
            zIndex: 10000,
            minWidth: 140,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,.18)',
            padding: '4px 0',
            fontSize: 13,
            color: 'var(--text)',
          }}
        >
          <CtxMenuItem
            icon={<IconCopy />}
            label={t('dm.ctx.copy')}
            onClick={() => { copyText(plainText); setCtxPos(null) }}
          />
          <CtxMenuItem
            icon={<IconQuote />}
            label={t('dm.ctx.quote')}
            onClick={() => { props.onQuote(m); setCtxPos(null) }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * 【P3】气泡里的一个附件引用块：图片渲染缩略图（点看大图），文档渲染一张可复制链接的卡片。
 *
 * 三条如实原则：
 *  1. 图片**加载失败**（离线 / 链接失效 / 被墙）不静默留白 —— 换成一张带文件名的卡片，
 *     并把公网直链原样给出来，用户仍可自己打开或复制；
 *  2. 不显示会员ID：这里只会出现文件名与 URL（URL 是网关生成的路径，不含会员身份）；
 *  3. 图片是公网直链（用户已知情拍板），所以这里明确写进 title，不假装它是私密内容。
 */
export function DmAttachmentBlock(props: {
  att: { t: 'image' | 'file'; u: string; n: string; s: number; w?: number; h?: number }
  narrow?: boolean
  onPreviewImage?: (src: string) => void
}): React.JSX.Element {
  const a = props.att
  const [broken, setBroken] = useState(false)
  const sizeTip = t('dm.attSizeLine', { name: a.n, size: formatBytes(a.s) })
  if (a.t === 'image' && !broken) {
    // 已知宽高时按比例占位，避免图片加载完把气泡顶跳（与「不闪烁」的口径一致）
    const ratio = a.w && a.h ? a.w / a.h : 4 / 3
    const width = props.narrow ? 168 : 220
    return (
      <img
        src={a.u}
        alt={a.n}
        title={sizeTip}
        loading="lazy"
        onClick={() => props.onPreviewImage?.(a.u)}
        onError={() => setBroken(true)}
        style={{ display: 'block', width, height: Math.round(width / ratio), maxWidth: '100%', objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', marginTop: ATT_GAP, cursor: 'zoom-in', background: 'var(--bg-app)' }}
      />
    )
  }
  return (
    <div
      title={broken ? t('dm.attBrokenTitle', { url: a.u }) : sizeTip}
      onClick={() => props.onPreviewImage?.(a.u)}
      style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: ATT_GAP, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-app)', minWidth: 0, cursor: 'pointer' }}
    >
      <span style={{ display: 'inline-flex', color: broken ? 'var(--danger)' : 'var(--text-muted)', flexShrink: 0 }}>{a.t === 'image' ? <IconImage /> : <IconFile />}</span>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: props.narrow ? 130 : 200 }}>{a.n}</span>
        <span style={{ fontSize: 10, color: broken ? 'var(--danger)' : 'var(--text-muted)' }}>{broken ? t('dm.attBroken') : formatBytes(a.s)}</span>
      </span>
    </div>
  )
}

/** 附件块与正文之间的固定间距（写成常量，避免两处 JSX 各写一个数字） */
const ATT_GAP = 6

/** 【P1】会话列表里的一行预览文本（最后一条消息；没加载到消息时如实说明，不拿 id 凑数） */
export function threadPreview(thread: { messages?: DmMessage[]; unread: number }): string {
  const last = thread.messages && thread.messages.length > 0 ? thread.messages[thread.messages.length - 1] : undefined
  if (!last) return thread.unread > 0 ? t('dm.threadUnread', { n: thread.unread }) : t('dm.threadNoRecord')
  // 【P3】附件消息的 content 是引用 JSON，列表里显示成「[图片] 截图.png」而不是串码
  // 【i18n 期1】前缀全部走词条：中文「我：/ [发送失败] 」，英文「Me: / [send failed] 」。
  //   量词「条」不再由代码拼接（英文没有量词），改由复数词条承担。
  return `${last.mine ? t('dm.threadMinePrefix') : ''}${last.failed ? t('dm.threadFailedPrefix') : ''}${dmContentPreview(last.text)}`
}
