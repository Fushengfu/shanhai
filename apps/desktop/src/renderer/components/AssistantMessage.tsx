import { useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconCopy, IconImage, IconMic } from './icons'
import { MessageActions, copyAssistantAsImage } from './MessageActions'
import { ReasoningBlock } from './ReasoningBlock'
import { makeMarkdownComponents } from './Markdown'
import { copyText } from './ui'

/** AI 助手消息卡片：左对齐，思考过程（可折叠）+ 正式回答，气泡下方固定显示「复制 / 复制为图片 / 朗读」操作 */
export function AssistantMessage({ content, reasoningContent, onPreviewImage }: { content: string; reasoningContent?: string; onPreviewImage: (url: string) => void }) {
  const bubbleRef = useRef<HTMLDivElement>(null)
  return (
    <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      {reasoningContent && <ReasoningBlock content={reasoningContent} />}
      <div ref={bubbleRef} style={{ maxWidth: '85%', padding: '10px 14px', borderRadius: 16, borderTopLeftRadius: 4, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.06)', fontSize: 14, lineHeight: 1.65, color: '#333', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeMarkdownComponents(onPreviewImage)}>
          {content}
        </ReactMarkdown>
      </div>
      <MessageActions
        actions={[
          { key: 'copy', icon: <IconCopy />, label: '复制', run: () => copyText(content) },
          { key: 'copyImage', icon: <IconImage />, label: '复制为图片', run: () => copyAssistantAsImage(bubbleRef.current) },
          { key: 'speak', icon: <IconMic />, label: '朗读', run: () => void window.shanhai?.speak(content) },
        ]}
      />
    </div>
  )
}
