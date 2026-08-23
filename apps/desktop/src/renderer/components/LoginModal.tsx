import { useState } from 'react'
import { IconClose } from './icons'

export function LoginModal({ onClose, onLogin }: { onClose: () => void; onLogin: (u: string, p: string) => Promise<void> }) {
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(): Promise<void> {
    if (!u || !p) return
    setLoading(true)
    setErr('')
    try {
      await onLogin(u, p)
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, fontFamily: 'system-ui, sans-serif' }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 340, padding: 32, background: 'var(--bg-panel)', borderRadius: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.15)', position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 12, right: 12, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
          <IconClose />
        </button>
        <h1 style={{ fontSize: 20, marginBottom: 4, textAlign: 'center' }}>山海</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', marginBottom: 24 }}>账号密码登录</p>
        <input
          value={u}
          onChange={(e) => setU(e.target.value)}
          placeholder="账号"
          autoFocus
          style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 14, marginBottom: 12, boxSizing: 'border-box', outline: 'none' }}
        />
        <input
          value={p}
          onChange={(e) => setP(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          type="password"
          placeholder="密码"
          style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 14, marginBottom: 12, boxSizing: 'border-box', outline: 'none' }}
        />
        {err && <p style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8, wordBreak: 'break-word' }}>{err}</p>}
        <button onClick={() => void submit()} disabled={loading} style={{ width: '100%', padding: 10, borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>
          {loading ? '登录中…' : '登录'}
        </button>
        <p style={{ fontSize: 11, color: 'var(--text-faint)', textAlign: 'center', marginTop: 16 }}>密码仅在登录瞬间使用，绝不落盘</p>
      </div>
    </div>
  )
}
