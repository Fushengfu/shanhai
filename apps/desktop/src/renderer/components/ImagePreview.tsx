import { useEffect } from 'react'

/** 图片预览遮罩层：全屏半透明背景 + 居中大图，点击背景或 Esc 关闭 */
export function ImagePreview({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        cursor: 'zoom-out',
      }}
    >
      <img
        src={src}
        alt="预览"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '92%', maxHeight: '92%', objectFit: 'contain', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }}
      />
    </div>
  )
}
