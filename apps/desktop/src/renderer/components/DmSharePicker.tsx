/**
 * 【任务109】消息卡片底部「分享」按钮的好友选择弹层 + 分享正文组装。
 *
 * 三条硬口径（来自 13:4x 只读摸底 A/B 节结论，逐条对着代码定）：
 *  1. **不新建第二套发送入口**：走既有 `window.shanhai.memberSend`（IPC `member:send`），
 *     由主进程按 `fromUserShare` 标志转调 `sendDmFromAgent` —— 与管家 dm_send **同一份实现**，
 *     出站敏感过滤一道不减；只按语义跳过「管家接管」开关（那是给 Agent 自动回复用的门，
 *     用户当面点分享不该被它拦）。★本轮不新增任何 ipcMain.handle / IPC 通道 / preload 方法。
 *  2. **正文取哪一份**：调用方必须传 `stripWrappedRecordTag` 后的文本（与既有 copy 按钮同源），
 *     禁止传裸 content（会把系统保留标签发给好友）。思考过程不分享。
 *  3. **绝不把 base64 塞进私信**：用户消息图片当轮是 data:、重启后是 https（摸底 A3 两份真相），
 *     故只有 http(s) 直链才作为附件发；data: 一律跳过并出可见提示。
 *  4. 【任务113】**整条一次发出，不分段**：管家要接管私信，被拆成多条的消息接管不了。
 *     超限（shared 的 DM_MAX_CONTENT_BYTES）→ 一条都不发 + 可见提示，禁止静默截断、禁止拆多条绕过上限。
 *
 * 弹层范式照抄 DmQuotePicker（PANEL_STYLE + useDismissOnClickOutside：本窗口 mousedown capture + Esc，
 * 不加 window blur、不加桌面壳广播 —— 任务48 用户明确不要）；条目名走 displayNameOf 单一真相源。
 */
import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconClose, IconShare, IconWarn } from './icons'
import { btn, smallIconBtn } from './ui'
import { useDismissOnClickOutside } from './useDismissOnClickOutside'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'
import { displayNameOf } from '../../shared/member-display'
import { DM_MAX_CONTENT_BYTES, encodeDmContent, utf8Bytes, type DmAttachmentPayload } from '../../shared/dm-attachment'
import type { DmFriend } from '../types'

// —————————————————————————— 纯逻辑（无 DOM / 无 IPC，便于无头断言）——————————————————————————

/**
 * 【任务113 · 取消分段】分享一律**整条一次发出**：不再拆多条、不再带 (i/N) 标注。
 * 理由（用户原话）：「后面管家接管消息的话分段消息怎么接管？不可能当作多条消息处理」——
 * 一条回答被拆成 3 条，管家会当成 3 件事接管，语义直接坏掉。
 * 原分段能力（planShareSegments / SHARE_MAX_SEGMENTS / (i/N) 标注 / graphemes 切分）已**整体删除**，
 * 不留会漂的第二套逻辑；超限语义收敛为「一条都不发 + 可见提示」，禁止静默截断、禁止拆多条绕过上限。
 * 上限值取 src/shared/dm-attachment.ts 的 DM_MAX_CONTENT_BYTES（与主进程 / 私信面板同一真相源）。
 */
export interface SharePlan {
  ok: boolean
  /** 拒因：empty=没有可分享的文字；tooLong=整条超过单条上限（一个字节都不发） */
  reason?: 'empty' | 'tooLong'
  /** 要发出的**唯一那一条** content（已含来源标注行；带图时是 encodeDmContent 的 atts 形态）；拒发时为 null */
  content: string | null
  /** 有图但没能随文发出（data: base64 被跳过 / 带上图后整条超限而退回纯文字）→ 调用方必须出可见提示 */
  imageSkipped: boolean
}

/** 只有 http(s) 直链能进私信附件；data:/blob: 一律跳过（严禁把 base64 发进私信，本项目踩过撑爆请求） */
export function shareableImageUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(String(url ?? '').trim())
}

