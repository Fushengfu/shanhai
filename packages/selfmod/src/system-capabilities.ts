/**
 * 阶段2：network / filesystem 受控桥「系统插件」骨架。
 *
 * 目的：把「联网」「文件读写」从 host 半的 node 内置模块裸能力，收敛成「受控桥」——
 * 能力本身在本文件（山海内核/selfmod 侧）实现，普通插件通过「阶段1b 的 capabilities.consume 路由」
 * 调用，而不是各插件自己 require('node:http')/require('node:fs') 裸开。
 *
 * 这里提供的是「可编译、最小可运行」的桥骨架：
 * - SSRF 拦截（禁内网/环回 hostname）
 * - 路径穿越拒绝（../ 等）
 * - HTTP GET/POST 代办（并发上限）
 * - 插件私有目录限定（~/.shanhai/plugins/<id>/data/）+ 配额
 *
 * 完整实测定（DNS 二次解析后再拦、请求大小/超时/重定向策略、配额落盘）标注为「待续」，
 * 见各函数注释。真正的系统插件 host 半会引用这里的工厂，并用 `ctx.provideCapability(name, meta, impl)`
 * 注册进内核（复用阶段1a 双写 + 阶段2 能力级审批）。
 */

import { promises as fs } from 'node:fs'
import { resolve, sep, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import type { CapabilityMeta, CapabilityRisk } from '@shanhai/kernel'

// —— 能力名（对齐设计文档：network:http / filesystem）——
export const NETWORK_CAPABILITY = 'network:http'
export const FILESYSTEM_CAPABILITY = 'filesystem'

// —— 浏览器系统能力（阶段3：能力切分映射三档风险）——
export const BROWSER_READ_CAPABILITY = 'browser:read'
export const BROWSER_NAVIGATE_CAPABILITY = 'browser:navigate'
export const BROWSER_INTERACT_CAPABILITY = 'browser:interact'
export const BROWSER_EXECUTE_CAPABILITY = 'browser:execute'
export const BROWSER_COOKIE_CAPABILITY = 'browser:cookie'
export const BROWSER_SCREENSHOT_CAPABILITY = 'browser:screenshot'

// —— 能力元数据（供系统插件 ctx.provideCapability 声明，决定审批分级）——
export const NETWORK_CAPABILITY_META: CapabilityMeta = {
  name: NETWORK_CAPABILITY,
  risk: 'write', // 网络 POST 属写操作，默认需审批；GET 为 read-only，能力粒度下统一按「write」从严
}
export const FILESYSTEM_CAPABILITY_META: CapabilityMeta = {
  name: FILESYSTEM_CAPABILITY,
  risk: 'write', // 文件写属写操作；文件读为 read-only，能力粒度下统一按「write」从严
}

// —— 浏览器能力元数据（阶段3：逐条映射三档风险 + 审批策略）——
export const BROWSER_READ_CAPABILITY_META: CapabilityMeta = {
  name: BROWSER_READ_CAPABILITY,
  risk: 'read-only',
  approval: 'allow', // 只读：getContent/getInfo/logs/networkRequests/list/wait
}
export const BROWSER_NAVIGATE_CAPABILITY_META: CapabilityMeta = {
  name: BROWSER_NAVIGATE_CAPABILITY,
  risk: 'write',
  approval: 'ask', // 打开 URL/前进后退/create/close/show/setShowOnCreate
}
export const BROWSER_INTERACT_CAPABILITY_META: CapabilityMeta = {
  name: BROWSER_INTERACT_CAPABILITY,
  risk: 'write',
  approval: 'ask', // click/type/scroll（含 select，v1 映射到 interact：BrowserUseService 无独立 select 方法）
}
export const BROWSER_EXECUTE_CAPABILITY_META: CapabilityMeta = {
  name: BROWSER_EXECUTE_CAPABILITY,
  risk: 'destructive',
  approval: 'always', // evaluate/chatWithPageBridge：逐次强制审批 + 回显代码
}
export const BROWSER_COOKIE_CAPABILITY_META: CapabilityMeta = {
  name: BROWSER_COOKIE_CAPABILITY,
  risk: 'write',
  approval: 'ask', // 读 cookie 也按 write 对待（登录态敏感）
}
export const BROWSER_SCREENSHOT_CAPABILITY_META: CapabilityMeta = {
  name: BROWSER_SCREENSHOT_CAPABILITY,
  risk: 'read-only',
  approval: 'allow', // 截图（3d 落盘改造后只返回文件路径，禁止 base64）
}

/** 私有/环回 hostname 黑名单（SSRF 拦截第一道：hostname 字符串匹配） */
const PRIVATE_HOST_SUFFIXES = [
  'localhost',
  '.local',
  '.internal',
  '.lan',
  '.home',
  '.corp',
]
const PRIVATE_IP_PREFIXES = [
  '10.',
  '127.',
  '169.254.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '192.168.',
  '0.',
  '::1',
  'fc',
  'fd',
  'fe8',
  'fe9',
  'fea',
  'feb',
]

/**
 * SSRF 拦截：判断一个 hostname 是否可能指向内网/环回地址。
 * 仅做 hostname 字符串匹配（第一道防线）；DNS 解析后再校验 IP 属「待续」（需引入 dns 异步解析，
 * 见 createNetworkBridge 的 httpGet/httpPost 注释）。
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase()
  if (!h) return true
  if (PRIVATE_HOST_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s))) return true
  if (PRIVATE_IP_PREFIXES.some((p) => h.startsWith(p))) return true
  return false
}

/**
 * SSRF 拦截第二道：判断解析出的单个 IP 是否为私有/环回/链路本地/保留地址。
 * 覆盖：0.0.0.0、10/8、100.64/10（CGNAT）、127/8、169.254/16、172.16/12、192.0.0/24、
 * 192.168/16、198.18/15、224/4 组播、::、::1、fc00::/7（ULA）、fe80::/10（链路本地）、
 * IPv4-mapped IPv6（::ffff:a.b.c.d）。
 */
export function isPrivateIp(ip: string): boolean {
  const bare = ip.trim().toLowerCase().split('%')[0]!
  const ver = isIP(bare)
  if (ver === 4) {
    const parts = bare.split('.').map(Number)
    const a = parts[0]!
    const b = parts[1]!
    if (a === 0) return true
    if (a === 10) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 0 && parts[2] === 0) return true
    if (a === 192 && b === 168) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true // 组播 / 保留
    return false
  }
  if (ver === 6) {
    if (bare === '::' || bare === '::1') return true
    if (bare.startsWith('fc') || bare.startsWith('fd')) return true
    if (bare.startsWith('fe8') || bare.startsWith('fe9') || bare.startsWith('fea') || bare.startsWith('feb')) return true
    if (bare.startsWith('ff')) return true // 组播
    if (bare.startsWith('::ffff:')) {
      return isPrivateIp(bare.slice('::ffff:'.length))
    }
    return false
  }
  return false
}

