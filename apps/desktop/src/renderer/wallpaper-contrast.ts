import type { CSSProperties } from 'react'

/**
 * 桌面壳壁纸上「插件应用标题」的可读性自适应（任务188）。
 *
 * 为什么要这个模块（实测依据，不是"看起来不清"）：标题原先固定用 var(--text)
 * （亮 #333333 / 暗 #e0e0e0）直接压在任意壁纸上，12 张预设渐变里
 * 亮色主题 9 张、暗色主题 8 张低于 WCAG 4.5:1，各有 8 张低于 3:1
 * （最坏：亮主题压 ocean 1.05:1、暗主题压 mist 1.32:1）。
 * 而且同一张壁纸在两套主题下的失效方向相反（亮主题怕深壁纸、暗主题怕浅壁纸），
 * 说明"一个固定色"在原理上不可能通吃 —— 必须要么加底板、要么随壁纸翻转。
 *
 * 两层做法：
 *  - 底层保障（无条件生效，不依赖任何背景信息）：半透明底板 chip + 双向描边。
 *    底板不透明度取"对全 0..255 灰阶都 ≥4.5:1"的最小值（见 CHIP_ALPHA_* 注释的实测数）。
 *  - 上层优化（能估出壁纸亮度时）：文字与底板方向随壁纸翻转
 *    （深壁纸→亮字+深底板；浅壁纸→深字+亮底板），观感更接近系统桌面。
 *  - 取不到亮度（远程图 / 解码失败 / 不支持的形态）一律退回兜底档，
 *    禁止静默失效；兜底档本身已保证 ≥4.5:1，所以"自适应挂了"也不会看不见。
 *
 * 颜色纪律：本模块与消费方都不出现任何新色值，全部由 theme.css 既有变量经 color-mix 派生。
 * 之所以取 --dock-ink / --dock-shade：它们是仓库里唯二"在明暗两套主题下方向恒定"的令牌
 * （ink 两套都是近白、shade 两套都是近黑），适合当"亮字/深字"；而 --text/--bg-panel 会随主题翻转，
 * 正好当兜底档（主题同向）。
 */

/** 标题配色档位：onDarkWallpaper=壁纸偏深（用亮字+深底板）；fallback=亮度未知（用主题同向底板） */
export type TitleScheme = 'onDarkWallpaper' | 'onLightWallpaper' | 'fallback'

/**
 * 壁纸亮度翻转阈值（WCAG 相对亮度，0..1）。
 * 推导：不加底板时，亮字(--dock-ink #ffffff)要达 4.5:1 需壁纸亮度 ≤0.183；
 * 深字(--dock-shade #0b1b3a)要达 4.5:1 需壁纸亮度 ≥0.231 —— 中间 [0.183,0.231] 是
 * "两种字都不够"的死区，取死区中点 0.207 圆整为 0.20。
 * 注意：阈值只决定"翻转方向"，不决定安全性 —— 安全性由底板 alpha 兜住（见下）。
 */
export const LUMINANCE_SPLIT = 0.2

/**
 * 已知壁纸方向时的底板不透明度。实测（对"该方向"最坏灰阶）：
 * 深底板+亮字 亮主题 10.26 / 暗主题 11.80；亮底板+深字 亮主题 10.91 / 暗主题 10.08，全部 ≥4.5。
 * 更关键：即便方向估反，对全 0..255 灰阶仍分别有 4.87 / 5.57 / 6.37 / 5.79 —— 不会跌破 4.5。
 */
export const CHIP_ALPHA_ADAPTIVE = 0.62

/**
 * 方向未知时的兜底底板不透明度（底板与文字都随主题翻转：--bg-panel + --text，同 AppMenuPanel 的派生法）。
 * 实测对全灰阶最坏：亮主题 A=0.70 只有 4.28（不达标）、A=0.78 才 7.47；暗主题 A=0.78 为 5.58
 * —— 0.78 是"两套主题都 ≥4.5:1"的最小档（0.70 会让暗主题跌破），故取 0.78。
 */
export const CHIP_ALPHA_FALLBACK = 0.78

/** 底板圆角（px）：与 Dock 卡片 14、磁贴 8 同一语言里取更小的胶囊档 */
export const CHIP_RADIUS = 7
/** 底板内边距（px）：上下 1px 让 12px 字号有呼吸，左右 6px 不吞掉省略号 */
export const CHIP_PADDING = '1px 6px'