/** 从直链取一个可显示的文件名；取不到就给 image-N.jpg（附件形态要求 n 是非空字符串） */
function nameFromUrl(url: string, idx: number): string {
  // 不用 arr[0] 取值（本仓库开了 noUncheckedIndexedAccess，索引结果一律可能是 undefined）
  const raw = String(url ?? '')
  let clean = raw
  const q = clean.indexOf('?')
  if (q >= 0) clean = clean.slice(0, q)
  const h = clean.indexOf('#')
  if (h >= 0) clean = clean.slice(0, h)
  const slash = clean.lastIndexOf('/')
  const base = (slash >= 0 ? clean.slice(slash + 1) : clean).trim()
  if (base && base.length <= 60 && /\.[a-z0-9]{2,5}$/i.test(base)) return base
  return `image-${idx + 1}.jpg`
}

/**
 * 组装**一条**分享内容（整条发出，不拆段）。
 *
 * 为什么图文可以合进同一条：encodeDmContent 的 atts 形态 `{"t":"atts","x":正文,"a":[引用…]}`
 * 本来就支持图文混排，一条装得下就没必要发两条 —— 改前把图片单独拆成第二条，
 * 与「分段消息管家接管不了」是同一个毛病，一并收掉。
 * 带上图后整条超上限 → 退回只发文字并登记 imageSkipped（界面出提示，不静默）；
 * 连纯文字都超上限 → 一律不发（reason='tooLong'）。
 */
export function planShare(body: string, headerLine: string, images?: string[]): SharePlan {
  const text = String(body ?? '').trim()
  const urls = (images ?? []).filter((u) => typeof u === 'string' && u.trim() !== '')
  const https = urls.filter(shareableImageUrl)
  const skipped = urls.length - https.length
  if (!text) return { ok: false, reason: 'empty', content: null, imageSkipped: skipped > 0 }

  const header = headerLine ? `${headerLine}\n` : ''
  const fullText = `${header}${text}`
  const atts: DmAttachmentPayload[] = https.map((u, i) => ({ t: 'image' as const, u: u.trim(), n: nameFromUrl(u, i), s: 0 }))

  if (atts.length > 0) {
    const mixed = encodeDmContent(fullText, atts)
    if (utf8Bytes(mixed) <= DM_MAX_CONTENT_BYTES) {
      return { ok: true, content: mixed, imageSkipped: skipped > 0 }
    }
  }
  // 无图，或带上图后整条超限（退回纯文字；图片被丢掉这件事必须让界面看得见）
  const droppedImages = skipped > 0 || atts.length > 0
  if (utf8Bytes(fullText) > DM_MAX_CONTENT_BYTES) {
    return { ok: false, reason: 'tooLong', content: null, imageSkipped: droppedImages }
  }
  return { ok: true, content: fullText, imageSkipped: droppedImages }
}

// —————————————————————————— 弹层组件 ——————————————————————————

const PANEL_STYLE: React.CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(430px, 90vw)',
  maxHeight: '72vh',
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 12,
  border: '1px solid var(--border-strong)',
  background: 'var(--bg-panel)',
  color: 'var(--text)',
  boxShadow: '0 10px 34px rgba(0,0,0,0.28)',
  zIndex: 900,
  overflow: 'hidden',
}

/** 失败/提示分支：一律存**词条 key + 参数**，不存已取好的字符串（期5B「别把语言烘进 state」的口径） */
interface ShareMsg {
  key: string
  params?: Record<string, string | number>
}

/** 【任务116】主进程 filterKind → 词典 key（★只存 key，不在这里 t() 取词烘进 state）。
 *  未知分类回落通用的那条 chat.share.filtered（保留为兜底，不是死键）。
 *  【任务120】addr / path / error 三条**当前不会被触发**——主进程按用户裁决
 *  （「账号密码、密钥这些可以拦截，其他的可以不拦截」）停用了地址/路径/堆栈三类规则，
 *  实际只会回 secret。本映射与四条词典词条**全部保留不删**：① 主进程开关
 *  （member-channel.ts ADDRESS_PATH_ERROR_FILTER_ENABLED）一拨回 true 即立刻生效，回退成本零；
 *  ② 表里仍被代码引用 ⇒ 那四条词条不构成死键。 */
const SHARE_FILTERED_KEYS: Record<string, string> = {
  secret: 'chat.share.filtered.secret',
  path: 'chat.share.filtered.path',
  addr: 'chat.share.filtered.addr',
  error: 'chat.share.filtered.error',
}

