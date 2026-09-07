/**
 * 附件规矩与私信消息体编解码（主进程与渲染层共用一份，避免「两套标准」）。
 *
 * 为什么放 src/shared（而不是各写一份）：
 *  1. 附件上限与白名单由用户 2026-09-04 拍板，要求「会话 / 管家 / 私信三处同一套标准」，
 *     写两份必然漂开（本项目已因「两套计数逻辑」被批评过）；
 *  2. 私信的 `[图片]` 内容在主进程也要用（系统通知正文、「引用到会话」的落地文本），
 *     渲染层再实现一遍解码就是第三个真相源。
 *
 * 【硬约束】私信正文上限 = 本文件导出的 DM_MAX_CONTENT_BYTES（单一真相源，主进程与渲染层都从这一处取），
 * **绝不允许把 base64 塞进消息**
 * （本项目已因截图 base64 撑爆请求踩过 context deadline exceeded）。所以附件一律
 * 「先上传拿公网 URL → 消息里只放引用」。
 */

// —————————————————————————— 附件规矩 ——————————————————————————
//
// 【i18n 期5A】dmContentPreview / attLabel 的输出是**给人看的一行预览**（会话列表、系统通知正文），
//   所以顿号、`[图片]/[文件]` 标签、`（附 …）` 全角括号一律走语言包取词。
//   取词用 shared 门面的**进程内镜像**（t()）：主进程那份由 main/locale-store.ts 写、渲染层那份由
//   renderer/locale.tsx 写 —— 每进程只有一个写入者，所以这里既不用加 locale 参数，也不用动
//   member-channel.ts（本期边界禁止碰它）。
// 【i18n 期5B】classifyAttachmentFile 的**六道闸门拒因**也走词条：它们的 reason 会被
//   DmComposer / ChatComposer / SupervisorComposer 直接显示到界面上（cls.reason → 提示条），
//   英文界面里出现整条中文拒因就是漏翻。判定条件（大小上限、白名单、FORBIDDEN_EXTS）一字未动。
// ⚠️ dmContentToPlainText **刻意不翻**：它的产物是「引用到会话」后交给模型阅读的正文，
//   期1 定的契约形态就是 `[图片] 名字 → URL`；改它会改变模型看到的输入，属另一件事。

import { t } from './i18n'

/** 图片上限 10MB（用户拍板） */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** 文档 / 音视频上限 20MB（用户拍板） */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

/**
 * 【任务113 · 单一真相源】单条私信 content 的字节上限。
 *
 * 为什么必须有这一份：改前主进程 member-channel.ts:110 `MAX_MSG_BYTES = 4000` 与渲染层
 * MemberPanel.tsx:49 `MAX_CONTENT_BYTES = 4000` 各写一个字面量，连 i18n key 与参数名都不同
 * （dm.sendTooLong{now,max} vs dm.send.tooLong{bytes,max}），改一处必然漂开另一处。
 * 现在两侧都 import 本常量，全仓只有这一个数值。
 *
 * 【口径统一】判定对象 = **编码后的 content**（encodeDmContent 的产物）的 UTF-8 字节数。
 *  主进程 sendDm 检的是入参 text，而渲染层传进来的入参本身就已经是编码后的 content
 *  （MemberPanel onSend 先 encodeDmContent 再 memberSend），所以两边其实是同一口径；
 *  渲染层 DmComposer / MemberPanel 也按编码后计数（附件引用同样占字节，只数正文字符会算少）。
 *
 * 【40000 这个数怎么来的（任务115，用户 2026-09-07 授权放宽）】
 *  - 网关 im_service 的 send handler 原先硬校验 4000（与旧客户端契约 v1 同值），已同步放宽到 40000；
 *  - 存储层 direct_messages.content 是 TEXT 列，容量 65535 字节 ⇒ 40000 约占 61%，不触列上限；
 *  - ws 帧 / 请求体上限 10MB（≈10485760 字节），远大于本值；
 *  - 相对存储列 65535 留 (65535-40000)/65535 ≈ 39% 余量，给附件引用 JSON 与编码膨胀留空间；
 *  - 手机端无私信 UI（apps/mobile 实测零私信渲染面），不构成约束。
 * 【上线顺序】网关那行未部署前，客户端单方面放到 40000 会出现「本地能输、发出去被网关以 4000 拒」；
 *  实际生效 = 网关已部署 + 山海重启。若网关侧回滚，本行改回 4000 即可，无需动任何其它文件。
 */
