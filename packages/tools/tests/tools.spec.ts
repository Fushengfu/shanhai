import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createAtomicTools } from '../src/tools'

describe('原子工具', () => {
  it('安全属性内嵌：写操作默认需审批', () => {
    const tools = createAtomicTools(() => '/tmp')
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(byName.read_file.riskLevel).toBe('readonly')
    expect(byName.read_file.approvalRequired).toBeUndefined()
    expect(byName.write_file.approvalRequired).toBe(true)
    expect(byName.run_command.approvalRequired).toBe(true)
    expect(tools.length).toBe(4)
  })

  it('read_file 读取文件内容（绝对路径）', async () => {
    const dir = join('/tmp', `shanhai-tools-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, 'f.txt')
    await fs.writeFile(file, 'hello')
    const readFileTool = createAtomicTools(() => dir).find((t) => t.name === 'read_file')!
    const content = await readFileTool.execute({ path: file })
    expect(content).toBe('hello')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('read_file 相对路径解析到工作目录', async () => {
    const dir = join('/tmp', `shanhai-tools-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'f.txt'), 'relative')
    const readFileTool = createAtomicTools(() => dir).find((t) => t.name === 'read_file')!
    const content = await readFileTool.execute({ path: 'f.txt' })
    expect(content).toBe('relative')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('write_file 写入内容（相对路径解析到工作目录）', async () => {
    const dir = join('/tmp', `shanhai-tools-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    const writeFileTool = createAtomicTools(() => dir).find((t) => t.name === 'write_file')!
    await writeFileTool.execute({ path: 'f.txt', content: 'world' })
    expect(await fs.readFile(join(dir, 'f.txt'), 'utf8')).toBe('world')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('run_command 执行命令', async () => {
    const runCommandTool = createAtomicTools(() => '/tmp').find((t) => t.name === 'run_command')!
    const result = (await runCommandTool.execute({ command: 'echo hi' })) as { stdout: string }
    expect(result.stdout.trim()).toBe('hi')
  })

  it('list_dir 返回树形结构', async () => {
    const dir = join('/tmp', `shanhai-tools-${Date.now()}`)
    await fs.mkdir(join(dir, 'sub'), { recursive: true })
    await fs.writeFile(join(dir, 'a.txt'), 'a')
    await fs.writeFile(join(dir, 'sub', 'b.txt'), 'b')
    const listDirTool = createAtomicTools(() => dir).find((t) => t.name === 'list_dir')!
    const out = (await listDirTool.execute({})) as string
    expect(out).toContain('a.txt')
    expect(out).toContain('sub/')
    expect(out).toContain('b.txt')
    expect(out).toContain('├──')
    await fs.rm(dir, { recursive: true, force: true })
  })
})
