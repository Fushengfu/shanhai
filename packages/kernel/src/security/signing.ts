import { sign, verify } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * Ed25519 签名 + 文件快照回滚（K4 安全）。
 *
 * - 签名：插件清单稳定序列化（键序稳定）后签名，加载前验签，篡改拒绝。
 * - 快照：写操作前备份，可回滚 / 确认后丢弃（支撑「信任四可」的可回退）。
 */

/** 键序稳定的 JSON 序列化（保证同构对象序列化结果一致） */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** 用 Ed25519 私钥对 payload 签名（返回 base64） */
export function signPayload(payload: unknown, privateKey: string): string {
  const data = Buffer.from(stableStringify(payload))
  return sign(null, data, privateKey).toString('base64')
}

/** 用 Ed25519 公钥验签（篡改返回 false） */
export function verifyPayload(payload: unknown, signature: string, publicKey: string): boolean {
  const data = Buffer.from(stableStringify(payload))
  try {
    return verify(null, data, publicKey, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

export type SnapshotId = string

/** 文件快照回滚接口 */
export interface SnapshotStore {
  snapshot(path: string): Promise<SnapshotId>
  rollback(path: string, id: SnapshotId): Promise<void>
  discard(path: string, id: SnapshotId): Promise<void>
}

/** 文件系统实现的快照存储：快照复制到专用目录 */
export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly dir: string) {}

  async snapshot(path: string): Promise<SnapshotId> {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    await fs.mkdir(this.dir, { recursive: true })
    await fs.copyFile(path, join(this.dir, id))
    return id
  }

  async rollback(path: string, id: SnapshotId): Promise<void> {
    const snapshotPath = join(this.dir, id)
    await fs.copyFile(snapshotPath, path)
  }

  async discard(_path: string, id: SnapshotId): Promise<void> {
    await fs.rm(join(this.dir, id), { force: true })
  }
}