export const DM_MAX_CONTENT_BYTES = 40000

/** 允许的图片扩展名（用户拍板的清单，逐字照抄） */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'] as const
/** 允许的文档扩展名（用户拍板的清单，逐字照抄） */
export const DOC_EXTS = ['pdf', 'docx', 'txt', 'md', 'xlsx'] as const
/**
 * 明确禁止的可执行与脚本扩展名。
 * ⚠️ 真正的判定是**白名单制**（不在白名单里一律拒），这份清单只用来把拒因说得更准，
 *    避免用户看到「不支持的文件类型」却不知道自己能传什么。
 */
export const FORBIDDEN_EXTS = [
  'sh', 'bash', 'zsh', 'command', 'exe', 'msi', 'app', 'dmg', 'pkg', 'deb', 'rpm',
  'bat', 'cmd', 'ps1', 'vbs', 'scr', 'jar', 'wasm', 'apk',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'php', 'pl', 'lua',
] as const

/** 附件归类（与渲染层既有 AttachmentItem.type 取值一致，不新造枚举） */
export type AttachmentKind = 'image' | 'file' | 'audio' | 'video'

export interface ClassifyOptions {
  /**
   * 是否放行音视频。会话 / 管家窗口**本来就有**音视频附件能力（App.tsx 会把它编成
   * input_audio / input_video 多模态部件发给模型），一刀切禁掉等于砍掉既有功能，故这两处传 true；
   * 私信 UI 不渲染音视频，传 false。
   */
  allowAudioVideo: boolean
}

export type ClassifyResult = { ok: true; kind: AttachmentKind } | { ok: false; reason: string }

