/**
 * 主进程的语言通道（i18n 期1 · 用户已批准的「新增语言能力」）。
 *
 * 【本期职责】只做两件事，且刻意不新增任何 IPC 通道：
 *   ① 启动时把「未设置」按系统语言解析一次并落盘（首次跟随系统语言）；
 *   ② 语言一变就广播 ui:locale 给所有窗口（照抄 theme:set → ui:theme 那条通道的形态）。
 *
 * 【为什么不新开 locale:get / locale:set 通道】
 * 读写设置已有现成通道（ipc-handlers.ts 的 settings:get / settings:set → runtime.getSettings/setSettings），
 * 渲染层直接用即可；再开一对 locale:* 就是同一份数据两条路，属第二套真相源，
 * 而且会让 ipcMain.handle 计数从 125 变成 127（历轮台账锁的是 125）。
 * 本期只在既有的 settings:set 处理器里补一行广播，通道数不变。
 *
 * 【真相源】config.json 的 settings.locale（AppSettings.locale）。
 * 本模块不另开 userData/locale.json —— 那样会有两份「用户选了哪种语言」，
 * 改一处另一处不知道，正是本项目反复踩过的第二份假真相。
 *
 * 【第 5 期（本期）已接】Dock 菜单 / 托盘 / 窗口右键菜单 / 系统通知全部走本模块：
 *   - 取词时读 getMainLocale()（**主进程唯一的语言真相源**，别处不许再读 settings.locale 原文、
 *     不许读 config.json、更不许把语言决策渗回渲染层）；
 *   - 需要「语言一变就重建」的原生 UI（Dock / 托盘）用 onMainLocaleChange(handler) 注册回调 ——
 *     本模块不 import 任何 UI 模块，所以不会形成循环依赖；注册方在 main/index.ts（组装根）。
 *   - 系统通知与窗口右键菜单**不需要**热更新：它们分别在「产生那一刻」与「每次弹出时」现取词。
 *
 * 【为什么 mainLocale 不再是本模块的私有变量】
 * 期1 在这里另存了一份 mainLocale，而 shared/i18n 里还有一份进程内镜像 —— 那是同一进程里的两份真相，
 * 谁漏写一次就不一致。本期把本模块改成**只驱动 shared/i18n 那一份镜像**（setLocale），
 * getMainLocale() 直接读它。主进程与渲染层共用 shared 镜像的语义（各进程一份、由本进程的入口写），
 * 而不是「主进程两份」。
 */
import { app, BrowserWindow } from 'electron'
import { getRuntime } from './runtime'
import { safeSend } from './safe-send'
import type { Locale } from '../shared/i18n'
import { FALLBACK_LOCALE, getLocale, resolveLocaleSetting, setLocale } from '../shared/i18n'

/**
 * 主进程侧要重建的原生 UI 回调（Dock 菜单 / 托盘菜单 + 托盘 tooltip）。
 * 用注册表而不是让 locale-store 去 import 这些模块：后者已经 import 了 runtime / 窗口层，
 * 反向 import 会形成循环依赖（ESM 下表现为半初始化模块）。
 */
type MainLocaleHandler = (locale: Locale) => void
const localeHandlers = new Set<MainLocaleHandler>()

/**
 * 系统语言标签：Electron 的 app.getLocale() 反映的是用户看到的系统显示语言，
 * 比 Node 的 ICU locale（可能只跟随安装语言）更准，所以首次解析以它为准。
 */
export function systemLocaleTag(): string {
  try {
    return app.getLocale?.() ?? ''
  } catch {
    return ''
  }
}

/**
 * 主进程读当前语言 —— **主进程唯一的语言真相源**（Dock / 托盘 / 右键菜单 / 系统通知全部用它）。
 * 实现上直接读 shared/i18n 的进程内镜像：本模块是该镜像在主进程里的**唯一写入者**，
 * 所以「读 getMainLocale()」与「读 shared 镜像」是同一件事，不存在第二份。
 * 未初始化（ensureLocaleResolved 之前）返回兜底语言，不抛错。
 */
export function getMainLocale(): Locale {
  return getLocale()
}

/**
 * 注册「语言变了」回调（供 Dock / 托盘这类**一次性建好的原生菜单**重建自己）。
 * 返回退订函数（与渲染层 onLocaleChange / onThemeChange 同一形态）。
 * 回调里抛错只告警、不传染：一个 UI 重建失败不该让另一个也不重建。
 */
export function onMainLocaleChange(handler: MainLocaleHandler): () => void {
  localeHandlers.add(handler)
  return () => {
    localeHandlers.delete(handler)
  }
}

function notifyMainLocaleHandlers(locale: Locale): void {
  // 复制一份再遍历：回调里可能退订/注册，直接迭代 Set 会漏掉或抛错
  for (const h of [...localeHandlers]) {
    try {
      h(locale)
    } catch (err) {
      console.warn('[山海] 语言变化后重建原生 UI 失败：', err)
    }
  }
}

/** 广播给所有窗口（照 theme:set 的写法：不区分窗口类型，各窗口自己决定要不要跟随） */
function broadcastLocale(locale: Locale): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win, 'ui:locale', locale)
  }
}

/**
 * 应用一份新的 locale 设置值：更新本进程镜像 + 广播。
 * @param raw settings.locale 的原始值（可能是 ''=未设置 / 任意历史字符串）
 * @returns 解析后的生效语言
 */
export function syncLocaleFromSettings(raw: unknown): Locale {
  const next = resolveLocaleSetting(raw, systemLocaleTag())
  // setLocale 内部对「同值」直接 bail out 并返回 false —— 同值时既不广播也不重建菜单，
  // 否则每次写设置（保存任何一项都会带全量 patch）都要重扫一遍窗口、重建一次原生菜单。
  const changed = setLocale(next)
  if (changed) {
    broadcastLocale(next)
    notifyMainLocaleHandlers(next)
  }
  return next
}

/**
 * 启动时调用一次：把「未设置」按系统语言解析并落盘，之后 settings.locale 一直是具体值。
 * 这样 prompts.ts（runtime 侧）只需比较 'en-US' 就能决定回复语言指令，不必知道「auto」这个概念。
 * 落盘失败不阻断启动：内存里仍按解析结果工作，下次启动再落。
 */
export async function ensureLocaleResolved(): Promise<Locale> {
  const saved = getRuntime().getSettings().locale
  const resolved = resolveLocaleSetting(saved, systemLocaleTag())
  // 启动时也要写镜像（此时还没有窗口、也没有注册回调，setLocale 的返回值在这里不用于广播）
  setLocale(resolved)
  if (saved !== resolved) {
    try {
      await getRuntime().setSettings({ locale: resolved })
    } catch {
      /* 落盘失败：内存值已生效，界面与主进程仍一致（只是重启后要重新解析一次） */
    }
  }
  return resolved
}
