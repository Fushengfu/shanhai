/**
 * 市场卡片视觉套件（**数值逐字提取自插件市场**，不新造第三套视觉语言）。
 *
 * 【基准出处】renderer/apps/PluginMarketApp.tsx（改前）：
 *  - 卡片外壳（padding 18 / radius 16 / border 1px / hover 描边主色 + 阴影 + 上移 2px / transition 0.18s）
 *    → MarketCard 的根 div、MyCard 的根 div、SubmitRecordCard 的根 div 三处**逐值相同**；
 *  - 图标（52×52 / radius 13 / 无图降级为首字母 + 渐变底）→ AppIcon；
 *  - 标签（fontSize 10 / padding 2px 7px / radius 6 / 五种 tone）→ Tag；
 *  - 元信息行（fontSize 11 / color var(--text-faint) / gap 8）→ 三张卡片的元信息行；
 *  - 底部动作按钮（padding 7px 16px / radius 8 / fontSize 13 / fontWeight 600）→ 三张卡片的按钮；
 *  - 筛选 chip（padding 5px 12px / radius 999）→ FilterChip；
 *  - 网格（repeat(auto-fill, minmax(230px,1fr)) / gap 14）→ 三处列表容器；
 *  - 骨架卡 → SkeletonCard。
 *
 * 【为什么是「提取成新文件」而不是让 PluginMarketApp 也 import 它】
 * 本轮硬边界写死「不许改 225/226 已交付的既有行为、只做加法」，而 PluginMarketApp 是更早的历史文件，
 * 把它改成 import 本文件属于「顺手重构」，超出本轮范围。当前状态是：**本文件 = 插件市场那套数值的
 * 权威副本**，技能市场（SkillMarketApp）与 MCP 管理（McpManagerApp）都从这里取；PluginMarketApp
 * 暂时保留自己的内联副本（两份同值实现），是否收敛已作为裁决项报给管家。
 * ⇒ 改这里的数值等于改技能市场/MCP 管理的观感；PluginMarketApp 不受影响（待收敛后才会一起变）。
 */
import * as React from 'react'
import { useState } from 'react'

/** 卡片网格容器（与插件市场三处列表容器同值） */
export const MARKET_GRID_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
  gap: 14,
}

/** 卡片外壳样式（hover 态 = 描边主色 + 悬浮阴影 + 上移 2px） */
function marketCardStyle(hover: boolean): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 18,
    borderRadius: 16,
    border: `1px solid ${hover ? 'var(--accent)' : 'var(--border)'}`,
    background: 'var(--bg-panel)',
    boxShadow: hover ? '0 8px 24px rgba(0,0,0,0.10)' : '0 1px 3px rgba(0,0,0,0.04)',
    transform: hover ? 'translateY(-2px)' : 'translateY(0)',
    transition: 'box-shadow 0.18s ease, border-color 0.18s ease, transform 0.18s ease',
  }
}

/** 卡片外壳：自己持有 hover 态（与插件市场每张卡片各自 useState 同口径），可点则出手型 */
export function MarketCardShell(props: {
  children: React.ReactNode
  /** 卡片底部动作区（与正文同 gap，无需额外包裹） */
  footer?: React.ReactNode
  onClick?: () => void
  clickable?: boolean
  /** 选中态（描边主色常亮），用于列表里「当前正在看详情」的那张 */
  active?: boolean
}): React.JSX.Element {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={props.onClick}
      style={{
        ...marketCardStyle(hover || !!props.active),
        cursor: props.clickable ? 'pointer' : 'default',
      }}
    >
      {props.children}
      {props.footer}
    </div>
  )
}

/** 卡片头部：图标 + 名称 + 一句话简介（两行截断） */
export function MarketCardHead(props: { name: string; desc: string; iconUrl?: string }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
      <MarketIcon name={props.name} iconUrl={props.iconUrl} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.name}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>{props.desc}</div>
      </div>
    </div>
  )
}

/** 标签行容器 */
export function MarketTagRow(props: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{props.children}</div>
}

/** 元信息行容器（作者 / 版本 / 大小 / 下载量…） */
export function MarketMetaRow(props: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ fontSize: 11, color: 'var(--text-faint)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{props.children}</div>
}

/** 标签（tone 与插件市场 Tag 同值） */
export function MarketTag({ label, tone = 'blue' }: { label: string; tone?: 'blue' | 'gray' | 'green' | 'orange' | 'red' }): React.JSX.Element {
  const bg =
    tone === 'blue' ? 'var(--tint-blue-soft)' :
    tone === 'green' ? 'var(--tint-green-soft, rgba(76,175,80,0.14))' :
    tone === 'orange' ? 'var(--tint-orange-soft, rgba(255,152,0,0.14))' :
    tone === 'red' ? 'rgba(239,68,68,0.14)' :
    'var(--bg-subtle)'
  const color =
    tone === 'blue' ? 'var(--accent)' :
    tone === 'green' ? 'var(--success-text, #2e7d32)' :
    tone === 'orange' ? 'var(--warning-text, #b26a00)' :
    tone === 'red' ? 'var(--text-danger, #ef4444)' :
    'var(--text-muted)'
  return (
    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: bg, color, fontWeight: 600 }}>{label}</span>
  )
}

