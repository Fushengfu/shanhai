import { useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconCopy, IconImage } from './icons'
import { MessageActions, copyAssistantAsImage } from './MessageActions'
import { ReasoningBlock } from './ReasoningBlock'
import { StepStats, ToolStep } from './ToolStep'
import { makeMarkdownComponents, normalizeTreeBlocks } from './Markdown'
import { copyText, formatDuration } from './ui'
import type { ToolTrace } from '../types'

/** AI 助手消息气泡：左对齐，耗时 + 工具执行步骤（紧凑）+ 思考过程（可折叠）+ 正式回答聚合在一个气泡内，气泡下方固定显示「复制 / 复制为图片」操作 */
export function AssistantMessage({ content, reasoningContent, toolSteps, turnDuration, onPreviewImage }: { content: string; reasoningContent?: string; toolSteps?: ToolTrace[]; turnDuration?: number; onPreviewImage: (url: string) => void }) {
  const bubbleRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const tools = toolSteps ?? []
  const hasReasoning = !!reasoningContent
  const hasTools = tools.length > 0
  return (
    <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <div
        ref={bubbleRef}
        style={{ maxWidth: '85%', minWidth: 0, padding: '10px 14px', borderRadius: 16, borderTopLeftRadius: 4, background: 'var(--bg-panel)', boxShadow: '0 1px 2px rgba(0,0,0,0.06)', fontSize: 14, lineHeight: 1.65, color: 'var(--text)', overflowWrap: 'anywhere', wordBreak: 'break-word', userSelect: 'text', WebkitUserSelect: 'text' }}
      >
        {(turnDuration != null || hasTools) && (
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>
            {turnDuration != null && <>耗时 {formatDuration(turnDuration)}</>}
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
        {content && (
          <div ref={contentRef} style={{ marginTop: hasTools ? 6 : 0, minWidth: 0, maxWidth: '100%', overflowX: 'auto' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeMarkdownComponents(onPreviewImage)}>
              {normalizeTreeBlocks(content)}
            </ReactMarkdown>
          </div>
        )}
      </div>
      <MessageActions
        actions={[
          { key: 'copy', icon: <IconCopy />, label: '复制', run: () => copyText(content) },
          { key: 'copyImage', icon: <IconImage />, label: '复制为图片', run: () => copyAssistantAsImage(contentRef.current) },
        ]}
      />
    </div>
  )
}
