import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Worker, Page } from 'tesseract.js'
import type { OcrWord } from './computer-use'

/**
 * tesseract.js 通用 OCR（Windows / Linux 共用，macOS 走 Vision 不经过这里）。
 *
 * - 纯 JS + wasm，Node 端跨平台，无需系统安装 tesseract；
 * - 语言包 chi_sim（简体中文）+ eng 首次会从 CDN 下载并缓存到 ~/.shanhai/tessdata，之后离线可用；
 * - 返回的文字块 bbox 是「左上角原点」像素坐标，与 OcrWord 定义一致，无需像 Vision 那样翻转。
 */

let workerPromise: Promise<Worker> | null = null

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, OEM } = await import('tesseract.js')
      const tessdataDir = join(homedir(), '.shanhai', 'tessdata')
      await fs.mkdir(tessdataDir, { recursive: true })
      return createWorker(['chi_sim', 'eng'], OEM.LSTM_ONLY, {
        cachePath: tessdataDir,
        logger: () => undefined,
      })
    })()
  }
  return workerPromise
}

/** 从 tesseract Page 递归提取每个 word 的文字 + 像素坐标 */
function extractWords(page: Page): OcrWord[] {
  const result: OcrWord[] = []
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const word of line.words) {
          if (!word.text || word.text.trim().length === 0) continue
          result.push({
            text: word.text,
            x0: word.bbox.x0,
            y0: word.bbox.y0,
            x1: word.bbox.x1,
            y1: word.bbox.y1,
            confidence: word.confidence,
          })
        }
      }
    }
  }
  return result
}

/** 对图片文件做 OCR，返回文字块 + 像素坐标；失败返回空数组（降级，不阻断） */
export async function ocrTesseract(imagePath: string): Promise<OcrWord[]> {
  try {
    const worker = await getWorker()
    const { data } = await worker.recognize(imagePath)
    return extractWords(data)
  } catch {
    return []
  }
}
