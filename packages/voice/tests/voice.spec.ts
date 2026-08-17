import { describe, it, expect } from 'vitest'
import { createMockVoiceService } from '../src/voice'

describe('VoiceService', () => {
  it('mock 兜底：transcribe 空、synthesize 返回字节', async () => {
    const voice = createMockVoiceService()
    expect(await voice.transcribe(new ArrayBuffer(0))).toBe('')
    const buf = await voice.synthesize('hi')
    expect(new TextDecoder().decode(buf)).toBe('hi')
  })
})
