/** 空状态欢迎页：产品名 + 欢迎语 + 能力点 + 快捷提问（点击填入输入框） */
export function WelcomeHero({ onSuggestion }: { onSuggestion: (text: string) => void }) {
  const suggestions = [
    '帮我写一段 Python 脚本',
    '解释一下当前项目结构',
    '用一句话介绍你自己',
    '帮我分析一个文件',
  ]
  return (
    <div style={{ textAlign: 'center', maxWidth: 640, width: '100%', paddingBottom: 8 }}>
      <div style={{ fontSize: 44, fontWeight: 700, color: 'var(--accent)', letterSpacing: 2, marginBottom: 10 }}>山海</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>欢迎使用山海 AI 助手</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 22 }}>
        一个可自我升级的桌面智能体：多专家编排、真实工具执行、会话级隔离。
        <br />
        登录后解锁全部模型，也支持接入你自己的模型服务商。
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
