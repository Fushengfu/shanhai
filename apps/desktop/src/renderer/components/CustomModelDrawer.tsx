import { useEffect, useRef, useState } from 'react'
import type { GatewayModel } from '../types'
import { IconPlus, IconWrench, IconCheck, IconWarn, IconTrash, IconChevronDown } from './icons'
import { WindowTitleBar } from './WindowTitleBar'

/** 模型协议 */
type ModelProtocol = 'openai' | 'anthropic'

/** 下拉选项结构（badge 为选项前的小标识字符） */
type SelectOption = { value: string; label: string; hint?: string; badge?: string }

/** 预置服务商（快捷填充 baseUrl / 模型列表 / 协议 / 默认上下文长度），用户也可完全手动填写 */
const MODEL_PROVIDERS: Array<{ id: string; name: string; badge: string; protocol: ModelProtocol; baseUrl: string; models: string[]; contextLength?: number }> = [
  { id: 'deepseek', name: 'DeepSeek', badge: 'D', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'], contextLength: 1000000 },
  { id: 'openai', name: 'OpenAI', badge: 'O', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.1', 'gpt-5.1-mini', 'gpt-5.1-nano'], contextLength: 200000 },
  { id: 'qwen', name: '通义千问 Qwen', badge: 'Q', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3.5-max', 'qwen3.5-plus', 'qwen3.5-turbo', 'qwen3.5-flash'], contextLength: 131072 },
  { id: 'kimi', name: 'Kimi (Moonshot)', badge: 'K', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k3', 'kimi-k3-thinking'], contextLength: 1000000 },
  { id: 'glm', name: '智谱 GLM', badge: 'G', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5.3', 'glm-5-turbo', 'glm-5.2'], contextLength: 1000000 },
  { id: 'minimax', name: 'MiniMax', badge: 'M', protocol: 'openai', baseUrl: 'https://api.minimax.chat/v1', models: ['MiniMax-M3', 'MiniMax-M2'], contextLength: 245760 },
  { id: 'anthropic', name: 'Anthropic (Claude)', badge: 'A', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'], contextLength: 200000 },
  { id: 'xiaomi', name: '小米 MiMo', badge: 'M', protocol: 'openai', baseUrl: 'https://api.xiaomimimo.com/v1', models: ['mimo-v2.5-pro', 'mimo-v2.5'], contextLength: 1000000 },
]

/** 自定义端点（不属于任何预置服务商）的默认 providerId */
const CUSTOM_PROVIDER_ID = 'custom'

/** 协议下拉选项 */
const PROTOCOL_OPTIONS: SelectOption[] = [
  { value: 'openai', label: 'OpenAI 兼容', hint: 'DeepSeek / Qwen / GLM 等', badge: 'AI' },
  { value: 'anthropic', label: 'Anthropic', hint: 'Claude 原生协议', badge: 'AN' },
]

/** 上下文长度上限（token 数，防止误填超大值导致上下文预算计算异常） */
const MAX_CONTEXT_LENGTH = 2_000_000

/** 根据 baseUrl 反查服务商（编辑已配置模型时回填下拉）；匹配不到返回 undefined */
function inferProvider(baseUrl: string): (typeof MODEL_PROVIDERS)[number] | undefined {
  const norm = (s: string) => s.replace(/\/+$/, '').toLowerCase()
  return MODEL_PROVIDERS.find((p) => norm(p.baseUrl) === norm(baseUrl))
}

/** 眼睛图标（睁眼/闭眼），内联 SVG，不引入额外依赖 */
function IconEye(props: { closed?: boolean; size?: number }) {
  const s = props.size ?? 16
  if (props.closed) {
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
        <line x1="2" x2="22" y1="2" y2="22" />
      </svg>
    )
  }
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

/**
 * 模型配置抽屉的局部样式（scoped 前缀 cm-）。
 * 全部使用 theme.css 里的语义变量，明暗主题自动适配；hover / focus / transition 等
 * 内联 style 无法表达的交互动效在这里统一定义。
 */
const CSS = `
.cm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.44);z-index:110;font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;display:flex;align-items:center;justify-content:center}
.cm-shell{width:100%;height:100%;background:var(--bg-panel);display:flex;flex-direction:column;color:var(--text)}
.cm-body{flex:1;display:flex;min-height:0;min-width:0}
.cm-sidebar{width:300px;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--bg-sidebar);flex-shrink:0}
.cm-sidebar-head{padding:14px 16px 8px;font-size:12px;color:var(--text-muted);font-weight:600;letter-spacing:.3px}
.cm-sidebar-list{flex:1;overflow-y:auto;padding:0 12px 12px}
.cm-list-item{position:relative;padding:12px 13px;padding-right:38px;border-radius:10px;margin-bottom:6px;cursor:pointer;background:var(--bg-panel);border:1px solid var(--border);transition:border-color .15s ease,box-shadow .15s ease,background .15s ease}
.cm-list-item:hover{border-color:var(--border-heavy);box-shadow:0 2px 8px rgba(0,0,0,.05)}
.cm-list-item.active{border-color:var(--accent);background:var(--tint-blue-soft);box-shadow:0 2px 10px rgba(22,119,255,.12)}
.cm-list-name{font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-list-meta{font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px;display:flex;align-items:center;gap:5px}
.cm-list-url{font-size:11px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}
.cm-badge{flex-shrink:0;font-size:10px;font-weight:600;padding:1px 6px;border-radius:99px;background:var(--tint-blue);color:var(--accent);line-height:1.6}
.cm-list-del{position:absolute;top:9px;right:9px;width:26px;height:26px;border-radius:7px;border:none;background:transparent;color:var(--text-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.55;transition:all .15s ease}
.cm-list-item:hover .cm-list-del{opacity:1}
.cm-list-del:hover{background:var(--tint-red);color:var(--danger)}
.cm-sidebar-foot{padding:12px;border-top:1px solid var(--border)}
.cm-add-btn{width:100%;padding:11px;border-radius:10px;border:1px dashed var(--border-strong);background:var(--bg-panel);cursor:pointer;font-size:13px;color:var(--text-secondary);display:flex;align-items:center;justify-content:center;gap:5px;transition:all .15s ease}
.cm-add-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--tint-blue-soft)}
.cm-main{flex:1;overflow-y:auto;padding:28px 36px 36px;min-width:0;max-width:720px}
.cm-title{font-size:17px;font-weight:700;color:var(--text);margin-bottom:4px}
.cm-subtitle{font-size:12px;color:var(--text-muted);margin-bottom:26px}
.cm-group{margin-bottom:26px}
.cm-group-title{font-size:12px;font-weight:600;color:var(--text-muted);letter-spacing:.4px;margin-bottom:14px;display:flex;align-items:center;gap:10px}
.cm-group-title::after{content:'';flex:1;height:1px;background:var(--border-soft)}
.cm-field{margin-bottom:16px}
.cm-field:last-child{margin-bottom:0}
.cm-field-label{font-size:12px;color:var(--text-secondary);margin-bottom:7px;font-weight:500}
.cm-field-hint{font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.6}
.cm-input{width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--border-strong);font-size:13px;box-sizing:border-box;outline:none;background:var(--bg-input);color:var(--text);transition:border-color .15s ease,box-shadow .15s ease}
.cm-input:hover{border-color:var(--border-heavy)}
.cm-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--tint-blue)}
.cm-input::placeholder{color:var(--text-faint)}
.cm-select-wrap{position:relative}
.cm-select{width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--border-strong);font-size:13px;box-sizing:border-box;background:var(--bg-input);color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;transition:border-color .15s ease,box-shadow .15s ease}
.cm-select:hover{border-color:var(--border-heavy)}
.cm-select:focus-visible{border-color:var(--accent);box-shadow:0 0 0 3px var(--tint-blue);outline:none}
.cm-select-value{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:7px}
.cm-select-chevron{color:var(--text-muted);display:flex;flex-shrink:0;transition:transform .15s ease}
.cm-select-chevron.open{transform:rotate(180deg)}
.cm-select-panel{z-index:999;background:var(--bg-panel);border:1px solid var(--border-strong);border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.18);padding:5px;max-height:300px;overflow-y:auto;animation:cmPopIn .14s ease}
.cm-select-option{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:7px;cursor:pointer;font-size:13px;color:var(--text);transition:background .12s ease}
.cm-select-option:hover{background:var(--bg-hover)}
.cm-select-option.active{background:var(--tint-blue-soft);color:var(--accent)}
.cm-option-badge{width:22px;height:22px;border-radius:6px;background:var(--tint-blue);color:var(--accent);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;letter-spacing:.2px}
.cm-select-option.active .cm-option-badge{background:var(--accent);color:#fff}
.cm-select-option-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-select-option-hint{font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%;flex-shrink:0}
.cm-select-option-check{color:var(--accent);display:flex;flex-shrink:0}
.cm-password-wrap{position:relative}
.cm-eye-btn{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:30px;height:30px;border-radius:7px;border:none;background:transparent;color:var(--text-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s ease}
.cm-eye-btn:hover{background:var(--bg-hover);color:var(--text)}
.cm-checkbox-row{display:flex;align-items:center;gap:9px;cursor:pointer;font-size:13px;color:var(--text);user-select:none}
.cm-checkbox{width:17px;height:17px;cursor:pointer;accent-color:var(--accent)}
.cm-link{background:none;border:none;padding:0;color:var(--accent);font-size:11px;cursor:pointer;flex-shrink:0}
.cm-link:hover{text-decoration:underline}
.cm-error{display:flex;align-items:flex-start;gap:7px;color:var(--danger-text);background:var(--tint-red);border:1px solid var(--tint-red-strong);font-size:12px;padding:9px 12px;border-radius:8px;margin-bottom:14px;line-height:1.5;word-break:break-word}
.cm-success{display:flex;align-items:center;gap:7px;color:var(--success-text);background:var(--tint-green);border:1px solid var(--success);font-size:12px;padding:9px 12px;border-radius:8px;margin-bottom:14px;line-height:1.5}
.cm-actions{display:flex;gap:9px;align-items:center;margin-top:8px}
.cm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 20px;border-radius:9px;border:none;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s ease}
.cm-btn:active{transform:translateY(1px)}
.cm-btn:disabled{cursor:not-allowed;opacity:.55}
.cm-btn-primary{background:var(--accent);color:#fff;box-shadow:0 1px 3px rgba(22,119,255,.3)}
.cm-btn-primary:hover:not(:disabled){background:var(--accent-strong)}
.cm-btn-outline{background:var(--bg-panel);color:var(--accent);border:1px solid var(--accent)}
.cm-btn-outline:hover{background:var(--tint-blue-soft)}
.cm-btn-danger{background:var(--bg-panel);color:var(--danger);border:1px solid var(--tint-red-strong)}
.cm-btn-danger:hover{background:var(--tint-red);border-color:var(--danger)}
.cm-btn-ghost{background:var(--bg-panel);color:var(--text-secondary);border:1px solid var(--border-strong)}
.cm-btn-ghost:hover{border-color:var(--border-heavy);color:var(--text)}
.cm-empty{padding:44px 16px;text-align:center;color:var(--text-faint);font-size:13px;line-height:1.7}
.cm-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:300;display:flex;align-items:center;justify-content:center;animation:cmPopIn .15s ease}
.cm-modal{background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.28);padding:20px;width:340px;max-width:90vw}
.cm-modal-title{font-size:15px;font-weight:700;color:var(--text);margin-bottom:8px}
.cm-modal-body{font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:18px;word-break:break-word}
.cm-modal-actions{display:flex;justify-content:flex-end;gap:9px}
@keyframes cmPopIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
`

/** 自定义下拉：统一风格、固定定位面板（不受滚动容器裁剪）、点击外部关闭、明暗适配 */
function CustomSelect(props: { value: string; options: SelectOption[]; onChange: (v: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, left: r.left, width: r.width })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onScroll = (): void => setOpen(false)
    const onResize = (): void => setOpen(false)
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const current = props.options.find((o) => o.value === props.value)

  return (
    <div className="cm-select-wrap">
      <button ref={btnRef} type="button" className="cm-select" onClick={toggle}>
        <span className="cm-select-value">
          {current?.badge && <span className="cm-option-badge">{current.badge}</span>}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current ? current.label : (props.placeholder ?? '请选择')}</span>
        </span>
        <span className={`cm-select-chevron${open ? ' open' : ''}`}>
          <IconChevronDown />
        </span>
      </button>
      {open && pos && (
        <div ref={panelRef} className="cm-select-panel" style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}>
          {props.options.map((o) => (
            <div
              key={o.value}
              className={`cm-select-option${o.value === props.value ? ' active' : ''}`}
              onClick={() => {
                props.onChange(o.value)
                setOpen(false)
              }}
            >
              {o.badge && <span className="cm-option-badge">{o.badge}</span>}
              <span className="cm-select-option-label">{o.label}</span>
              {o.hint && <span className="cm-select-option-hint">{o.hint}</span>}
              {o.value === props.value && (
                <span className="cm-select-option-check">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Field(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string; password?: boolean }) {
  const [reveal, setReveal] = useState(false)
  return (
    <div className="cm-field">
      <div className="cm-field-label">{props.label}</div>
      {props.password ? (
        <div className="cm-password-wrap">
          <input
            className="cm-input"
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            type={reveal ? 'text' : 'password'}
            placeholder={props.placeholder}
            style={{ paddingRight: 44 }}
          />
          <button type="button" className="cm-eye-btn" onClick={() => setReveal((r) => !r)} title={reveal ? '隐藏' : '显示'} aria-label={reveal ? '隐藏 API Key' : '显示 API Key'}>
            <IconEye closed={!reveal} />
          </button>
        </div>
      ) : (
        <input className="cm-input" value={props.value} onChange={(e) => props.onChange(e.target.value)} placeholder={props.placeholder} />
      )}
      {props.hint && <div className="cm-field-hint">{props.hint}</div>}
    </div>
  )
}

export function CustomModelDrawer(props: {
  models: GatewayModel[]
  onClose?: () => void
  onAdd: (m: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: ModelProtocol; contextLength?: number; supportsVision?: boolean }) => Promise<void>
  onUpdate: (id: string, m: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: ModelProtocol; contextLength?: number; supportsVision?: boolean }) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onSelect: (id: string) => void
  variant?: 'panel' | 'window'
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [protocol, setProtocol] = useState<ModelProtocol>('openai')
  const [providerId, setProviderId] = useState(CUSTOM_PROVIDER_ID)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [customModel, setCustomModel] = useState(false)
  const [supportsVision, setSupportsVision] = useState(false)
  const [contextLength, setContextLength] = useState('')
  const [err, setErr] = useState('')
  const [savedMsg, setSavedMsg] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  /** 当前协议下的预置服务商 */
  const providersOfProtocol = MODEL_PROVIDERS.filter((p) => p.protocol === protocol)
  /** 服务商下拉选项（预置 + 自定义端点） */
  const providerOptions: SelectOption[] = [
    ...providersOfProtocol.map((p) => ({ value: p.id, label: p.name, hint: p.baseUrl, badge: p.badge })),
    { value: CUSTOM_PROVIDER_ID, label: '自定义端点', hint: '手动填写接口地址与模型', badge: '自' },
  ]
  /** 模型下拉选项（当前服务商的预置模型 + 其他自定义） */
  const modelOptions: SelectOption[] = [
    ...(MODEL_PROVIDERS.find((p) => p.id === providerId)?.models ?? []).map((m) => ({ value: m, label: m })),
    { value: '__custom__', label: '其他（自定义）…', badge: '+' },
  ]

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
    setProviderId(inferProvider(first.baseUrl)?.id ?? CUSTOM_PROVIDER_ID)
    setCustomModel(!inferProvider(first.baseUrl)?.models.includes(first.model ?? first.id))
    setSupportsVision(!!first.supportsVision)
    setContextLength(first.contextLength ? String(first.contextLength) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openAdd(): void {
    setEditingId(null)
    selectProtocol('openai')
    setApiKey('')
    setSupportsVision(false)
    setErr('')
    setSavedMsg('')
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
    setProviderId(p?.id ?? CUSTOM_PROVIDER_ID)
    setCustomModel(!p || !p.models.includes(m.model ?? m.id))
    setSupportsVision(!!m.supportsVision)
    setContextLength(m.contextLength ? String(m.contextLength) : '')
    setErr('')
    setSavedMsg('')
  }

  /** 切换协议：重置为该协议第一个预置服务商的默认 baseUrl / 模型 / 上下文长度 */
  function selectProtocol(p: ModelProtocol): void {
    setProtocol(p)
    const first = MODEL_PROVIDERS.find((x) => x.protocol === p)
    if (first) {
      setProviderId(first.id)
      setName(first.name)
      setBaseUrl(first.baseUrl)
      setModel(first.models[0] ?? '')
      setCustomModel(false)
      setContextLength(first.contextLength ? String(first.contextLength) : '')
    } else {
      setProviderId(CUSTOM_PROVIDER_ID)
      setName('')
      setBaseUrl(p === 'anthropic' ? 'https://api.anthropic.com' : '')
      setModel('')
      setCustomModel(true)
      setContextLength('')
    }
    setErr('')
    setSavedMsg('')
  }

  /** 选择服务商：预填 baseUrl / 模型 / 协议 / 名称 / 默认上下文长度 */
  function selectProvider(id: string): void {
    const p = MODEL_PROVIDERS.find((x) => x.id === id)
    if (!p) {
      // 自定义端点：不属于任何预置服务商，模型改为手动输入
      setProviderId(CUSTOM_PROVIDER_ID)
      setCustomModel(true)
      setErr('')
      setSavedMsg('')
      return
    }
    setProviderId(id)
    setProtocol(p.protocol)
    setName(p.name)
    setBaseUrl(p.baseUrl)
    setModel(p.models[0] ?? '')
    setCustomModel(false)
    setContextLength(p.contextLength ? String(p.contextLength) : '')
    setErr('')
    setSavedMsg('')
  }

  function handleModelSelect(v: string): void {
    if (v === '__custom__') {
      setCustomModel(true)
      return
    }
    setCustomModel(false)
    setModel(v)
  }

  async function submit(): Promise<void> {
    setSavedMsg('')
    const finalName = name.trim() || MODEL_PROVIDERS.find((p) => p.id === providerId)?.name || '自定义模型'
    const trimmedBaseUrl = baseUrl.trim()
    const trimmedApiKey = apiKey.trim()
    const trimmedModel = model.trim()
    if (!trimmedBaseUrl || !trimmedApiKey || !trimmedModel) {
      setErr('请填写接口地址、API Key 与模型名')
      return
    }
    // URL 格式校验：必须以 http(s) 开头，避免保存非法地址后调用必失败
    if (!/^https?:\/\//i.test(trimmedBaseUrl)) {
      setErr('接口地址需以 http:// 或 https:// 开头')
      return
    }
    // 重复添加检测：相同 baseUrl + 模型名已存在则拦截（排除当前正在编辑的那条）
    const dup = props.models.find((m) => m.id !== editingId && m.baseUrl.trim() === trimmedBaseUrl && (m.model ?? m.id) === trimmedModel)
    if (dup) {
      setErr(`已存在接口地址与模型名相同的配置「${dup.name}」，无需重复添加`)
      return
    }
    let ctxLenNum: number | undefined
    if (contextLength.trim()) {
      const n = Number(contextLength.trim())
      if (!Number.isFinite(n) || n <= 0) {
        setErr('上下文长度需为正整数')
        return
      }
      if (n > MAX_CONTEXT_LENGTH) {
        setErr(`上下文长度过大（上限 ${MAX_CONTEXT_LENGTH.toLocaleString()} token）`)
        return
      }
      ctxLenNum = n
    }
    setLoading(true)
    setErr('')
    try {
      if (editingId) {
        await props.onUpdate(editingId, { name: finalName, baseUrl: trimmedBaseUrl, apiKey: trimmedApiKey, model: trimmedModel, protocol, contextLength: ctxLenNum, supportsVision })
        setSavedMsg('已保存修改')
      } else {
        await props.onAdd({ name: finalName, baseUrl: trimmedBaseUrl, apiKey: trimmedApiKey, model: trimmedModel, protocol, contextLength: ctxLenNum, supportsVision })
        setSavedMsg(`已添加「${finalName}」`)
      }
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }

  async function doConfirmDelete(): Promise<void> {
    const id = confirmDeleteId
    setConfirmDeleteId(null)
    if (!id) return
    await props.onRemove(id)
    if (editingId === id) openAdd()
  }

  const confirmDeleteModel = props.models.find((m) => m.id === confirmDeleteId)

  function useModel(): void {
    if (!editingId) return
    props.onSelect(editingId)
    props.onClose?.()
  }

  return (
    <>
      <style>{CSS}</style>
      <div
        onClick={() => props.onClose?.()}
        className="cm-overlay"
        style={props.variant === 'window' ? { height: '100vh', background: 'var(--bg-panel)' } : undefined}
      >
        {/* 全屏弹窗：左右排版 */}
        <div onClick={(e) => e.stopPropagation()} className="cm-shell">
          <WindowTitleBar icon={<IconWrench />} title="自定义模型" onClose={() => props.onClose?.()} />

          <div className="cm-body">
            {/* 左侧：已配置模型列表 */}
            <aside className="cm-sidebar">
              <div className="cm-sidebar-head">已配置模型</div>
              <div className="cm-sidebar-list">
                {props.models.length === 0 ? (
                  <div className="cm-empty">
                    还没有自定义模型
                    <br />
                    点击下方按钮新增
                  </div>
                ) : (
                  props.models.map((m) => (
                    <div key={m.id} onClick={() => openEdit(m)} className={editingId === m.id ? 'cm-list-item active' : 'cm-list-item'}>
                      <div className="cm-list-name">{m.name}</div>
                      <div className="cm-list-meta">
                        {m.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}
                        <span className="cm-badge">{m.model ?? m.id}</span>
                      </div>
                      <div className="cm-list-url">{m.baseUrl}</div>
                      <button
                        type="button"
                        className="cm-list-del"
                        title={`删除「${m.name}」`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmDeleteId(m.id)
                        }}
                      >
                        <IconTrash />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="cm-sidebar-foot">
                <button onClick={openAdd} className="cm-add-btn">
                  <IconPlus /> 新增自定义模型
                </button>
              </div>
            </aside>

            {/* 右侧：选中模型的配置编辑区域 */}
            <main className="cm-main">
              <div className="cm-title">{editingId ? '编辑自定义模型' : '新增自定义模型'}</div>
              <div className="cm-subtitle">支持 OpenAI 兼容与 Anthropic 两种协议，可接任意服务商或自建网关</div>

              {/* 分组：接入方式 */}
              <div className="cm-group">
                <div className="cm-group-title">接入方式</div>
                <div className="cm-field">
                  <div className="cm-field-label">协议</div>
                  <CustomSelect value={protocol} options={PROTOCOL_OPTIONS} onChange={(v) => selectProtocol(v as ModelProtocol)} />
                </div>
                <div className="cm-field">
                  <div className="cm-field-label">服务商（快捷填充）</div>
                  <CustomSelect value={providerId} options={providerOptions} onChange={selectProvider} />
                  <div className="cm-field-hint">选择服务商后自动填充接口地址、模型与上下文长度，也可选「自定义端点」手动填写</div>
                </div>
              </div>

              {/* 分组：模型信息 */}
              <div className="cm-group">
                <div className="cm-group-title">模型信息</div>
                <Field label="名称" value={name} onChange={setName} placeholder="例如：我的 Claude" />
                <div className="cm-field">
                  <div className="cm-field-label">模型</div>
                  {customModel ? (
                    <input
                      className="cm-input"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder={protocol === 'anthropic' ? '输入模型名，如 claude-3-5-sonnet-20241022' : '输入模型名，如 gpt-4o'}
                    />
                  ) : (
                    <CustomSelect value={model} options={modelOptions} onChange={handleModelSelect} placeholder="选择模型" />
                  )}
                  {customModel && (
                    <div className="cm-field-hint" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span>自定义模型名（可随时切回预置）</span>
                      <button type="button" className="cm-link" onClick={() => setCustomModel(false)}>
                        从预置选择
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* 分组：连接配置 */}
              <div className="cm-group">
                <div className="cm-group-title">连接配置</div>
                <Field label="接口地址 (Base URL)" value={baseUrl} onChange={setBaseUrl} placeholder={protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.example.com/v1'} hint="需以 http:// 或 https:// 开头" />
                <Field label="API Key" value={apiKey} onChange={setApiKey} placeholder={protocol === 'anthropic' ? 'sk-ant-...' : 'sk-...'} password />
              </div>

              {/* 分组：高级选项 */}
              <div className="cm-group">
                <div className="cm-group-title">高级选项</div>
                <div className="cm-field">
                  <label className="cm-checkbox-row">
                    <input type="checkbox" className="cm-checkbox" checked={supportsVision} onChange={(e) => setSupportsVision(e.target.checked)} />
                    支持多模态（视觉输入）
                  </label>
                </div>
                <div className="cm-field">
                  <div className="cm-field-label">上下文长度（token，选填）</div>
                  <input
                    className="cm-input"
                    value={contextLength}
                    onChange={(e) => setContextLength(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="例如 131072、200000，留空则使用默认"
                    inputMode="numeric"
                  />
                  <div className="cm-field-hint">选择服务商时会自动填充默认值，可手动修改（上限 {MAX_CONTEXT_LENGTH.toLocaleString()}）</div>
                </div>
              </div>

              {err && (
                <div className="cm-error">
                  <IconWarn />
                  <span>{err}</span>
                </div>
              )}
              {savedMsg && (
                <div className="cm-success">
                  <IconCheck />
                  <span>{savedMsg}</span>
                </div>
              )}

              <div className="cm-actions">
                <button onClick={() => void submit()} disabled={loading} className="cm-btn cm-btn-primary">
                  {loading ? '保存中…' : '保存'}
                </button>
                {editingId && (
                  <>
                    <button onClick={useModel} className="cm-btn cm-btn-outline">
                      使用此模型
                    </button>
                    <button onClick={() => setConfirmDeleteId(editingId)} className="cm-btn cm-btn-danger">
                      <IconTrash /> 删除
                    </button>
                  </>
                )}
                <button onClick={() => props.onClose?.()} className="cm-btn cm-btn-ghost" style={{ marginLeft: 'auto' }}>
                  关闭
                </button>
              </div>
            </main>
          </div>
        </div>
      </div>

      {/* 删除确认弹层（左侧列表删除 + 右侧删除按钮共用） */}
      {confirmDeleteId && (
        <div className="cm-modal-overlay" onClick={() => setConfirmDeleteId(null)}>
          <div className="cm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cm-modal-title">删除自定义模型</div>
            <div className="cm-modal-body">确认删除「{confirmDeleteModel?.name ?? ''}」？此操作不可撤销。</div>
            <div className="cm-modal-actions">
              <button onClick={() => setConfirmDeleteId(null)} className="cm-btn cm-btn-ghost">
                取消
              </button>
              <button onClick={() => void doConfirmDelete()} className="cm-btn cm-btn-danger">
                <IconTrash /> 删除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
