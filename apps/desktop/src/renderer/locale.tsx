/**
 * 渲染层的语言绑定 —— 照抄同目录 theme.ts 的范式，不发明第二套。
 *
 *   主题：localStorage['shanhai-theme'] → data-theme → setTheme 广播 ui:theme → useThemeSync
 *   语言：settings.locale（真相源，存的是用户的【选择】，可能是「跟随系统」）
 *         → 生效语言由主进程解析并广播 ui:locale（含每个窗口加载完成时补推一次）→ useLocaleSync
 *         → data-locale
 *
 * 【localStorage 只是首屏缓存，不是真相源】
 * 真相源要走一次异步 IPC（settings:get）。若等它回来再首帧渲染，英文用户会先看到一屏中文再跳英文
 * （又是一次「一闪」）。所以本地缓存同步读一次做首屏，随后一律被主进程返回值覆盖 ——
 * 每次启动都会被校正，两者不一致时以主进程为准。
 *
 * 【为什么渲染层不自己按 navigator.language 解析】
 * 解析只发生在主进程一次（app.getLocale() 才是用户看到的系统显示语言，Node/navigator 的
 * ICU locale 可能与它不一致）。渲染层只消费解析结果，避免「两个进程各解一套」的第二份真相。
 */
import { Fragment, useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { AppSettings } from './types'
import type { LParams, LPart, Locale } from '../shared/i18n'
import { getLocale, onLocaleChange, setLocale as setI18nLocale, t, tf } from '../shared/i18n'
import { FALLBACK_LOCALE, LOCALE_AUTO, normalizeLocale } from '../shared/i18n'

/** 首屏缓存键（与主题的 shanhai-theme 同一层级、同一性质：只是缓存） */
export const LOCALE_STORAGE_KEY = 'shanhai-locale'

/** 读首屏缓存；没有缓存返回 null（表示「还没读过主进程」，不要拿默认值冒充用户的选择） */
export function readLocaleCache(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY)
    return v ? normalizeLocale(v) : null
  } catch {
    return null
  }
}

function writeLocaleCache(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    /* localStorage 不可用时静默忽略（与 theme.ts 同口径） */
  }
}

/** 把语言挂到根元素，供 theme.css 按 data-locale 做差异化（字体栈、行高等） */
export function applyLocaleToDom(locale: Locale): void {
  document.documentElement.setAttribute('data-locale', locale)
}

/**
 * 应用一次语言（**同步**，幂等）：更新取词镜像 → 挂 data-locale → 写首屏缓存。
 * 相同值时 shared 门面内部会 bail out、不通知订阅者 —— 避免把任务59 消掉的重复渲染请回来。
 * 注意这里**不**写回 settings：写回是 setAppLocale 的职责，收到广播时再写会造成回环。
 */
export function applyLocale(locale: unknown): Locale {
  const l = normalizeLocale(locale)
  setI18nLocale(l)
  applyLocaleToDom(l)
  writeLocaleCache(l)
  return l
}

/**
 * 用户主动切换语言：写进真相源（settings.locale），主进程落盘后广播给所有窗口。
 * 本窗口先乐观应用一次，不等广播回来 —— 否则点了没反应，就是本项目反复踩的静默失败。
 * 写失败必须可见（抛给调用方去提示），不静默吞。
 *
 * 【为什么必须把 setSettings 的返回值交回调用方（真机缺陷修复）】
 * 返回值是主进程落盘后的**全量快照**，其中 settings.locale 就是「用户的选择」这个真相源。
 * 历轮这里 `await` 完就丢弃返回值 → 设置面板那份用于渲染选中高亮的 state 永远停在 mount 时读到的旧值，
 * 于是出现用户报的现象：**界面语言真的切了（走的是 i18n 镜像），但高亮一直钉在「跟随系统」**。
 * 「生效语言」与「用户的选择」是两件事，面板判高亮只看后者，所以后者必须被同步回来。
 * 交回快照而不是让调用方自己猜一个值写进 state —— 后者会在主进程改写（如归一化）时出现两份真相。
 */
export async function setAppLocale(locale: Locale): Promise<AppSettings | null> {
  applyLocale(locale)
  const api = window.shanhai
  if (!api?.setSettings) throw new Error('本窗口拿不到设置通道（window.shanhai.setSettings 不可用），请重启山海')
  return (await api.setSettings({ locale })) ?? null
}

