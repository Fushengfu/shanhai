/**
 * 插件版本号比较（任务122 P1：从 PluginMarketApp.tsx 提到 shared 层，做**单一真相源**）。
 *
 * 【为什么放 shared】市场「是否有更新 / 是否降级」的判定同时需要两处：
 *  - 主进程 `marketplace.ts`：给列表项算 localVersion / hasUpdate / downgrade（决定是否出「更新」按钮、
 *    以及安装前的防降级守卫）；
 *  - 渲染层 `PluginMarketApp.tsx`：自研插件的「提交升级版本共享」状态机（shareAction）。
 *  两处各留一份就会漂（本项目反复踩过的「两份真相」），故统一提到本文件，两边 import。
 *
 * 【为什么不用字符串字典序】'1.10.0' < '1.9.0' 在字典序下成立，会把新版本判成旧版本。
 * 故按数字段逐段比较，缺段补 0（'1.1' == '1.1.0'）。
 */

/** 解析版本号为数字段（取所有连续数字段，非 semver 严格解析：容忍 '1.1'、'v2.0.0'、'1.2.3-beta4'） */
export function parseVersion(v?: string): number[] {
  if (!v) return []
  const m = String(v).trim().match(/\d+/g)
  return m ? m.map((n) => parseInt(n, 10)) : []
}

/** semver 比较：a > b 返回 1，a < b 返回 -1，相等返回 0 */
export function compareVersions(a?: string, b?: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/**
 * 目标版本相对本地版本的关系。
 *
 * ★ 任一侧缺版本号 / 解析不出数字段时返回 'unknown'，调用方**不得**把它当 'same' 或 'newer' 用：
 *   - 防降级守卫只在明确 'older' 时触发（unknown 不拦，避免"网关没给版本"就完全装不上）；
 *   - 「有更新」标记只在明确 'newer' 时给（unknown 不谎报可升级）。
 */
export type MarketVersionRelation = 'newer' | 'same' | 'older' | 'unknown'

export function versionRelation(target?: string, local?: string): MarketVersionRelation {
  if (!target || !local) return 'unknown'
  if (parseVersion(target).length === 0 || parseVersion(local).length === 0) return 'unknown'
  const c = compareVersions(target, local)
  if (c > 0) return 'newer'
  if (c < 0) return 'older'
  return 'same'
}