export type Rgb = readonly [number, number, number]

/** sRGB 单通道 → 线性值（WCAG 公式） */
export function srgbToLinear(v8: number): number {
  const c = v8 / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 相对亮度 */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2])
}

/** WCAG 对比度（无序，恒 ≥1） */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** 半透明色压在底色上的等效不透明色（底板对比度必须按"混合后的实际像素"算，不能按底板自身色算） */
export function compositeOver(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [
    Math.round(alpha * fg[0] + (1 - alpha) * bg[0]),
    Math.round(alpha * fg[1] + (1 - alpha) * bg[1]),
    Math.round(alpha * fg[2] + (1 - alpha) * bg[2]),
  ]
}

/** 一个从 CSS 里解析出来的颜色：rgb 分量 + 自身 alpha（渐变里的 rgba 光晕层 alpha<1） */
export interface ParsedColor {
  rgb: Rgb
  alpha: number
}

const HEX_RE = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g
const RGB_RE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)/g
const VAR_RE = /var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g

function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

/** 解析 CSS 串里的十六进制与 rgb()/rgba() 颜色（不解析颜色名，解析不到就返回空） */
export function parseCssColors(css: string): ParsedColor[] {
  const out: ParsedColor[] = []
  for (const m of css.matchAll(HEX_RE)) {
    const raw = m[1]
    if (!raw) continue
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
    out.push({
      rgb: [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)],
      alpha: 1,
    })
  }
  for (const m of css.matchAll(RGB_RE)) {
    const r = m[1]
    const g = m[2]
    const b = m[3]
    if (r === undefined || g === undefined || b === undefined) continue
    out.push({ rgb: [clamp8(+r), clamp8(+g), clamp8(+b)], alpha: m[4] === undefined ? 1 : Number(m[4]) })
  }
  return out
}

/** CSS 串里出现的 var(--x) 变量名（去重，保持出现顺序） */
export function cssVarNames(css: string): string[] {
  const seen = new Set<string>()
  for (const m of css.matchAll(VAR_RE)) if (m[1]) seen.add(m[1])
  return [...seen]
}

/** 多个不透明色的逐通道平均（空数组返回 null，让调用方显式处理"估不出"） */
function averageRgb(colors: Rgb[]): Rgb | null {
  if (colors.length === 0) return null
  let r = 0
  let g = 0
  let b = 0
  for (const c of colors) {
    r += c[0]
    g += c[1]
    b += c[2]
  }
  const n = colors.length
  return [r / n, g / n, b / n]
}

/**
 * 从 CSS 背景值估亮度：不透明色标取平均，半透明色标（科技系壁纸的 radial 光晕）按自身 alpha
 * 叠加到均值上 —— 只算不透明色标会让 deepspace/cyber 这类"深色底 + 亮色光晕"被系统性低估。
 * var(--x) 走 resolveVar（浏览器里读 computed style；测试里注入桩）。
 */
export function cssLuminance(css: string, resolveVar?: (name: string) => string | null): number | null {
  const colors = parseCssColors(css)
  if (resolveVar) {
    for (const name of cssVarNames(css)) {
      const v = resolveVar(name)
      if (!v) continue
      const first = parseCssColors(v)[0]
      if (first) colors.push(first)
    }
  }
  const opaque = colors.filter((c) => c.alpha >= 1).map((c) => c.rgb)
  let base = averageRgb(opaque)
  for (const c of colors) {
    if (c.alpha < 1) base = base ? compositeOver(c.rgb, c.alpha, base) : c.rgb
  }
  return base ? relativeLuminance(base) : null
}

/** 解码 data:/blob: 图片并抽样亮度（16×16 足够；data: URL 不污染 canvas，可安全 getImageData） */
export async function sampleImageLuminance(src: string): Promise<number | null> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return null
  try {
    const img = new Image()
    const ok = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true)
      img.onerror = () => resolve(false)
      img.src = src
    })
    if (!ok || !img.naturalWidth || !img.naturalHeight) return null
    const size = 16
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, size, size)
    const data = ctx.getImageData(0, 0, size, size).data
    let r = 0
    let g = 0
    let b = 0
    let count = 0
    for (let i = 0; i + 3 < data.length; i += 4) {
      const a = (data[i + 3] ?? 0) / 255
      if (a <= 0) continue
      r += data[i] ?? 0
      g += data[i + 1] ?? 0
      b += data[i + 2] ?? 0
      count += 1
    }
    if (!count) return null
    return relativeLuminance([r / count, g / count, b / count])
  } catch {
    return null
  }
}