export interface DmSharePickerProps {
  /** 要分享的正文（调用方必须已 stripWrappedRecordTag） */
  body: string
  /** 来源类型：决定标注行文案（AI 回复 / 我的消息） */
  source: 'assistant' | 'user'
  /** 用户消息携带的图片（data: 与 https 混合，本组件自己分流；AI 卡片不传） */
  images?: string[]
  onClose: () => void
}

/**
 * 【任务111 修复 · 根因】两个窗口的消息流容器都带 `contain:'layout'` + overflowY:auto
 * （ChatPlugin VirtualList style / SupervisorApp.tsx:782）。按 CSS Containment 规范，layout containment
 * 使该元素成为 **fixed 后代的包含块**：弹层 position:fixed left/top:50% 不再相对视口，而是落在
 * 「滚动后的内容坐标」里 —— 聊天列表日常吸底（scrollTop 大），弹层整块被顶到视口外
 * （同 Chromium 引擎实测：top≈-2004px，与视口交集=0）→ 用户看到「点了分享没反应」。
 * DmQuotePicker 同款样式却正常，是因为它挂在 MemberPanel 顶层（弹层不在任何 contain 滚动容器里）。
 * 修复 = createPortal 把弹层挂到 document.body，复刻 DmQuotePicker 的有效挂载语境（fixed=视口）；
 * portal 机制项目内已有先例（App.tsx:1063 语音粒子浮层 / SupervisorApp.tsx:906）。
 * 视觉与交互零改动：PANEL_STYLE / useDismissOnClickOutside / 条目渲染全部原样。
 */
export function DmSharePicker(props: DmSharePickerProps): React.JSX.Element {
  return createPortal(<DmSharePickerPanel {...props} />, document.body)
}

