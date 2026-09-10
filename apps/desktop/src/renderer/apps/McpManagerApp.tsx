/**
 * MCP 管理（本机 MCP 服务的**编辑 / 启停**）。独立应用窗口，入口在账号悬停弹窗的「MCP 服务」区。
 *
 * 【与技能市场的关系】同属「账号弹窗生态」：入口形态、窗口注册方式（registry + AppWindow switch）、
 * 卡片视觉全部与技能市场/插件市场一致（卡片数值取自 components/marketCards.tsx，即插件市场那套）。
 *
 * 【凭证红线（本组件是渲染层唯一接触 env 的地方）】
 *  - 界面上看到的 env 值**永远是主进程给的掩码**（`••••••••`），组件拿不到原值；
 *  - 输入框留空 = 不改（提交时 value=null，主进程 merge 原值）；填了新值才覆盖；
 *  - 所以「把掩码写回文件」这条错路在本组件里物理上不可能发生。
 *
 * 【启停口径】停用 = 主进程把该条从 `servers` 段移到 `disabledServers` 段 ⇒ McpService 读不到 ⇒
 * AI 侧（mcp_list_tools / mcp_call）真的看不到。**不是 UI 假开关**。
 */
import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { McpManagedServer } from '../../shared/mcp-manage'
import { WindowTitleBar } from '../components/WindowTitleBar'
import { IconClose, IconEdit, IconGrid, IconPlus, IconRefresh, IconTrash, IconWarn } from '../components/icons'
import { MarketCardShell, MarketMetaRow, MarketTag, MarketTagRow, MARKET_GRID_STYLE, MarketEmpty } from '../components/marketCards'
import { smallIconBtn, btn } from '../components/ui'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'
import { useThemeSync } from '../theme'

/** 编辑态的一行 env：key 固定；value=null 表示「保持原值不变」（界面只显示掩码） */
interface EnvDraftRow {
  key: string
  value: string | null
  /** 新增行（可改 key，且必须有值才算数） */
  isNew: boolean
}

interface Draft {
  command: string
  /** args 以「每行一个」编辑（与 shell 直觉一致） */
  argsText: string
  env: EnvDraftRow[]
  removed: string[]
}

function toDraft(s: McpManagedServer): Draft {
  return {
    command: s.command,
    argsText: s.args.join('\n'),
    env: s.env.map((e) => ({ key: e.key, value: null, isNew: false })),
    removed: [],
  }
}

