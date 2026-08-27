import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import type { VoiceService } from '@shanhai/voice'

const execFileAsync = promisify(execFileCallback)

/** 当前正在播放的 say 子进程：新播报来了先打断旧的，避免多条语音叠加播放 */
let activeSay: ChildProcess | null = null

/** 用系统语音引擎播报文本（可被打断，不设固定超时，按实际文本长度自然朗读完整）。
 *  macOS 走 /usr/bin/say，Windows 走 PowerShell System.Speech SAPI（无外部依赖）。 */
export function spawnSay(text: string, voice: string): Promise<void> {
  const isWin = process.platform === 'win32'
  const file = isWin ? 'powershell.exe' : '/usr/bin/say'
  const args = isWin
    ? ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${String(text).replace(/'/g, "''")}')`]
    : voice ? ['-v', voice, text] : [text]
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'ignore' })
    activeSay = child
    child.on('error', () => {
      if (activeSay === child) activeSay = null
      resolve()
    })
    child.on('exit', () => {
      if (activeSay === child) activeSay = null
      resolve()
    })
  })
}

/** 系统语音服务：TTS 走 macOS say（真实发声）。
 *  STT 不再走 macOS Speech——swift 独立进程没有 app bundle 与 NSSpeechRecognitionUsageDescription，
 *  拿不到 TCC 授权，SFSpeechRecognizer 基本恒返回空；语音识别统一走网关 ASR（见 bootstrap.transcribeAudio）。 */
export function createSystemVoiceService(): VoiceService {
  return {
    transcribe: async () => {
      // 本接口保留仅为满足 VoiceService 契约，实际语音识别走网关 ASR 主路径。
      return ''
    },
    synthesize: async (text) => {
      // macOS：用绝对路径 execFile 调用 say（避免 shell 转义 / PATH 问题），
      // 优先选唯一中文女声 Tingting（婷婷），回退 Yue，再回退任意 zh_CN，找不到则用系统默认语音。
      // Windows：无 say，走 PowerShell System.Speech SAPI（spawnSay 内部分发），跳过语音列表查询。
      const isWin = process.platform === 'win32'
      let voice = ''
      if (!isWin) {
        try {
          const { stdout: list } = await execFileAsync('/usr/bin/say', ['-v', '?'], { timeout: 5000 })
          const lines = list.split('\n').map((l: string) => l.trim())
          const preferred = ['Tingting', 'Yue', 'Sin-ji'].find((c) =>
            lines.some((l) => l.includes('zh_CN') && (l.startsWith(`${c} `) || l.startsWith(`${c}\t`))),
          )
          if (preferred) {
            voice = preferred
          } else {
            const zh = lines.find((l) => l.includes('zh_CN'))
            voice = zh?.match(/^\S+/)?.[0] ?? ''
          }
        } catch {
          /* 查询语音列表失败则用系统默认语音 */
        }
      }
      try {
        // 新播报打断上一条未播完的语音（kill 旧 say 进程），避免多条语音叠加播放
        if (activeSay) {
          try {
            activeSay.kill('SIGTERM')
          } catch {
            /* 已退出 */
          }
          activeSay = null
        }
        // 不设固定超时：让 say 按实际文本长度自然朗读完整，避免长文本被 30s 硬超时截断
        await spawnSay(text, voice)
      } catch (err) {
        // 明确记录失败原因（之前 .catch 静默吞掉，无法定位「没声音」）
        console.error('[voice] say 播报失败:', err instanceof Error ? err.message : String(err))
      }
      return new TextEncoder().encode(text).buffer as ArrayBuffer
    },
  }
}

/** 网关 ASR：PCM(Int16 16kHz) base64 → 文字。
 *  对齐 taco voice.recognize：POST {baseUrl}/audio/asr，模型 stepaudio-2.5-asr，
 *  body { audioData: pcmBase64, language: 'zh', model: 'stepaudio-2.5-asr' }，Accept: text/event-stream。 */
export async function gatewayAsrTranscribe(pcmBase64: string, apiKey: string, baseUrl: string): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/audio/asr`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ audioData: pcmBase64, language: 'zh', model: 'stepaudio-2.5-asr' }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`)
    }
    const text = await res.text()
    // 优先 SSE：逐行 data: {type:"transcript.text.delta", delta:"..."} 累加 delta
    let result = ''
    let matched = false
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s || s === 'data: [DONE]') continue
      if (s.startsWith('data: ')) {
        try {
          const obj = JSON.parse(s.slice(6)) as { type?: string; delta?: string }
          if (obj.type === 'transcript.text.delta' && obj.delta) {
            result += obj.delta
            matched = true
          }
        } catch {
          // 忽略非 JSON 行
        }
      }
    }
    if (matched) return result.trim()
    // 非流式 JSON 兜底：{text} 或 {result}
    try {
      const obj = JSON.parse(text) as { text?: string; result?: string }
      if (typeof obj.text === 'string') return obj.text.trim()
      if (typeof obj.result === 'string') return obj.result.trim()
    } catch {
      // 忽略
    }
    return ''
  } finally {
    clearTimeout(timer)
  }
}
