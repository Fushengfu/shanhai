import { promises as fs } from 'node:fs'
import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const exec = promisify(execCallback)

/** 工具风险等级（安全属性内嵌于契约） */
export type RiskLevel = 'readonly' | 'reversible' | 'irreversible' | 'high'

/**
 * 工具契约：一个工具的完整定义。
 *
 * description 是隐式 prompt——写清「何时用 / 参数含义 / 返回什么 / 何时不能用」，
 * 直接决定模型调用准确率。风险等级 + approvalRequired 让安全层统一拦截。
 */
export interface ToolContract {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  riskLevel: RiskLevel
  approvalRequired?: boolean
  timeoutMs?: number
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

/** 原子工具：read_file（只读，无需审批） */
export const readFileTool: ToolContract = {
  name: 'read_file',
  description: '读取指定路径的文本文件内容。当需要查看文件内容时使用。',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '文件绝对路径' } },
    required: ['path'],
  },
  riskLevel: 'readonly',
  execute: async (args) => {
    const path = resolve(String(args.path))
    return fs.readFile(path, 'utf8')
  },
}

/** 原子工具：write_file（可逆，默认需审批） */
export const writeFileTool: ToolContract = {
  name: 'write_file',
  description: '写入文本内容到指定路径（覆盖）。会修改文件，默认需用户确认。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      content: { type: 'string', description: '要写入的内容' },
    },
    required: ['path', 'content'],
  },
  riskLevel: 'reversible',
  approvalRequired: true,
  execute: async (args) => {
    const path = resolve(String(args.path))
    await fs.writeFile(path, String(args.content), 'utf8')
    return { ok: true, path }
  },
}

/** 原子工具：run_command（不可逆，默认需审批） */
export const runCommandTool: ToolContract = {
  name: 'run_command',
  description: '在用户系统上执行 shell 命令。危险操作，默认需用户确认。',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
    required: ['command'],
  },
  riskLevel: 'irreversible',
  approvalRequired: true,
  execute: async (args) => {
    const { stdout, stderr } = await exec(String(args.command))
    return { stdout, stderr }
  },
}

/** 内置原子工具清单 */
export function atomicTools(): ToolContract[] {
  return [readFileTool, writeFileTool, runCommandTool]
}