/** 弹层本体（全部 hook 在此，仍在任何提前 return 之前 —— SessionRow 白屏教训）。SSR 测试直接渲染它。 */
export function DmSharePickerPanel(props: DmSharePickerProps): React.JSX.Element {
  // ⚠️ hook 必须在任何提前 return 之前（SessionRow 白屏教训：条件性 Hook 调用 → 整树崩）
  useLocaleSync()
  const boxRef = useRef<HTMLDivElement>(null)
  useDismissOnClickOutside({ open: true, containerRef: boxRef, onDismiss: props.onClose })

  const [friends, setFriends] = useState<DmFriend[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ShareMsg | null>(null)
  const [hint, setHint] = useState<ShareMsg | null>(null)
  const [doneWith, setDoneWith] = useState<string | null>(null)

  // 好友候选只从既有 memberFriends() 取（摸底 C1：好友表在主进程内存，无第二份真相）
  useEffect(() => {
    let alive = true
    void (async () => {
      const sh = window.shanhai
      if (!sh?.memberFriends || !sh?.memberSend) {
        if (alive) {
          setFriends([])
          setErr({ key: 'dm.send.noBridge' })
        }
        return
      }
      try {
        const st = await sh.memberStatus()
        if (alive && !st.ready) setErr({ key: 'chat.share.notReady' })
      } catch {
        /* 状态拿不到不拦弹层，发送时主进程仍会如实回原因 */
      }
      try {
        const snap = await sh.memberFriends()
        if (alive) setFriends(Array.isArray(snap.friends) ? snap.friends : [])
      } catch {
        if (alive) setFriends([])
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const doShare = useCallback(
    async (f: DmFriend) => {
      if (busy) return
      setErr(null)
      setHint(null)
      setDoneWith(null)
      const sh = window.shanhai
      if (!sh?.memberSend) {
        setErr({ key: 'dm.send.noBridge' })
        return
      }
      const headerLine = t(props.source === 'assistant' ? 'chat.share.sourceAssistant' : 'chat.share.sourceUser')
      // 【任务113】整条一次发出：不再拆段、不再串行发多条（分段消息管家接管不了）
      const plan = planShare(props.body, headerLine, props.images)
      if (!plan.ok || !plan.content) {
        // 超限 / 空正文各出各的可见原因，禁止静默 return
        setErr({ key: plan.reason === 'tooLong' ? 'chat.share.tooLong' : 'chat.share.emptyBody' })
        return
      }
      setBusy(true)
      // fromUserShare：用户当面点分享 → 主进程跳过「管家接管」开关，但出站敏感过滤照过
      const r = await sh.memberSend({ peerMemberId: f.memberId, text: plan.content, fromUserShare: true })
      setBusy(false)
      if (!r?.ok) {
        // 各失败分支各出各的可见原因（禁止静默）；被过滤器拦时**不回显规则名与命中原文**，
        // 只按主进程给的「分类」取对应词条，让用户知道该改哪一类内容（任务116：不能只说"含不宜外发的信息"）
        if (r?.reason === 'content_filtered') {
          const kind = r.filterKind ?? 'secret'
          setErr({ key: SHARE_FILTERED_KEYS[kind] ?? 'chat.share.filtered' })
        }
        // 主进程回的是**已按主进程语言取好的原因串**（既有 MemberPanel 同款口径）；
        // 拿不到原因时改存**词条 key**，不在这里 t() 取词后塞进 state（那等于把语言烘进 state）
        else setErr(r?.message ? { key: 'chat.share.failed', params: { err: r.message } } : { key: 'chat.share.failedUnknown' })
        return
      }
      if (plan.imageSkipped) setHint({ key: 'chat.share.imageSkipped' })
      setDoneWith(displayNameOf(f.nickname || f.username, f.memberId))
      window.setTimeout(() => props.onClose(), 900)
    },
    [busy, props.body, props.images, props.onClose, props.source],
  )

  const list = friends ?? []
  return (
    <div ref={boxRef} style={PANEL_STYLE} role="dialog" aria-label={t('chat.share.ariaLabel')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}>
        <span style={{ display: 'inline-flex', color: 'var(--text-secondary)', flexShrink: 0 }}><IconShare /></span>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0 }}>{t('chat.share.title')}</span>
        <button onClick={props.onClose} title={t('common.cancel')} style={{ ...smallIconBtn, width: 22, height: 22, flexShrink: 0 }}>
          <IconClose />
        </button>
      </div>

      {/* 失败原因：留在弹层内，用户看得见（关掉弹层不该把原因一起丢掉 —— 同 DmQuotePicker 口径） */}
      {err && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '8px 12px', fontSize: 12, lineHeight: 1.6, color: 'var(--danger-text, #b91c1c)', background: 'var(--tint-red, rgba(239,68,68,0.08))', flexShrink: 0 }}>
          <span style={{ display: 'inline-flex', flexShrink: 0, marginTop: 1 }}><IconWarn /></span>
          <span style={{ flex: 1, minWidth: 0 }}>{t(err.key, err.params)}</span>
        </div>
      )}
      {/* 中性提示（图片被跳过 / 已分享）：不是故障，用中性底色 */}
      {(hint || doneWith) && (
        <div style={{ padding: '8px 12px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)', background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}>
          {doneWith ? t('chat.share.done', { name: doneWith }) : hint ? t(hint.key, hint.params) : ''}
        </div>
      )}

      <div style={{ padding: '8px 12px 0', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, flexShrink: 0 }}>{t('chat.share.footer')}</div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {friends === null && <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '10px 0' }}>{t('common.loading')}</div>}
        {friends !== null && list.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, padding: '10px 0' }}>{t('chat.share.emptyFriends')}</div>
        )}
        {list.map((f) => {
          // 条目名走 displayNameOf 单一真相源：昵称 → 用户名 → 「未知会员」，★绝不回落 memberId
          const label = displayNameOf(f.nickname || f.username, f.memberId)
          return (
            <div
              key={f.memberId}
              onClick={() => { if (!busy) void doShare(f) }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 10px',
                borderRadius: 8,
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.55 : 1,
                background: 'var(--bg-app)',
                border: '1px solid var(--border-soft)',
                minWidth: 0,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
                {typeof f.online === 'boolean' && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{f.online ? t('chat.share.online') : t('chat.share.offline')}</div>
                )}
              </div>
              <span style={{ fontSize: 11, color: 'var(--accent)', flexShrink: 0 }}>{t('chat.share.pickHere')}</span>
            </div>
          )
        })}
      </div>

      <div style={{ padding: '8px 12px 10px', borderTop: '1px solid var(--border-soft)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0 }}>{busy ? t('chat.share.sending') : t('chat.share.idle')}</span>
        <button onClick={props.onClose} style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}
