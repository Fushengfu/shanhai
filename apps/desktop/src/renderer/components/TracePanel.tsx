import { useEffect, useMemo, useState, type UIEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconActivity, IconWrench } from './icons'
import { makeMarkdownComponents, normalizeTreeBlocks } from './Markdown'
import { TOOL_META, toolSummary, toolTitle, renderToolResult } from './ToolStep'
import { getLocale } from '../../shared/i18n'
import { useLocaleSync } from '../locale'
import { t } from '../../shared/i18n'
import { ThinkingDots } from './ui'
import { WindowTitleBar } from './WindowTitleBar'

type TraceEntry = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoningContent?: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  toolCallId?: string
  toolName?: string
  result?: unknown
  error?: string
  turn: number
  timestamp: number
}

// 表里存词条键而不是中文：模块级常量表存中文会在加载期固化，切语言不跟着变
// （期1 STATUS_LABEL / 期2 TOOL_META / 期3 SUPERVISOR_ARG_LABELS / 期4 SECTIONS 第四次踩同一个坑）
const ROLE_META: Record<TraceEntry['role'], { k: string; color: string; bg: string }> = {
  system: { k: 'panels.roleSystem', color: 'var(--text-muted)', bg: 'var(--bg-subtle)' },
  user: { k: 'panels.roleUser', color: 'var(--accent)', bg: 'var(--tint-blue-soft)' },
  assistant: { k: 'panels.roleAssistant', color: 'var(--success-text)', bg: 'var(--tint-green)' },
  tool: { k: 'panels.roleTool', color: 'var(--warning)', bg: 'var(--tint-orange)' },
}

type CallMeta = { name: string; args: Record<string, unknown> }

/** 工具结果详情：中文工具名 + 参数 + 类型化结果（对齐聊天流的 ToolStep 渲染） */
function ToolResultRow({ m, callMap }: { m: TraceEntry; callMap: Map<string, CallMeta> }) {
  useLocaleSync()
  const call = m.toolCallId ? callMap.get(m.toolCallId) : undefined
  const name = m.toolName ?? call?.name ?? ''
  // 表里只存词条键，标题一律渲染时取词（切语言才会跟着变）
  const meta = TOOL_META[name] ?? { k: '', icon: <IconWrench /> }
  const args = call?.args
  const summary = toolSummary(name, args)
  const resultBody =
    renderToolResult(name, m.result, m.error, args) ??
    (m.content ? (
      <pre style={{ margin: 0, padding: '10px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto' }}>
        {m.content}
      </pre>
    ) : (
      <div style={{ color: 'var(--text-faint)', fontSize: 12, padding: '8px 12px' }}>{t('panels.noResult')}</div>
    ))

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ color: 'var(--warning)', display: 'inline-flex', flexShrink: 0 }}>{meta.icon}</span>
        <b style={{ color: 'var(--text)', fontSize: 13, flexShrink: 0 }}>{toolTitle(name)}</b>
        {summary && (
          <span style={{ color: 'var(--text-muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            · {summary}
          </span>
        )}
        {name && <span style={{ color: 'var(--text-faint)', fontSize: 11, fontFamily: 'ui-monospace, monospace', flexShrink: 0, marginLeft: 'auto' }}>{name}</span>}
      </div>
      {args && Object.keys(args).length > 0 && (
        <div style={{ marginBottom: 6, padding: '6px 10px', borderRadius: 6, background: 'var(--tint-orange)', border: '1px solid var(--tint-orange-strong)', fontSize: 12 }}>
          <div style={{ color: 'var(--warning-text)', fontWeight: 600, marginBottom: 4 }}>{t('panels.args')}</div>
          <pre style={{ margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflowY: 'auto' }}>
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
      )}
      {resultBody}
    </div>
  )
}

