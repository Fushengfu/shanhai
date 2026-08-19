import { useState } from 'react'
import { toPng } from 'html-to-image'
import { IconCheck } from './icons'

export interface MessageAction {
  key: string
  icon: React.ReactNode
  label: string
  run: () => void | Promise<void>
}

/** 把 AI 回复的气泡 DOM 节点原样截图成图片写入剪贴板（html-to-image 精确还原渲染效果，与界面显示一致，2x 高清） */
export async function copyAssistantAsImage(node: HTMLElement | null): Promise<void> {
  if (!node) throw new Error('未找到要复制的消息节点')
  const dataUrl = await toPng(node, {
    pixelRatio: 2,
    backgroundColor: '#ffffff',
  })
  const blob = await (await fetch(dataUrl)).blob()
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

/** 消息图标操作行（参考 taco 的 msg-actions：常显在气泡下方，图标按钮 + 点击后对勾反馈） */
export function MessageActions({ actions }: { actions: MessageAction[] }) {
  const [done, setDone] = useState<string | null>(null)
  return (
    <div style={{ display: 'flex', gap: 2, marginTop: 4, opacity: 0.85, transition: 'opacity .15s' }}>
      {actions.map((a) => (
        <button
          key={a.key}
          title={a.label}
          onClick={() => {
            try {
              void a.run()
            } catch {
              /* 忽略复制失败 */
            }
            setDone(a.key)
            window.setTimeout(() => setDone((v) => (v === a.key ? null : v)), 1000)
          }}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 6, border: 'none', background: 'transparent', color: done === a.key ? '#1677ff' : '#999', cursor: 'pointer', padding: 0 }}
        >
          {done === a.key ? <IconCheck /> : a.icon}
        </button>
      ))}
    </div>
  )
}
