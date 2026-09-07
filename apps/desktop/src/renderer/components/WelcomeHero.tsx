import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

/** 空状态欢迎页：产品名 + 欢迎语 + 能力点 + 快捷提问（点击填入输入框） */
export function WelcomeHero({ onSuggestion }: { onSuggestion: (text: string) => void }) {
  // 【期4C】快捷提问是「点一下填进输入框」的界面文案 → 取词；渲染期求值，切语言立刻换
  useLocaleSync()
  const suggestions = [
    t('chat.suggest.python'),
    t('chat.suggest.project'),
    t('chat.suggest.intro'),
    t('chat.suggest.file'),
    t('chat.suggest.plugin.dev'),
    t('chat.suggest.plugin.list'),
    t('chat.suggest.plugin.open'),
  ]
  return (
    <div style={{ textAlign: 'center', maxWidth: 640, width: '100%', paddingBottom: 8 }}>
      <div style={{ fontSize: 44, fontWeight: 700, color: 'var(--accent)', letterSpacing: 2, marginBottom: 10 }}>{t('chat.brand')}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>{t('chat.welcomeTitle')}</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 22 }}>
        {t('chat.welcomeDesc1')}
        <br />
        {t('chat.welcomeDesc2')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onSuggestion(s)}
            style={{ padding: '8px 14px', borderRadius: 18, border: '1px solid var(--border-soft)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', transition: 'border-color 0.2s' }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-soft)')}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}
