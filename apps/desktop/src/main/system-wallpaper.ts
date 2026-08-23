import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** macOS 系统壁纸目录（静态高清 HEIC 原图） */
const SYSTEM_WALLPAPER_DIR = '/System/Library/Desktop Pictures'

/** 一张可用的系统壁纸元信息（仅含缩略图，不含原图 base64，避免列表 payload 过大） */
export interface SystemWallpaperMeta {
  /** 唯一标识（源文件名，如 "Mac Blue.heic"） */
  id: string
  /** 显示名（去掉 .heic 后缀） */
  name: string
  /** 缩略图 data URL（sips 转码的 200px PNG，可直接 <img src> 或 backgroundImage 使用） */
  thumbnail: string
}

/**
 * 用 macOS 自带的 sips 把 HEIC 转码成指定尺寸的 data URL。
 * - maxPx：最长边像素（-Z 保持宽高比缩放）
 * - format：png / jpeg（jpeg 时附带 formatOptions 85 控制体积）
 * 转码到临时文件 → 读 base64 → 删除临时文件，返回纯 data URL（不含 url() 包装）。
 */
async function heicToDataUrl(sourcePath: string, maxPx: number, format: 'png' | 'jpeg'): Promise<string> {
  const tmpPath = join(tmpdir(), `shanhai-wallpaper-${Date.now()}-${Math.random().toString(36).slice(2)}.${format}`)
  const args = ['-s', 'format', format]
  if (format === 'jpeg') args.push('-s', 'formatOptions', '85')
  args.push('-Z', String(maxPx), sourcePath, '--out', tmpPath)
  try {
    await execFileAsync('/usr/bin/sips', args)
    const buf = await readFile(tmpPath)
    const mime = format === 'png' ? 'image/png' : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } finally {
    await rm(tmpPath, { force: true })
  }
}

/** 校验源路径必须落在系统壁纸目录内（防路径穿越读任意文件） */
function assertInsideSystemDir(sourcePath: string): string {
  const resolved = resolve(sourcePath)
  if (!resolved.startsWith(SYSTEM_WALLPAPER_DIR + sep)) {
    throw new Error(`非法的壁纸路径：${sourcePath}`)
  }
  return resolved
}

/** 扫描系统壁纸目录，返回静态高清壁纸列表（含缩略图）；目录不存在或转码失败时降级为空/跳过 */
export async function listSystemWallpapers(): Promise<SystemWallpaperMeta[]> {
  let files: string[]
  try {
    files = readdirSync(SYSTEM_WALLPAPER_DIR).filter((f) => f.toLowerCase().endsWith('.heic'))
  } catch (err) {
    console.warn('[山海] 读取系统壁纸目录失败：', err)
    return []
  }

  const metas = await Promise.all(
    files.map(async (file): Promise<SystemWallpaperMeta | null> => {
      try {
        const thumbnail = await heicToDataUrl(join(SYSTEM_WALLPAPER_DIR, file), 200, 'png')
        return { id: file, name: file.replace(/\.heic$/i, ''), thumbnail }
      } catch (err) {
        console.warn('[山海] 生成系统壁纸缩略图失败：', file, err)
        return null
      }
    }),
  )

  return metas.filter((m): m is SystemWallpaperMeta => m !== null)
}

/**
 * 应用某张系统壁纸：转码成 2880px JPEG 并包装为 CSS backgroundImage 值返回。
 * 由调用方负责 setWallpaper + patchUiState 持久化与广播。
 */
export async function applySystemWallpaper(sourcePath: string): Promise<string> {
  // 渲染进程传的是文件名（如 "Sonoma.heic"），主进程拼回系统壁纸目录再校验（防路径穿越不变）
  const fullPath = sourcePath.startsWith(SYSTEM_WALLPAPER_DIR) ? sourcePath : join(SYSTEM_WALLPAPER_DIR, sourcePath)
  const resolved = assertInsideSystemDir(fullPath)
  const dataUrl = await heicToDataUrl(resolved, 2880, 'jpeg')
  return `url(${dataUrl})`
}