/** 单条消息痕迹：索引 #N + 角色标签 + 轮次 + 时间 + 元数据（reasoning / tool_calls / tool_call_id）+ 内容 */
function TraceRow({ m, index, callMap, isLast }: { m: TraceEntry; index: number; callMap: Map<string, CallMeta>; isLast?: boolean }) {
  useLocaleSync()
  const meta = ROLE_META[m.role]
  // 改前写死 'zh-CN'：英文界面下时间戳仍是中文格式。现在跟随当前语言（hour12 由语言决定）
  const time = new Date(m.timestamp).toLocaleString(undefined, { hour12: getLocale() === 'en-US' })
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
      <div style={{ width: 16, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: meta.color, flexShrink: 0, marginTop: 14, boxShadow: '0 0 0 2px var(--bg-panel)' }} />
        {!isLast && <span style={{ width: 2, flex: 1, background: 'var(--border)', marginTop: 4 }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0, marginBottom: isLast ? 0 : 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-panel)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: meta.bg, borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'ui-monospace, monospace', flexShrink: 0 }}>#{index}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: meta.color, padding: '1px 8px', borderRadius: 10, background: 'var(--bg-panel)', border: `1px solid ${meta.color}` }}>{t(meta.k)}</span>
        {m.turn > 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('panels.turn', { n: m.turn })}</span>}
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{time}</span>
        {m.toolCallId && <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'ui-monospace, monospace' }}>tool_call_id: {m.toolCallId}</span>}
      </div>
      <div style={{ padding: '8px 12px' }}>
        {m.reasoningContent && (
          <div style={{ marginBottom: 6, padding: '6px 10px', borderRadius: 6, background: 'var(--bg-app)', color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto' }}>
            <span style={{ color: 'var(--purple-soft)', fontWeight: 600 }}>{t('panels.reasoningLabel')}</span>
            {m.reasoningContent}
          </div>
        )}
        {m.toolCalls && m.toolCalls.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {m.toolCalls.map((tc) => {
              const tmeta = TOOL_META[tc.name] ?? { k: '', icon: <IconWrench /> }
              return (
                <div key={tc.id} style={{ padding: '6px 10px', borderRadius: 6, background: 'var(--tint-orange)', border: '1px solid var(--tint-orange-strong)', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: 'var(--warning)', fontWeight: 600 }}>{t('panels.callTool', { name: toolTitle(tc.name) })}</span>
                  <span style={{ color: 'var(--text-faint)', fontFamily: 'ui-monospace, monospace' }}> {tc.name} · id={tc.id}</span>
                  <pre style={{ margin: '4px 0 0', fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflowY: 'auto' }}>
                    {JSON.stringify(tc.args, null, 2)}
                  </pre>
                </div>
              )
            })}
          </div>
        )}
        {m.role === 'tool' ? (
          <ToolResultRow m={m} callMap={callMap} />
        ) : m.content ? (
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto', fontFamily: 'system-ui, sans-serif' }}>
            {m.role === 'assistant' && !m.toolCalls ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeMarkdownComponents(() => undefined)}>
                {normalizeTreeBlocks(m.content)}
              </ReactMarkdown>
            ) : (
              m.content
            )}
          </div>
        ) : (
          <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>{t('panels.noContent')}</div>
        )}
      </div>
      </div>
    </div>
  )
}

