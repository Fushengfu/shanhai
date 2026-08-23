import { promises as fs } from 'node:fs'
import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'
import type { ComputerUseService, OcrWord } from './computer-use'

const execAsync = promisify(execCallback)

/** macOS Vision OCR 脚本：识别图片文字 + 精确像素坐标（左上角原点）。运行时写入临时文件用 swift 执行。 */
const OCR_SWIFT = `
import Vision
import AppKit
import Foundation

guard CommandLine.arguments.count > 1 else { print("[]"); exit(0) }
let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path),
      let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let cg = rep.cgImage else { print("[]"); exit(0) }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch { print("[]"); exit(0) }

let w = CGFloat(cg.width)
let h = CGFloat(cg.height)
let words: [[String: Any]] = (request.results ?? []).compactMap { obs in
    guard let cand = obs.topCandidates(1).first else { return nil }
    let box = obs.boundingBox
    // Vision 原点在左下角，转为左上角原点 + 像素坐标
    let x0 = box.minX * w
    let y0 = (1 - box.maxY) * h
    let x1 = box.maxX * w
    let y1 = (1 - box.minY) * h
    return ["text": cand.string, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "confidence": cand.confidence]
}
do {
    let data = try JSONSerialization.data(withJSONObject: words)
    if let s = String(data: data, encoding: .utf8) { print(s) } else { print("[]") }
} catch { print("[]") }
`

/** 用 macOS Vision 对图片做 OCR，返回文字块 + 像素坐标；失败返回空数组（降级，不阻断） */
async function ocrImage(path: string): Promise<OcrWord[]> {
  const scriptPath = `/tmp/shanhai-ocr-${process.pid}.swift`
  try {
    await fs.writeFile(scriptPath, OCR_SWIFT, 'utf8')
    const { stdout } = await execAsync(`swift "${scriptPath}" "${path}"`, { timeout: 30000 })
    const parsed = JSON.parse(stdout.trim() || '[]') as OcrWord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => undefined)
  }
}

/** macOS 键位名 → System Events key code */
function keyCode(key: string): number {
  const map: Record<string, number> = {
    enter: 36,
    return: 36,
    space: 49,
    tab: 48,
    escape: 53,
    esc: 53,
    left: 123,
    right: 124,
    up: 126,
    down: 125,
  }
  return map[key.toLowerCase()] ?? 0
}

/** macOS computer-use：截图走 screencapture，OCR 走 Vision，键鼠走 System Events（osascript） */
export function createDarwinComputerUseService(): ComputerUseService {
  const screenshotToFile = async (): Promise<string> => {
    const tmp = `/tmp/shanhai-shot-${Date.now()}.png`
    // -x 静音不播放快门声；-C 连鼠标光标一起截取
    await execAsync(`screencapture -xC "${tmp}"`)
    return tmp
  }

  const clickAtOsascript = (x: number, y: number): string =>
    `osascript -e 'tell application "System Events" to click at {${x}, ${y}}'`

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
      await execAsync(clickAtOsascript(x, y)).catch(() => undefined)
    },
    doubleClickAt: async (x, y) => {
      await execAsync(
        `${clickAtOsascript(x, y)} -e 'delay 0.06' -e 'tell application "System Events" to click at {${x}, ${y}}'`,
      ).catch(() => undefined)
    },
    typeText: async (text) => {
      await execAsync(`osascript -e 'tell application "System Events" to keystroke ${JSON.stringify(text)}'`).catch(
        () => undefined,
      )
    },
    pressKey: async (key) => {
      await execAsync(`osascript -e 'tell application "System Events" to key code ${keyCode(key)}'`).catch(
        () => undefined,
      )
    },
    scroll: async (direction, amount) => {
      // 无 cliclick 时用方向键模拟滚动：down=下箭头(125)，up=上箭头(126)
      const code = direction === 'down' ? 125 : 126
      const times = Math.max(1, Math.min(Math.round(amount ?? 3), 20))
      for (let i = 0; i < times; i++) {
        await execAsync(`osascript -e 'tell application "System Events" to key code ${code}'`).catch(() => undefined)
      }
    },
    ocr: async (imageBase64) => {
      let tmp = ''
      try {
        if (imageBase64) {
          tmp = `/tmp/shanhai-ocr-${Date.now()}.png`
          await fs.writeFile(tmp, Buffer.from(imageBase64, 'base64'))
        } else {
          tmp = await screenshotToFile()
        }
        return await ocrImage(tmp)
      } finally {
        if (tmp) await fs.rm(tmp, { force: true }).catch(() => undefined)
      }
    },
  }
}
