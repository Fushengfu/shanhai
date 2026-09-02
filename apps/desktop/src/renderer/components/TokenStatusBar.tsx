import { memo, useState } from 'react'
import type { TokenSnapshot } from '../types'
import { fmtTokens } from './ui'

export const TokenStatusBar = memo(function TokenStatusBar({ stats }: { stats: TokenSnapshot | null }) {
  if (!stats) {
    return <div style={{ padding: '6px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg-panel)', fontSize: 11, color: 'var(--text-faint)' }}>token 用量统计中…</div>
  }
  return (
    <div style={{ padding: '6px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg-panel)', fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontFamily: 'ui-monospace, monospace' }}>
      <span title="本次启动以来累计 token">
        累计 <b style={{ color: 'var(--text-secondary)' }}>{fmtTokens(stats.total)}</b>
        <span style={{ color: 'var(--text-faint)' }}>（入 {fmtTokens(stats.totalPrompt)} / 出 {fmtTokens(stats.totalCompletion)}）</span>
      </span>
      <span title="本轮实时输入/输出 token（模型每次返回 usage 时更新）">
        本轮 <b style={{ color: 'var(--accent)' }}>入 {fmtTokens(stats.turnPrompt)} / 出 {fmtTokens(stats.turnCompletion)}</b>
      </span>
      <span title="最近一次请求的 prompt 缓存命中率（命中缓存 token / 该次输入 token）">
        缓存命中 <b style={{ color: (stats.cacheHitRatio || 0) > 0 ? 'var(--success)' : 'var(--text-muted)' }}>{Math.round((stats.cacheHitRatio || 0) * 100)}%</b>
      </span>
      <span title="当前会话累计完成的任务循环轮次（一次完整的「用户消息 → 最终回复」算一轮）">
        轮次 <b style={{ color: 'var(--accent)' }}>{stats.turnCount}</b>
      </span>
      <span title="当前会话上下文窗口占用" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        上下文
        <ContextRing stats={stats} />
      </span>
    </div>
  )
})

/** 上下文窗口占用环形指示器：中间显示百分比，悬停弹出详情（最大窗口/当前占用/剩余可用/占比） */
export function ContextRing({ stats }: { stats: TokenSnapshot }) {
  const [hover, setHover] = useState(false)
  const pct = Math.round((stats.contextUsageRatio || 0) * 100)
  const r = 9
  const c = 2 * Math.PI * r
  const color = pct > 80 ? 'var(--danger)' : pct > 60 ? 'var(--warning)' : 'var(--accent)'
  const remaining = stats.contextLength > 0 ? Math.max(stats.contextLength - stats.lastPrompt, 0) : 0
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: 'help' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <svg width={22} height={22} viewBox="0 0 24 24">
        <circle cx={12} cy={12} r={r} fill="none" stroke="var(--border)" strokeWidth={3.5} />
        <circle
          cx={12}
          cy={12}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={3.5}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(pct, 100) / 100)}
          strokeLinecap="round"
          transform="rotate(-90 12 12)"
          style={{ transition: 'stroke-dashoffset 0.3s ease' }}
        />
        <text x={12} y={12.5} textAnchor="middle" dominantBaseline="central" fontSize={6.5} fill="var(--text-secondary)" fontWeight={600}>
          {pct}%
        </text>
      </svg>
      {hover && (
        <div
          style={{
            position: 'absolute',
            bottom: '150%',
            right: 0,
            padding: '8px 12px',
            borderRadius: 8,
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            fontSize: 11,
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            zIndex: 100,
            lineHeight: 1.7,
          }}
        >
          <div>最大窗口：{stats.contextLength > 0 ? `${fmtTokens(stats.contextLength)} tokens` : '未知'}</div>
          <div>当前占用：{fmtTokens(stats.lastPrompt)} tokens</div>
          <div>剩余可用：{stats.contextLength > 0 ? `${fmtTokens(remaining)} tokens` : '未知'}</div>
          <div>上下文占比：{pct}%</div>
        </div>
      )}
    </span>
  )
}
