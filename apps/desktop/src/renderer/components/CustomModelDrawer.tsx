import { useEffect, useState } from 'react'
import type { GatewayModel } from '../types'
import { IconPlus, IconWrench } from './icons'
import { WindowTitleBar } from './WindowTitleBar'

/** 模型协议 */
type ModelProtocol = 'openai' | 'anthropic'

/** 预置服务商（快捷填充 baseUrl / 模型列表 / 协议），用户也可完全手动填写 */
const MODEL_PROVIDERS: Array<{ id: string; name: string; protocol: ModelProtocol; baseUrl: string; models: string[] }> = [
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.1', 'gpt-5.1-mini', 'gpt-5.1-nano'] },
  { id: 'qwen', name: '通义千问 Qwen', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3.5-max', 'qwen3.5-plus', 'qwen3.5-turbo', 'qwen3.5-flash'] },
  { id: 'kimi', name: 'Kimi (Moonshot)', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k3', 'kimi-k3-thinking'] },
  { id: 'glm', name: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5.3', 'glm-5-turbo', 'glm-5.2'] },
  { id: 'minimax', name: 'MiniMax', protocol: 'openai', baseUrl: 'https://api.minimax.chat/v1', models: ['MiniMax-M3', 'MiniMax-M2'] },
  { id: 'anthropic', name: 'Anthropic (Claude)', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'] },
  { id: 'xiaomi', name: '小米 MiMo', protocol: 'openai', baseUrl: 'https://api.xiaomimimo.com/v1', models: ['mimo-v2.5-pro', 'mimo-v2.5'] },
]

/** 根据 baseUrl 反查服务商（编辑已配置模型时回填下拉）；匹配不到返回 undefined */
function inferProvider(baseUrl: string): (typeof MODEL_PROVIDERS)[number] | undefined {
  const norm = (s: string) => s.replace(/\/+$/, '').toLowerCase()
  return MODEL_PROVIDERS.find((p) => norm(p.baseUrl) === norm(baseUrl))
}

function Field({ label, value, onChange, placeholder, password }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; password?: boolean }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={password ? 'password' : 'text'}
        placeholder={placeholder}
        style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 13, boxSizing: 'border-box', outline: 'none' }}
      />
    </div>
  )
}

