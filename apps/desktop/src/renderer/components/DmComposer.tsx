import * as React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { IconClock, IconFile, IconPaperclip, IconSend, IconStop } from './icons'
import { iconBtn, readFileAsDataUrl } from './ui'
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  acceptAttrFor,
  classifyAttachmentFile,
  encodeDmContent,
  formatBytesShared,
  utf8Bytes,
} from '../../shared/dm-attachment'
import type { DmAttachmentPayload } from '../../shared/dm-attachment'
// 【i18n 期1】取词函数用别名 tKey，与 MemberPanel / DmQuotePicker 同一口径（避免与局部变量 t 冲突）
import { t as tKey } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

/**
 * 私信输入区（P3）：**照抄** components/Composer.tsx 的容器结构与按钮样式常量，
 * 让「会话窗口 / 管家窗口 / 私信窗口」三处输入区是同一个样子，不发明第四种。
 *
 * 逐字对齐 Composer.tsx 的地方：
 *  - 外层容器 `padding:'12px 16px 16px' + borderTop + background:var(--bg-panel)`（Composer.tsx:63）
 *  - 输入框卡片 `border:'1px solid var(--border-strong)', borderRadius:16, padding:'10px 18px 10px 16px'`（:69）
 *  - 附件缩略图 56×56 / 上传中转圈 / done 绿勾 / error 红点 title「上传失败，点击重试」/ × 移除（:71-118）
 *  - textarea `minHeight:60, maxHeight:200, resize:'none'` + IME 双重保护（:135-158）
 *  - 工具行「左侧 flex:1 minWidth:0 + 右侧 flexShrink:0」分组（:167 / :296）
 *  - 发送按钮 36×36 / borderRadius:18 / 无内容 var(--border-strong)+not-allowed / 可发 var(--accent)（:302-322）
 *
 * 与会话窗口的**有意差异**（都写在这里，避免被当成漏改）：
 *  1. 不搬模型选择 / 工作目录 / 安全模式 / 麦克风 —— 私信不跑 Agent，这些控件放进去是误导；
 *  2. 发送按钮不做「busy → 红色 IconStop + breathe」：私信没有「停止发送」这种可中断动作，
 *     照搬会做出一个「看着能点、点了什么都没停」的假按钮（本项目反复踩的静默失败）。
 *     发送中沿用同一尺寸与圆角，配色保持 accent、禁用并改 title 说明「正在发送」，图标用 IconStop 表示「再点无效」。
 *  3. 多了一行「编码后字节 / 上限」计数：私信 content 有字节上限（上限值见 shared 的 DM_MAX_CONTENT_BYTES），且附件引用也计入。
 *
 * 【硬约束】附件一律「先上传拿公网 URL → 消息里只放引用」，**绝不把 base64 塞进私信消息**；
 * 本地 dataUrl 只用于发送前的预览（用户拍板：粘贴后先本地预览再发、可取消）。
 */

/** 一条待发送的私信附件（本地态；dataUrl 只在内存里做预览，不进消息体） */
export interface DmPendingAttachment {
  id: string
  kind: 'image' | 'file'
  name: string
  mime: string
  size: number
  /** 本地预览用 data URL（**绝不进 content**） */
  dataUrl: string
  /** 上传成功后的公网直链 */
  url?: string
  /** 沿用会话窗口既有的状态机取值（AttachmentItem.uploadStatus），不另立一套 */
  uploadStatus: 'uploading' | 'done' | 'error'
  /** 上传失败的原因（如实展示，不只剩一个红点） */
  error?: string
  w?: number
  h?: number
}

/** 附件 → 消息里的引用对象（只有传完的才有 URL，调用方已过滤） */
export function dmAttToPayload(a: DmPendingAttachment): DmAttachmentPayload {
  const out: DmAttachmentPayload = { t: a.kind, u: a.url ?? '', n: a.name, s: a.size }
  if (a.w && a.h) {
    out.w = a.w
    out.h = a.h
  }
  return out
}

