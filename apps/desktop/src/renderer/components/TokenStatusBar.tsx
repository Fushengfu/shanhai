import { memo, useState } from 'react'
import type { TokenSnapshot } from '../types'
import { fmtTokens } from './ui'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

export const TokenStatusBar = memo(function TokenStatusBar({ stats }: { stats: TokenSnapshot | null }) {
  useLocaleSync()
  if (!stats) {
    return <div style={{ padding: '6px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg-panel)', fontSize: 11, color: 'var(--text-faint)' }}>{t('chat.token.loading')}</div>
  }
  return (
    <div style={{ padding: '6px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg-panel)', fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontFamily: 'ui-monospace, monospace' }}>
      <span title={t('chat.token.totalTitle')}>
        {t('chat.token.total')} <b style={{ color: 'var(--text-secondary)' }}>{fmtTokens(stats.total)}</b>
        <span style={{ color: 'var(--text-faint)' }}>{t('chat.token.inOutParen', { p: fmtTokens(stats.totalPrompt), c: fmtTokens(stats.totalCompletion) })}</span>
      </span>
      <span title={t('chat.token.turnTitle')}>
        {t('chat.token.turn')} <b style={{ color: 'var(--accent)' }}>{t('chat.token.turnInOut', { p: fmtTokens(stats.turnPrompt), c: fmtTokens(stats.turnCompletion) })}</b>
      </span>
      <span title={t('chat.token.cacheTitle')}>
        {t('chat.token.cache')} <b style={{ color: (stats.cacheHitRatio || 0) > 0 ? 'var(--success)' : 'var(--text-muted)' }}>{Math.round((stats.cacheHitRatio || 0) * 100)}%</b>
      </span>
      <span title={t('chat.token.roundTitle')}>
        {t('chat.token.round')} <b style={{ color: 'var(--accent)' }}>{stats.turnCount}</b>
      </span>
      <span title={t('chat.token.contextTitle')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {t('chat.token.context')}
        <ContextRing stats={stats} />
      </span>
    </div>
  )
})

/** 上下文窗口占用环形指示器：中间显示百分比，悬停弹出详情（最大窗口/当前占用/剩余可用/占比） */
export function ContextRing({ stats }: { stats: TokenSnapshot }) {
  useLocaleSync()
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
          <div>{t('chat.token.maxWindow', { v: stats.contextLength > 0 ? `${fmtTokens(stats.contextLength)} tokens` : t('common.unknown') })}</div>
          <div>{t('chat.token.currentUsed', { v: `${fmtTokens(stats.lastPrompt)} tokens` })}</div>
          <div>{t('chat.token.remaining', { v: stats.contextLength > 0 ? `${fmtTokens(remaining)} tokens` : t('common.unknown') })}</div>
          <div>{t('chat.token.ratio', { v: `${pct}%` })}</div>
        </div>
      )}
    </span>
  )
}
