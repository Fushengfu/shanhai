import * as React from 'react'
import { useEffect, useRef } from 'react'

/**
 * 量子立体粒子特效（Canvas 3D，无第三方依赖）。
 * - 粒子均匀分布在球体表面（fibonacci sphere），绕 Y/X 轴 3D 旋转
 * - 邻近粒子之间绘制「量子纠缠」连线，形成立体神经网络质感
 * - 中心发光核心 + 粒子深度着色（近处青蓝 / 远处紫）
 * - speaking=true 时：旋转加速 + 整体呼吸扩散 + 粒子辉光增强
 * 用途：语音播报时置顶浮层展示；桌面壳窗口常驻装饰（speaking=false）。
 */
interface Particle {
  x: number
  y: number
  z: number
}

const PARTICLE_COUNT = 150
const SPHERE_RADIUS = 96
const SIZE = 320

/** 球面均匀采样（Fibonacci sphere） */
function fibonacciSphere(n: number, radius: number): Particle[] {
  const pts: Particle[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(n - 1, 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    pts.push({ x: Math.cos(theta) * r * radius, y: y * radius, z: Math.sin(theta) * r * radius })
  }
  return pts
}

export function AiOrb({ speaking = false }: { speaking?: boolean }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const speakingRef = useRef(speaking)
  speakingRef.current = speaking

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = SIZE * dpr
    canvas.height = SIZE * dpr
    canvas.style.width = `${SIZE}px`
    canvas.style.height = `${SIZE}px`
    ctx.scale(dpr, dpr)

    const particles = fibonacciSphere(PARTICLE_COUNT, SPHERE_RADIUS)
    let angleY = 0
    let angleX = 0
    let raf = 0
    let last = performance.now()

    const draw = (now: number): void => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      const speakingNow = speakingRef.current
      const speed = speakingNow ? 1.15 : 0.35
      angleY += dt * speed
      angleX += dt * speed * 0.62
      const pulse = speakingNow ? 1 + 0.09 * Math.sin(now / 160) : 1 + 0.03 * Math.sin(now / 420)

      ctx.clearRect(0, 0, SIZE, SIZE)
      const cx = SIZE / 2
      const cy = SIZE / 2
      const radius = SPHERE_RADIUS * pulse
      const cosY = Math.cos(angleY)
      const sinY = Math.sin(angleY)
      const cosX = Math.cos(angleX)
      const sinX = Math.sin(angleX)

      const proj: { px: number; py: number; d: number }[] = particles.map((p) => {
        // 绕 Y 轴
        const x1 = p.x * cosY + p.z * sinY
        const z1 = -p.x * sinY + p.z * cosY
        const y1 = p.y
        // 绕 X 轴
        const y2 = y1 * cosX - z1 * sinX
        const z2 = y1 * sinX + z1 * cosX
        const scale = radius / SPHERE_RADIUS
        return { px: cx + x1 * scale, py: cy + y2 * scale, d: z2 / SPHERE_RADIUS }
      })

      // 量子纠缠连线（邻近粒子之间）
      const linkDist = speakingNow ? 36 : 27
      ctx.lineWidth = 1
      for (let i = 0; i < proj.length; i++) {
        const a = proj[i]
        if (!a) continue
        for (let j = i + 1; j < proj.length; j++) {
          const b = proj[j]
          if (!b) continue
          const dx = a.px - b.px
          const dy = a.py - b.py
          const dist = Math.hypot(dx, dy)
          if (dist < linkDist) {
            const alpha = (1 - dist / linkDist) * 0.34
            ctx.strokeStyle = `rgba(99,132,248,${alpha.toFixed(3)})`
            ctx.beginPath()
            ctx.moveTo(a.px, a.py)
            ctx.lineTo(b.px, b.py)
            ctx.stroke()
          }
        }
      }

      // 发光粒子（近处青蓝 / 远处紫，带深度）
      for (const p of proj) {
        if (!p) continue
        const depthAlpha = 0.5 + ((p.d + 1) / 2) * 0.5
        const r = 1.1 + ((p.d + 1) / 2) * 1.7
        ctx.shadowBlur = speakingNow ? 12 : 7
        ctx.shadowColor = 'rgba(34,211,238,0.9)'
        ctx.fillStyle = p.d > 0.15 ? 'rgba(34,211,238,0.95)' : 'rgba(139,92,246,0.85)'
        ctx.globalAlpha = depthAlpha
        ctx.beginPath()
        ctx.arc(p.px, p.py, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      ctx.shadowBlur = 0

      // 中心发光核心
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.42)
      core.addColorStop(0, 'rgba(255,255,255,0.95)')
      core.addColorStop(0.35, 'rgba(129,140,248,0.9)')
      core.addColorStop(0.7, 'rgba(99,102,241,0.72)')
      core.addColorStop(1, 'rgba(76,29,149,0)')
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx, cy, radius * 0.42, 0, Math.PI * 2)
      ctx.fill()

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: SIZE, height: SIZE, display: 'block', pointerEvents: 'none', userSelect: 'none' }}
      aria-label="AI 语音播报特效"
    />
  )
}