export interface DmComposerProps {
  /** 会员通道就绪（connected + 已知本账号身份） */
  ready: boolean
  /** 全局登录态：未登录时不能上传（凭证在主进程，网关会回 401），必须给出路 */
  loggedIn: boolean
  /** 对方显示名（调用方必须已用 displayNameOf 归一；本组件不参与任何显示兜底） */
  peerName: string
  /** 单条私信 content 字节上限（调用方传 shared 的 DM_MAX_CONTENT_BYTES，与主进程同口径） */
  maxContentBytes: number
  /**
   * 真正发送：返回 true = 已交给主进程（本组件清空输入与附件）；
   * 返回 false = 上层没发出去（原因由上层渲染到提示条，本组件**保留**输入与附件，不丢用户已写的东西）。
   */
  onSend: (text: string, atts: DmAttachmentPayload[]) => Promise<boolean>
  /** 被本组件拦下时（未登录 / 没就绪 / 上传未完成 / 超限）交出一条可见原因；传空串表示清除上一条原因 */
  onBlocked: (reason: string) => void
  /** 【P6】初始正文：切回该会话时用它重建输入框内容（父组件按 channelId 存草稿） */
  initialText?: string
  /** 【P6】每次输入变化实时上报（父组件据此存草稿） */
  onTextChange?: (text: string) => void
  /** 【P6】发送成功后通知父组件清除该会话草稿 */
  onSent?: () => void
  /** 点缩略图看大图（复用既有 ImagePreview 遮罩） */
  onPreviewImage: (src: string) => void
}

/** 生成附件唯一 id（与会话窗口 ChatComposer 同一写法） */
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 读图片自然尺寸（拿不到就返回 null，不阻塞发送） */
function readImageSize(dataUrl: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new window.Image()
    const finish = (v: { w: number; h: number } | null): void => {
      img.onload = null
      img.onerror = null
      resolve(v)
    }
    img.onload = () => finish({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 })
    img.onerror = () => finish(null)
    img.src = dataUrl
  })
}

/** data URL → 纯 base64（与会话窗口同一口径） */
function stripDataUrl(dataUrl: string): string {
  return dataUrl.replace(/^data:[^;]+;base64,/, '')
}