/** DNS 解析 + 二次 IP 校验：堵掉「用域名绕过 hostname 黑名单指向内网」的洞。解析失败一律拒绝（保守）。 */
async function assertPublicHost(hostname: string): Promise<void> {
  // 第一道：hostname 字符串粗筛（快速失败，避免无谓的 DNS 查询）
  if (isPrivateOrLoopbackHost(hostname)) {
    throw new Error(`SSRF 拦截：拒绝访问内网/环回地址 "${hostname}"`)
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await new Promise<Array<{ address: string }>>((resolveP, rejectP) => {
      lookup(hostname, { all: true }, (err, res) => (err ? rejectP(err) : resolveP(res as Array<{ address: string }>)))
    })
  } catch (err) {
    throw new Error(`SSRF 拦截：无法解析主机 "${hostname}"（${err instanceof Error ? err.message : String(err)}）`)
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`SSRF 拦截：主机 "${hostname}" 解析到内网/环回地址 ${address}`)
    }
  }
}

/** 解析 URL，返回 { hostname, secure }，并对非法/内网 host 抛错（SSRF 拦截入口） */
function parseUrlOrThrow(rawUrl: string): { url: URL } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`非法的 URL: ${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`仅允许 http/https 协议: ${url.protocol}`)
  }
  if (isPrivateOrLoopbackHost(url.hostname)) {
    throw new Error(`SSRF 拦截：拒绝访问内网/环回地址 "${url.hostname}"`)
  }
  return { url }
}

/** 网络桥配置 */
export interface NetworkBridgeOptions {
  /** 并发请求上限（超出抛错） */
  maxConcurrent?: number
  /** 单请求超时（毫秒） */
  timeoutMs?: number
}

/**
 * 网络桥：HTTP GET/POST 代办 + SSRF 拦截 + 并发上限。
 * 注意：当前仅做 hostname 级 SSRF 拦截；DNS 解析后再校验目标 IP 属「待续」。
 */
export function createNetworkBridge(opts: NetworkBridgeOptions = {}) {
  const maxConcurrent = opts.maxConcurrent ?? 8
  const timeoutMs = opts.timeoutMs ?? 30000
  let inflight = 0

  const acquire = (): void => {
    if (inflight >= maxConcurrent) {
      throw new Error(`网络桥并发超限（${maxConcurrent}），请稍后重试`)
    }
    inflight += 1
  }
  const release = (): void => {
    inflight = Math.max(0, inflight - 1)
  }

  const doRequest = async (url: URL, method: 'GET' | 'POST', body?: string): Promise<{ status: number; body: string }> => {
    // SSRF 第二道防线：DNS 解析 + IP 二次校验（堵「域名绕过 hostname 黑名单指向内网」）
    await assertPublicHost(url.hostname)
    acquire()
    try {
      return await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          { method, headers: { 'user-agent': 'shanhai-controlled-bridge' }, timeout: timeoutMs },
          (res: IncomingMessage) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
              const respBody = Buffer.concat(chunks).toString('utf8')
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ status: res.statusCode, body: respBody })
              } else {
                reject(new Error(`HTTP ${res.statusCode}: ${respBody.slice(0, 200)}`))
              }
            })
          },
        )
        req.on('error', (err) => reject(err))
        req.on('timeout', () => {
          req.destroy(new Error(`网络请求超时（${timeoutMs}ms）`))
        })
        if (method === 'POST' && body != null) req.write(body)
        req.end()
      })
    } finally {
      release()
    }
  }

  return {
    async httpGet(rawUrl: string): Promise<{ status: number; body: string }> {
      const { url } = parseUrlOrThrow(rawUrl)
      return doRequest(url, 'GET')
    },
    async httpPost(rawUrl: string, body: string): Promise<{ status: number; body: string }> {
      const { url } = parseUrlOrThrow(rawUrl)
      return doRequest(url, 'POST', body)
    },
  }
}

/**
 * 路径穿越拒绝：解析并校验目标路径确实落在 root 目录内（含 `..` / 绝对路径 / 符号链接后仍越界）。
 * 返回归一化的绝对路径或抛错。
 */
export function resolveWithinRoot(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error('文件桥拒绝空路径')
  }
  if (rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel)) {
    throw new Error(`文件桥拒绝绝对路径: ${rel}`)
  }
  const rootAbs = resolve(root)
  const target = resolve(rootAbs, rel)
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new Error(`文件桥拒绝越界路径: ${rel}`)
  }
  return target
}

/** 文件桥配置 */
export interface FilesystemBridgeOptions {
  /** 单插件私有目录根（~/.shanhai/plugins/<id>/data），路径穿越/越界都相对它校验 */
  rootDir: string
  /** 单插件配额上限（字节，缺省 64MB） */
  maxBytes?: number
}

/**
 * 文件桥：插件私有目录限定 + 路径穿越拒绝 + 配额。
 * 注意：配额校验用「每次写前 stat 估算」，未做锁/原子扣减；超大文件流式写入未实现（待续）。
 */
export function createFilesystemBridge(opts: FilesystemBridgeOptions) {
  const root = resolve(opts.rootDir)
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024

  const ensureRoot = async (): Promise<void> => {
    await fs.mkdir(root, { recursive: true })
  }

  const currentBytes = async (): Promise<number> => {
    let total = 0
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          await walk(p)
        } else if (e.isFile()) {
          try {
            total += (await fs.stat(p)).size
          } catch {
            // 忽略竞态删除
          }
        }
      }
    }
    await walk(root)
    return total
  }

  const checkQuota = async (addingBytes: number): Promise<void> => {
    if (maxBytes <= 0) return
    const used = await currentBytes()
    if (used + addingBytes > maxBytes) {
      throw new Error(`文件桥配额超限（${maxBytes} 字节），当前已用 ${used}`)
    }
  }

  return {
    async readFile(rel: string): Promise<string> {
      await ensureRoot()
      const target = resolveWithinRoot(root, rel)
      return fs.readFile(target, 'utf8')
    },
    async writeFile(rel: string, content: string): Promise<void> {
      await ensureRoot()
      const target = resolveWithinRoot(root, rel)
      const newBytes = Buffer.byteLength(content, 'utf8')
      // 单次写入显式上限报错（不小步超配额、不静默超载）
      if (maxBytes > 0 && newBytes > maxBytes) {
        throw new Error(`文件桥单次写入 ${newBytes} 字节超过配额上限 ${maxBytes} 字节`)
      }
      // 写前：旧文件若存在，其大小会被本次覆盖释放，按「净增量」估算（防明显超额）
      let oldBytes = 0
      try {
        oldBytes = (await fs.stat(target)).size
      } catch {
        // 目标不存在，旧大小按 0 计
      }
      await checkQuota(newBytes - oldBytes)
      await fs.mkdir(join(target, '..'), { recursive: true })
      await fs.writeFile(target, content, 'utf8')
      // 写后：实际累计校验（堵「写前 stat 估算」的偏差/并发竞态），超额则回滚本次写入
      const usedAfter = await currentBytes()
      if (maxBytes > 0 && usedAfter > maxBytes) {
        try {
          await fs.rm(target, { force: true })
        } catch {
          // 回滚失败不掩盖配额错误
        }
        throw new Error(`文件桥配额超限（${maxBytes} 字节），写入后实际已用 ${usedAfter}，本次写入已回滚`)
      }
    },
    async listDir(rel = '.'): Promise<string[]> {
      await ensureRoot()
      const target = resolveWithinRoot(root, rel)
      return fs.readdir(target)
    },
    async exists(rel: string): Promise<boolean> {
      await ensureRoot()
      const target = resolveWithinRoot(root, rel)
      try {
        await fs.access(target)
        return true
      } catch {
        return false
      }
    },
    async usageBytes(): Promise<number> {
      await ensureRoot()
      return currentBytes()
    },
  }
}

/**
 * 系统能力注册清单：把 network/filesystem 桥能力的能力名 + 元数据集中一处，
 * 供系统插件 host 半在 `ctx.provideCapability(name, meta, impl)` 时引用（避免散落）。
 */
export interface SystemCapabilityDefinition {
  name: string
  meta: CapabilityMeta
  risk: CapabilityRisk
}

export const SYSTEM_CAPABILITIES: SystemCapabilityDefinition[] = [
  { name: NETWORK_CAPABILITY, meta: NETWORK_CAPABILITY_META, risk: 'write' },
  { name: FILESYSTEM_CAPABILITY, meta: FILESYSTEM_CAPABILITY_META, risk: 'write' },
  { name: BROWSER_READ_CAPABILITY, meta: BROWSER_READ_CAPABILITY_META, risk: 'read-only' },
  { name: BROWSER_NAVIGATE_CAPABILITY, meta: BROWSER_NAVIGATE_CAPABILITY_META, risk: 'write' },
  { name: BROWSER_INTERACT_CAPABILITY, meta: BROWSER_INTERACT_CAPABILITY_META, risk: 'write' },
  { name: BROWSER_EXECUTE_CAPABILITY, meta: BROWSER_EXECUTE_CAPABILITY_META, risk: 'destructive' },
  { name: BROWSER_COOKIE_CAPABILITY, meta: BROWSER_COOKIE_CAPABILITY_META, risk: 'write' },
  { name: BROWSER_SCREENSHOT_CAPABILITY, meta: BROWSER_SCREENSHOT_CAPABILITY_META, risk: 'read-only' },
]