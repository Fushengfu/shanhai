/**
 * 语言（locale）基础定义 —— 山海 i18n 的地基，不含任何词条。
 *
 * 【设计口径】照抄既有「主题」范式的**形态**（一个偏好 + 全窗口广播 + 只读窗口订阅），
 * 但持久化位置不同，且这是刻意的：
 *   主题：localStorage['shanhai-theme']（主进程完全不持久化、不解析）
 *   语言：config.json 的 settings.locale（主进程与 runtime 都要读得到 → 必须走持久化设置通道）
 *
 * 【为什么落 AppSettings，而不是另开 userData/locale.json】
 * 1. prompts.ts（apps/runtime）要按当前语言决定「回复用中文还是英文」。runtime 读不到 Electron 的
 *    userData 路径，但**已经在启动时把 settings 读进内存**（ctx.currentSettings），走 settings 零额外 IO。
 * 2. AppSettings 的读写在 5 个位置各有一份「字段枚举字面量」（DEFAULT_SETTINGS / readSettings /
 *    writeSettings / bootstrap.setSettings 的合并与返回 / getSettings 的返回 / SettingsPanel 的初始 state）。
 *    看着像风险，其实每一处都是对象字面量赋给 AppSettings 类型 —— **漏一个字段 tsc 直接报错**，
 *    比 env 变量、独立 json 文件这类「编译器看不见的第二份真相」安全得多。
 * 3. 主进程读当前语言 = locale-store.getMainLocale()（就是下面那份 shared 镜像），
 *    不需要新文件、不需要新真相源。
 *
 * 【取值】持久化的是用户的【选择】：'zh-CN' | 'en-US' | 空串 | 'auto'，
 * 其中**空串与 'auto' 同义，都表示「跟随系统」**（合并成一个语义是刻意的：老 config 的 ''
 * 与用户显式选的「跟随系统」行为完全一致，分成两个值就需要迁移历史数据）。
 * ⚠️ 主进程**不会**把解析结果写回这里（i18n 落盘修复轮）：解析出来的是【生效语言】，只进内存
 * （shared 镜像 + runtime 的 ctx.effectiveLocale），一次都不落盘 —— 否则「跟随系统」会在
 * 第一次重启后被冲成具体语言、语义永久丢失。见 main/locale-store.ts 的 ensureLocaleResolved。
 */

/** 支持的语言集合。本期只中英（用户拍板）；新增语言要同时补 dict 与这里。 */
export type Locale = 'zh-CN' | 'en-US'

/** 全部支持语言（顺序 = 设置面板展示顺序） */
export const SUPPORTED_LOCALES: readonly Locale[] = ['zh-CN', 'en-US']

/** 兜底语言：任何环节失败都落到它，绝不出现无词可用 */
export const FALLBACK_LOCALE: Locale = 'zh-CN'

/** 「未设置 / 跟随系统」哨兵：settings.locale 的初始值，表示用户从没手动选过语言 */
export const LOCALE_AUTO = 'auto'

/** 持久化取值域：具体语言 或 未设置（空串与 'auto' 同义） */
export type LocaleSetting = Locale | typeof LOCALE_AUTO | ''

/**
 * 把任意输入归一成受支持的语言；不认识的一律落兜底。
 * ⚠️ 空串 / 'auto' 都落兜底：它们是「未解析」状态，解开由 resolveLocaleSetting 负责。
 */
export function normalizeLocale(input: unknown): Locale {
  if (typeof input !== 'string') return FALLBACK_LOCALE
  const s = input.trim().replace(/_/g, '-')
  if (!s || s === LOCALE_AUTO) return FALLBACK_LOCALE
  const lower = s.toLowerCase()
  for (const l of SUPPORTED_LOCALES) if (l.toLowerCase() === lower) return l
  // 语言段命中：zh / zh-TW / zh-Hans-CN → zh-CN；en / en-GB → en-US
  const primary = lower.split('-')[0]
  if (primary === 'zh') return 'zh-CN'
  if (primary === 'en') return 'en-US'
  return FALLBACK_LOCALE
}

/**
 * 系统语言标签（app.getLocale() / navigator.language）→ 受支持语言。
 * 中文（zh*）→ zh-CN；其余一律 en-US —— 本期只有两种语言，英文作为非中文的通用回落。
 */
export function resolveLocaleFromSystem(systemTag: unknown): Locale {
  if (typeof systemTag !== 'string') return FALLBACK_LOCALE
  return systemTag.trim().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** 设置值 → 实际生效语言：未设置用系统语言解开，其余按 normalizeLocale。 */
export function resolveLocaleSetting(setting: unknown, systemTag: unknown): Locale {
  const s = typeof setting === 'string' ? setting.trim() : ''
  if (!s || s === LOCALE_AUTO) return resolveLocaleFromSystem(systemTag)
  return normalizeLocale(s)
}

/**
 * 语言的自称名：固定用该语言自身书写，不随界面语言变化（i18n 惯例，避免「把 English 翻成英文」这类困惑）。
 * 所以这一项**故意不进语言包** —— 它是常量，翻它反而是 bug。
 */
export const LOCALE_DISPLAY_NAME: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
}

/**
 * 复数类别：与 Intl.PluralRules 对齐（en: 1→one，其余→other；zh: 恒 other）。
 * 优先用 Intl.PluralRules（Electron/Node 内置，实测可用），拿不到时退到手写规则，
 * 保证任何运行环境下 0 / 1 / 2 / 5 / 21 这些数量的判定一致。
 */
export function pluralCategory(locale: Locale, count: number): 'one' | 'other' {
  const n = Number.isFinite(count) ? Math.abs(Math.trunc(count)) : 0
  try {
    return new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other'
  } catch {
    if (locale === 'zh-CN') return 'other'
    return n === 1 ? 'one' : 'other'
  }
}

