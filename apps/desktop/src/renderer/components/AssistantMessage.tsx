import { memo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconCopy, IconImage, IconShare } from './icons'
import { MessageActions, copyAssistantAsImage } from './MessageActions'
import { ReasoningBlock } from './ReasoningBlock'
import { StepStats, ToolStep } from './ToolStep'
import { makeMarkdownComponents, normalizeTreeBlocks, stripWrappedRecordTag } from './Markdown'
import { DmSharePicker } from './DmSharePicker'
import { copyText, formatDuration } from './ui'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'
import type { ToolTrace } from '../types'

/** AI 助手消息气泡：左对齐，耗时 + 工具执行步骤（紧凑）+ 思考过程（可折叠）+ 正式回答聚合在一个气泡内，气泡下方固定显示「复制 / 复制为图片 / 分享到好友」操作 */
export const AssistantMessage = memo(function AssistantMessage({ content, reasoningContent, toolSteps, turnDuration, onPreviewImage }: { content: string; reasoningContent?: string; toolSteps?: ToolTrace[]; turnDuration?: number; onPreviewImage: (url: string) => void }) {
  useLocaleSync()
  // 【任务109】分享弹层开关：放在任何 return 之前（条件性 Hook 调用会让整棵树崩掉 —— SessionRow 白屏教训）
  const [shareOpen, setShareOpen] = useState(false)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const tools = toolSteps ?? []
  const hasReasoning = !!reasoningContent
  const hasTools = tools.length > 0
  // 渲染前保守去壳：仅整段被系统内置标签包裹时剥标签，夹在正文中间/转义/普通 HTML 均不处理
  const displayContent = stripWrappedRecordTag(content)
  return (
    <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0, maxWidth: '100%' }}>
      <div
        ref={bubbleRef}
        style={{ width: '85%', maxWidth: '85%', minWidth: 0, boxSizing: 'border-box', padding: '10px 14px', borderRadius: 16, borderTopLeftRadius: 4, background: 'var(--bg-panel)', boxShadow: '0 1px 2px rgba(0,0,0,0.06)', fontSize: 14, lineHeight: 1.65, color: 'var(--text)', overflowWrap: 'anywhere', wordBreak: 'break-word', userSelect: 'text', WebkitUserSelect: 'text' }}
      >
        {(turnDuration != null || hasTools) && (
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>
            {turnDuration != null && <>{t('chat.time.elapsed')} {formatDuration(turnDuration)}</>}
            <StepStats tools={tools} />
          </div>
        )}
        {hasTools && (
          <div style={{ margin: '0 0 2px' }}>
            {tools.map((t) => (
              <ToolStep key={t.callId} trace={t} />
            ))}
          </div>
        )}
        {hasReasoning && <ReasoningBlock content={reasoningContent} />}
        {displayContent && (
          <div ref={contentRef} style={{ marginTop: hasTools ? 6 : 0, minWidth: 0, maxWidth: '100%', overflowX: 'auto' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeMarkdownComponents(onPreviewImage)}>
              {normalizeTreeBlocks(displayContent)}
            </ReactMarkdown>
          </div>
        )}
      </div>
      <MessageActions
        actions={[
          { key: 'copy', icon: <IconCopy />, label: t('common.copy'), run: () => copyText(displayContent) },
          { key: 'copyImage', icon: <IconImage />, label: t('chat.msg.copyImage'), run: () => copyAssistantAsImage(contentRef.current) },
          // 【任务109】分享到指定好友：取文与 copy 同源（stripWrappedRecordTag 后的 displayContent），
          // 不分享思考过程；弹层是 position:fixed，不占消息流空间
          { key: 'share', icon: <IconShare />, label: t('chat.share.button'), run: () => setShareOpen(true) },
        ]}
      />
      {shareOpen && <DmSharePicker body={displayContent} source="assistant" onClose={() => setShareOpen(false)} />}
    </div>
  )
})
