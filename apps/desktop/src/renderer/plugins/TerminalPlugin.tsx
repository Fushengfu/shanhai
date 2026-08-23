import { TerminalPanel } from '../components/TerminalPanel'
import { registerSlot } from '../slots'
import { useUIContext } from '../ui-context'

/** shell.terminal 插件：底部会话级交互式终端面板（用户手动执行命令，多开多个，可被 selfmod 替换） */
function TerminalSlot(): React.JSX.Element {
  const ctx = useUIContext()
  return <TerminalPanel sessionId={ctx.currentSessionId} open={ctx.terminalPanelOpen} onToggle={() => ctx.setTerminalPanelOpen(false)} />
}

registerSlot('shell.terminal', 'core:terminal', 'core', TerminalSlot)
