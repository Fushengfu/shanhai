import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { readFileTool, writeFileTool, runCommandTool, atomicTools } from '../src/tools'

describe('原子工具', () => {
  it('安全属性内嵌：写操作默认需审批', () => {
    expect(readFileTool.riskLevel).toBe('readonly')
    expect(readFileTool.approvalRequired).toBeUndefined()
    expect(writeFileTool.approvalRequired).toBe(true)
    expect(runCommandTool.approvalRequired).toBe(true)
    expect(atomicTools().length).toBe(3)
  })

  it('read_file 读取文件内容', async () => {
    const dir = join('/tmp', `shanhai-tools-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, 'f.txt')
    await fs.writeFile(file, 'hello')
    const content = await readFileTool.execute({ path: file })
    expect(content).toBe('hello')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('write_file 写入内容', async () => {
    const dir = join('/tmp', `shanhai-tools-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, 'f.txt')
    await writeFileTool.execute({ path: file, content: 'world' })
    expect(await fs.readFile(file, 'utf8')).toBe('world')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('run_command 执行命令', async () => {
    const result = (await runCommandTool.execute({ command: 'echo hi' })) as { stdout: string }
    expect(result.stdout.trim()).toBe('hi')
  })
})
