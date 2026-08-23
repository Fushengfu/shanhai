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

  const width = node.offsetWidth
  const restorations: { el: HTMLElement; style: string }[] = []
  const patch = (el: HTMLElement, fn: (s: CSSStyleDeclaration) => void) => {
    restorations.push({ el, style: el.getAttribute('style') ?? '' })
    fn(el.style)
  }

  // 1) 锁定气泡宽度：克隆后 maxWidth:85% 会相对新的离屏容器二次计算而变小/错位，这里固定为实际渲染宽度
  patch(node, (s) => {
    s.width = `${width}px`
    s.maxWidth = `${width}px`
  })

  // 2) 代码块 / 目录列表等 pre/code 横向溢出：截图时让长行换行，避免右侧内容被裁掉
  node.querySelectorAll('pre, code').forEach((el) => {
    patch(el as HTMLElement, (s) => {
      s.whiteSpace = 'pre-wrap'
      s.wordBreak = 'break-word'
      s.overflowX = 'visible'
    })
  })

  try {
    const dataUrl = await toPng(node, {
      pixelRatio: 2,
      backgroundColor: 'var(--bg-panel)',
      width,
    })
    const blob = await (await fetch(dataUrl)).blob()
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } finally {
    // 还原临时样式，避免影响页面正常显示
    for (const { el, style } of restorations) {
      if (style) el.setAttribute('style', style)
      else el.removeAttribute('style')
    }
  }
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
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 6, border: 'none', background: 'transparent', color: done === a.key ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', padding: 0 }}
        >
          {done === a.key ? <IconCheck /> : a.icon}
        </button>
      ))}
    </div>
  )
}
