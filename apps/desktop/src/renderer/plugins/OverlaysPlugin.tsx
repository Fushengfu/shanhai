import { ImagePreview } from '../components/ImagePreview'
import { LoginModal } from '../components/LoginModal'
import { registerSlot } from '../slots'
import { useUIContext } from '../ui-context'

/** shell.overlays 插件：遮罩层（登录弹窗 / 图片预览，可被 selfmod 替换） */
function OverlaysSlot(): React.JSX.Element {
  const ctx = useUIContext()
  return (
    <>
      {ctx.loginOpen && <LoginModal onClose={() => ctx.setLoginOpen(false)} onLogin={ctx.handleLogin} onRegister={ctx.handleRegister} />}
      {ctx.previewImage && <ImagePreview src={ctx.previewImage} onClose={() => ctx.setPreviewImage(null)} />}
    </>
  )
}

registerSlot('shell.overlays', 'core:overlays', 'core', OverlaysSlot)
