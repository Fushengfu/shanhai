import type { ExpertTrace } from '../types'

/** 多专家协作卡片：列出本轮各专家的执行状态（✓/✗/…），紧凑展示，渲染在正文之前 */
export function ExpertTraces({ traces }: { traces: ExpertTrace[] }): React.JSX.Element | null {
  if (traces.length === 0) return null
  return (
    <div style={{ margin: '6px 0 2px', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--tint-purple)', background: 'var(--tint-purple)', fontSize: 12 }}>
      <div style={{ fontWeight: 600, color: 'var(--purple)', marginBottom: 6 }}>多专家协作</div>
      {traces.map((t) => (
        <div key={t.stepId} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', color: 'var(--text-secondary)' }}>
          <span style={{ width: 16, textAlign: 'center', color: t.status === 'completed' ? 'var(--success)' : t.status === 'failed' ? 'var(--danger)' : 'var(--accent)' }}>
            {t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : '…'}
          </span>
          <span style={{ color: 'var(--purple)', fontWeight: 500 }}>{t.expertName}</span>
          <span style={{ flex: 1, overflowWrap: 'break-word', wordBreak: 'break-word' }}>{t.title}</span>
          {t.status === 'failed' && t.error && <span style={{ color: 'var(--danger)' }}>{t.error}</span>}
        </div>
      ))}
    </div>
  )
}
