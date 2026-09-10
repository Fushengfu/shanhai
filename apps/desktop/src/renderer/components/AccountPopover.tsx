/**
 * 左下角账号区的**悬停信息弹窗**（用户信息 / 本机技能 / 本机 MCP 服务）。
 *
 * 【为什么弹窗必须 createPortal 挂 body】
 * 账号区所在容器的祖先带 `overflow:'hidden'`（App.tsx 的根容器与 <aside> 侧栏），
 * 弹窗若作为其子节点会被直接裁掉。portal 机制项目内已有先例（DmSharePicker.tsx / 语音粒子浮层）。
 *
 * 【为什么不用 position:absolute 而是 fixed】
 * 弹窗挂 body 后不在任何 contain/transform 包含块内，fixed 即相对视口（与 DmSharePicker 同口径）；
 * 面板靠 bottom 锚在账号条目上方 8px，不顶开侧栏布局。
 *
 * 【交互口径（本任务书指定）】
 * - onMouseEnter 打开；onMouseLeave **延迟 200ms** 关闭（防鼠标在条目与面板之间穿越时抖动）；
 * - 点击固定 / 再点取消：悬停打开的弹窗点一下就固定（此后鼠标移出也不关），再点一下取消；
 * - 收起复用既有 components/useDismissOnClickOutside（点本窗口内其它地方 / Esc）。
 *
 * 【与 useDismissOnClickOutside 的配合】
 * 该 hook 的 containerRef 只能指向一个 DOM 子树，而「触发条目」与「面板」是两棵
 * （面板被 portal 到了 body）。所以在条目上把切换逻辑挂在 **onMouseDown** 上：
 * document 的 capture 监听先跑（把「开着的弹窗」收起），随后才轮到条目的 mousedown ——
 * 此时本组件闭包里的 open/pinned 仍是**被收起之前**那次渲染的值（React 18 在同一事件内批量更新），
 * 于是能正确区分「本来就开着且已固定 → 再点取消」与「开着但只是悬停 / 本来就关着 → 点一下固定」。
 *
 * 【数据】技能与 MCP 清单只读，来自主进程（main/skills-mcp.ts）。MCP 工具数探测带超时与降级，
 * 拿不到就显示「读取失败」，不编数字。
 */
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { McpServerSummary, SkillSummary } from '../../shared/account-services'
import { useUIContext } from '../ui-context'
import { useLocaleSync } from '../locale'
import { t } from '../../shared/i18n'
import { useDismissOnClickOutside } from './useDismissOnClickOutside'
import { IconAvatar, IconGrid, IconLogout, IconMobile, IconStore, IconWrench } from './icons'
import { MobileQrImage, mobileQrHint, useMobileApkInfo } from './mobileDownload'
// 头像首字复用私信面板既有的 initialsOf（同一个「中文取第一个字 / 代理对按码点 / 拉丁大写」规则），
// 不再另写一套取值口径。
import { initialsOf } from './DmIm'

/** 悬停移出后的收起延迟（防鼠标穿越间隙抖动） */
const CLOSE_DELAY_MS = 200

/** 面板宽度（与任务书口径一致） */
const PANEL_WIDTH = 260

/** 二维码弹层宽度（比信息弹窗窄：内容只有标题 + 二维码 + 一行提示） */
const QR_PANEL_WIDTH = 200

/** 弹层里二维码的展示边长（弹层宽 200，左右各留 12 padding，取 160 会溢出 4px → 用 168 内的安全值） */
const QR_SIZE = 152

interface AnchorRect {
  left: number
  top: number
}

