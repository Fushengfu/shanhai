import { registerSlot } from '../slots'
import { useUIContext } from '../ui-context'
import { ChatComposer } from '../components/ChatComposer'

/** shell.composer 插件：底部输入区（自持输入态，可被 selfmod 替换）。低频数据（模型/安全模式/工作目录）与回调由 App 经 ctx 传入，
 *  高频输入态（input/attachments/recording 等）内聚在 ChatComposer 内部，使每次键入只重渲染输入区子树、不拖累整窗。 */
function ComposerSlot(): React.JSX.Element {
  const ctx = useUIContext()
  return (
    <ChatComposer
      busy={ctx.cur.busy}
      isEmpty={ctx.isEmpty}
      models={ctx.models}
      selectedModel={ctx.selectedModel}
      loggedIn={ctx.loggedIn}
      approvalPolicy={ctx.approvalPolicy}
      workDir={ctx.workDir}
      workDirName={ctx.workDirName}
      queueCount={ctx.queueCount}
      setPreviewImage={ctx.setPreviewImage}
      selectModel={ctx.selectModel}
      switchApprovalPolicy={ctx.switchApprovalPolicy}
      pickWorkdir={ctx.pickWorkdir}
      send={ctx.send}
      stopSend={ctx.stopSend}
      composerRef={ctx.composerRef}
      seed={ctx.composerSeed}
    />
  )
}

registerSlot('shell.composer', 'core:composer', 'core', ComposerSlot)