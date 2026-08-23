import { WelcomeHero } from '../components/WelcomeHero'
import { registerSlot } from '../slots'
import { useUIContext } from '../ui-context'

/** shell.welcome 插件：空会话欢迎页（可被 selfmod 替换） */
function WelcomeSlot(): React.JSX.Element {
  const { setInput } = useUIContext()
  return <WelcomeHero onSuggestion={setInput} />
}

registerSlot('shell.welcome', 'core:welcome', 'core', WelcomeSlot)
