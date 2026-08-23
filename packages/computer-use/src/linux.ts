import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'
import type { ComputerUseService } from './computer-use'
import { ocrTesseract } from './ocr-tesseract'

const execAsync = promisify(execCallback)

/** Linux 键位名 → xdotool 键名 */
function linuxKeyName(key: string): string {
  const map: Record<string, string> = {
    enter: 'Return',
    return: 'Return',
    space: 'space',
    tab: 'Tab',
    escape: 'Escape',
    esc: 'Escape',
    left: 'Left',
    right: 'Right',
    up: 'Up',
    down: 'Down',
  }
  return map[key.toLowerCase()] ?? ''
}

/**
 * Linux 截图：按 scrot → gnome-screenshot → ImageMagick import 顺序尝试，
 * 命中即返回；全部失败抛错（上层降级）。仅 X11 环境可用（Wayland 是已知限制）。
 * 前两者带 `-p` 把鼠标光标画进截图；import 不支持光标，作为最后兜底。
 */
async function screenshotToFile(): Promise<string> {
  const tmp = join(tmpdir(), `shanhai-shot-${Date.now()}.png`)
  const candidates = [`scrot -p "${tmp}"`, `gnome-screenshot -p -f "${tmp}"`, `import -window root "${tmp}"`]
  let lastErr: unknown
  for (const cmd of candidates) {
    try {
      await execAsync(cmd, { timeout: 10000 })
      return tmp
    } catch (err) {
      lastErr = err
    }
  }
  await fs.rm(tmp, { force: true }).catch(() => undefined)
  throw lastErr instanceof Error ? lastErr : new Error('Linux 截图失败：缺少 import/scrot/gnome-screenshot')
}

/** Linux computer-use：截图走 import/scrot，OCR 走 tesseract.js，键鼠走 xdotool */
export function createLinuxComputerUseService(): ComputerUseService {
  return {
    screenshot: async () => {
      const tmp = await screenshotToFile()
      try {
        const buf = await fs.readFile(tmp)
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
      }
    },
    clickAt: async (x, y) => {
      await execAsync(`xdotool mousemove ${Math.round(x)} ${Math.round(y)} click 1`).catch(() => undefined)
    },
    doubleClickAt: async (x, y) => {
      await execAsync(`xdotool mousemove ${Math.round(x)} ${Math.round(y)} click --repeat 2 --delay 60 1`).catch(
        () => undefined,
      )
    },
    typeText: async (text) => {
      // -- 分隔，避免文本被当成选项；JSON.stringify 保证 shell 转义安全
      await execAsync(`xdotool type --delay 20 -- ${JSON.stringify(text)}`).catch(() => undefined)
    },
    pressKey: async (key) => {
      const name = linuxKeyName(key)
      if (!name) return
      await execAsync(`xdotool key ${name}`).catch(() => undefined)
    },
    scroll: async (direction, amount) => {
      const times = Math.max(1, Math.min(Math.round(amount ?? 3), 20))
      // xdotool：滚轮上=按钮4，下=按钮5
      const btn = direction === 'down' ? '5' : '4'
      for (let i = 0; i < times; i++) {
        await execAsync(`xdotool click ${btn}`).catch(() => undefined)
      }
    },
    ocr: async (imageBase64) => {
      let tmp = ''
      try {
        if (imageBase64) {
          tmp = join(tmpdir(), `shanhai-ocr-${Date.now()}.png`)
          await fs.writeFile(tmp, Buffer.from(imageBase64, 'base64'))
        } else {
          tmp = await screenshotToFile()
        }
        return await ocrTesseract(tmp)
      } finally {
        if (tmp) await fs.rm(tmp, { force: true }).catch(() => undefined)
      }
    },
  }
}