/** 取小写扩展名（不含点）；没有扩展名返回空串 */
function extOf(name: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/** 字节数 → 可读文本（shared 里自带一份，不依赖渲染层 ui.tsx，主进程也要用） */
export function formatBytesShared(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 判定一个文件能不能当附件、算哪一类、超不超限。
 * 拒因必须是**人能照做的一句话**（本项目反复踩过的坑就是「拒了但没说为什么」）。
 */
export function classifyAttachmentFile(
  file: { name: string; mime?: string; size: number },
  opts: ClassifyOptions,
): ClassifyResult {
  const ext = extOf(file.name)
  const mime = (file.mime ?? '').toLowerCase()
  const isImage = mime.startsWith('image/') || (IMAGE_EXTS as readonly string[]).includes(ext)
  const isAudio = mime.startsWith('audio/')
  const isVideo = mime.startsWith('video/')
  const isDoc = (DOC_EXTS as readonly string[]).includes(ext)

  if (isImage) {
    if (file.size > MAX_IMAGE_BYTES) {
      return { ok: false, reason: t('dm.gate.imageTooLarge', { size: formatBytesShared(file.size), limit: formatBytesShared(MAX_IMAGE_BYTES) }) }
    }
    return { ok: true, kind: 'image' }
  }
  if (isAudio || isVideo) {
    if (!opts.allowAudioVideo) {
      return { ok: false, reason: t('dm.gate.avNotAllowed') }
    }
    if (file.size > MAX_FILE_BYTES) {
      return { ok: false, reason: t(isAudio ? 'dm.gate.audioTooLarge' : 'dm.gate.videoTooLarge', { size: formatBytesShared(file.size), limit: formatBytesShared(MAX_FILE_BYTES) }) }
    }
    return { ok: true, kind: isAudio ? 'audio' : 'video' }
  }
  if (isDoc) {
    if (file.size > MAX_FILE_BYTES) {
      return { ok: false, reason: t('dm.gate.fileTooLarge', { size: formatBytesShared(file.size), limit: formatBytesShared(MAX_FILE_BYTES) }) }
    }
    return { ok: true, kind: 'file' }
  }
  if ((FORBIDDEN_EXTS as readonly string[]).includes(ext)) {
    return { ok: false, reason: t('dm.gate.forbiddenExt', { ext, images: IMAGE_EXTS.join('/'), docs: DOC_EXTS.join('/') }) }
  }
  return { ok: false, reason: ext
    ? t('dm.gate.unsupportedExt', { ext, images: IMAGE_EXTS.join('/'), docs: DOC_EXTS.join('/') })
    : t('dm.gate.unsupportedBare', { images: IMAGE_EXTS.join('/'), docs: DOC_EXTS.join('/') }) }
}

/** 文件选择框的 accept 白名单（照抄规矩，别让用户在弹窗里挑到一个注定被拒的文件） */
export function acceptAttrFor(opts: ClassifyOptions): string {
  const parts = [...IMAGE_EXTS.map((e) => `.${e}`), ...DOC_EXTS.map((e) => `.${e}`)]
  if (opts.allowAudioVideo) parts.push('audio/*', 'video/*')
  return parts.join(',')
}

// —————————————————————————— 私信消息体（附件引用）——————————————————————————

/**
 * UTF-8 字节数（与主进程 Buffer.byteLength 同口径）。
 * 放这里是因为**编码后的 content** 才受本文件 DM_MAX_CONTENT_BYTES 的上限约束：附件引用会占几十字节，
 * 只数正文字符数会算少，于是「本地以为没超、网关回 message_too_large」。渲染层两处（私信面板 / 输入区）共用一份。
 */
export function utf8Bytes(text: string): number {
  let n = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80) n += 1
    else if (code < 0x800) n += 2
    else if (code < 0x10000) n += 3
    else n += 4
  }
  return n
}

/**
 * 单条附件引用（放进私信 content 里的紧凑 JSON）。
 * 字段名刻意压到一个字母：私信正文受 DM_MAX_CONTENT_BYTES 的字节上限约束，一条带名字的长 URL 也要占地方。
 * 理想方案是网关给 direct_messages 加 msg_type + attachment 列（依赖清单 G1）；
 * 网关没加之前，本期就走这个「content 放 JSON 字符串」的兼容写法。
 */
export interface DmAttachmentPayload {
  /** 类型：image=图片，file=文档 */
  t: 'image' | 'file'
  /** 云存储公网直链（永久、无签名 —— 用户已知情拍板接受该风险） */
  u: string
  /** 文件名（含扩展名），用于显示 */
  n: string
  /** 字节数，用于显示 */
  s: number
  /** 图片宽高（拿得到就带，用于气泡按比例占位，避免加载完跳动） */
  w?: number
  h?: number
}

/** 多附件 / 图文混排的封装形态：`{"t":"atts","x":"正文","a":[引用…]}` */
const MIXED_TAG = 'atts'

/**
 * 编码私信 content：
 *  - 无附件 → 原样纯文本（**完全向后兼容**：手机端、老版本山海看到的还是普通文本）；
 *  - 单个附件且没写正文 → 就是任务书给的那个形态 `{"t":"image","u":…,"n":…,"s":…}`；
 *  - 有正文或有多个附件 → 包一层 `{"t":"atts","x":正文,"a":[…]}`。
 */
export function encodeDmContent(text: string, atts: DmAttachmentPayload[]): string {
  // 归一入参：万一调用方误传单个对象，也得编出**能被 decode 认回来**的形态
  // （否则 content 会变成 a 是对象而不是数组的畸形 JSON，解码按「不像引用」原样显示，附件就悄悄丢了）
  const list = Array.isArray(atts) ? atts : atts ? [atts as DmAttachmentPayload] : []
  if (list.length === 0) return text
  if (list.length === 1 && !text.trim()) return JSON.stringify(list[0])
  return JSON.stringify({ t: MIXED_TAG, x: text, a: list })
}

