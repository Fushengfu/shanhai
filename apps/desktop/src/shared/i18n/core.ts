/**
 * 词条类型与取词内核（纯函数，不依赖 Electron / React，主进程与渲染层共用同一份）。
 *
 * 【词条组织方式 —— 给后续 i18n 期数复用，请勿各写一套】
 * 1. 词典按语言分文件：dict/zh-CN.ts（源语言，全量）+ dict/en-US.ts（按 keyof typeof zh-CN 强约束，缺键直接编译报错）。
 * 2. key 用「模块.语义」的点号扁平命名，一个模块一个前缀：
 *      common.*   跨模块通用词（确定 / 取消 / 重试 / 未知会员 …）
 *      dm.*       私信模块（MemberPanel / DmIm / DmComposer / DmQuotePicker）
 *      chat.*     聊天窗口（第 2 期）  sup.*  管家（第 3 期）  settings.* / market.* …（第 4 期）
 *      native.*   Dock / 托盘 / 右键菜单 / 系统通知（第 5 期）
 *    新增期数只加前缀，不改内核，也不许把两个模块的词混进同一个前缀。
 * 3. 词条值两种形态：
 *      string                     —— 无变量的固定文案
 *      { one, other }             —— 带数量的文案（英文有单复数，中文两种形态同值）
 *    带数量的一律用复数形态 + {n} 占位符，**禁止**在代码里拼 `${n} 条` 这类量词（英文没有量词，
 *    拼出来就是「1 messages」病）。
 * 4. 占位符写 {name}，取值来自 t(key, { name })。缺参数时原样保留 {name}，便于肉眼发现漏传。
 * 5. 兜底：当前语言缺词 → 回退 zh-CN；两边都没有 → 原样返回 key（编译期已禁止，运行时再兜一层）。
 *    界面上永远不会出现 dm.xxx：因为 en-US 被类型约束成全量，运行时兜底只在有人手改词典时才会触发。
 */
import type { Locale } from './locale'
import { pluralCategory } from './locale'

/** 复数词条形态 */
export interface LPlural {
  one: string
  other: string
}

/** 一条词条：固定文案 或 复数文案 */
export type LEntry = string | LPlural

/** 词典：key → 词条 */
export type LDict = Record<string, LEntry>

/** 取词参数：值可以是字符串或数字（数字用于复数判定与占位符替换） */
export type LParams = Record<string, string | number>

/** 复数词条的判定键：params 里出现这些键时用它选 one/other（优先 n，其次 count） */
const PLURAL_KEYS = ['n', 'count'] as const

function pickPluralCount(params?: LParams): number | undefined {
  if (!params) return undefined
  for (const k of PLURAL_KEYS) {
    const v = params[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

/** 占位符替换：只替换 {字母数字_} 形式，避免误伤文案里的其它花括号 */
function interpolate(text: string, params?: LParams): string {
  if (!params) return text
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  )
}

/** 取一条词条的原文形态（当前语言缺词 → 回退 zh-CN；两边都没有 → undefined） */
function resolveEntry(locale: Locale, key: string, dicts: Record<Locale, LDict>): LEntry | undefined {
  return dicts[locale]?.[key] ?? dicts['zh-CN']?.[key]
}

/** 按数量挑出单/复数形态 */
function pickForm(locale: Locale, entry: LEntry, params?: LParams): string {
  if (typeof entry === 'string') return entry
  const n = pickPluralCount(params)
  // 复数词条但没给数量：按 other 处理（英文 other 是通用形态），不猜 one
  const form = n === undefined ? 'other' : pluralCategory(locale, n)
  return form === 'one' ? entry.one : entry.other
}

/**
 * 从词典取一条文案（纯函数，便于 node 复刻断言）。
 * @param locale 目标语言
 * @param key    词条 key
 * @param params 占位符参数（含 n/count 时触发复数）
 */
export function lookup(locale: Locale, key: string, params: LParams | undefined, dicts: Record<Locale, LDict>): string {
  const entry = resolveEntry(locale, key, dicts)
  // 兜底：词典里查不到就原样返回 key。正常走不到这里 —— en-US 被类型约束成全量（见 dict/en-US.ts），
  // 真出现说明有人在词典里删了键，返回 key 比返回空串更容易被发现。
  if (entry === undefined) return key
  return interpolate(pickForm(locale, entry, params), params)
}

/** 富文本片段：字符串是普通文字，{ ph } 是需要由调用方渲染成 React 节点的占位符 */
export type LPart = string | { ph: string }

/**
 * 取一条文案并切成片段，供界面里**带内嵌标签**的句子使用（如「必须<b>互为好友</b>才能…」）。
 *
 * 为什么需要它：中文原句里嵌了 <b>，如果只把中文当字符串替换成英文，英文的语序会不同，
 * 加粗位置就错位。切成片段后，加粗落在哪个词由**各语言自己的词条**决定，语序自由。
 * 不做插值：{ph} 原样保留在片段里，交给渲染侧映射成节点。
 */
export function lookupParts(locale: Locale, key: string, dicts: Record<Locale, LDict>): LPart[] {
  const entry = resolveEntry(locale, key, dicts)
  if (entry === undefined) return [key]
  const text = pickForm(locale, entry)
  const out: LPart[] = []
  const re = /\{([A-Za-z0-9_]+)\}/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    // noUncheckedIndexedAccess 下 m[1] 可能是 undefined；正则要求必须有捕获组，取不到就整段当普通文字
    const ph = m[1]
    if (ph) out.push({ ph })
    else out.push(m[0])
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
