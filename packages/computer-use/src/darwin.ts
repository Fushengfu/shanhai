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

/**
 * macOS 真实文本输入脚本：剪贴板 + Cmd+V（支持任意 Unicode：中文/emoji/全角标点）。
 * 为什么不用 System Events `keystroke`：keystroke 只能键入键盘能直接产生的 ASCII 字符，
 * 对中文等非 ASCII 字符会按 keycode 0（'a'）处理，实测 "雷涛" 被写成 "aa"。
 * 剪贴板方案与 win32 的 TYPE_PS（Set-Clipboard + Ctrl+V）对齐，是唯一能稳定写中文的通用做法。
 *
 * 用法：type.swift <textBase64>
 *   文本以 base64 传入，避免命令行转义/编码问题。
 * 流程：保存原剪贴板 → 写入新文本 → 发 Cmd+V → 等待目标 App 完成粘贴 → 恢复原剪贴板。
 * 恢复用「保存全部类型 data + 逐一 setData 写回」，尽量不丢用户原剪贴板（文字/富文本/图片）。
 */
const TYPE_SWIFT = `
import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count >= 2,
      let data = Data(base64Encoded: CommandLine.arguments[1]),
      let text = String(data: data, encoding: .utf8) else { exit(2) }

let pb = NSPasteboard.general
// 1. 保存原剪贴板全部类型的 data（best-effort，尽量完整恢复）
var saved: [(NSPasteboard.PasteboardType, Data)] = []
for t in pb.types ?? [] {
    if let d = pb.data(forType: t) { saved.append((t, d)) }
}
// 2. 写入新文本
pb.clearContents()
pb.setString(text, forType: .string)
// 3. 发送 Cmd+V（V = kVK_ANSI_V = 0x09）
usleep(100000)
let src = CGEventSource(stateID: .hidSystemState)
let down = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: true)
down?.flags = .maskCommand
down?.post(tap: .cghidEventTap)
usleep(50000)
let up = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: false)
up?.flags = .maskCommand
up?.post(tap: .cghidEventTap)
// 4. 等待目标 App 完成粘贴后恢复原剪贴板
usleep(300000)
pb.clearContents()
for (t, d) in saved { pb.setData(d, forType: t) }
print("ok")
`

/**
 * macOS 前台窗口命中校验脚本：给定坐标，返回「该坐标处最上层窗口的 owner 是否 == 当前前台 App」。
 * 用于缺陷②（坐标点击无前台命中校验会点到背景窗口）：点击前校验，若坐标处是背景窗口（另一 App），
 * 点击会把它带到前台，属「点到别的 App」，应停下报错而非盲点。
 *
 * 用法：frontmostAtPoint.swift <pixelX> <pixelY>
 *   输入是截图/OCR 的物理像素坐标，内部 ÷ backingScaleFactor 转逻辑点后再查 CGWindowList。
 *   CGWindowList 的 bounds 与 CGEvent 的 mouseCursorPosition 同属「全局显示坐标（点，主屏左上角原点）」。
 * 输出 JSON：{ matched: Bool, frontmost: String, ownerAtPoint: String }
 *   matched = ownerAtPoint 非空 且 == frontmost；ownerAtPoint 空 = 该坐标处无窗口（桌面）。
 */
const FRONTMOST_SWIFT = `
import CoreGraphics
import AppKit
import Foundation

guard CommandLine.arguments.count >= 3,
      let px = Double(CommandLine.arguments[1]),
      let py = Double(CommandLine.arguments[2]) else { exit(1) }

let scale = NSScreen.main?.backingScaleFactor ?? 2.0
let x = px / scale
let y = py / scale

let frontmost = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
var topOwner = ""
var topLayer = Int.max
for w in list {
    guard let b = w[kCGWindowBounds as String] as? [String: Any],
          let owner = w[kCGWindowOwnerName as String] as? String,
          let layer = w[kCGWindowLayer as String] as? Int,
          let bx = b["X"] as? Double, let by = b["Y"] as? Double,
          let bw = b["Width"] as? Double, let bh = b["Height"] as? Double else { continue }
    if x >= bx && x < bx + bw && y >= by && y < by + bh {
        if layer < topLayer { topLayer = layer; topOwner = owner }
    }
}
let matched = !topOwner.isEmpty && topOwner == frontmost
let out: [String: Any] = ["matched": matched, "frontmost": frontmost, "ownerAtPoint": topOwner]
if let d = try? JSONSerialization.data(withJSONObject: out), let s = String(data: d, encoding: .utf8) {
    print(s)
} else {
    print("{}")
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
      // 剪贴板 + Cmd+V（支持任意 Unicode）；失败会 throw（由上层 action 工具感知并报 failed，不再静默吞错）
      const b64 = Buffer.from(text, 'utf8').toString('base64')
      const scriptPath = `/tmp/shanhai-type-${process.pid}-${Date.now()}.swift`
      try {
        await fs.writeFile(scriptPath, TYPE_SWIFT, 'utf8')
        await execAsync(`swift "${scriptPath}" "${b64}"`, { timeout: 15000 })
      } finally {
        await fs.rm(scriptPath, { force: true }).catch(() => undefined)
      }
    },
    windowOwnerAtPoint: async (x, y) => {
      // 前台窗口命中校验：返回坐标处最上层窗口 owner 是否 == 前台 App。校验脚本失败时降级放行（matched=true），不阻断坐标点击兜底路径
      const scriptPath = `/tmp/shanhai-frontmost-${process.pid}-${Date.now()}.swift`
      try {
        await fs.writeFile(scriptPath, FRONTMOST_SWIFT, 'utf8')
        const { stdout } = await execAsync(`swift "${scriptPath}" "${x}" "${y}"`, { timeout: 10000 })
        const parsed = JSON.parse(stdout.trim() || '{}') as { matched?: boolean; frontmost?: string; ownerAtPoint?: string }
        return {
          matched: parsed.matched !== false,
          frontmost: parsed.frontmost ?? '',
          ownerAtPoint: parsed.ownerAtPoint ?? '',
        }
      } catch {
        return { matched: true, frontmost: '', ownerAtPoint: '' }
      } finally {
        await fs.rm(scriptPath, { force: true }).catch(() => undefined)
      }
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
