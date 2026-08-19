import { useEffect, useState } from 'react'
import type { GatewayModel } from '../types'
import { IconClose, IconPlus } from './icons'

/** 预置服务商（OpenAI 兼容端点）：用户只需选服务商 + 填密钥，baseUrl/模型由服务商预设 */
const MODEL_PROVIDERS: Array<{ id: string; name: string; baseUrl: string; models: string[] }> = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'] },
  { id: 'qwen', name: '通义千问 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'] },
  { id: 'kimi', name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2'] },
  { id: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'] },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', models: ['abab6.5s-chat', 'MiniMax-Text-01'] },
]

/** 根据 baseUrl 反查服务商（编辑已配置模型时回填下拉）；匹配不到返回 undefined */
function inferProvider(baseUrl: string): (typeof MODEL_PROVIDERS)[number] | undefined {
  const norm = (s: string) => s.replace(/\/+$/, '').toLowerCase()
  return MODEL_PROVIDERS.find((p) => norm(p.baseUrl) === norm(baseUrl))
}

function Field({ label, value, onChange, placeholder, password }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; password?: boolean }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={password ? 'password' : 'text'}
        placeholder={placeholder}
        style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid #ddd', fontSize: 13, boxSizing: 'border-box', outline: 'none' }}
      />
    </div>
  )
}

export function CustomModelDrawer(props: {
  models: GatewayModel[]
  onClose: () => void
  onAdd: (m: { name: string; baseUrl: string; apiKey: string; model: string }) => Promise<void>
  onUpdate: (id: string, m: { name: string; baseUrl: string; apiKey: string; model: string }) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onSelect: (id: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [providerId, setProviderId] = useState('')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [customModel, setCustomModel] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  // 打开时默认选中第一个已配置模型，右侧立即有内容
  useEffect(() => {
    const first = props.models[0]
    if (!first) return
    setEditingId(first.id)
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
    const p = MODEL_PROVIDERS[0]
    if (!p) return
    setProviderId(p.id)
    setName(p.name)
    setBaseUrl(p.baseUrl)
    setModel(p.models[0] ?? '')
    setCustomModel(false)
    setApiKey('')
    setErr('')
  }

  function openEdit(m: GatewayModel): void {
    setEditingId(m.id)
    setName(m.name)
    setBaseUrl(m.baseUrl)
    setApiKey(m.apiKey)
    setModel(m.model ?? m.id)
    const p = inferProvider(m.baseUrl)
    setProviderId(p?.id ?? '')
    setCustomModel(!p || !p.models.includes(m.model ?? m.id))
    setErr('')
  }

  function selectProvider(id: string): void {
    const p = MODEL_PROVIDERS.find((x) => x.id === id)
    if (!p) return
    setProviderId(id)
    setName(p.name)
    setBaseUrl(p.baseUrl)
    setModel(p.models[0] ?? '')
    setCustomModel(false)
    setErr('')
  }

  async function submit(): Promise<void> {
    const finalName = name.trim() || MODEL_PROVIDERS.find((p) => p.id === providerId)?.name || '自定义模型'
    if (!baseUrl || !apiKey.trim() || !model.trim()) {
      setErr('请选择服务商、填写 API Key 与模型')
      return
    }
    setLoading(true)
    setErr('')
    try {
      if (editingId) await props.onUpdate(editingId, { name: finalName, baseUrl, apiKey, model })
      else await props.onAdd({ name: finalName, baseUrl, apiKey, model })
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
    props.onClose()
  }

  return (
    <div onClick={props.onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 110, fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* 全屏弹窗：左右排版 */}
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', height: '100%', background: '#fff', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>自定义模型</div>
          <button onClick={props.onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#999', padding: 4, display: 'inline-flex' }}>
            <IconClose />
          </button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* 左侧：已配置模型列表 */}
          <aside style={{ width: 280, borderRight: '1px solid #eee', display: 'flex', flexDirection: 'column', background: '#fafafa' }}>
            <div style={{ padding: '12px 12px 8px', fontSize: 12, color: '#999', fontWeight: 600 }}>已配置模型</div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
              {props.models.length === 0 ? (
                <div style={{ padding: '40px 12px', textAlign: 'center', color: '#bbb', fontSize: 13 }}>
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
                      background: editingId === m.id ? '#e8f1ff' : '#fff',
                      border: editingId === m.id ? '1px solid #1677ff' : '1px solid #eee',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                    <div style={{ fontSize: 11, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                      model: {m.model ?? m.id}
                    </div>
                    <div style={{ fontSize: 11, color: '#bbb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.baseUrl}</div>
                  </div>
                ))
              )}
            </div>
            <div style={{ padding: '12px', borderTop: '1px solid #eee' }}>
              <button onClick={openAdd} style={{ width: '100%', padding: '10px', borderRadius: 8, border: '1px dashed #d9d9d9', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                <IconPlus /> 新增自定义模型
              </button>
            </div>
          </aside>

          {/* 右侧：选中模型的配置编辑区域 */}
          <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 16 }}>
              {editingId ? '编辑自定义模型' : '新增自定义模型'}
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>服务商</div>
              <select
                value={providerId}
                onChange={(e) => selectProvider(e.target.value)}
                style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid #ddd', fontSize: 13, boxSizing: 'border-box', outline: 'none', background: '#fff' }}
              >
                {!MODEL_PROVIDERS.some((p) => p.id === providerId) && <option value="">自定义端点</option>}
                {MODEL_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <Field label="名称" value={name} onChange={setName} placeholder="例如：我的 GPT-4o" />
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>模型</div>
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
                style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid #ddd', fontSize: 13, boxSizing: 'border-box', outline: 'none', background: '#fff', marginBottom: 6 }}
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
                  placeholder="输入模型名，如 gpt-4o"
                  style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid #ddd', fontSize: 13, boxSizing: 'border-box', outline: 'none' }}
                />
              )}
            </div>
            <Field label="API Key" value={apiKey} onChange={setApiKey} placeholder="sk-..." password />
            <div style={{ fontSize: 11, color: '#bbb', marginBottom: 12, wordBreak: 'break-all' }}>端点：{baseUrl || '（未选择服务商）'}</div>
            {err && <p style={{ color: '#ff4d4f', fontSize: 12, marginBottom: 8, wordBreak: 'break-word' }}>{err}</p>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => void submit()} disabled={loading} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#1677ff', color: '#fff', fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>
                {loading ? '保存中…' : '保存'}
              </button>
              {editingId && (
                <>
                  <button onClick={useModel} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #1677ff', background: '#fff', color: '#1677ff', fontSize: 14, cursor: 'pointer' }}>
                    使用此模型
                  </button>
                  <button onClick={() => void remove()} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #ffccc7', background: '#fff', color: '#ff4d4f', fontSize: 14, cursor: 'pointer' }}>
                    删除
                  </button>
                </>
              )}
              <button onClick={props.onClose} style={{ marginLeft: 'auto', padding: '10px 16px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', color: '#555', fontSize: 14, cursor: 'pointer' }}>
                关闭
              </button>
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
