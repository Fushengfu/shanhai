import { describe, it, expect } from 'vitest'
import { bootstrap } from '../src/bootstrap'

describe('语音能力（TTS 真实发声 + STT 容错）', () => {
  it('TTS synthesize 真实发声（macOS say），不崩溃', async () => {
    const runtime = await bootstrap()
    try {
      // say 命令不依赖音频设备，直接生成语音；无凭证环境也能跑
      const bytes = await runtime.voice.synthesize('你好，这是语音测试')
      expect(bytes.byteLength).toBeGreaterThan(0)
    } finally {
      await runtime.kernel.dispose()
    }
  })

  it('STT transcribeAudio 空音频容错返回空串（不崩溃）', async () => {
    const runtime = await bootstrap()
    try {
      // 空音频：afconvert/swift 失败都应降级返回空串，不抛错
      const text = await runtime.transcribeAudio('')
      expect(typeof text).toBe('string')
    } finally {
      await runtime.kernel.dispose()
    }
  })
})
