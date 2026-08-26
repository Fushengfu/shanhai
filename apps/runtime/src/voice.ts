import { promises as fs } from 'node:fs'
import { exec as execCallback, execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import type { VoiceService } from '@shanhai/voice'

const execAsync = promisify(execCallback)
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

/** 真实语音：TTS 走 macOS say（真实发声），STT 需系统麦克风权限（暂返回空） */
export function createSystemVoiceService(): VoiceService {
  return {
    transcribe: async (audio) => {
      // Windows 暂未接入 STT（macOS Speech 识别不可用），直接返回空，不阻断流程
      if (process.platform === 'win32') return ''
      // 真实 STT：音频字节 → 临时文件 → afconvert 转 wav → macOS Speech 识别（失败返回空，不阻断）
      if (audio.byteLength === 0) return ''
      const base = `/tmp/shanhai-voice-${Date.now()}`
      const src = `${base}.webm`
      const wav = `${base}.wav`
      try {
        await fs.writeFile(src, Buffer.from(audio))
        // webm(opus) → wav；失败则用原始文件直接识别（SFSpeechRecognizer 也能读部分容器格式）
        try {
          await execAsync(`afconvert -f WAVE -d LEI16 "${src}" "${wav}"`, { timeout: 15000 })
        } catch {
          return await transcribeAudioFile(src)
        }
        return await transcribeAudioFile(wav)
      } catch {
        return ''
      } finally {
        await fs.rm(src, { force: true }).catch(() => undefined)
        await fs.rm(wav, { force: true }).catch(() => undefined)
      }
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

/** macOS Speech 语音识别脚本：识别音频文件（wav/m4a/aiff）转文字。运行时写入临时文件用 swift 执行。 */
const STT_SWIFT = `
import Speech
import Foundation

guard CommandLine.arguments.count > 1 else { print(""); exit(0) }
let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) ?? SFSpeechRecognizer() else {
    print("")
    exit(0)
}

let request = SFSpeechURLRecognitionRequest(url: url)
request.shouldReportPartialResults = false

let semaphore = DispatchSemaphore(value: 0)
var text = ""

recognizer.recognitionTask(with: request) { result, error in
    if let result = result, result.isFinal {
        text = result.bestTranscription.formattedString
        semaphore.signal()
    } else if error != nil {
        semaphore.signal()
    }
}

_ = semaphore.wait(timeout: .now() + 30)
print(text)
`

/** 用 macOS Speech 识别音频文件转文字（失败返回空串，不阻断） */
export async function transcribeAudioFile(path: string): Promise<string> {
  const scriptPath = `/tmp/shanhai-stt-${process.pid}.swift`
  try {
    await fs.writeFile(scriptPath, STT_SWIFT, 'utf8')
    const { stdout } = await execAsync(`swift "${scriptPath}" "${path}"`, { timeout: 35000 })
    return stdout.trim()
  } catch {
    return ''
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => undefined)
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

/** PCM(Int16 16kHz 单声道) base64 → 写临时 WAV 文件，返回路径（供 macOS Speech 降级识别，SFSpeechRecognizer 不认裸 PCM） */
export async function pcmBase64ToWavFile(pcmBase64: string): Promise<string> {
  const pcm = Buffer.from(pcmBase64, 'base64')
  const path = `/tmp/shanhai-pcm-${Date.now()}.wav`
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt 块大小
  header.writeUInt16LE(1, 20) // PCM 编码
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(16000, 24) // 采样率
  header.writeUInt32LE(16000 * 2, 28) // 字节率
  header.writeUInt16LE(2, 32) // 块对齐
  header.writeUInt16LE(16, 34) // 位深
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  await fs.writeFile(path, Buffer.concat([header, pcm]))
  return path
}
