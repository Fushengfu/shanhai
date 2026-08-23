import * as React from 'react'
import { IconCheck, IconChevronDown, IconClock, IconFile, IconFolder, IconMic, IconMonitor, IconPaperclip, IconPlus, IconRefresh, IconSend, IconShield, IconStop } from './icons'
import { iconBtn } from './ui'
import { AppendSlotView } from '../slots'
import type { AttachmentItem, GatewayModel } from '../types'

/**
 * 统一的输入框组件（props 驱动）：聊天窗口（ComposerSlot）与「会话管家」窗口共用，
 * 保证附件 / 模型选择 / 工作目录 / 安全模式 / 麦克风 / 发送停止 等功能与样式完全一致。
 */
export interface ComposerProps {
  isEmpty: boolean
  attachments: AttachmentItem[]
  setAttachments: React.Dispatch<React.SetStateAction<AttachmentItem[]>>
  retryImageUpload: (id: string) => void
  setPreviewImage: (v: string | null) => void
  fileRef: React.RefObject<HTMLInputElement>
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>
  queueCount: number
  voiceNotice: string
  input: string
  setInput: (v: string) => void
  isComposingRef: React.MutableRefObject<boolean>
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => Promise<void>
  modelMenuRef: React.RefObject<HTMLDivElement>
  modelMenuOpen: boolean
  setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  models: GatewayModel[]
  selectedModel: string
  loggedIn: boolean
  selectModel: (id: string) => void
  workDir: string
  workDirName: string
  pickWorkdir: () => Promise<void>
  approvalMenuRef: React.RefObject<HTMLDivElement>
  approvalMenuOpen: boolean
  setApprovalMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  approvalPolicy: 'ask' | 'workdir' | 'never'
  switchApprovalPolicy: (policy: 'ask' | 'workdir' | 'never') => void
  recording: boolean
  toggleRecording: () => Promise<void>
  busy: boolean
  send: () => Promise<void>
  stopSend: () => void
}

