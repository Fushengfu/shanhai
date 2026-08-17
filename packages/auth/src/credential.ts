import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import type { GatewayModel } from './auth'

export interface LocalCredential {
  username: string
  token: string
  customModels?: GatewayModel[]
}

export interface CredentialStore {
  load(): Promise<LocalCredential | null>
  save(cred: LocalCredential): Promise<void>
  clear(): Promise<void>
}

/**
 * 文件凭证存储：~/.shanhai/config.json（权限 600）。
 *
 * 只存 token + username + 自定义模型，密码绝不落盘（只在登录请求瞬间使用）。
 */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly path: string = join(homedir(), '.shanhai', 'config.json')) {}

  async load(): Promise<LocalCredential | null> {
    try {
      const raw = await fs.readFile(this.path, 'utf8')
      return JSON.parse(raw) as LocalCredential
    } catch {
      return null
    }
  }

  async save(cred: LocalCredential): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true })
    await fs.writeFile(this.path, JSON.stringify(cred, null, 2), { mode: 0o600 })
  }

  async clear(): Promise<void> {
    await fs.rm(this.path, { force: true })
  }
}

function join(...parts: string[]): string {
  return parts.join('/').replace(/\/{2,}/g, '/')
}
