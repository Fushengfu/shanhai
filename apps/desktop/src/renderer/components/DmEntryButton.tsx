import { useEffect, useState } from 'react'
import { IconChat } from './icons'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

/**
 * 「私信」顶栏入口按钮 —— 普通会话窗口（plugins/HeaderPlugin.tsx）与会话管家窗口
 * （supervisor/SupervisorApp.tsx 的 WindowTitleBar.actions）**共用这一套**，不再各写一份。
 *
 * 真值源（本组件不自己算任何计数，两个入口读的是同一份主进程真值）：
 *  - 未读私信数：主进程 member-channel.ts `broadcastUnread()` 广播 `member:unread`
 *    （权威值为 HTTP `GET /api/v1/messages/unread`，见 `pullGlobalUnread()`）；
 *  - 待处理好友申请数：主进程 `broadcastFriends()` 携带的 `requestCount`，走 `member:friends` 广播
 *    （权威值为 HTTP `GET /api/v1/friends/requests/count`）。
 *  初次挂载先读一次本地快照（`memberUnread()` / `memberFriends()`），之后靠广播增量更新；
 *  登录态切换时重读一次快照（登录成功后主通道会连接并补拉，广播也会到达）。
 *
 * 点击行为：`window.shanhai.openApp('messages')` —— 复用 apps/registry.tsx 已注册的 `messages`
 *  应用窗口（主进程 openApp 按 appId 复用单实例），管家与聊天打开的是**同一个**私信面板，
 *  不为管家另做第二个面板实例。
 *
 * 登录态如实呈现：未登录 / 凭证失效（主进程会把全局 loggedIn 翻成 false）时，**不显示「0 未读」
 *  假装正常**，而是把按钮文字置红并在 tooltip 里说明原因；窄窗口（仅图标形态）额外给一个红点，
 *  保证不 hover 也能看出「当前不可用」。
 */
export function DmEntryButton(props: {
  /** 是否已登录会员账号（聊天窗口传 UIContext.loggedIn，管家窗口传 ui.loggedIn，同一来源） */
  loggedIn: boolean
  /** true＝带「私信」文字（聊天窗口顶栏）；false＝仅图标（管家窗口顶栏较窄，避免挤压标题区） */
  labeled?: boolean
  /** 追加样式（聊天窗口用 `marginLeft:'auto'` 把入口推到右侧） */
  style?: React.CSSProperties
}): React.JSX.Element {
  // 本组件渲染期直接取词（tooltip / 按钮文字 / 未读量词）→ 必须自订阅
  useLocaleSync()
  const labeled = props.labeled ?? false
  /** 未读私信数（member:unread 广播，主进程权威） */
  const [dmUnread, setDmUnread] = useState(0)
  /** 待处理好友申请数（member:friends 广播里的 requestCount，主进程权威） */
  const [dmRequests, setDmRequests] = useState(0)
  useEffect(() => {
    void window.shanhai?.memberUnread().then((u) => setDmUnread(u?.total ?? 0))
    void window.shanhai?.memberFriends().then((f) => setDmRequests(f?.requestCount ?? f?.requests?.length ?? 0))
    const off = window.shanhai?.onMemberUnread((u) => setDmUnread(u.total))
    const offFriends = window.shanhai?.onMemberFriends((snap) => setDmRequests(snap.requestCount ?? snap.requests?.length ?? 0))
    return () => {
      off?.()
      offFriends?.()
    }
  }, [props.loggedIn])
  // 未读私信 + 待处理好友申请合并计数：两类都需要用户处理，分开两个点反而看不清（与聊天窗口原口径一致）
  const badge = dmUnread + dmRequests
  const counts = [t('dm.entryUnread', { n: dmUnread }), t('dm.entryRequests', { n: dmRequests })].join(t('common.sepMiddle'))
  const title = !props.loggedIn
    ? t('dm.entryNotLoggedIn')
    : dmRequests > 0
      ? t('dm.entryBase') + t('common.sepMiddle') + counts
      : t('dm.entryBase')
  return (
    <button
      onClick={() => void window.shanhai?.openApp('messages')}
      title={title}
      style={
        {
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: labeled ? '5px 12px' : '5px 10px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          color: props.loggedIn ? 'var(--text-secondary)' : 'var(--danger-text, #b91c1c)',
          fontSize: 12,
          cursor: 'pointer',
          flexShrink: 0,
          ...props.style,
          ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties),
        } as React.CSSProperties
      }
    >
      <IconChat />
      {labeled && (props.loggedIn ? t('dm.title') : t('dm.entryLabelNotLoggedIn'))}
      {props.loggedIn && badge > 0 && (
        <span
          title={dmRequests > 0 ? counts : t('dm.entryUnread', { n: dmUnread })}
          style={{ marginLeft: 2, minWidth: 16, textAlign: 'center', padding: '0 4px', borderRadius: 8, background: 'var(--danger, #ef4444)', color: '#fff', fontSize: 10, lineHeight: '16px' }}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {/* 仅图标形态（管家窗口）没有文字可标注，未登录时用一个红点如实表示「当前不可用」 */}
      {!labeled && !props.loggedIn && (
        <span style={{ position: 'absolute', top: 3, right: 3, width: 7, height: 7, borderRadius: '50%', background: 'var(--danger, #ef4444)' }} />
      )}
    </button>
  )
}
