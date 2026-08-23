import { TokenStatusBar } from '../components/TokenStatusBar'
import { registerSlot } from '../slots'
import { useUIContext } from '../ui-context'

/** shell.statusbar 插件：token 用量状态栏（可被 selfmod 替换） */
function StatusbarSlot(): React.JSX.Element {
  const { currentTokenStats } = useUIContext()
  return <TokenStatusBar stats={currentTokenStats} />
}

registerSlot('shell.statusbar', 'core:statusbar', 'core', StatusbarSlot)
