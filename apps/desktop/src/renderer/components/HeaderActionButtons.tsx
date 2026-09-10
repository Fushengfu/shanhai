import { IconActivity, IconClock, IconMoon, IconSun } from './icons'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

/**
 * 顶栏「功能按钮组」：记忆 / 轨迹 / 主题。
 *
 * 普通会话窗口顶栏（plugins/HeaderPlugin.tsx）与会话管家面板标题栏
 * （supervisor/SupervisorApp.tsx 的 WindowTitleBar.actions）**共用这一份**，
 * 不再各写一份 —— 此前管家侧只有「私信 + 主题」两个按钮，会话侧有四个，
 * 同一个应用两套顶栏视觉语言不一致（用户实测反馈）。
 *
 * 谁取词谁订阅：本组件渲染期直接取词（按钮文字 + tooltip），必须 useLocaleSync()。
 *
 * 样式逐字段取自原 HeaderPlugin 内联实现（padding：记忆/轨迹 5px 12px、主题 5px 10px），
 * 不新增任何色值 / CSS 变量。
 */
export function HeaderActionButtons(props: {
  /** 当前主题（决定主题按钮的图标与 tooltip 文案） */
  theme: 'light' | 'dark'
  /** 点击主题按钮时的切换动作（会话窗口传 UIContext.toggleTheme，管家面板传自身的 toggleTheme） */
  onToggleTheme: () => void
  /**
   * 【任务223】「记忆 / 轨迹」要展示的**目标会话**（可选）。
   *
   * - 不传（会话侧顶栏 HeaderPlugin 的调用方式）= 原行为：`openApp('memory' | 'trace')`，
   *   独立应用窗口内读 ui-store 的 currentSessionId（= 会话列正在显示的那个会话）。
   * - 传值（管家面板）= `openApp('memory' | 'trace', sessionId)`，仍是**同一套独立应用窗口**
   *   （创建/定位/生命周期全复用 openApp，不为管家另造窗口类型），只是把目标会话经
   *   窗口 argv 带下去，窗口内的 MemoryPanel/TracePanel 就查该会话的数据。
   *   管家传 'supervisor'：管家会话不是、也不能是 currentSessionId（runtime 的
   *   switchSessionInternal 明确拒绝），故必须显式传递，不能靠全局游标。
   *
   * 【为什么不再是 220 的 onOpenMemory/onOpenTrace】那两个回调让管家在面板内盖一层子面板，
   * 与会话侧「开独立窗口」的行为不一致（用户实测反馈「跟子会话的不一样，搞得很特立」）。
   * 改成传 sessionId 后两侧是**同一条 openApp 路径**，视觉/交互自然一致。
   */
  sessionId?: string
}): React.JSX.Element {
  useLocaleSync()
  const btnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '5px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-panel)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    cursor: 'pointer',
    ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties),
  }
  return (
    <>
      <button onClick={() => void window.shanhai?.openApp('memory', props.sessionId)} title={t('panels.header.memoryTip')} style={btnStyle}>
        <IconClock />
        {t('app.memory.name')}
      </button>
      <button onClick={() => void window.shanhai?.openApp('trace', props.sessionId)} title={t('panels.header.traceTip')} style={btnStyle}>
        <IconActivity />
        {t('app.trace.name')}
      </button>
      <button
        onClick={props.onToggleTheme}
        title={props.theme === 'light' ? t('common.themeToDark') : t('common.themeToLight')}
        style={{ ...btnStyle, padding: '5px 10px' }}
      >
        {props.theme === 'light' ? <IconMoon /> : <IconSun />}
      </button>
    </>
  )
}
