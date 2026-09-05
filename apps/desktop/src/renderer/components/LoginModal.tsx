import { useState } from 'react'
import { IconClose } from './icons'
import { t as tKey } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

type Tab = 'login' | 'register'

export function LoginModal({
  onClose,
  onLogin,
  onRegister,
}: {
  onClose: () => void
  onLogin: (u: string, p: string) => Promise<void>
  onRegister: (u: string, p: string, nickname?: string, phone?: string, email?: string) => Promise<void>
}) {
  // 谁取词谁订阅：本组件渲染期取词，必须自订阅语言变化
  useLocaleSync()
  const [tab, setTab] = useState<Tab>('login')
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [regNickname, setRegNickname] = useState('')
  const [regPhone, setRegPhone] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  const inputStyle = {
    width: '100%',
    padding: 10,
    borderRadius: 8,
    border: '1px solid var(--border-strong)',
    fontSize: 14,
    marginBottom: 12,
    boxSizing: 'border-box',
    outline: 'none',
    background: 'var(--bg-panel)',
    color: 'var(--text)',
  } as const

  async function submit(): Promise<void> {
    setLoading(true)
    setErr('')
    try {
      if (tab === 'login') {
        if (!u || !p) {
          setErr(tKey('panels.login.errAccountPassword'))
          return
        }
        await onLogin(u, p)
      } else {
        const phone = regPhone.trim()
        if (!phone) {
          setErr(tKey('panels.login.errPhoneRequired'))
          return
        }
        if (phone.length !== 11 || !/^\d{11}$/.test(phone)) {
          setErr(tKey('panels.login.errPhoneFormat'))
          return
        }
        if (!regPassword) {
          setErr(tKey('panels.login.errPasswordRequired'))
          return
        }
        if (regPassword.length < 6) {
          setErr(tKey('panels.login.errPasswordShort'))
          return
        }
        const nickname = regNickname.trim()
        if (!nickname) {
          setErr(tKey('panels.login.errNicknameRequired'))
          return
        }
        const email = regEmail.trim()
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          setErr(tKey('panels.login.errEmailFormat'))
          return
        }
        await onRegister(phone, regPassword, nickname, phone, email || undefined)
      }
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
        <h1 style={{ fontSize: 20, marginBottom: 4, textAlign: 'center' }}>{tKey('chat.brand')}</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', marginBottom: 16 }}>{tKey('panels.login.subtitle')}</p>

        {/* 登录 / 注册 tab 切换 */}
        <div style={{ display: 'flex', marginBottom: 20, borderBottom: '1px solid var(--border)' }}>
          {(['login', 'register'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t)
                setErr('')
              }}
              style={{
                flex: 1,
                padding: '8px 0',
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 600,
                color: tab === t ? 'var(--text)' : 'var(--text-muted)',
                borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
                transition: 'color 0.15s ease, border-color 0.15s ease',
              }}
            >
              {t === 'login' ? tKey('panels.login.tabLogin') : tKey('panels.login.tabRegister')}
            </button>
          ))}
        </div>

        {tab === 'login' ? (
          <>
            <input
              value={u}
              onChange={(e) => setU(e.target.value)}
              placeholder={tKey('panels.login.account')}
              autoFocus
              style={inputStyle}
            />
            <input
              value={p}
              onChange={(e) => setP(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              type="password"
              placeholder={tKey('panels.login.password')}
              style={inputStyle}
            />
          </>
        ) : (
          <>
            <input
              value={regPhone}
              onChange={(e) => setRegPhone(e.target.value)}
              placeholder={tKey('panels.login.phone')}
              autoFocus
              style={inputStyle}
            />
            <input
              value={regPassword}
              onChange={(e) => setRegPassword(e.target.value)}
              type="password"
              placeholder={tKey('panels.login.passwordAtLeast')}
              style={inputStyle}
            />
            <input
              value={regNickname}
              onChange={(e) => setRegNickname(e.target.value)}
              placeholder={tKey('panels.login.nicknameRequired')}
              style={inputStyle}
            />
            <input
              value={regEmail}
              onChange={(e) => setRegEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder={tKey('panels.login.emailOptional')}
              style={inputStyle}
            />
          </>
        )}

        {err && <p style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8, wordBreak: 'break-word' }}>{err}</p>}
        <button
          onClick={() => void submit()}
          disabled={loading}
          style={{ width: '100%', padding: 10, borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}
        >
          {loading ? (tab === 'login' ? tKey('panels.login.loggingIn') : tKey('panels.login.registering')) : tab === 'login' ? tKey('panels.login.tabLogin') : tKey('panels.login.tabRegister')}
        </button>
        <p style={{ fontSize: 11, color: 'var(--text-faint)', textAlign: 'center', marginTop: 16 }}>{tKey('panels.login.passwordNote')}</p>
      </div>
    </div>
  )
}
