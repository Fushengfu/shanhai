/**
 * 【i18n 期5B-补漏】会员显示名的**唯一**实现（任务58「界面不显示 memberId」的语义载体）。
 *
 * 为什么要有这个文件：
 *   「昵称 → 用户名 → 未知会员，绝不回落 memberId」这套判定原先**只写在渲染层**
 *   （MemberPanel.tsx 的 displayNameOf）。而主进程有六条路径在拿不到昵称/用户名时
 *   直接兜底成对端 memberId，其中 `notifyDmMessage` 的标题、好友申请通知的标题
 *   根本不经过渲染层 —— 于是「英文界面 + 通知里一个纯数字 memberId」。
 *   用户已裁决：**任何位置都不出现纯数字 memberId**，通知也走「昵称→用户名→未知会员」。
 *
 * 所以把这套语义抽到 shared 层，主进程与渲染层共用同一份实现。
 * ⚠️ 禁止在 main 里再抄一份判定（两份必然漂）；要新兜底就改这里。
 *
 * 两个函数分工：
 *   - realNameOrEmpty：给「要落盘 / 要跨进程传」的值用。只回答「有没有真名」，
 *     拿不到就返回**空串**，由显示层再决定兜底词。
 *     —— 不在这里出「未知会员」是有意的：那是**已翻译的文案**，写进 dm-store.json
 *     或塞进跨进程载荷，就等于把语言烘进磁盘/载荷（期5B 在 m.failed 上刚踩过同一个坑，
 *     切语言后旧值永远停在旧语言）。
 *   - displayNameOf：给「此刻就要给人看」的地方用（系统通知标题）。返回当前语言的兜底词。
 *
 * 两个函数的**判定条件完全相同**（空 / 等于 id 都算「没有真名」），只是一个返回空串、
 * 一个返回本地化兜底词 —— 不存在两套真相。
 */
import { t } from './i18n'

/**
 * 真名判定：空串、或「名字本身就等于那个 id」都算没有真名 → 返回空串。
 * 第二条判据是为了挡住**历史数据**：修复前主进程已经把 memberId 写进了 peerName /
 * fromName 并落盘，升级后不能指望磁盘上是干净的。
 */
export function realNameOrEmpty(name: string | undefined | null, id?: string): string {
  const n = (name ?? '').trim()
  if (!n) return ''
  if (id && n === id) return ''
  return n
}

/**
 * 显示名（本地化）：真名 → 当前语言的「未知会员」。
 * ⚠️ 只用于**即时显示**（系统通知标题这类不经过渲染层的场合）。
 *    不要把返回值写进落盘字段或跨进程载荷 —— 那会把语言烘进磁盘，用 realNameOrEmpty。
 */
export function displayNameOf(name: string | undefined | null, id?: string): string {
  return realNameOrEmpty(name, id) || t('common.unknownMember')
}