export function CustomModelDrawer(props: {
  models: GatewayModel[]
  onClose?: () => void
  onAdd: (m: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: ModelProtocol }) => Promise<void>
  onUpdate: (id: string, m: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: ModelProtocol }) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onSelect: (id: string) => void
  variant?: 'panel' | 'window'
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [protocol, setProtocol] = useState<ModelProtocol>('openai')
  const [providerId, setProviderId] = useState('')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [customModel, setCustomModel] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  /** 当前协议下的预置服务商 */
  const providersOfProtocol = MODEL_PROVIDERS.filter((p) => p.protocol === protocol)

  // 打开时默认选中第一个已配置模型，右侧立即有内容
  useEffect(() => {
    const first = props.models[0]
    if (!first) return
    setEditingId(first.id)
    const proto = first.protocol ?? 'openai'
    setProtocol(proto)
    setName(first.name)
    setBaseUrl(first.baseUrl)
    setApiKey(first.apiKey)
    setModel(first.model ?? first.id)
    setProviderId(inferProvider(first.baseUrl)?.id ?? '')
    setCustomModel(!inferProvider(first.baseUrl)?.models.includes(first.model ?? first.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openAdd(): void {
    setEditingId(null)
    selectProtocol('openai')
    setApiKey('')
    setErr('')
  }

  function openEdit(m: GatewayModel): void {
    setEditingId(m.id)
    const proto = m.protocol ?? 'openai'
    setProtocol(proto)
    setName(m.name)
    setBaseUrl(m.baseUrl)
    setApiKey(m.apiKey)
    setModel(m.model ?? m.id)
    const p = inferProvider(m.baseUrl)
    setProviderId(p?.id ?? '')
    setCustomModel(!p || !p.models.includes(m.model ?? m.id))
    setErr('')
  }

  /** 切换协议：重置为该协议第一个预置服务商的默认 baseUrl / 模型 */
  function selectProtocol(p: ModelProtocol): void {
    setProtocol(p)
    const first = MODEL_PROVIDERS.find((x) => x.protocol === p)
    if (first) {
      setProviderId(first.id)
      setName(first.name)
      setBaseUrl(first.baseUrl)
      setModel(first.models[0] ?? '')
      setCustomModel(false)
    } else {
      setProviderId('')
      setName('')
      setBaseUrl(p === 'anthropic' ? 'https://api.anthropic.com' : '')
      setModel('')
      setCustomModel(true)
    }
    setErr('')
  }

  function selectProvider(id: string): void {
    const p = MODEL_PROVIDERS.find((x) => x.id === id)
    if (!p) return
    setProviderId(id)
    setProtocol(p.protocol)
    setName(p.name)
    setBaseUrl(p.baseUrl)
    setModel(p.models[0] ?? '')
    setCustomModel(false)
    setErr('')
  }

  async function submit(): Promise<void> {
    const finalName = name.trim() || MODEL_PROVIDERS.find((p) => p.id === providerId)?.name || '自定义模型'
    if (!baseUrl.trim() || !apiKey.trim() || !model.trim()) {
      setErr('请填写接口地址、API Key 与模型名')
      return
    }
    setLoading(true)
    setErr('')
    try {
      if (editingId) await props.onUpdate(editingId, { name: finalName, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim(), protocol })
      else await props.onAdd({ name: finalName, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim(), protocol })
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }

  async function remove(): Promise<void> {
    if (!editingId) return
    await props.onRemove(editingId)
    openAdd()
  }

  function useModel(): void {
    if (!editingId) return
    props.onSelect(editingId)
    props.onClose?.()
  }

  return (
    <div
      onClick={() => props.onClose?.()}
      style={
        props.variant === 'window'
          ? { height: '100vh', background: 'var(--bg-panel)', fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }
          : { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 110, fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }
      }
    >
      {/* 全屏弹窗：左右排版 */}
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', height: '100%', background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column' }}>
        <WindowTitleBar icon={<IconWrench />} title="自定义模型" onClose={() => props.onClose?.()} />

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* 左侧：已配置模型列表 */}
          <aside style={{ width: 280, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--bg-sidebar)' }}>
            <div style={{ padding: '12px 12px 8px', fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>已配置模型</div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
              {props.models.length === 0 ? (
                <div style={{ padding: '40px 12px', textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>
                  还没有自定义模型
                  <br />
                  点击下方按钮新增
                </div>
              ) : (
                props.models.map((m) => (
                  <div
                    key={m.id}
                    onClick={() => openEdit(m)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      marginBottom: 6,
                      cursor: 'pointer',
                      background: editingId === m.id ? 'var(--tint-blue)' : 'var(--bg-panel)',
                      border: editingId === m.id ? '1px solid var(--accent)' : '1px solid var(--border)',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                      {m.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'} · {m.model ?? m.id}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.baseUrl}</div>
                  </div>
                ))
              )}
            </div>
            <div style={{ padding: '12px', borderTop: '1px solid var(--border)' }}>
              <button onClick={openAdd} style={{ width: '100%', padding: '10px', borderRadius: 8, border: '1px dashed var(--border-strong)', background: 'var(--bg-panel)', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                <IconPlus /> 新增自定义模型
              </button>
            </div>
          </aside>

          {/* 右侧：选中模型的配置编辑区域 */}
          <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 16 }}>
              {editingId ? '编辑自定义模型' : '新增自定义模型'}
            </div>

            {/* 协议选择 */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>协议</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {(
                  [
                    { value: 'openai', label: 'OpenAI 兼容', desc: 'DeepSeek / Qwen / GLM 等' },
                    { value: 'anthropic', label: 'Anthropic', desc: 'Claude 原生协议' },
                  ] as Array<{ value: ModelProtocol; label: string; desc: string }>
                ).map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => selectProtocol(opt.value)}
                    style={{
                      flex: 1,
                      padding: '10px 12px',
                      borderRadius: 8,
                      border: protocol === opt.value ? '1px solid var(--accent)' : '1px solid var(--border-strong)',
                      background: protocol === opt.value ? 'var(--tint-blue)' : 'var(--bg-panel)',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: protocol === opt.value ? 'var(--accent)' : 'var(--text)' }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>服务商（快捷填充，可选）</div>
              <select
                value={providerId}
                onChange={(e) => selectProvider(e.target.value)}
                style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 13, boxSizing: 'border-box', outline: 'none', background: 'var(--bg-panel)' }}
              >
                <option value="">自定义端点</option>
                {providersOfProtocol.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <Field label="名称" value={name} onChange={setName} placeholder="例如：我的 Claude" />
            <Field label="接口地址 (Base URL)" value={baseUrl} onChange={setBaseUrl} placeholder={protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.example.com/v1'} />

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>模型</div>
              <select
                value={customModel ? '__custom__' : model}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '__custom__') {
                    setCustomModel(true)
                    return
                  }
                  setCustomModel(false)
                  setModel(v)
                }}
                style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 13, boxSizing: 'border-box', outline: 'none', background: 'var(--bg-panel)', marginBottom: 6 }}
              >
                {(MODEL_PROVIDERS.find((p) => p.id === providerId)?.models ?? [model]).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="__custom__">其他（自定义）…</option>
              </select>
              {customModel && (
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={protocol === 'anthropic' ? '输入模型名，如 claude-3-5-sonnet-20241022' : '输入模型名，如 gpt-4o'}
                  style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 13, boxSizing: 'border-box', outline: 'none' }}
                />
              )}
            </div>
            <Field label="API Key" value={apiKey} onChange={setApiKey} placeholder={protocol === 'anthropic' ? 'sk-ant-...' : 'sk-...'} password />
            {err && <p style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8, wordBreak: 'break-word' }}>{err}</p>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => void submit()} disabled={loading} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>
                {loading ? '保存中…' : '保存'}
              </button>
              {editingId && (
                <>
                  <button onClick={useModel} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid var(--accent)', background: 'var(--bg-panel)', color: 'var(--accent)', fontSize: 14, cursor: 'pointer' }}>
                    使用此模型
                  </button>
                  <button onClick={() => void remove()} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid var(--tint-red-strong)', background: 'var(--bg-panel)', color: 'var(--danger)', fontSize: 14, cursor: 'pointer' }}>
                    删除
                  </button>
                </>
              )}
              <button onClick={() => props.onClose?.()} style={{ marginLeft: 'auto', padding: '10px 16px', borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 14, cursor: 'pointer' }}>
                关闭
              </button>
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
