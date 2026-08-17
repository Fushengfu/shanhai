import { describe, it, expect } from 'vitest'
import { createMockModel, userMessageWithImages, audioContent, videoContent, userMessageWithParts } from '../src/llm'

describe('Model 接口', () => {
  it('mock 模型按队列返回响应', async () => {
    const model = createMockModel([
      { text: 'first' },
      { toolCall: { name: 'read_file', args: { path: '/a' } } },
    ])
    expect(await model.complete([])).toEqual({ text: 'first' })
    expect(await model.complete([])).toEqual({ toolCall: { name: 'read_file', args: { path: '/a' } } })
  })

  it('队列耗尽复用最后一个', async () => {
    const model = createMockModel([{ text: 'only' }])
    expect(await model.complete([])).toEqual({ text: 'only' })
    expect(await model.complete([])).toEqual({ text: 'only' })
  })
})

describe('多模态（视觉/音频/视频）', () => {
  it('userMessageWithImages 构造文本 + 图片消息', () => {
    const msg = userMessageWithImages('看图', ['data:image/png;base64,xxx'])
    expect(msg.role).toBe('user')
    expect(Array.isArray(msg.content)).toBe(true)
    const parts = msg.content as Array<{ type: string }>
    expect(parts[0]?.type).toBe('text')
    expect(parts[1]?.type).toBe('image_url')
  })

  it('audioContent / videoContent 构造音视频片段', () => {
    expect(audioContent('base64-audio', 'wav')).toEqual({
      type: 'input_audio',
      input_audio: { data: 'base64-audio', format: 'wav' },
    })
    expect(videoContent('base64-video', 'mp4')).toEqual({
      type: 'input_video',
      input_video: { data: 'base64-video', format: 'mp4' },
    })
  })

  it('userMessageWithParts 构造图文音视频混排消息', () => {
    const msg = userMessageWithParts('分析这段', [
      audioContent('audio-data', 'mp3'),
      videoContent('video-data', 'webm'),
    ])
    const parts = msg.content as Array<{ type: string }>
    expect(parts.map((p) => p.type)).toEqual(['text', 'input_audio', 'input_video'])
  })
})
