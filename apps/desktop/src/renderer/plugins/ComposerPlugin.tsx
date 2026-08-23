import { registerSlot } from '../slots'
import { useUIContext } from '../ui-context'
import { Composer } from '../components/Composer'

/** shell.composer 插件：底部输入区（附件 / 模型选择 / 工作目录 / 安全模式 / 语音 / 发送，可被 selfmod 替换） */
function ComposerSlot(): React.JSX.Element {
  const ctx = useUIContext()
  return (
    <Composer
      isEmpty={ctx.isEmpty}
      attachments={ctx.attachments}
      setAttachments={ctx.setAttachments}
      retryImageUpload={ctx.retryImageUpload}
      setPreviewImage={ctx.setPreviewImage}
      fileRef={ctx.fileRef}
      handleFileSelect={ctx.handleFileSelect}
      queueCount={ctx.queueCount}
      voiceNotice={ctx.voiceNotice}
      input={ctx.input}
      setInput={ctx.setInput}
      isComposingRef={ctx.isComposingRef}
      handlePaste={ctx.handlePaste}
      modelMenuRef={ctx.modelMenuRef}
      modelMenuOpen={ctx.modelMenuOpen}
      setModelMenuOpen={ctx.setModelMenuOpen}
      models={ctx.models}
      selectedModel={ctx.selectedModel}
      loggedIn={ctx.loggedIn}
      selectModel={ctx.selectModel}
      workDir={ctx.workDir}
      workDirName={ctx.workDirName}
      pickWorkdir={ctx.pickWorkdir}
      approvalMenuRef={ctx.approvalMenuRef}
      approvalMenuOpen={ctx.approvalMenuOpen}
      setApprovalMenuOpen={ctx.setApprovalMenuOpen}
      approvalPolicy={ctx.approvalPolicy}
      switchApprovalPolicy={ctx.switchApprovalPolicy}
      recording={ctx.recording}
      toggleRecording={ctx.toggleRecording}
      busy={ctx.cur.busy}
      send={ctx.send}
      stopSend={ctx.stopSend}
    />
  )
}

registerSlot('shell.composer', 'core:composer', 'core', ComposerSlot)
