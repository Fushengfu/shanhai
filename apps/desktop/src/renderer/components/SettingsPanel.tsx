import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, AppSettingsPatch, HttpTraceRecord, RemoteStatus, RelayStatus } from '../types'
import { IconSettings } from './icons'
import { smallIconBtn } from './ui'
import { WindowTitleBar } from './WindowTitleBar'

/** 单个开关项：标签 + 描述 + 切换开关 */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>{description}</div>
      </div>
      <button
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        title={checked ? '已开启' : '已关闭'}
        style={{
          flexShrink: 0,
          width: 40,
          height: 22,
          borderRadius: 11,
          border: 'none',
          cursor: 'pointer',
          position: 'relative',
          background: checked ? 'var(--purple)' : 'var(--border-strong)',
          transition: 'background 0.18s ease',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 20 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: 'var(--bg-panel)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
            transition: 'left 0.18s ease',
          }}
        />
      </button>
    </div>
  )
}

/** 单选组：标签 + 描述 + 多个选项卡片（用于插入/队列模式等互斥配置） */
function RadioGroup({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string
  description: string
  value: string
  options: Array<{ value: string; label: string; desc: string }>
  onChange: (v: string) => void
}) {
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>{description}</div>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {options.map((o) => {
          const active = o.value === value
          return (
            <button
              key={o.value}
              onClick={() => onChange(o.value)}
              role="radio"
              aria-checked={active}
              style={{
                textAlign: 'left',
                padding: '10px 12px',
                borderRadius: 8,
                border: active ? '1px solid var(--purple)' : '1px solid var(--border-soft)',
                background: active ? 'var(--tint-purple)' : 'var(--bg-panel)',
                cursor: 'pointer',
                transition: 'border-color 0.15s ease, background 0.15s ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    border: active ? '4px solid var(--purple)' : '2px solid var(--border-strong)',
                    boxSizing: 'border-box',
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{o.label}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>{o.desc}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 设置面板：配置通用设置（浏览器窗口显示等），持久化到 config.json，跨会话、重启保留。侧滑铺满主区域 */
export function SettingsPanel({ left, top, onClose, variant = 'panel' }: { left?: number; top?: number; onClose?: () => void; variant?: 'panel' | 'window' }) {
  const [settings, setSettings] = useState<AppSettings>({ browser: { showOnCreate: true, enableWebBridge: true }, messageSubmit: { mode: 'queue' }, debug: { traceLlm: false }, voice: { enabled: false }, supervisorApproval: { enabled: false }, supervisorAsk: { enabled: false } })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [httpTraces, setHttpTraces] = useState<HttpTraceRecord[]>([])
  const [showHttpTraces, setShowHttpTraces] = useState(false)
  const [dsb, setDsb] = useState<{ windowReady: boolean; bridgeInjected: boolean }>({ windowReady: false, bridgeInjected: false })
  const [dsbBusy, setDsbBusy] = useState(false)
  const [dsbMsg, setDsbMsg] = useState('')
  const [dsbMsgOk, setDsbMsgOk] = useState(true)
  const [remote, setRemote] = useState<RemoteStatus | null>(null)
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [relay, setRelay] = useState<RelayStatus | null>(null)
  const [relayBusy, setRelayBusy] = useState(false)

  const loadDsb = useCallback(() => {
    void window.shanhai
      ?.getDeepSeekBridgeStatus()
      .then((s) => {
        if (s) setDsb(s)
      })
      .catch(() => undefined)
  }, [])

  const loadRemote = useCallback(() => {
    void window.shanhai
      ?.remoteStatus()
      .then((s) => {
        if (s) setRemote(s)
      })
      .catch(() => undefined)
  }, [])

  const toggleRemote = useCallback(async () => {
    setRemoteBusy(true)
    try {
      const s = remote?.enabled ? await window.shanhai?.remoteDisable() : await window.shanhai?.remoteEnable()
      if (s) setRemote(s)
    } catch (e) {
      console.error('[remote] 切换远程连接失败:', e)
    } finally {
      setRemoteBusy(false)
    }
  }, [remote?.enabled])

  const loadRelay = useCallback(() => {
    void window.shanhai
      ?.relayStatus()
      .then((s) => {
        if (s) setRelay(s)
      })
      .catch(() => undefined)
  }, [])

  const toggleRelay = useCallback(async () => {
    setRelayBusy(true)
    try {
      const s = relay?.enabled ? await window.shanhai?.relayDisable() : await window.shanhai?.relayEnable()
      if (s) setRelay(s)
    } catch (e) {
      console.error('[relay] 切换网关中继失败:', e)
    } finally {
      setRelayBusy(false)
    }
  }, [relay?.enabled])

  const openDsb = useCallback(async () => {
    setDsbBusy(true)
    setDsbMsg('')
    try {
      const r = await window.shanhai?.openDeepSeekBridge()
      setDsbMsg(r?.message ?? '')
      setDsbMsgOk(!!r?.ok)
      loadDsb()
    } catch (e) {
      setDsbMsg(e instanceof Error ? e.message : String(e))
      setDsbMsgOk(false)
    } finally {
      setDsbBusy(false)
    }
  }, [loadDsb])

  const injectDsb = useCallback(async () => {
    setDsbBusy(true)
    setDsbMsg('')
    try {
      const r = await window.shanhai?.injectDeepSeekBridge()
      setDsbMsg(r?.message ?? '')
      setDsbMsgOk(!!r?.ok)
      loadDsb()
    } catch (e) {
      setDsbMsg(e instanceof Error ? e.message : String(e))
      setDsbMsgOk(false)
    } finally {
      setDsbBusy(false)
    }
  }, [loadDsb])

  const loadHttpTraces = useCallback(() => {
    void window.shanhai?.getHttpTrace().then((t) => setHttpTraces(t ?? [])).catch(() => setHttpTraces([]))
  }, [])

  const load = useCallback(() => {
    void window.shanhai
      ?.getSettings()
      .then((s) => {
        if (s) setSettings(s)
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    loadDsb()
    loadRemote()
    loadRelay()
  }, [load, loadDsb, loadRemote, loadRelay])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const update = useCallback(
    async (patch: AppSettingsPatch): Promise<void> => {
      setSaving(true)
      try {
        const next = await window.shanhai?.setSettings(patch)
        if (next) setSettings(next)
      } catch {
        // 忽略保存失败，保留本地状态
      } finally {
        setSaving(false)
      }
    },
    [],
  )

  return (
    <div
      style={{
        ...(variant === 'window'
          ? { height: '100vh' }
          : { position: 'fixed', top, left, right: 0, bottom: 0, zIndex: 50, borderLeft: '1px solid var(--border)', boxShadow: '-20px 0 60px rgba(0,0,0,0.2)' }),
        background: 'var(--bg-panel)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <WindowTitleBar
        icon={<IconSettings />}
        title="设置"
        subtitle={saving ? '保存中…' : '更改自动保存到本地'}
        onClose={() => onClose?.()}
      />

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>加载中…</div>
          ) : (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '2px 0 8px', textTransform: 'uppercase', letterSpacing: 0.5, borderLeft: '3px solid var(--accent)', paddingLeft: 8 }}>
                浏览器
              </div>
              <ToggleRow
                label="创建窗口时直接显示"
                description="开启后，AI 打开内置浏览器窗口会立即弹出到前台；关闭后浏览器在后台静默运行，不打扰当前操作（仍可通过顶部标签或列表唤出）。"
                checked={settings.browser.showOnCreate}
                onChange={(v) => void update({ browser: { showOnCreate: v } })}
              />
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '18px 0 6px', textTransform: 'uppercase', letterSpacing: 0.5, borderLeft: '3px solid var(--accent)', paddingLeft: 8 }}>
                消息
              </div>
              <RadioGroup
                label="任务执行中发送消息"
                description="当一个任务正在执行时，继续发送新消息的处理方式。"
                value={settings.messageSubmit.mode}
                onChange={(v) => void update({ messageSubmit: { mode: v as 'queue' | 'insert' } })}
                options={[
                  { value: 'queue', label: '等待队列模式', desc: '新消息排队，当前任务完成后自动逐条执行，不打断当前任务。' },
                  { value: 'insert', label: '插入模式', desc: '不打断当前任务，把新消息注入正在执行的任务，在下一步模型调用前追加到上下文（多条都会插入，不丢失）。' },
                ]}
              />
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '18px 0 6px', textTransform: 'uppercase', letterSpacing: 0.5, borderLeft: '3px solid var(--accent)', paddingLeft: 8 }}>
                语音
              </div>
              <ToggleRow
                label="任务完成自动播报"
                description="开启后，每次任务执行完、输出正文时会用系统语音（macOS say）朗读结果，同时聊天窗口显示 3D AI 特效（超长正文截断到约 500 字）。默认开启。"
                checked={settings.voice.enabled}
                onChange={(v) => void update({ voice: { enabled: v } })}
              />
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '18px 0 6px', textTransform: 'uppercase', letterSpacing: 0.5, borderLeft: '3px solid var(--accent)', paddingLeft: 8 }}>
                管家
              </div>
              <ToggleRow
                label="管家接管审批"
                description="开启后，会话管家下发的任务触发的授权确认，由管家代替你决策（管家决策后弹窗自动关闭）；你自己发起的任务仍由你手动点击授权，弹窗始终显示、你始终可以手动点。默认关闭。"
                checked={settings.supervisorApproval.enabled}
                onChange={(v) => void update({ supervisorApproval: { enabled: v } })}
              />
              <ToggleRow
                label="管家接管提问"
                description="开启后，会话管家下发的任务里会话发起的提问（ask_user），由管家代替你回答（管家代答后弹窗自动关闭）；你自己发起的任务仍由你手动回答，弹窗始终显示、你始终可以手动点。默认关闭。"
                checked={settings.supervisorAsk.enabled}
                onChange={(v) => void update({ supervisorAsk: { enabled: v } })}
              />
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '18px 0 6px', textTransform: 'uppercase', letterSpacing: 0.5, borderLeft: '3px solid var(--accent)', paddingLeft: 8 }}>
                DeepSeek 网页版
              </div>
              <ToggleRow
                label="开启网页版桥接"
                description="关闭后不注册「DeepSeek 网页版」模型，也不再为每个会话预创建默认浏览器窗口；仅当 agent 用到浏览器工具时才按需创建窗口。"
                checked={settings.browser.enableWebBridge}
                onChange={(v) => void update({ browser: { enableWebBridge: v } })}
              />
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: '4px 0 8px' }}>
                复用已登录的 DeepSeek 网页版作为免费模型来源：在模型下拉框选「DeepSeek 网页版」发消息时，自动创建/复用专用浏览器窗口，通过 CDP 直连页面完成对话（无需本地端口）。
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
                <span>窗口：{dsb.windowReady ? '已创建' : '未创建'}</span>
                <span>桥接：{dsb.bridgeInjected ? '已注入' : '未注入'}</span>
              </div>
              <div style={{ padding: '8px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  onClick={() => void openDsb()}
                  disabled={dsbBusy}
                  style={{ ...smallIconBtn, padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                >
                  {dsbBusy ? '处理中…' : '打开并注入桥接'}
                </button>
                <button
                  onClick={() => void injectDsb()}
                  disabled={dsbBusy}
                  style={{ ...smallIconBtn, padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                >
                  重新注入
                </button>
              </div>
              {dsbMsg ? (
                <div style={{ fontSize: 12, color: dsbMsgOk ? 'var(--success-text)' : 'var(--danger-text)', margin: '2px 0 8px', lineHeight: 1.5, wordBreak: 'break-all' }}>
                  {dsbMsg}
                </div>
              ) : null}
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '18px 0 6px', textTransform: 'uppercase', letterSpacing: 0.5, borderLeft: '3px solid var(--accent)', paddingLeft: 8 }}>
                远程连接
              </div>
              <ToggleRow
                label="开启手机端远程控制"
                description="开启后，桌面端在本机局域网起一个配对码鉴权的 WebSocket 服务，手机 App 连同一 WiFi、输入配对码即可远程查看/控制会话。数据不出局域网。"
                checked={!!remote?.enabled}
                onChange={() => {
                  if (!remoteBusy) void toggleRemote()
                }}
              />
              {remote?.enabled ? (
                <div style={{ padding: '8px 0', fontSize: 12, lineHeight: 1.9, color: 'var(--text-secondary)' }}>
                  <div>
                    本机地址：<span style={{ fontWeight: 600, color: 'var(--text)' }}>{remote.ip}:{remote.port}</span>
                  </div>
                  <div>
                    配对码：<span style={{ fontWeight: 700, fontSize: 16, letterSpacing: 3, color: 'var(--purple)' }}>{remote.pairingCode}</span>
                  </div>
                  <div style={{ color: 'var(--text-muted)' }}>已连接设备：{remote.pairedClients} 台（配对码 5 分钟内有效）</div>
                  <div style={{ color: 'var(--text-faint)' }}>在手机 App 里输入上述地址和配对码即可连接。</div>
                </div>
              ) : null}
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '18px 0 6px', textTransform: 'uppercase', letterSpacing: 0.5, borderLeft: '3px solid var(--accent)', paddingLeft: 8 }}>
                远程连接（外网）
              </div>
              <ToggleRow
                label="开启网关中继（外网可访问）"
                description="开启后，桌面端作为 Host 连网关中继服务，手机 App 用同一会员账号登录即可在外网远程查看/控制会话（无需同一 WiFi）。需先登录会员账号。"
                checked={!!relay?.enabled}
                onChange={() => {
                  if (!relayBusy) void toggleRelay()
                }}
              />
              {relay?.enabled ? (
                <div style={{ padding: '8px 0', fontSize: 12, lineHeight: 1.9, color: 'var(--text-secondary)' }}>
                  <div>
                    连接状态：<span style={{ fontWeight: 600, color: relay.connected ? 'var(--success-text)' : 'var(--danger-text)' }}>{relay.connected ? '已连接网关' : '未连接（需登录会员账号）'}</span>
                  </div>
                  <div>账号：{relay.username ?? '未登录'}</div>
                  <div>已连接手机：{relay.clientCount} 台</div>
                  <div style={{ color: 'var(--text-faint)' }}>手机 App 用同一会员账号登录后即可自动配对连接，无需配对码。</div>
                </div>
              ) : null}
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '18px 0 6px', textTransform: 'uppercase', letterSpacing: 0.5, borderLeft: '3px solid var(--accent)', paddingLeft: 8 }}>
                调试
              </div>
              <ToggleRow
                label="记录 LLM 请求/响应"
                description="开启后，每次调用大模型都会把【接口地址 + 完整原始请求 body + 完整原始响应 body】拆成请求一条、响应一条，追加记录到 ~/.shanhai/traces/<会话id>.http.log（每会话一个文件，会话隔离），用于排查问题。默认关闭，记录会占用磁盘。"
                checked={settings.debug.traceLlm}
                onChange={(v) => void update({ debug: { traceLlm: v } })}
              />
              <div style={{ padding: '10px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  onClick={() => {
                    setShowHttpTraces((s) => !s)
                    if (!showHttpTraces) loadHttpTraces()
                  }}
                  style={{ ...smallIconBtn, padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                >
                  {showHttpTraces ? '收起日志' : '查看原始请求/响应日志'}
                </button>
                <button
                  onClick={() => {
                    void window.shanhai?.clearHttpTrace().then(() => setHttpTraces([]))
                  }}
                  style={{ ...smallIconBtn, padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                >
                  清空日志
                </button>
                <button
                  onClick={() => {
                    void window.shanhai?.openTraceDir()
                  }}
                  style={{ ...smallIconBtn, padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                >
                  打开日志目录
                </button>
              </div>
              {showHttpTraces && (
                <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8, marginTop: 4 }}>
                  {httpTraces.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-faint)', textAlign: 'center', padding: 16 }}>暂无记录（需先开启上方开关并运行任务）</div>
                  ) : (
                    httpTraces.map((t, i) => (
                      <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-secondary)' }}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <span style={{ color: 'var(--text-muted)' }}>#{i + 1}</span>
                          <span style={{ fontWeight: 600, color: t.phase === 'request' ? 'var(--accent)' : 'var(--success-text)' }}>{t.phase === 'request' ? '请求' : '响应'}</span>
                          <span style={{ color: 'var(--text-muted)' }}>{t.model}</span>
                          <span style={{ color: 'var(--text-muted)' }}>{new Date(t.ts).toLocaleTimeString()}</span>
                          {t.responseStatus != null && <span style={{ color: 'var(--text-muted)' }}>HTTP {t.responseStatus}</span>}
                          {t.error ? <span style={{ color: 'var(--danger-text)' }}>错误</span> : null}
                        </div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 11, wordBreak: 'break-all', marginTop: 2 }}>{t.method} {t.url}</div>
                        {t.error ? (
                          <div style={{ color: 'var(--danger-text)', marginTop: 2, wordBreak: 'break-all' }}>{t.error}</div>
                        ) : (
                          <details style={{ marginTop: 2 }}>
                            <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11 }}>完整 body</summary>
                            <pre style={{ margin: '4px 0 0', padding: 6, background: 'var(--bg-sidebar)', borderRadius: 4, overflowX: 'auto', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                              {typeof t.body === 'string' ? t.body : JSON.stringify(t.body ?? null, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </div>
    </div>
  )
}
