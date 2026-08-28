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

/**
 * macOS 真实鼠标点击脚本：用 CoreGraphics CGEvent 发送 HID 层真实鼠标事件。
 * 为什么不用 osascript `click at`：System Events 的 click 走辅助功能（AX）元素，
 * 对 Electron 应用（Chromium 渲染的按钮）通常无效（scroll 用方向键反而有效，因为它是键盘事件）。
 * CGEvent 是硬件级鼠标事件，能正常触发 Electron 应用按钮。
 *
 * 坐标换算：screencapture 截图是 Retina 物理像素（如 3600×2338），OCR 返回像素坐标；
 * CGEvent 的 mouseCursorPosition 用「全局显示坐标」（逻辑点，如 1800×1169）。
 * 故需 ÷ backingScaleFactor（Retina 缩放因子，通常 2.0）。
 *
 * 用法：click.swift <pixelX> <pixelY> [clicks] [downUpMs]
 *   pixelX/pixelY：截图/OCR 的物理像素坐标（调用方直接传 OCR 坐标，勿手动换算）
 *   clicks：点击次数（1 单击 / 2 双击），默认 1
 *   downUpMs：按下到抬起间隔毫秒，默认 200（部分按钮对快速点击不敏感，≥200ms 才稳定）
 */
const CLICK_SWIFT = `
import CoreGraphics
import AppKit
import Foundation

guard CommandLine.arguments.count >= 3,
      let px = Double(CommandLine.arguments[1]),
      let py = Double(CommandLine.arguments[2]) else { exit(1) }

let scale = NSScreen.main?.backingScaleFactor ?? 2.0
let clicks = CommandLine.arguments.count >= 4 ? (Int(CommandLine.arguments[3]) ?? 1) : 1
let downUpMs = CommandLine.arguments.count >= 5 ? (Int(CommandLine.arguments[4]) ?? 200) : 200
let point = CGPoint(x: px / scale, y: py / scale)

func post(_ type: CGEventType, _ p: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}

var i = 0
while i < clicks {
    if i > 0 { usleep(60000) }
    post(.mouseMoved, point)
    usleep(20000)
    post(.leftMouseDown, point)
    usleep(UInt32(max(1, downUpMs)) * 1000)
    post(.leftMouseUp, point)
    i += 1
}
`

/** 用 Swift CGEvent 发送真实鼠标点击（Electron 应用可用）；失败静默（权限不足等） */
async function clickAtSwift(x: number, y: number, clicks: number, downUpMs = 200): Promise<void> {
  const scriptPath = `/tmp/shanhai-click-${process.pid}-${Date.now()}.swift`
  try {
    await fs.writeFile(scriptPath, CLICK_SWIFT, 'utf8')
    await execAsync(`swift "${scriptPath}" "${x}" "${y}" "${clicks}" "${downUpMs}"`, { timeout: 15000 })
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

/** macOS computer-use：截图走 screencapture，OCR 走 Vision，点击走 CGEvent（真实鼠标事件），键盘/滚动走 System Events（osascript） */
export function createDarwinComputerUseService(): ComputerUseService {
  const screenshotToFile = async (): Promise<string> => {
    const tmp = `/tmp/shanhai-shot-${Date.now()}.png`
    // -x 静音不播放快门声；-C 连鼠标光标一起截取
    await execAsync(`screencapture -xC "${tmp}"`)
    return tmp
  }

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
      await clickAtSwift(x, y, 1, 200).catch(() => undefined)
    },
    doubleClickAt: async (x, y) => {
      await clickAtSwift(x, y, 2, 200).catch(() => undefined)
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