/**
 * 「用户的选择」→ 设置面板单选组应该点亮哪一项。
 *
 * 判定源**只能**是 settings.locale（真相源），绝不能用 getLocale()（当前生效语言）：
 * 系统语言是中文时，「跟随系统」与「显式选简体中文」的生效语言都是 zh-CN，
 * 用生效语言判高亮就把两种选择压成一种，用户点了也看不出区别。
 * 抽成纯函数是为了能被真跑断言覆盖（面板本体要 React + IPC 才渲得出来）。
 *
 * 空串 / 'auto' → 'auto'（跟随系统；空串是老 config 的「从未设置」，与 auto 同义，见 locale.ts 取值域注释）。
 * 其余值一律 normalizeLocale —— 手改 config 写进来的 'zh' / 'en_GB' / 未知标签也能落到一个真实选项上，
 * 比历轮的「不匹配就谁都不亮」更贴近实际（那种情况下生效语言正是 normalizeLocale 的结果）。
 */
export function localeOptionOf(rawSetting: unknown): Locale | 'auto' {
  if (typeof rawSetting !== 'string') return 'auto'
  const s = rawSetting.trim()
  if (!s || s === LOCALE_AUTO) return 'auto'
  return normalizeLocale(s)
}

/**
 * 窗口启动时的语言初始化（在 main.tsx 里对所有窗口类型统一调用一次）：
 * 1) 先用 localStorage 缓存同步定语言 → 首屏不闪；
 * 2) 再向主进程要真相，但**只有落盘值是具体语言时**才拿它校正；
 * 3) 订阅后续广播（在 useLocaleSync 里）——「跟随系统」时的生效语言由主进程在
 *    窗口加载完成时补推（main/locale-store.ts 的 attachInitialLocalePush）。
 */
export function initLocale(): void {
  applyLocale(readLocaleCache() ?? FALLBACK_LOCALE)
  void (async () => {
    try {
      const s = await window.shanhai?.getSettings?.()
      // ⚠️ 落盘值是【用户的选择】，可能是「跟随系统」（空串 / 'auto'）。
      // 那种情况下它不是生效语言，拿去 applyLocale 会被 normalize 成兜底中文，
      // 把首屏正确的语言（localStorage 缓存 / 主进程补推）冲掉 —— 所以必须跳过。
      if (s && typeof s.locale === 'string' && localeOptionOf(s.locale) !== 'auto') applyLocale(s.locale)
    } catch {
      /* 拿不到主进程：保持缓存值（或兜底），不阻断渲染 */
    }
  })()
}

/**
 * 把带槽位的词条渲染成 React 节点序列（配合 tf() 使用）。
 *
 * 为什么需要：中文原句里嵌了 <b>（如「必须<b>互为好友</b>才能…」），
 * 若只把整句当字符串翻译，英文语序不同 → 加粗会落错词。切成片段后，
 * 加粗落在哪个词由各语言自己的词条决定。后续期数遇到同类句子直接用它。
 *
 * @param parts  tf() 出来的片段
 * @param slots  槽名 → 节点（词条里的 {b1} 对应 slots.b1）
 */
export function renderRich(parts: LPart[], slots: Record<string, ReactNode>): ReactNode {
  return parts.map((p, i) =>
    typeof p === 'string'
      ? <Fragment key={i}>{p}</Fragment>
      : <Fragment key={i}>{slots[p.ph] ?? ''}</Fragment>,
  )
}

/** 订阅源：shared 门面的语言变化 */
function subscribeLocale(cb: () => void): () => void {
  return onLocaleChange(() => cb())
}

/**
 * 只读窗口订阅语言广播（对应 theme.ts 的 useThemeSync）。
 * 聊天窗口与应用窗口都能改语言（设置面板两处都开），所以所有窗口都订阅，不区分写者。
 */
export function useLocaleSync(): void {
  useSyncExternalStore(subscribeLocale, getLocale, () => FALLBACK_LOCALE)
}

/**
 * 组件内取词。语言变化时 useSyncExternalStore 让本组件重渲染 —— 这是唯一的响应式入口，
 * 后续期数不要再各自搭一套 Context / Provider。
 */
export function useI18n(): {
  locale: Locale
  /** 按当前语言取一条文案（可带 {name} 占位符与 n/count 复数） */
  tr: (key: string, params?: LParams) => string
  /** 按当前语言取富文本片段（词条里的 {b} 槽交给调用方渲染成节点） */
  tfParts: (key: string) => LPart[]
  /** 切换语言（写真相源 + 广播），返回主进程落盘后的全量快照，调用方据此同步自己那份 settings */
  switchLocale: (locale: Locale) => Promise<AppSettings | null>
} {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => FALLBACK_LOCALE)
  const tr = useCallback((key: string, params?: LParams) => t(key, params), [locale])
  const tfParts = useCallback((key: string) => tf(key), [locale])
  return { locale, tr, tfParts, switchLocale: setAppLocale }
}