export function McpManagerApp({ onClose }: { onClose: () => void }): React.JSX.Element {
  useLocaleSync()
  useThemeSync()

  const [servers, setServers] = useState<McpManagedServer[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const sh = window.shanhai
    if (!sh?.listMcpManaged) {
      setServers([])
      setErr(t('mcp.manage.failed'))
      return
    }
    try {
      const r = await sh.listMcpManaged()
      setServers(r.servers)
      setErr(r.error ?? null)
    } catch (e) {
      setServers([])
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Esc 关闭窗口（与其它窗口应用同口径）
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = async (id: string, next: boolean): Promise<void> => {
    const sh = window.shanhai
    if (!sh?.setMcpServerEnabled) return
    setBusyId(id)
    setNotice(null)
    try {
      const r = await sh.setMcpServerEnabled(id, next)
      if (!r.ok) setNotice({ ok: false, text: r.error ?? t('mcp.manage.failed') })
      else setNotice({ ok: true, text: next ? t('mcp.manage.enabledOk') : t('mcp.manage.disabledOk') })
      // 启停会改文件 ⇒ 重新读列表（工具数也只有启用项才探测）
      await load()
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyId(null)
    }
  }

  const save = async (id: string): Promise<void> => {
    const sh = window.shanhai
    if (!draft || !sh?.saveMcpServer) return
    // 新增行没有键名 / 没有值 = 用户没填完，直接忽略（不当成错误）
    const env = draft.env
      .filter((e) => (e.key ?? '').trim() !== '')
      .filter((e) => !(e.isNew && (e.value ?? '') === ''))
      .map((e) => ({ key: e.key.trim(), value: e.value }))
    const args = draft.argsText
      .split('\n')
      .map((x) => x.trim())
      .filter((x) => x !== '')
    setBusyId(id)
    setNotice(null)
    try {
      const r = await sh.saveMcpServer({ id, command: draft.command, args, env, envRemoved: draft.removed })
      if (!r.ok) setNotice({ ok: false, text: r.error ?? t('mcp.manage.failed') })
      else {
        setNotice({ ok: true, text: t('mcp.manage.saved') })
        setEditingId(null)
        setDraft(null)
        await load()
      }
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyId(null)
    }
  }

  const list = servers ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--bg-app)', color: 'var(--text)' }}>
      <WindowTitleBar
        icon={<IconGrid />}
        title={t('app.mcpManager.name')}
        subtitle={t('app.mcpManager.desc')}
        extra={
          servers ? <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--text-faint)', flexShrink: 0 }}>{t('mcp.manage.count', { n: list.length })}</span> : null
        }
        onClose={onClose}
      />

      <div style={{ padding: '10px 20px 8px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>{t('mcp.manage.disableHint')}</span>
        <button title={t('common.refresh')} onClick={() => void load()} style={{ ...smallIconBtn, color: 'var(--text-muted)', width: 34, height: 34 }}>
          <IconRefresh />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {err ? (
          <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--tint-red)', color: 'var(--danger)', fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <IconWarn />
            <span style={{ wordBreak: 'break-word' }}>{t('mcp.manage.listFailed', { msg: err })}</span>
          </div>
        ) : null}
        {notice ? (
          <div style={{ padding: '10px 12px', borderRadius: 8, background: notice.ok ? 'var(--tint-green)' : 'var(--tint-red)', color: notice.ok ? 'var(--success)' : 'var(--danger)', fontSize: 12.5, wordBreak: 'break-word' }}>{notice.text}</div>
        ) : null}

        {!servers ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>{t('skills.market.loading')}</div>
        ) : list.length === 0 ? (
          <MarketEmpty icon={<IconGrid />} title={t('mcp.manage.empty')} hint={t('mcp.manage.emptyHint')} />
        ) : (
          <div style={MARKET_GRID_STYLE}>
            {list.map((s) => (
              <ServerCard
                key={s.id}
                s={s}
                busy={busyId === s.id}
                editing={editingId === s.id}
                draft={draft}
                onToggle={(next) => void toggle(s.id, next)}
                onEdit={() => {
                  setNotice(null)
                  setEditingId(s.id)
                  setDraft(toDraft(s))
                }}
                onCancel={() => {
                  setEditingId(null)
                  setDraft(null)
                }}
                onSave={() => void save(s.id)}
                onDraft={setDraft}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ServerCard(props: {
  s: McpManagedServer
  busy: boolean
  editing: boolean
  draft: Draft | null
  onToggle: (next: boolean) => void
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
  onDraft: (d: Draft) => void
}): React.JSX.Element {
  const { s, editing, draft } = props
  const toolText = s.enabled
    ? s.toolError
      ? t('mcp.manage.toolsFailed')
      : typeof s.toolCount === 'number'
        ? t('chat.account.toolCount', { n: s.toolCount })
        : t('skills.market.loading')
    : t('mcp.manage.toolsDisabled')

  return (
    <MarketCardShell>
      {/* 头部：图标 + id + command 摘要 */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 13,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, var(--tint-blue-soft), var(--bg-panel))',
            border: '1px solid var(--border-soft)',
            color: 'var(--accent)',
          }}
        >
          <IconGrid />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.id}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[s.command, ...s.args].join(' ')}>
            {[s.command, ...s.args].join(' ') || t('mcp.manage.noCommand')}
          </div>
        </div>
      </div>

      {/* 标签：启用状态 + 工具数 */}
      <MarketTagRow>
        <MarketTag label={s.enabled ? t('mcp.manage.enabled') : t('mcp.manage.disabled')} tone={s.enabled ? 'green' : 'gray'} />
        <MarketTag label={toolText} tone={s.enabled && s.toolError ? 'red' : 'blue'} />
      </MarketTagRow>

      {editing && draft ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Field label={t('mcp.manage.command')}>
            <input
              value={draft.command}
              onChange={(e) => props.onDraft({ ...draft, command: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label={t('mcp.manage.args')}>
            <textarea
              value={draft.argsText}
              onChange={(e) => props.onDraft({ ...draft, argsText: e.target.value })}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'ui-monospace, monospace', lineHeight: 1.5 }}
            />
          </Field>
          <Field label={t('mcp.manage.env')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {draft.env
                .filter((e) => !draft.removed.includes(e.key))
                .map((e, i) => (
                  <div key={`${e.key}-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {e.isNew ? (
                      <input
                        value={e.key}
                        placeholder={t('mcp.manage.newKey')}
                        onChange={(ev) => {
                          const env = draft.env.slice()
                          env[i] = { ...e, key: ev.target.value }
                          props.onDraft({ ...draft, env })
                        }}
                        style={{ ...inputStyle, width: 130, flexShrink: 0 }}
                      />
                    ) : (
                      <span style={{ width: 130, flexShrink: 0, fontSize: 11.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.key}>
                        {e.key}
                      </span>
                    )}
                    <input
                      // ★原值永不下发：这里显示的只是掩码；留空 = 保持原值（提交 value=null）
                      value={e.value ?? ''}
                      placeholder={s.env.find((x) => x.key === e.key)?.masked || t('mcp.manage.envKeep')}
                      onChange={(ev) => {
                        const env = draft.env.slice()
                        env[i] = { ...e, value: ev.target.value }
                        props.onDraft({ ...draft, env })
                      }}
                      style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                    />
                    <button
                      title={t('mcp.manage.removeKey')}
                      onClick={() => {
                        const env = draft.env.slice()
                        env[i] = { ...e, value: null }
                        const removed = e.isNew ? draft.removed : [...draft.removed, e.key]
                        props.onDraft({ ...draft, env: env.filter((_x, j) => j !== i), removed })
                      }}
                      style={{ ...smallIconBtn, color: 'var(--text-muted)', flexShrink: 0 }}
                    >
                      <IconTrash />
                    </button>
                  </div>
                ))}
              <button
                onClick={() => props.onDraft({ ...draft, env: [...draft.env, { key: '', value: '', isNew: true }] })}
                style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', color: 'var(--accent)', fontSize: 12, cursor: 'pointer', padding: '2px 0' }}
              >
                <IconPlus />
                {t('mcp.manage.addKey')}
              </button>
              <div style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>{t('mcp.manage.envHint')}</div>
            </div>
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={props.onSave} disabled={props.busy} style={{ ...btn('var(--accent)', '#fff'), opacity: props.busy ? 0.6 : 1 }}>
              {props.busy ? t('mcp.manage.saving') : t('mcp.manage.save')}
            </button>
            <button onClick={props.onCancel} style={{ ...btn('var(--bg-panel)', 'var(--text-secondary)'), border: '1px solid var(--border)' }}>
              <IconClose />
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <MarketMetaRow>
            <span>{t('mcp.manage.envCount', { n: s.env.length })}</span>
          </MarketMetaRow>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => props.onToggle(!s.enabled)} disabled={props.busy} style={{ ...btn(s.enabled ? 'var(--bg-panel)' : 'var(--accent)', s.enabled ? 'var(--text-secondary)' : '#fff'), border: s.enabled ? '1px solid var(--border)' : 'none', opacity: props.busy ? 0.6 : 1 }}>
              {s.enabled ? t('mcp.manage.disable') : t('mcp.manage.enable')}
            </button>
            <button onClick={props.onEdit} style={{ ...btn('var(--bg-panel)', 'var(--text-secondary)'), border: '1px solid var(--border)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <IconEdit />
              {t('mcp.manage.edit')}
            </button>
          </div>
        </>
      )}
    </MarketCardShell>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-panel)',
  color: 'var(--text)',
  fontSize: 12,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{label}</span>
      {children}
    </div>
  )
}