export interface DmContentParsed {
  /** 用户写的正文（没有就空串） */
  text: string
  /** 解析出来的附件引用 */
  atts: DmAttachmentPayload[]
}

function asPayload(v: unknown): DmAttachmentPayload | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.t !== 'image' && o.t !== 'file') return null
  if (typeof o.u !== 'string' || !/^https?:\/\//i.test(o.u)) return null
  if (typeof o.n !== 'string' || typeof o.s !== 'number') return null
  const p: DmAttachmentPayload = { t: o.t, u: o.u, n: o.n, s: o.s }
  if (typeof o.w === 'number' && o.w > 0) p.w = o.w
  if (typeof o.h === 'number' && o.h > 0) p.h = o.h
  return p
}

/**
 * 解码私信 content。
 * ⚠️ 铁律：**任何解析失败或形态不符，一律原样把文本交回去** ——
 *    对方（手机端 / 老版本山海 / 用户手打的 JSON）发的普通文本绝不能被我们当成附件引用吞掉。
 */
export function decodeDmContent(raw: string | undefined | null): DmContentParsed {
  const s = (raw ?? '').trim()
  const plain: DmContentParsed = { text: raw ?? '', atts: [] }
  if (!s.startsWith('{') || !s.endsWith('}')) return plain
  let o: unknown
  try {
    o = JSON.parse(s)
  } catch {
    return plain
  }
  if (!o || typeof o !== 'object') return plain
  const obj = o as Record<string, unknown>
  if (obj.t === MIXED_TAG) {
    if (!Array.isArray(obj.a) || obj.a.length === 0) return plain
    const atts = obj.a.map(asPayload)
    if (atts.some((x) => x === null)) return plain
    return { text: typeof obj.x === 'string' ? obj.x : '', atts: atts as DmAttachmentPayload[] }
  }
  const one = asPayload(obj)
  if (!one) return plain
  return { text: typeof obj.x === 'string' ? obj.x : '', atts: [one] }
}

/** 附件的短标签（列表预览 / 系统通知正文用，不含 URL，避免被 80 字截断成一串链接） */
function attLabel(a: DmAttachmentPayload): string {
  // 【期5A】标签走词条：英文态是 `[Image] x.png`，不再是中文 `[图片]`
  return `${t(a.t === 'image' ? 'native.attImage' : 'native.attFile')} ${a.n}`
}

/**
 * content → 一行预览（会话列表、系统通知用）。
 * 附件消息不再显示成 `{"t":"image","u":"http…` 这种串码，而是 `[图片] 截图.png`。
 */
export function dmContentPreview(raw: string | undefined | null): string {
  const { text, atts } = decodeDmContent(raw)
  if (atts.length === 0) return raw ?? ''
  // 【期5A】顿号与全角括号都走词条 —— 英文界面里出现「、」「（）」是异体字
  const labels = atts.map(attLabel).join(t('common.sepEnumeration'))
  return text ? t('native.attAttached', { text, labels }) : labels
}

/**
 * content → 纯文本（「引用到会话」写进输入框 / 交给 Agent 阅读时用）。
 * 与预览的区别：**这里必须带上 URL**，否则用户引用一张图到会话，模型只看到「[图片] 名字」而无从查看内容。
 */
export function dmContentToPlainText(raw: string | undefined | null): string {
  const { text, atts } = decodeDmContent(raw)
  if (atts.length === 0) return raw ?? ''
  const lines = atts.map((a) => `${a.t === 'image' ? '[图片]' : '[文件]'} ${a.n} → ${a.u}`)
  return [text, ...lines].filter((x) => x && x.trim()).join('\n')
}
