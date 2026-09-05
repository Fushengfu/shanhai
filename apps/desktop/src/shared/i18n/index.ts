/**
 * 山海 i18n 门面（纯取词，不依赖 Electron / React，主进程与渲染层共用同一份）。
 *
 * 【用法】
 *   渲染层组件：  const { tr, tfParts, locale } = useI18n()      —— 见 renderer/locale.ts，语言变化会自动重渲染
 *   非组件代码：  import { t } from '../shared/i18n'; t('dm.title')
 *   主进程：      import { tIn } from '../shared/i18n'; tIn(getMainLocale(), 'native.xxx')（第 5 期）
 *
 * 【真相源在哪】
 * 只有 config.json 的 settings.locale 一份（见 apps/runtime/src/types.ts 的 AppSettings）。
 * 本模块的 currentLocale 只是**它在当前进程里的镜像**，由 renderer/locale.ts（渲染层）
 * 或 main/locale-store.ts（主进程）在启动与变更时写入，任何地方都不许绕过它们直接改它。
 */
import type { LDict, LEntry, LParams, LPart } from './core'
import { lookup, lookupParts } from './core'
import type { Locale, LocaleSetting } from './locale'
import { FALLBACK_LOCALE, normalizeLocale, resolveLocaleSetting } from './locale'
import { zhCN } from './dict/zh-CN'
import { enUS } from './dict/en-US'

/** 全部词典。新增语言：这里加一项 + 补 dict 文件 + locale.ts 的 SUPPORTED_LOCALES 加 key。 */
export const DICTS: Record<Locale, LDict> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

let currentLocale: Locale = FALLBACK_LOCALE
const listeners = new Set<(locale: Locale) => void>()

/** 当前生效语言（本进程镜像） */
export function getLocale(): Locale {
  return currentLocale
}

/**
 * 设置本进程的语言镜像。相同值直接 bail out、不通知订阅者 ——
 * 这条很重要：语言是低频用户动作，若每次广播都无脑通知一遍，就把任务59 消掉的重复渲染又请回来了。
 * @returns 是否真的发生了变化
 */
export function setLocale(next: unknown): boolean {
  const l = normalizeLocale(next)
  if (l === currentLocale) return false
  currentLocale = l
  // 复制一份再遍历：订阅者可能在回调里取消订阅，直接迭代 Set 会漏掉/抛错
  for (const cb of [...listeners]) cb(l)
  return true
}

/** 订阅语言变化，返回取消订阅函数 */
export function onLocaleChange(cb: (locale: Locale) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 用指定语言取词（不碰全局镜像；主进程通知文案、复刻断言用这个） */
export function tIn(locale: Locale, key: string, params?: LParams): string {
  return lookup(locale, key, params, DICTS)
}

/** 按当前语言取词 */
export function t(key: string, params?: LParams): string {
  return lookup(currentLocale, key, params, DICTS)
}

/** 按当前语言取词并切成富文本片段（词条里的 {b} 槽由调用方渲染成节点） */
export function tf(key: string): LPart[] {
  return lookupParts(currentLocale, key, DICTS)
}

/** 用指定语言切片段 */
export function tfIn(locale: Locale, key: string): LPart[] {
  return lookupParts(locale, key, DICTS)
}

/**
 * 把「持久化设置值 + 系统语言标签」解析成生效语言，并同步本进程镜像。
 * 两个进程都用它，保证同一份 settings.locale 在渲染层与主进程解出同一个结果。
 */
export function applyLocaleSetting(setting: LocaleSetting | string | undefined | null, systemTag: string | undefined | null): Locale {
  const l = resolveLocaleSetting(setting, systemTag)
  setLocale(l)
  return l
}

export type { LDict, LEntry, LParams, LPart }
export type { Locale, LocaleSetting } from './locale'
export {
  SUPPORTED_LOCALES,
  FALLBACK_LOCALE,
  LOCALE_AUTO,
  normalizeLocale,
  resolveLocaleFromSystem,
  resolveLocaleSetting,
  LOCALE_DISPLAY_NAME,
  pluralCategory,
} from './locale'
export type { MsgKey } from './dict/zh-CN'
