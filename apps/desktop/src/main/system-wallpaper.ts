import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 内置壁纸资源目录（dist/main → ../../assets/wallpapers；打包后随 asar 分发）。
 * 摆脱对 macOS 系统壁纸目录（/System/Library/Desktop Pictures）与 sips 转码的依赖，跨平台可用。
 */
const BUILTIN_WALLPAPER_DIR = join(__dirname, '../../assets/wallpapers')

/**
 * 内置壁纸清单：id 为对外标识（沿用 macOS 系统壁纸文件名，前端 applySystemWallpaper 传此 id），
 * name 为显示名，同时对应资源文件前缀（`${name}-full.jpg` 高清 / `${name}-thumb.jpg` 缩略图）。
 */
const BUILTIN_WALLPAPERS: Array<{ id: string; name: string }> = [
  { id: 'Mac Blue.heic', name: 'Mac Blue' },
  { id: 'Mac Pink.heic', name: 'Mac Pink' },
  { id: 'Mac Purple.heic', name: 'Mac Purple' },
  { id: 'Mac Yellow.heic', name: 'Mac Yellow' },
  { id: 'Radial Sky Blue.heic', name: 'Radial Sky Blue' },
  { id: 'Sonoma.heic', name: 'Sonoma' },
  { id: 'iMac Blue.heic', name: 'iMac Blue' },
  { id: 'iMac Green.heic', name: 'iMac Green' },
  { id: 'iMac Orange.heic', name: 'iMac Orange' },
  { id: 'iMac Pink.heic', name: 'iMac Pink' },
  { id: 'iMac Purple.heic', name: 'iMac Purple' },
  { id: 'iMac Silver.heic', name: 'iMac Silver' },
  { id: 'iMac Yellow.heic', name: 'iMac Yellow' },
]

/** 一张可用的系统壁纸元信息（仅含缩略图，不含原图 base64，避免列表 payload 过大） */
export interface SystemWallpaperMeta {
  /** 唯一标识（源文件名，如 "Mac Blue.heic"） */
  id: string
  /** 显示名（如 "Mac Blue"） */
  name: string
  /** 缩略图 data URL（预生成 200px JPEG，可直接 <img src> 或 backgroundImage 使用） */
  thumbnail: string
}

/** 读取内置壁纸文件并包装为 data URL */
async function readAsDataUrl(filePath: string, mime: string): Promise<string> {
  const buf = await readFile(filePath)
  return `data:${mime};base64,${buf.toString('base64')}`
}

/** 返回内置壁纸列表（含缩略图）；单个资源缺失/读取失败时跳过，不拖垮整体 */
export async function listSystemWallpapers(): Promise<SystemWallpaperMeta[]> {
  const metas = await Promise.all(
    BUILTIN_WALLPAPERS.map(async (w): Promise<SystemWallpaperMeta | null> => {
      try {
        const thumbnail = await readAsDataUrl(join(BUILTIN_WALLPAPER_DIR, `${w.name}-thumb.jpg`), 'image/jpeg')
        return { id: w.id, name: w.name, thumbnail }
      } catch (err) {
        console.warn('[山海] 读取内置壁纸缩略图失败：', w.name, err)
        return null
      }
    }),
  )
  return metas.filter((m): m is SystemWallpaperMeta => m !== null)
}

/**
 * 应用某张内置壁纸：读取高清图并包装为 CSS backgroundImage 值返回。
 * 由调用方负责 setWallpaper + patchUiState 持久化与广播。
 * sourcePath 兼容 id（"Mac Blue.heic"）或显示名（"Mac Blue"）。
 */
export async function applySystemWallpaper(sourcePath: string): Promise<string> {
  const w =
    BUILTIN_WALLPAPERS.find((x) => x.id === sourcePath) ?? BUILTIN_WALLPAPERS.find((x) => x.name === sourcePath)
  if (!w) throw new Error(`未知的内置壁纸：${sourcePath}`)
  const dataUrl = await readAsDataUrl(join(BUILTIN_WALLPAPER_DIR, `${w.name}-full.jpg`), 'image/jpeg')
  return `url(${dataUrl})`
}