export function Composer(p: ComposerProps): React.JSX.Element {
  const systemModels = p.models.filter((m) => !m.custom)
  const customModels = p.models.filter((m) => m.custom)

  return (
    <div
      style={
        p.isEmpty
          ? { padding: '8px 16px 28px', flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }
          : { padding: '12px 16px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg-panel)', boxSizing: 'border-box' }
      }
    >
      <div style={{ border: '1px solid var(--border-strong)', borderRadius: 16, padding: '10px 18px 10px 16px', background: 'var(--bg-panel)', width: '100%', maxWidth: p.isEmpty ? 760 : 'none', boxSizing: 'border-box' }}>
        {p.attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {p.attachments.map((a) => (
              <div key={a.id} style={{ position: 'relative' }}>
                {a.type === 'image' ? (
                  <>
                    <img
                      src={a.dataUrl}
                      alt={a.name}
                      onClick={() => p.setPreviewImage(a.url ?? a.dataUrl)}
                      style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', display: 'block', cursor: 'zoom-in', opacity: a.uploadStatus === 'uploading' ? 0.5 : 1 }}
                    />
                    {a.uploadStatus === 'uploading' && (
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                        <div style={{ width: 18, height: 18, border: '2px solid var(--border-strong)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                      </div>
                    )}
                    {a.uploadStatus === 'done' && (
                      <div style={{ position: 'absolute', right: -4, bottom: -4, width: 16, height: 16, borderRadius: '50%', background: 'var(--success)', color: '#fff', fontSize: 10, lineHeight: '16px', textAlign: 'center', pointerEvents: 'none' }}>✓</div>
                    )}
                    {a.uploadStatus === 'error' && (
                      <div
                        title="上传失败，点击重试"
                        onClick={() => p.retryImageUpload(a.id)}
                        style={{ position: 'absolute', right: -4, bottom: -4, width: 16, height: 16, borderRadius: '50%', background: 'var(--danger)', color: '#fff', fontSize: 11, lineHeight: '16px', textAlign: 'center', cursor: 'pointer' }}
                      >
                        !
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ width: 56, height: 56, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-app)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', gap: 2, padding: '0 4px', boxSizing: 'border-box' }}>
                    {a.type === 'file' ? <IconFile /> : a.type === 'audio' ? <IconMic /> : <IconMonitor />}
                    {a.type === 'file' && (
                      <div style={{ fontSize: 8, lineHeight: 1.1, color: 'var(--text-muted)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {a.name.length > 8 ? `${a.name.slice(0, 8)}…` : a.name}
                      </div>
                    )}
                  </div>
                )}
                <button
                  onClick={() => p.setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', border: 'none', background: 'var(--danger)', color: '#fff', fontSize: 12, lineHeight: '18px', cursor: 'pointer', padding: 0 }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <input ref={p.fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => void p.handleFileSelect(e)} />
        {p.queueCount > 0 && (
          <div style={{ marginBottom: 6, fontSize: 12, color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <IconClock />
            排队中 {p.queueCount} 条消息，将在当前任务完成后自动执行
          </div>
        )}
        {p.voiceNotice && (
          <div style={{ marginBottom: 6, fontSize: 12, color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <IconMic />
            {p.voiceNotice}
          </div>
        )}
        <textarea
          value={p.input}
          onChange={(e) => p.setInput(e.target.value)}
          onCompositionStart={() => {
            p.isComposingRef.current = true
          }}
          onCompositionEnd={() => {
            p.isComposingRef.current = false
          }}
          onKeyDown={(e) => {
            const composing = p.isComposingRef.current || e.nativeEvent.isComposing
            if (e.key === 'Enter' && !e.shiftKey && !composing) {
              e.preventDefault()
              void p.send()
            }
          }}
          onPaste={(e) => void p.handlePaste(e)}
          autoFocus
          rows={3}
          placeholder="输入任务，Enter 发送，Shift+Enter 换行"
          style={{ width: '100%', border: 'none', outline: 'none', resize: 'none', fontSize: 14, lineHeight: 1.6, background: 'transparent', minHeight: 60, maxHeight: 200, fontFamily: 'inherit', display: 'block', boxSizing: 'border-box' }}
        />
        {/* 追加型扩展点：输入框下方（agent 往这里挂按钮/小组件，不替换核心输入框） */}
        <AppendSlotView slot="composer.below" />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 0 }}>
            <button title="附件" onClick={() => p.fileRef.current?.click()} style={iconBtn}>
              <IconPaperclip />
            </button>
            {/* 追加型扩展点：输入框工具栏（agent 往这里追加操作按钮） */}
            <AppendSlotView slot="composer.actions" />
            <div ref={p.modelMenuRef} style={{ position: 'relative' }}>
              <button
                onClick={() => p.setModelMenuOpen((v) => !v)}
                style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-panel)', outline: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 180, minWidth: 0 }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                  {p.models.find((m) => m.id === p.selectedModel)?.name ?? (p.loggedIn ? '选择模型' : '未登录')}
                </span>
                <IconChevronDown />
              </button>
              {p.modelMenuOpen && (
                <div style={{ position: 'absolute', bottom: '110%', left: 0, minWidth: 260, maxHeight: 360, overflowY: 'auto', background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', zIndex: 20, padding: 4 }}>
                  <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>系统内置</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void window.shanhai?.refreshModels()
                      }}
                      title="从网关重新拉取最新模型列表"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', padding: '2px 4px', borderRadius: 4 }}
                    >
                      <IconRefresh />
                      刷新
                    </button>
                  </div>
                  {systemModels.length === 0 ? (
                    <div style={{ padding: '8px 10px', color: 'var(--text-faint)', fontSize: 12 }}>请先登录以加载模型</div>
                  ) : (
                    systemModels.map((m) => (
                      <div
                        key={m.id}
                        onClick={() => {
                          p.selectModel(m.id)
                          p.setModelMenuOpen(false)
                        }}
                        style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: m.id === p.selectedModel ? 'var(--accent)' : 'var(--text)', background: m.id === p.selectedModel ? 'var(--tint-blue-soft)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                        {m.id === p.selectedModel && <IconCheck />}
                      </div>
                    ))
                  )}
                  {customModels.length > 0 && (
                    <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginTop: 4, borderTop: '1px solid var(--border)' }}>我的模型</div>
                  )}
                  {customModels.map((m) => (
                    <div
                      key={m.id}
                      onClick={() => {
                        p.selectModel(m.id)
                        p.setModelMenuOpen(false)
                      }}
                      style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: m.id === p.selectedModel ? 'var(--accent)' : 'var(--text)', background: m.id === p.selectedModel ? 'var(--tint-blue-soft)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                      {m.id === p.selectedModel && <IconCheck />}
                    </div>
                  ))}
                  <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
                    <button
                      onClick={() => {
                        p.setModelMenuOpen(false)
                        void window.shanhai?.openApp('models')
                      }}
                      style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px dashed var(--border-strong)', background: 'var(--bg-panel)', cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                    >
                      <IconPlus /> 管理自定义模型
                    </button>
                  </div>
                </div>
              )}
            </div>
            <button
              onClick={() => void p.pickWorkdir()}
              title={`工作目录：${p.workDir || '未设置'}（点击选择目录）`}
              style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-panel)', outline: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 150 }}
            >
              <IconFolder />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.workDirName}</span>
            </button>
            <div ref={p.approvalMenuRef} style={{ position: 'relative' }}>
              <button
                onClick={() => p.setApprovalMenuOpen((v) => !v)}
                title="安全模式（审批策略）"
                style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 12, color: p.approvalPolicy === 'never' ? 'var(--warning)' : p.approvalPolicy === 'workdir' ? 'var(--accent)' : 'var(--text-secondary)', background: 'var(--bg-panel)', outline: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <IconShield />
                {p.approvalPolicy === 'ask' ? '每次询问' : p.approvalPolicy === 'workdir' ? '目录内免审批' : '自动执行'}
                <IconChevronDown />
              </button>
              {p.approvalMenuOpen && (
                <div style={{ position: 'absolute', bottom: '110%', left: 0, minWidth: 180, background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', zIndex: 20, padding: 4 }}>
                  <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>安全模式</div>
                  <div
                    onClick={() => p.switchApprovalPolicy('ask')}
                    style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: p.approvalPolicy === 'ask' ? 'var(--accent)' : 'var(--text)', background: p.approvalPolicy === 'ask' ? 'var(--tint-blue-soft)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <span>每次询问</span>
                    {p.approvalPolicy === 'ask' && <IconCheck />}
                  </div>
                  <div
                    onClick={() => p.switchApprovalPolicy('workdir')}
                    style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: p.approvalPolicy === 'workdir' ? 'var(--accent)' : 'var(--text)', background: p.approvalPolicy === 'workdir' ? 'var(--tint-blue-soft)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <span>工作目录内免审批</span>
                    {p.approvalPolicy === 'workdir' && <IconCheck />}
                  </div>
                  <div
                    onClick={() => p.switchApprovalPolicy('never')}
                    style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: p.approvalPolicy === 'never' ? 'var(--warning)' : 'var(--text)', background: p.approvalPolicy === 'never' ? 'var(--tint-orange)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <span>自动执行（不询问）</span>
                    {p.approvalPolicy === 'never' && <IconCheck />}
                  </div>
                  <div style={{ padding: '4px 10px 6px', fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                    每次询问：工作目录内也确认；工作目录内免审批：目录内自动执行、访问目录外才确认；自动执行：所有操作都不确认
                  </div>
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            <button
              title={p.recording ? '停止录音' : '语音输入（录音识别）'}
              onClick={() => void p.toggleRecording()}
              style={{ ...iconBtn, color: p.recording ? 'var(--danger)' : undefined, borderColor: p.recording ? 'var(--tint-red-strong)' : undefined, background: p.recording ? 'var(--tint-red)' : undefined, animation: p.recording ? 'micPulse 1.4s ease-in-out infinite' : undefined }}
            >
              <IconMic />
            </button>
            <button
              onClick={() => (p.busy ? p.stopSend() : void p.send())}
              disabled={!p.busy && !p.input.trim()}
              title={p.busy ? '停止' : '发送'}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                border: 'none',
                background: p.busy ? 'var(--danger)' : !p.input.trim() ? 'var(--border-strong)' : 'var(--accent)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: !p.busy && !p.input.trim() ? 'not-allowed' : 'pointer',
                flexShrink: 0,
                animation: p.busy ? 'breathe 1.6s ease-in-out infinite' : undefined,
              }}
            >
              {p.busy ? <IconStop /> : <IconSend />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
