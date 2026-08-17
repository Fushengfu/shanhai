/** 语音能力：STT（语音转文字）+ TTS（文字转语音） */
export interface VoiceService {
  transcribe(audio: ArrayBuffer): Promise<string>
  synthesize(text: string): Promise<ArrayBuffer>
}

/** mock 语音服务：transcribe 返回空、synthesize 返回 UTF-8 字节（离线/测试兜底） */
export function createMockVoiceService(): VoiceService {
  return {
    transcribe: async () => '',
    synthesize: async (text) => new TextEncoder().encode(text).buffer as ArrayBuffer,
  }
}