/**
 * 图标：优先真实 iconUrl（公网链接，**只透传 URL 字符串、不内联 base64**），
 * 无图或加载失败 → 首字母占位（与插件市场 AppIcon 同值）。
 */
export function MarketIcon({ name, iconUrl, size = 52, radius = 13 }: { name: string; iconUrl?: string; size?: number; radius?: number }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(true)}
        style={{ borderRadius: radius, objectFit: 'cover', display: 'block', flexShrink: 0, background: 'var(--bg-subtle)' }}
      />
    )
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, var(--tint-blue-soft), var(--bg-panel))',
        border: '1px solid var(--border-soft)',
        color: 'var(--accent)',
        fontWeight: 700,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {(name || '?').slice(0, 1).toUpperCase()}
    </div>
  )
}

/** 卡片底部按钮（主色实心 / 灰态描边两态，与插件市场卡片按钮同值） */
export function MarketCardButton(props: {
  label: string
  onClick?: () => void
  disabled?: boolean
  grey?: boolean
  /**
   * 附加色调（可选，**不传 = 与插件市场逐值一致**）：
   *  - 'outline'：可点击的灰色描边按钮（用于「取消」这类非破坏性次动作；
   *    不能复用 `grey` —— 那个是「已安装」的**禁用**态，disabled 恒为 true，点了不会响应）
   *  - 'danger'：危险实心（用于「确认卸载」这类破坏性动作，取自安装按钮在 confirm 态用的 var(--danger)）
   */
  tone?: 'outline' | 'danger'
}): React.JSX.Element {
  const grey = !!props.grey
  const outline = props.tone === 'outline'
  const danger = props.tone === 'danger'
  const disabled = props.disabled || grey
  return (
    <button
      onClick={props.onClick}
      disabled={disabled}
      style={{
        alignSelf: 'flex-start',
        padding: '7px 16px',
        borderRadius: 8,
        border: grey || outline ? '1px solid var(--border)' : 'none',
        cursor: disabled ? 'default' : 'pointer',
        background: grey || outline ? 'transparent' : danger ? 'var(--danger)' : 'var(--accent)',
        color: grey || outline ? 'var(--text-muted)' : '#fff',
        fontSize: 13,
        fontWeight: 600,
        transition: 'background 0.15s ease',
        opacity: props.disabled ? 0.6 : 1,
      }}
    >
      {props.label}
    </button>
  )
}

/** 筛选 chip（与插件市场 FilterChip 同值） */
export function MarketFilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px',
        borderRadius: 999,
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'var(--tint-blue-soft)' : 'var(--bg-panel)',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

/** 加载骨架卡（与插件市场 SkeletonCard 同值） */
export function MarketSkeletonCard(): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 18, borderRadius: 16, border: '1px solid var(--border)', background: 'var(--bg-panel)' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div style={{ width: 52, height: 52, borderRadius: 13, background: 'var(--bg-subtle)' }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ width: '55%', height: 14, borderRadius: 6, background: 'var(--bg-subtle)' }} />
          <div style={{ width: '85%', height: 11, borderRadius: 5, background: 'var(--bg-subtle)' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ width: 44, height: 18, borderRadius: 8, background: 'var(--bg-subtle)' }} />
        ))}
      </div>
      <div style={{ width: '100%', height: 36, borderRadius: 10, background: 'var(--bg-subtle)' }} />
    </div>
  )
}

/** 字节数格式化（与插件市场 formatSize 同值） */
export function formatSize(n?: number): string {
  if (!n || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** 卡片网格里的空态（与插件市场空态同值：图标 + 主句 + 副句） */
export function MarketEmpty(props: { icon: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ padding: '56px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
      <div style={{ opacity: 0.45, display: 'inline-flex' }}>
        <span style={{ transform: 'scale(1.6)', display: 'inline-flex' }}>{props.icon}</span>
      </div>
      <div>{props.title}</div>
      {props.hint ? <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{props.hint}</div> : null}
      {props.action}
    </div>
  )
}

/** 顶部 tab 条（数值与插件市场 tab 条同值：padding 10px 14px / 底线 2px / fontSize 13 / 选中 600） */
export function MarketTabBar<T extends string>(props: {
  tabs: Array<{ k: T; label: string }>
  active: T
  onChange: (k: T) => void
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 4, padding: '0 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
      {props.tabs.map((t) => (
        <button
          key={t.k}
          onClick={() => props.onChange(t.k)}
          style={{
            padding: '10px 14px',
            border: 'none',
            borderBottom: props.active === t.k ? '2px solid var(--accent)' : '2px solid transparent',
            background: 'transparent',
            color: props.active === t.k ? 'var(--text)' : 'var(--text-muted)',
            fontSize: 13,
            fontWeight: props.active === t.k ? 600 : 500,
            cursor: 'pointer',
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