/** 浏览器默认读法：var() 走根元素的 computed style（主题切换后值自然跟着变） */
function resolveVarFromDom(name: string): string | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || null
  } catch {
    return null
  }
}

/** 壁纸 CSS 串里的 url(...)（图片形态：内置壁纸与本地图片都是 data: URL） */
const URL_RE = /url\(\s*(['"]?)(data:|blob:|https?:|file:)[^'"]*\1\s*\)/

/**
 * 估一张壁纸的亮度。返回 null 表示"估不出来"，调用方必须退回兜底档（不许当作"亮"或"暗"猜）。
 * 覆盖三种真实形态：① 预设/自定义 CSS 渐变（解析色标）② 图片壁纸 url()（解码抽样）
 * ③ null=默认壁纸（由 --bg-app/--bg-panel 派生，与 DesktopApp 的默认值同源）。
 */
export async function estimateWallpaperLuminance(
  css: string | null,
  deps?: {
    resolveVar?: (name: string) => string | null
    sampleImage?: (src: string) => Promise<number | null>
  },
): Promise<number | null> {
  const resolveVar = deps?.resolveVar ?? resolveVarFromDom
  const sample = deps?.sampleImage ?? sampleImageLuminance
  if (css == null) {
    // 默认壁纸是 linear-gradient(var(--bg-app) → var(--bg-panel))，亮度直接由这两个令牌派生
    return cssLuminance('linear-gradient(var(--bg-app), var(--bg-panel))', resolveVar)
  }
  const found = css.match(URL_RE)
  if (found?.[0]) {
    const src = found[0].slice(4, -1).replace(/^['"]|['"]$/g, '')
    const fromImage = await sample(src)
    if (fromImage != null) return fromImage
    // 图片解码失败：串里没有别的色标可退，交给下面的 cssLuminance 返回 null → 调用方走兜底档
  }
  return cssLuminance(css, resolveVar)
}

/** 决策：亮度未知 → 兜底；否则按阈值翻转 */
export function pickTitleScheme(luminance: number | null): TitleScheme {
  if (luminance == null || Number.isNaN(luminance)) return 'fallback'
  return luminance < LUMINANCE_SPLIT ? 'onDarkWallpaper' : 'onLightWallpaper'
}

/** 把某个既有变量按不透明度派生成 color-mix 值（本模块唯一的"造色"方式，零新色值） */
function mix(token: string, alpha: number): string {
  return `color-mix(in srgb, var(${token}) ${Math.round(alpha * 100)}%, transparent)`
}

/** 标题最终样式（含底板与描边）。全部颜色都是既有变量的 color-mix 派生。 */
export function buildTitleStyles(scheme: TitleScheme): CSSProperties {
  if (scheme === 'onDarkWallpaper') {
    return {
      color: 'var(--dock-ink)',
      background: mix('--dock-shade', CHIP_ALPHA_ADAPTIVE),
      // 深底 + 亮字：描边取更深的一档，把字从底板里再"顶"出来
      textShadow: `0 1px 2px ${mix('--dock-shade', 0.9)}, 0 0 6px ${mix('--dock-shade', 0.55)}`,
    }
  }
  if (scheme === 'onLightWallpaper') {
    return {
      color: 'var(--dock-shade)',
      background: mix('--dock-ink', CHIP_ALPHA_ADAPTIVE),
      textShadow: `0 1px 2px ${mix('--dock-ink', 0.9)}, 0 0 6px ${mix('--dock-ink', 0.55)}`,
    }
  }
  // 兜底：底板与文字都随主题翻转（亮主题=浅底深字，暗主题=深底亮字），双向描边补边缘
  return {
    color: 'var(--text)',
    background: mix('--bg-panel', CHIP_ALPHA_FALLBACK),
    textShadow: `0 0 3px ${mix('--dock-ink', 0.7)}, 0 1px 2px ${mix('--dock-shade', 0.6)}`,
  }
}
