import { useEffect, useRef } from 'react'
import * as React from 'react'
import { IconMonitor } from '../components/icons'
import { useThemeSync } from '../theme'
import { t } from '../../shared/i18n'
import { applyLocale, useLocaleSync } from '../locale'

/**
 * 会话管家悬浮图标（独立窗口 supervisor-bubble）。
 * - 管家窗口点关闭后显示本图标；点图标恢复管家窗口。
 * - 支持拖动：mousedown 记录起始屏幕坐标，mousemove 按位移增量调 IPC 移动窗口，mouseup 判断位移。
 *   （位移 < 3px 视为「点击」→ 恢复窗口；否则视为「拖动」）
 */
export function SupervisorBubble(): React.JSX.Element {
  // 主题：订阅主进程广播，跟随聊天窗口切换（渐变颜色随亮/暗变化）
  useThemeSync()
  // 语言（i18n 期3）：本气泡自己取词（title），必须订阅语言变化，否则切了语言 tooltip 还是旧语言。
  useLocaleSync()
  // 窗口级：订阅主进程 ui:locale 广播，把语言写进本窗口的取词镜像（气泡是独立窗口，不订阅就永远停在挂载时那份）。
  useEffect(() => {
    const off = window.shanhai?.onLocaleChange((l) => applyLocale(l))
    return off
  }, [])
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null)

  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    dragRef.current = { startX: e.screenX, startY: e.screenY, moved: false }

    const onMove = (ev: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.screenX - d.startX
      const dy = ev.screenY - d.startY
      if (!d.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        d.moved = true
      }
      if (d.moved) {
        void window.shanhai?.moveSupervisorBubble(dx, dy)
        d.startX = ev.screenX
        d.startY = ev.screenY
      }
    }
    const onUp = (): void => {
      const d = dragRef.current
      if (d && !d.moved) {
        // 位移极小 → 视为点击 → 恢复管家窗口
        void window.shanhai?.showSupervisorFromBubble()
      }
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      <div
        onMouseDown={onMouseDown}
        title={t('sup.bubble.title')}
        style={{
          width: 52,
          height: 52,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, var(--accent), var(--purple-soft))',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: '0 4px 18px rgba(0,0,0,0.28)',
        }}
      >
        <span style={{ display: 'inline-flex', transform: 'scale(1.5)' }}>
          <IconMonitor />
        </span>
      </div>
    </div>
  )
}
