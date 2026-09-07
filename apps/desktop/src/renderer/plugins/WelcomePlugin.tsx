import { WelcomeHero } from '../components/WelcomeHero'
import { registerSlot } from '../slots'
import { useUIContext } from '../ui-context'

/** shell.welcome 插件：空会话欢迎页（可被 selfmod 替换） */
function WelcomeSlot(): React.JSX.Element {
  const { setComposerInput } = useUIContext()
  // 欢迎页快捷提问是「替换」语义：点哪条，输入框就只显示哪条（不追加、不拼接）。
  // 传 replace=true 走 App.setComposerInput 的替换分支；私信「引用到会话」仍走默认追加（保留用户草稿）。
  return <WelcomeHero onSuggestion={(s) => setComposerInput(s, true)} />
}

registerSlot('shell.welcome', 'core:welcome', 'core', WelcomeSlot)
