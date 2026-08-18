import { describe, it, expect } from 'vitest'
import { bootstrap } from '../src/bootstrap'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 真实网关 E2E：仅在有本地凭证时运行（无凭证环境自动跳过，不污染常规测试）
const hasCredential = existsSync(join(homedir(), '.shanhai', 'config.json'))

// 生成 100x100 纯红色 PNG 的 data URL
function makeRedPngDataUrl(): string {
  const w = 100
  const h = 100
  const raw = Buffer.alloc(h * (1 + w * 3))
  let off = 0
  for (let y = 0; y < h; y++) {
    raw[off++] = 0
    for (let x = 0; x < w; x++) {
      raw[off++] = 0xff
      raw[off++] = 0x00
      raw[off++] = 0x00
    }
  }
  // 用 Node zlib 做 PNG（简单方式：直接用手写 PNG 编码）
  const zlib = require('node:zlib') as typeof import('node:zlib')
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]!
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
    return Buffer.concat([len, typeBuf, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const idat = zlib.deflateSync(raw)
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return 'data:image/png;base64,' + png.toString('base64')
}

describe.skipIf(!hasCredential)('图片发送 E2E（真实网关 + 视觉模型）', () => {
  it('切到视觉模型后，带图片附件发送，模型能识别图片内容', async () => {
    const runtime = await bootstrap()
    // 切到视觉模型 kimi-k3（deepseek-v4-flash 不支持图片）
    runtime.switchModel('kimi-k3')
    const dataUrl = makeRedPngDataUrl()
    const result = await runtime.run('这张图片是什么颜色？一句话回答', {
      attachments: [{ type: 'image_url', image_url: { url: dataUrl } }],
    })
    console.log('图片识别结果:', result)
    expect(result).toMatch(/红|red/i)
    await runtime.kernel.dispose()
  }, 60000)
})