export function DmComposer(p: DmComposerProps): React.JSX.Element {
  // 同 MemberPanel：本组件在 render 期直接取词，必须自订阅语言变化
  useLocaleSync()
  const [text, setText] = useState(p.initialText ?? '')
  const [atts, setAtts] = useState<DmPendingAttachment[]>([])
  const [sending, setSending] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const isComposingRef = useRef(false)
  /** 异步回调里读最新附件清单（避免闭包捕获旧数组） */
  const attsRef = useRef<DmPendingAttachment[]>(atts)
  attsRef.current = atts

  const accept = useMemo(() => acceptAttrFor({ allowAudioVideo: false }), [])
  const uploadingCount = atts.filter((a) => a.uploadStatus === 'uploading').length
  const failedCount = atts.filter((a) => a.uploadStatus === 'error').length
  const donePayloads = useMemo(() => atts.filter((a) => a.uploadStatus === 'done' && a.url).map(dmAttToPayload), [atts])
  /** 计数按**编码后的 content** 算：只数正文会算少（附件引用也占字节），会出现「本地以为没超、网关回 content_too_long」 */
  const totalBytes = useMemo(() => utf8Bytes(encodeDmContent(text, donePayloads)), [text, donePayloads])
  const overLimit = totalBytes > p.maxContentBytes
  const hasPayload = text.trim().length > 0 || atts.length > 0
  /** 能不能发：登录 + 就绪 + 有内容 + 不超限 + 附件全部传完且无失败 + 未在发送中 */
  const canSend = p.ready && p.loggedIn && hasPayload && !overLimit && uploadingCount === 0 && failedCount === 0 && !sending

  const patchAtt = useCallback(
    (id: string, patch: Partial<DmPendingAttachment>): void => {
      setAtts((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)))
    },
    [],
  )

  /**
   * 上传一个附件：图片走既有 uploadImage、文档走本期新增的 uploadFile，
   * 两条都是同一条云存储通道（会员 JWT 换凭证 → 七牛直传），凭证只在主进程、渲染层拿不到。
   */
  const upload = useCallback(
    (id: string, kind: 'image' | 'file', dataUrl: string, mime: string, name: string): void => {
      void (async () => {
        const bridge = window.shanhai
        const base64 = stripDataUrl(dataUrl)
        const api = kind === 'image' ? bridge?.uploadImage : bridge?.uploadFile
        if (!api) {
          // 可选链会把「桥不存在」吞成 undefined → 这里显式区分，不能报成「上传失败」
          patchAtt(id, { uploadStatus: 'error', error: kind === 'image' ? tKey('dm.composer.noImageBridge') : tKey('dm.composer.noFileBridge') })
          return
        }
        try {
          const url = (kind === 'image' ? await api(base64, mime || 'image/png') : await api(base64, mime || 'application/octet-stream', name)) ?? null
          // 既有语义：返回 null 涵盖「未登录 / 网关异常 / 超时(15s)」三种，主进程不带详情 → 如实列出，不猜是哪种
          patchAtt(id, url ? { uploadStatus: 'done', url, error: undefined } : { uploadStatus: 'error', error: tKey('dm.composer.uploadFailed') })
        } catch (e) {
          patchAtt(id, { uploadStatus: 'error', error: tKey('dm.composer.uploadException', { error: e instanceof Error ? e.message : String(e) }) })
        }
      })()
    },
    [patchAtt],
  )

  /** 收下一个文件：先过规矩（类型 / 大小），拒因立刻可见；通过才读盘 + 上传（粘贴后先本地预览、可取消） */
  const acceptFile = useCallback(
    async (file: File, fallbackName: string): Promise<void> => {
      const name = file.name || fallbackName
      if (!p.loggedIn) {
        p.onBlocked(tKey('dm.composer.blockedNoLoginAttach'))
        return
      }
      const cls = classifyAttachmentFile({ name, mime: file.type, size: file.size }, { allowAudioVideo: false })
      if (!cls.ok || cls.kind === 'audio' || cls.kind === 'video') {
        p.onBlocked(tKey('dm.composer.blockedFile', { name, reason: cls.ok ? tKey('dm.composer.avNotAllowed') : cls.reason }))
        return
      }
      const kind: 'image' | 'file' = cls.kind === 'image' ? 'image' : 'file'
      let dataUrl = ''
      try {
        dataUrl = await readFileAsDataUrl(file)
      } catch (e) {
        p.onBlocked(tKey('dm.composer.readFailed', { error: e instanceof Error ? e.message : String(e) }))
        return
      }
      const id = genId()
      setAtts((prev) => [...prev, { id, kind, name, mime: file.type || (kind === 'image' ? 'image/png' : 'application/octet-stream'), size: file.size, dataUrl, uploadStatus: 'uploading' }])
      if (kind === 'image') {
        const dim = await readImageSize(dataUrl)
        if (dim) patchAtt(id, { w: dim.w, h: dim.h })
      }
      upload(id, kind, dataUrl, file.type, name)
    },
    [p, patchAtt, upload],
  )

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const files = e.target.files
      if (!files || files.length === 0) return
      for (const file of Array.from(files)) {
        await acceptFile(file, tKey('dm.composer.unnamedFile'))
      }
      // 清空 value，保证「连续选同一个文件」也会再触发 change（会话窗口同样做法）
      e.target.value = ''
    },
    [acceptFile],
  )

  /** 粘贴截图：clipboardData.items → getAsFile()（与 ChatComposer:186-201 同一实现；缩略图立刻出现即反馈，不额外弹提示） */
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (!item.type.startsWith('image/')) continue
        const file = item.getAsFile()
        if (!file) continue
        await acceptFile(file, `pasted-${Date.now()}.png`)
      }
    },
    [acceptFile],
  )

  const retryUpload = useCallback(
    (id: string): void => {
      const a = attsRef.current.find((x) => x.id === id)
      if (!a) return
      patchAtt(id, { uploadStatus: 'uploading', url: undefined, error: undefined })
      upload(id, a.kind, a.dataUrl, a.mime, a.name)
    },
    [patchAtt, upload],
  )

  /** 发送前的闸门：每一条都给出**可区分**的可见原因（禁止像 App.tsx:636 那样静默 return） */
  const send = useCallback(async (): Promise<void> => {
    if (sending) return
    if (!p.loggedIn) {
      p.onBlocked(tKey('dm.composer.blockedNoLogin'))
      return
    }
    if (!p.ready) {
      p.onBlocked(tKey('dm.composer.blockedNotReady'))
      return
    }
    const trimmed = text.trim()
    if (!trimmed && atts.length === 0) {
      p.onBlocked(tKey('dm.composer.blockedEmpty'))
      return
    }
    if (uploadingCount > 0) {
      p.onBlocked(tKey('dm.composer.blockedUploading', { n: uploadingCount }))
      return
    }
    if (failedCount > 0) {
      p.onBlocked(tKey('dm.composer.blockedFailed', { n: failedCount }))
      return
    }
    const content = encodeDmContent(trimmed, donePayloads)
    const bytes = utf8Bytes(content)
    if (bytes > p.maxContentBytes) {
      // 【任务113】超限文案收敛成共享词条 dm.contentTooLong（与主进程 / 私信面板同一份文案、同一组参数名）
      p.onBlocked(tKey('dm.contentTooLong', { bytes, max: p.maxContentBytes }))
      return
    }
    setSending(true)
    try {
      const ok = await p.onSend(trimmed, donePayloads)
      if (ok) {
        setText('')
        setAtts([])
        p.onSent?.()
      }
    } finally {
      setSending(false)
    }
  }, [atts, donePayloads, failedCount, p, sending, text, uploadingCount])

  const placeholder = !p.loggedIn
    ? tKey('dm.composer.placeholderNoLogin')
    : !p.ready
      ? tKey('dm.composer.placeholderNotReady')
      : tKey('dm.composer.placeholder', { name: p.peerName })

  return (
    <div style={{ padding: '12px 16px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg-panel)', boxSizing: 'border-box', flexShrink: 0 }}>
      <div style={{ border: '1px solid var(--border-strong)', borderRadius: 16, padding: '10px 18px 10px 16px', background: 'var(--bg-panel)', width: '100%', boxSizing: 'border-box' }}>
        {/* 附件条：结构与 Composer.tsx:71-118 同款（56×56 / 转圈 / 绿勾 / 红点重试 / × 移除） */}
        {atts.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {atts.map((a) => (
              <div key={a.id} style={{ position: 'relative' }}>
                {a.kind === 'image' ? (
                  <>
                    <img
                      src={a.dataUrl}
                      alt={a.name}
                      onClick={() => p.onPreviewImage(a.url ?? a.dataUrl)}
                      title={a.uploadStatus === 'uploading' ? tKey('dm.composer.attUploading') : a.uploadStatus === 'error' ? (a.error ?? tKey('dm.composer.attFailedRetry')) : tKey('dm.composer.attImageTip', { name: a.name, size: formatBytesShared(a.size) })}
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
                        title={a.error ?? tKey('dm.composer.attFailedRetry')}
                        onClick={() => retryUpload(a.id)}
                        style={{ position: 'absolute', right: -4, bottom: -4, width: 16, height: 16, borderRadius: '50%', background: 'var(--danger)', color: '#fff', fontSize: 11, lineHeight: '16px', textAlign: 'center', cursor: 'pointer' }}
                      >
                        !
                      </div>
                    )}
                  </>
                ) : (
                  <div
                    title={a.uploadStatus === 'error' ? tKey('dm.composer.attFailedTip', { name: a.name, size: formatBytesShared(a.size), error: a.error ?? tKey('dm.composer.attFailedRetry') }) : tKey('dm.composer.attImageTip', { name: a.name, size: formatBytesShared(a.size) })}
                    onClick={() => {
                      if (a.uploadStatus === 'error') retryUpload(a.id)
                    }}
                    style={{ width: 56, height: 56, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-app)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', gap: 2, padding: '0 4px', boxSizing: 'border-box', cursor: a.uploadStatus === 'error' ? 'pointer' : 'default', opacity: a.uploadStatus === 'uploading' ? 0.5 : 1 }}
                  >
                    <IconFile />
                    <div style={{ fontSize: 8, lineHeight: 1.1, color: 'var(--text-muted)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.name.length > 8 ? `${a.name.slice(0, 8)}…` : a.name}
                    </div>
                    {a.uploadStatus === 'uploading' && <div style={{ width: 14, height: 14, border: '2px solid var(--border-strong)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />}
                    {a.uploadStatus === 'done' && <div style={{ fontSize: 10, color: 'var(--success)' }}>✓</div>}
                    {a.uploadStatus === 'error' && <div style={{ fontSize: 11, color: 'var(--danger)' }}>!</div>}
                  </div>
                )}
                <button
                  onClick={() => setAtts((prev) => prev.filter((x) => x.id !== a.id))}
                  title={tKey('dm.composer.attRemoveTitle')}
                  style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', border: 'none', background: 'var(--danger)', color: '#fff', fontSize: 12, lineHeight: '18px', cursor: 'pointer', padding: 0 }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <input ref={fileRef} type="file" multiple accept={accept} style={{ display: 'none' }} onChange={(e) => void handleFileSelect(e)} />
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); p.onTextChange?.(e.target.value) }}
          onCompositionStart={() => {
            isComposingRef.current = true
          }}
          onCompositionEnd={() => {
            // macOS 等平台的原生输入法在按回车确认候选词时，compositionend 会先于紧随的
            // keydown(Enter) 触发；若立即置 false，那个「选词回车」会被误判成发送。
            // 延迟到下一个宏任务再清除（照抄 Composer.tsx:139-147）。
            setTimeout(() => {
              isComposingRef.current = false
            }, 0)
          }}
          onKeyDown={(e) => {
            // keyCode 229 = 该按键正在被 IME 处理（组合中），不应触发发送（照抄 Composer.tsx:149-156）
            const composing = isComposingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229
            if (e.key === 'Enter' && !e.shiftKey && !composing) {
              e.preventDefault()
              void send()
            }
          }}
          onPaste={(e) => void handlePaste(e)}
          rows={3}
          placeholder={placeholder}
          style={{ width: '100%', border: 'none', outline: 'none', resize: 'none', fontSize: 14, lineHeight: 1.6, background: 'transparent', minHeight: 60, maxHeight: 200, fontFamily: 'inherit', display: 'block', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 0 }}>
            <button
              title={tKey('dm.composer.attachTitle', { imgMax: formatBytesShared(MAX_IMAGE_BYTES), docMax: formatBytesShared(MAX_FILE_BYTES) })}
              onClick={() => fileRef.current?.click()}
              disabled={!p.loggedIn}
              style={{ ...iconBtn, cursor: !p.loggedIn ? 'not-allowed' : 'pointer', opacity: !p.loggedIn ? 0.5 : 1 }}
            >
              <IconPaperclip />
            </button>
            {/* 字节计数：私信独有的硬约束（编码后 content ≤ 上限字节），放工具行左侧不压住文字 */}
            <span title={tKey('dm.composer.byteTitle', { max: p.maxContentBytes })} style={{ fontSize: 11, color: overLimit ? 'var(--danger-text, #b91c1c)' : 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
              {tKey('dm.composer.byteLine', { bytes: totalBytes, max: p.maxContentBytes })}{overLimit ? tKey('dm.composer.byteOver') : ''}
            </span>
            {uploadingCount > 0 && (
              <span style={{ fontSize: 11, color: 'var(--warning)', display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                <IconClock />
                {tKey('dm.composer.uploadingCount', { n: uploadingCount })}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            <button
              onClick={() => void send()}
              disabled={!canSend}
              title={
                sending
                  ? tKey('dm.composer.sending')
                  : !p.loggedIn
                    ? tKey('dm.composer.tipNoLogin')
                    : !p.ready
                      ? tKey('dm.composer.tipNotReady')
                      : failedCount > 0
                        ? tKey('dm.composer.tipFailedAtt')
                        : uploadingCount > 0
                          ? tKey('dm.composer.tipUploading')
                          : overLimit
                            ? tKey('dm.composer.tipOverLimit')
                            : !hasPayload
                              ? tKey('dm.composer.tipEmpty')
                              : tKey('common.send')
              }
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                border: 'none',
                background: !canSend ? 'var(--border-strong)' : 'var(--accent)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: !canSend ? 'not-allowed' : 'pointer',
                flexShrink: 0,
              }}
            >
              {sending ? <IconStop /> : <IconSend />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