export function TracePanel({ left, top, sessionId, busy, streamingReasoning, streaming, onClose, variant = 'panel' }: {
  left?: number
  top?: number
  sessionId: string
  busy: boolean
  streamingReasoning: string
  streaming: string
  onClose?: () => void
  variant?: 'panel' | 'window'
}) {
  // 本组件渲染期直接取词（标题栏 title / subtitle 的计数句）→ 必须自订阅。
  // 它是通过 slot 插件挂进 App 的，静态分析追不到父组件，所以不能指望父重渲染带下来。
  useLocaleSync()
  const [trace, setTrace] = useState<TraceEntry[]>([])
  const [loading, setLoading] = useState(true)
  // 分批渲染：数据量大时避免一次性全量渲染导致卡顿（配合滚动懒加载逐批增量渲染）
  const [visibleCount, setVisibleCount] = useState(50)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setVisibleCount(50)
    void window.shanhai?.getSessionTrace(sessionId).then((t) => {
      if (alive) {
        setTrace(t ?? [])
        setLoading(false)
      }
    }).catch(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [sessionId])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // callId → { name, args } 映射：工具结果消息通过 tool_call_id 反查参数
  const callMap = useMemo(() => {
    const map = new Map<string, CallMeta>()
    for (const m of trace) {
      if (m.toolCalls) for (const tc of m.toolCalls) map.set(tc.id, { name: tc.name, args: tc.args })
    }
    return map
  }, [trace])

  const roleCount = (r: TraceEntry['role']): number => trace.filter((m) => m.role === r).length
  const toolCallCount = trace.filter((m) => m.toolCalls && m.toolCalls.length > 0).length

  const visibleTrace = trace.slice(0, visibleCount)
  const hasMore = visibleCount < trace.length
  const streamingActive = Boolean(streamingReasoning || streaming)
  // 滚动到接近底部时增量加载更多，避免长列表一次性渲染卡死
  const handleScroll = (e: UIEvent<HTMLDivElement>): void => {
    if (!hasMore) return
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
      setVisibleCount((v) => Math.min(v + 50, trace.length))
    }
  }

  return (
    <div style={{ ...(variant === 'window' ? { height: '100vh' } : { position: 'fixed', top, left, right: 0, bottom: 0, zIndex: 50, borderLeft: '1px solid var(--border)', boxShadow: '-20px 0 60px rgba(0,0,0,0.2)' }), background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif' }}>
      <WindowTitleBar
        icon={<IconActivity />}
        title={t('panels.traceTitle')}
        subtitle={[
          t('panels.traceMessages', { n: trace.length }),
          t('panels.traceToolCalls', { n: toolCallCount }),
          t('panels.traceRoleCounts', { a: roleCount('system'), u: roleCount('user'), h: roleCount('assistant'), t: roleCount('tool') }),
        ].join(t('common.sepMiddle'))}
        onClose={() => onClose?.()}
      />

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }} onScroll={handleScroll}>
          {/* 加载提示：轨迹数据拉取期间显示骨架占位，避免被误判为「暂无」或界面无响应 */}
          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' }}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} style={{ display: 'flex', gap: 12 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--border)', flexShrink: 0, marginTop: 6 }} />
                  <div style={{ flex: 1, height: 44, borderRadius: 8, background: 'var(--bg-subtle)' }} />
                </div>
              ))}
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>{t('panels.traceLoading')}</div>
            </div>
          )}
          {!loading && trace.length === 0 && !busy && (
            <div style={{ textAlign: 'center', color: 'var(--text-faint)', padding: '80px 0', fontSize: 14 }}>{t('panels.traceEmpty')}</div>
          )}
          {!loading && visibleTrace.map((m, i) => (
            <TraceRow key={i} m={m} index={i + 1} callMap={callMap} isLast={i === visibleTrace.length - 1 && !hasMore && !streamingActive && !busy} />
          ))}
          {!loading && streamingReasoning && (
            <TraceRow m={{ role: 'assistant', content: '', reasoningContent: streamingReasoning, turn: 0, timestamp: Date.now() }} index={trace.length + 1} callMap={callMap} isLast={!streaming} />
          )}
          {!loading && streaming && (
            <TraceRow m={{ role: 'assistant', content: streaming, turn: 0, timestamp: Date.now() }} index={trace.length + 2} callMap={callMap} isLast />
          )}
          {!loading && hasMore && !streamingActive && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: '8px 0 16px' }}>{t('panels.traceLoadMore')}</div>
          )}
          {!loading && busy && !streamingReasoning && !streaming && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 13, paddingLeft: 28 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--purple-soft)' }} />
              {t('chat.plugin.thinking')}
              <ThinkingDots />
            </div>
          )}
        </div>
      </div>
  )
}
