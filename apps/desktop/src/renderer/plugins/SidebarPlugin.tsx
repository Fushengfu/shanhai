import { useState } from 'react'
import { SessionRow } from '../components/SessionRow'
import { IconAvatar, IconClose, IconLogout, IconPlus, IconSearch } from '../components/icons'
import { smallIconBtn } from '../components/ui'
import { registerSlot } from '../slots'
import { useUIContext } from '../ui-context'

/** shell.sidebar 插件：会话列表侧边栏（可折叠，可被 selfmod 替换） */
function SidebarSlot(): React.JSX.Element {
  const ctx = useUIContext()
  const [search, setSearch] = useState('')

  // 搜索过滤：标题 / 工作目录名 / 完整工作目录路径，大小写不敏感
  const q = search.trim().toLowerCase()
  const visibleSessions = q
    ? ctx.sortedSessions.filter((s) => {
        const workDirName = s.workDir ? (s.workDir.split(/[\\/]/).filter(Boolean).pop() ?? '') : ''
        return s.title.toLowerCase().includes(q) || s.workDir.toLowerCase().includes(q) || workDirName.toLowerCase().includes(q)
      })
    : ctx.sortedSessions

  return (
    <>
      <div style={{ padding: '12px 12px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>会话</span>
        <button onClick={() => void ctx.createSession()} title="新增会话" style={smallIconBtn}>
          <IconPlus />
        </button>
      </div>
      <div style={{ padding: '0 12px 6px', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 8, background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--text-muted)', display: 'inline-flex' }}>
            <IconSearch />
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索会话"
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              background: 'transparent',
              outline: 'none',
              fontSize: 13,
              color: 'var(--text)',
              padding: 0,
            }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              title="清空"
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'inline-flex' }}
            >
              <IconClose />
            </button>
          )}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', WebkitAppRegion: 'no-drag', padding: '4px 0 8px' } as React.CSSProperties}>
        {visibleSessions.length === 0 ? (
          <div style={{ padding: '16px 12px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>{q ? '无匹配会话' : '暂无会话'}</div>
        ) : (
          visibleSessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === ctx.currentSessionId}
            busy={ctx.sessionBusy(s.id)}
            editing={ctx.editingSessionId === s.id}
            editingTitle={ctx.editingTitle}
            onTitleChange={ctx.setEditingTitle}
            onStartEdit={() => {
              ctx.setEditingSessionId(s.id)
              ctx.setEditingTitle(s.title)
            }}
            onCommitEdit={() => {
              void ctx.renameSession(s.id, ctx.editingTitle)
              ctx.setEditingSessionId(null)
            }}
            onCancelEdit={() => ctx.setEditingSessionId(null)}
            onDelete={() => void ctx.deleteSession(s.id)}
            onSelect={() => void ctx.switchToSession(s.id)}
          />
          ))
        )}
      </div>
      {/* 侧边栏底部：账号头像 + 昵称 + 退出（未登录点击头像弹登录窗） */}
      <div style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div
          onClick={() => {
            if (!ctx.loggedIn) ctx.setLoginOpen(true)
          }}
          title={ctx.loggedIn ? ctx.username ?? '' : '点击登录'}
          style={{ width: 32, height: 32, borderRadius: '50%', background: ctx.loggedIn ? 'var(--accent)' : 'var(--border-strong)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: ctx.loggedIn ? 'default' : 'pointer' }}
        >
          <IconAvatar />
        </div>
        <div
          onClick={() => {
            if (!ctx.loggedIn) ctx.setLoginOpen(true)
          }}
          style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: ctx.loggedIn ? 'default' : 'pointer' }}
        >
          {ctx.loggedIn ? (ctx.username ?? '已登录') : '未登录'}
        </div>
        {ctx.loggedIn && (
          <button onClick={() => void ctx.handleLogout()} title="退出登录" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'inline-flex' }}>
            <IconLogout />
          </button>
        )}
      </div>
    </>
  )
}

registerSlot('shell.sidebar', 'core:sidebar', 'core', SidebarSlot)