/** 侧栏底部账号区：头像 + 昵称 + 退出登录 + 悬停信息弹窗 */
export function AccountBar(): React.JSX.Element {
  useLocaleSync()
  const ctx = useUIContext()
  const barRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [open, setOpen] = useState(false)
  /** 是否已「点击固定」：固定后鼠标移出不再收起 */
  const [pinned, setPinned] = useState(false)
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)

  // ——— ② 手机端下载二维码弹窗（头像右侧那个按钮触发的第二个弹层）———
  // 交互口径与上面的信息弹窗**完全一致**（悬停开 / 200ms 延迟关 / 点击固定 / Esc / 点外），
  // 面板同样 portal 到 body（左侧栏祖先带 overflow:hidden，会被裁切）。
  const qrPanelRef = useRef<HTMLDivElement>(null)
  const qrBtnRef = useRef<HTMLButtonElement>(null)
  const qrTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [qrOpen, setQrOpen] = useState(false)
  const [qrPinned, setQrPinned] = useState(false)
  const [qrAnchor, setQrAnchor] = useState<AnchorRect | null>(null)

  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  /** 打开（并重新量一次锚点，窗口尺寸变了也不会错位） */
  const openNow = (): void => {
    clearTimer()
    const el = barRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      setAnchor({ left: r.left, top: r.top })
    }
    setOpen(true)
  }

  /** 延迟收起（已固定则不收） */
  const scheduleClose = (): void => {
    if (pinned) return
    clearTimer()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }

  const closeNow = (): void => {
    clearTimer()
    setPinned(false)
    setOpen(false)
  }

  // 组件卸载时清掉待收起的定时器（常驻窗口反复悬停不会累积）
  useEffect(() => () => clearTimer(), [])

  // 面板打开时才挂「点外 / Esc 收起」
  useDismissOnClickOutside({ open, containerRef: panelRef, onDismiss: closeNow })

  // ——— ② 手机端二维码弹窗：与信息弹窗同一套时序（见文件头的交互口径注释）———
  const qrClearTimer = (): void => {
    if (qrTimerRef.current !== null) {
      clearTimeout(qrTimerRef.current)
      qrTimerRef.current = null
    }
  }

  /**
   * 打开二维码弹窗。
   * ★同时收起「信息弹窗」：两个面板锚在同一位置，一起显示会互相盖住（且用户只可能在看其中一个）。
   */
  const qrOpenNow = (): void => {
    qrClearTimer()
    const el = qrBtnRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      setQrAnchor({ left: r.left - 12, top: r.top })
    }
    clearTimer()
    setPinned(false)
    setOpen(false)
    setQrOpen(true)
  }

  const qrScheduleClose = (): void => {
    if (qrPinned) return
    qrClearTimer()
    qrTimerRef.current = setTimeout(() => {
      qrTimerRef.current = null
      setQrOpen(false)
    }, CLOSE_DELAY_MS)
  }

  const qrCloseNow = (): void => {
    qrClearTimer()
    setQrPinned(false)
    setQrOpen(false)
  }

  useEffect(() => () => qrClearTimer(), [])

  useDismissOnClickOutside({ open: qrOpen, containerRef: qrPanelRef, onDismiss: qrCloseNow })

  // 弹窗打开时才拉 APK 信息（悬停是高频动作，不打开就不发 IPC）
  const { apk: qrApk, loading: qrLoading, error: qrErr } = useMobileApkInfo(qrOpen)

  // 打开时才拉数据（悬停是高频动作，不打开就不发 IPC）
  const [skills, setSkills] = useState<SkillSummary[] | null>(null)
  const [skillErr, setSkillErr] = useState<string | null>(null)
  const [servers, setServers] = useState<McpServerSummary[] | null>(null)
  const [serverErr, setServerErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    const sh = window.shanhai
    if (!sh?.listSkills || !sh?.listMcpServers) {
      setSkills([])
      setSkillErr(t('chat.account.failed'))
      setServers([])
      return
    }
    void (async () => {
      try {
        const r = await sh.listSkills()
        if (!alive) return
        setSkills(r.skills)
        setSkillErr(r.error ?? null)
      } catch (err) {
        if (alive) {
          setSkills([])
          setSkillErr(err instanceof Error ? err.message : String(err))
        }
      }
      try {
        const r = await sh.listMcpServers()
        if (!alive) return
        setServers(r.servers)
        setServerErr(r.error ?? null)
        // 工具数与逐条清单已收敛到「MCP 管理」面板：本弹窗不再探测工具数
        // （少一次会 spawn 子进程的调用；悬停是高频动作）
      } catch (err) {
        if (alive) {
          setServers([])
          setServerErr(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [open])

  const panelStyle: React.CSSProperties | null = anchor
    ? {
        position: 'fixed',
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - PANEL_WIDTH - 8)),
        bottom: Math.max(8, window.innerHeight - anchor.top + 8),
        width: PANEL_WIDTH,
        maxHeight: Math.max(160, anchor.top - 16),
        overflowY: 'auto',
        zIndex: 1000,
        background: 'var(--bg-panel)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
        padding: '10px 0',
      }
    : null

  // 二维码弹层样式：与信息弹窗同一套视觉语言（同圆角/描边/阴影/zIndex），只是更窄、padding 均等
  const qrPanelStyle: React.CSSProperties | null = qrAnchor
    ? {
        position: 'fixed',
        left: Math.max(8, Math.min(qrAnchor.left, window.innerWidth - QR_PANEL_WIDTH - 8)),
        bottom: Math.max(8, window.innerHeight - qrAnchor.top + 8),
        width: QR_PANEL_WIDTH,
        zIndex: 1000,
        background: 'var(--bg-panel)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
        padding: 12,
      }
    : null

  return (
    <>
      <div
        ref={barRef}
        onMouseEnter={openNow}
        onMouseLeave={scheduleClose}
        onMouseDown={() => {
          if (open && pinned) closeNow()
          else {
            setPinned(true)
            openNow()
          }
        }}
        onClick={() => {
          if (!ctx.loggedIn) ctx.setLoginOpen(true)
        }}
        style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div
          title={ctx.loggedIn ? ctx.username ?? '' : t('chat.sidebar.clickLogin')}
          style={{ width: 32, height: 32, borderRadius: '50%', background: ctx.loggedIn ? 'var(--accent)' : 'var(--border-strong)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: ctx.loggedIn ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, lineHeight: 1 }}
        >
          {/* 头像：有头像图就显示图（当前无数据源，见下方 AccountAvatar 注释），否则显示昵称/账号首字；
              连显示名都没有（未登录）→ 沿用既有 IconAvatar 中性占位（不出现空白圆圈）。 */}
          <AccountAvatar name={ctx.loggedIn ? ctx.username : null} size={32} src={ctx.avatar ?? undefined} />
        </div>
        <div
          style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: ctx.loggedIn ? 'default' : 'pointer' }}
        >
          {ctx.loggedIn ? (ctx.username ?? t('chat.sidebar.loggedIn')) : t('common.notLoggedIn')}
        </div>
        {ctx.loggedIn && (
          <button
            ref={qrBtnRef}
            onMouseEnter={qrOpenNow}
            onMouseLeave={qrScheduleClose}
            onMouseDown={(e) => {
              // 与信息弹窗同一套「点一下固定 / 再点取消」口径：
              // 先让 mousedown 冒泡到账号条目会被其 onMouseDown 接管，故这里阻止冒泡，
              // 由本按钮自己处理（否则会同时打开两个面板）。
              e.stopPropagation()
              if (qrOpen && qrPinned) qrCloseNow()
              else {
                setQrPinned(true)
                qrOpenNow()
              }
            }}
            title={t('settings.about.downloadMobile')}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'inline-flex' }}
          >
            <IconMobile />
          </button>
        )}
      </div>
      {/* ② 手机端下载二维码弹层（portal 到 body：侧栏祖先带 overflow:hidden 会裁切） */}
      {qrOpen && qrPanelStyle
        ? createPortal(
            <div
              ref={qrPanelRef}
              onMouseEnter={qrClearTimer}
              onMouseLeave={qrScheduleClose}
              style={qrPanelStyle}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{t('settings.apk.qrAlt')}</div>
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'center' }}>
                {qrLoading ? (
                  <div style={{ height: QR_SIZE, display: 'flex', alignItems: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                    {t('settings.about.fetching')}
                  </div>
                ) : qrApk ? (
                  <MobileQrImage downloadUrl={qrApk.downloadUrl} size={QR_SIZE} />
                ) : (
                  <div style={{ height: QR_SIZE, display: 'flex', alignItems: 'center', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                    {qrErr || t('chat.account.failed')}
                  </div>
                )}
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {qrApk ? mobileQrHint(qrApk.version) : ''}
              </div>
            </div>,
            document.body,
          )
        : null}
      {open && panelStyle
        ? createPortal(
            <div
              ref={panelRef}
              onMouseEnter={clearTimer}
              onMouseLeave={scheduleClose}
              style={panelStyle}
            >
              {/* ① 用户信息 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 12px 10px' }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: ctx.loggedIn ? 'var(--accent)' : 'var(--border-strong)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {/* 与账号条目同一份头像渲染（同一个人的头像不该两处长得不一样） */}
                  <AccountAvatar name={ctx.loggedIn ? ctx.username : null} size={32} src={ctx.avatar ?? undefined} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ctx.loggedIn ? (ctx.username ?? t('common.unknownMember')) : t('common.notLoggedIn')}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {ctx.loggedIn ? t('chat.sidebar.loggedIn') : t('chat.sidebar.clickLogin')}
                  </div>
                </div>
              </div>

              <div style={{ height: 1, background: 'var(--border)', margin: '0 0 8px' }} />

              {/* ② 本机技能（**不再逐条罗列**：清单收敛到技能市场的「已安装」tab，这里只留计数 + 入口） */}
              <Section
                icon={<IconWrench />}
                title={t('chat.account.skills')}
                badge={skills ? t('chat.account.count', { n: skills.length }) : t('chat.account.loading')}
              >
                <>
                  {skillErr ? (
                    <EmptyRow title={skillErr}>{t('chat.account.failed')}</EmptyRow>
                  ) : !skills ? (
                    <EmptyRow>{t('chat.account.loading')}</EmptyRow>
                  ) : null}
                  {/* 去技能市场：复用既有 openApp 通道（二级入口应用，不占 Dock 图标位）；
                      先关掉本弹窗，否则它 portal 在 body 上会盖在新窗口之上（观感上像没打开） */}
                  <div
                    role="button"
                    onClick={() => {
                      closeNow()
                      void window.shanhai?.openApp('skills-market')
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px', fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}
                  >
                    <IconStore />
                    <span>{t('chat.account.gotoMarket')}</span>
                  </div>
                </>
              </Section>

              <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />

              {/* ③ 本机 MCP 服务（**不再逐条罗列**：清单与启停收敛到 MCP 管理面板，这里只留计数 + 入口） */}
              <Section
                icon={<IconGrid />}
                title={t('chat.account.mcp')}
                badge={servers ? t('chat.account.count', { n: servers.length }) : t('chat.account.loading')}
              >
                <>
                  {serverErr ? (
                    <EmptyRow title={serverErr}>{t('chat.account.failed')}</EmptyRow>
                  ) : !servers ? (
                    <EmptyRow>{t('chat.account.loading')}</EmptyRow>
                  ) : null}
                  <div
                    role="button"
                    onClick={() => {
                      closeNow()
                      void window.shanhai?.openApp('mcp-manager')
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px', fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}
                  >
                    <IconGrid />
                    <span>{t('chat.account.gotoMcp')}</span>
                  </div>
                </>
              </Section>

              {/* ④ 底部固定：退出登录（复用既有 ctx.handleLogout，不新写一套） */}
              {ctx.loggedIn && (
                <>
                  <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
                  <div
                    role="button"
                    onClick={() => {
                      closeNow()
                      void ctx.handleLogout()
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}
                  >
                    <IconLogout />
                    <span>{t('chat.sidebar.logout')}</span>
                  </div>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

/** 分区：图标 + 标题 + 右侧数量徽标 + 子行 */
function Section(props: { icon: React.ReactNode; title: string; badge: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 12px 6px', fontSize: 12, color: 'var(--text-secondary)' }}>
        <span style={{ display: 'inline-flex', color: 'var(--text-muted)' }}>{props.icon}</span>
        <span style={{ fontWeight: 600 }}>{props.title}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-faint)' }}>{props.badge}</span>
      </div>
      {props.children}
    </div>
  )
}

/** 空态 / 加载态行（与条目行同缩进，保持视觉节奏） */
function EmptyRow(props: { title?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div title={props.title} style={{ padding: '3px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
      {props.children}
    </div>
  )
}

/**
 * 账号头像：**有头像图就显示图，没有就显示显示名的首字**（用户口径）。
 *
 * 【显示名口径】调用方传进来的 `name` 必须是**已按「昵称 → 用户名」优先级选好的显示名**
 * —— `ui-context` 的 `username` 就是主进程按该优先级算出来的（`model-provider.ts:256`
 * `ctx.username = s.nickname ?? s.username`），所以这里直接用 `ctx.username` 即满足优先级。
 * ★**绝不回落会员 ID（memberId）**：`name` 为空（未登录 / 拿不到显示名）时走中性占位 IconAvatar，
 * 不显示空白圆、也不拿数字 ID 顶替。
 *
 * 【首字规则】复用 `DmIm.initialsOf`（唯一实现）：
 * 中文取第一个字、代理对按码点取（emoji 不会被截成半个）、拉丁字母大写。
 * ★用户名是手机号等纯数字串时**照取首位数字**（用户明确要求「账号第一位」），不做脱敏、不跳过数字。
 *
 * 【`src` 的真实来源（任务235 起已接通）】`ctx.avatar` = 当前登录用户**自己的**头像 URL：
 *  runtime `applyAuthSession`（登录/注册响应 `AuthSession.avatar`）与 `restoreCredentials`
 *  （重启后从本地配置 `gateway.account.avatar` 读回）两处写入内存，经 `auth:status` 只读下发到
 *  `ui-context.avatar`（同一通道的既有字段面，未新增 IPC / 未新增 store 字段）。
 *  未登录、网关未下发、老配置无该字段时均为 null ⇒ 走首字分支；
 *  URL 非法（非 http(s)）或图片加载失败 ⇒ 同样回落首字（不出现破图/空白圆）。
 * ★绝不涉及 memberId：`name` 为空（未登录/拿不到显示名）时走中性占位 IconAvatar，不回落会员 ID。
 *
 * 【样式】圆形尺寸/背景/字色沿用账号区原样式（`var(--accent)` 底 + 白字），
 * 字号/字重取私信面板 `DmAvatar` 首字分支的同一套数值（`round(size*0.42)` / 600 / lineHeight 1）。
 */
export function AccountAvatar({ name, size = 32, src }: { name: string | null | undefined; size?: number; src?: string }): React.JSX.Element {
  /** 记「哪个 URL 加载失败了」而不是布尔量：换头像（URL 变了）时自动重试一次（与 DmAvatar 同口径） */
  const [failedUrl, setFailedUrl] = useState('')
  const displayName = (name ?? '').trim()
  const url = /^https?:\/\/\S+$/i.test((src ?? '').trim()) ? (src ?? '').trim() : ''
  if (url && failedUrl !== url) {
    return (
      <img
        src={url}
        alt=""
        onError={() => setFailedUrl(url)}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
      />
    )
  }
  if (!displayName) return <IconAvatar />
  return (
    <span
      style={{
        fontSize: Math.max(11, Math.round(size * 0.42)),
        fontWeight: 600,
        lineHeight: 1,
        userSelect: 'none',
      }}
    >
      {initialsOf(displayName)}
    </span>
  )
}
