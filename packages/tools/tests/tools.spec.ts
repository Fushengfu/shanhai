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
    expect(byName.edit_file.riskLevel).toBe('reversible')
    expect(byName.edit_file.approvalRequired).toBe(true)
    expect(byName.run_command.approvalRequired).toBe(true)
    expect(tools.length).toBe(5)
  })

  it('resolveRisk 返回 outsideWorkdir（工作目录范围判断）', async () => {
    const dir = join('/tmp', `shanhai-tools-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    const tools = createAtomicTools(() => dir)
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

    // 相对路径 → 工作目录内（outsideWorkdir=false）
    expect((await byName.read_file.resolveRisk!({ path: 'f.txt' })).outsideWorkdir).toBe(false)
    expect((await byName.write_file.resolveRisk!({ path: 'f.txt' })).outsideWorkdir).toBe(false)
    expect((await byName.edit_file.resolveRisk!({ path: 'f.txt' })).outsideWorkdir).toBe(false)

    // 绝对路径在工作目录内 → false
    expect((await byName.write_file.resolveRisk!({ path: join(dir, 'f.txt') })).outsideWorkdir).toBe(false)

    // 绝对路径在工作目录外 → true
    expect((await byName.write_file.resolveRisk!({ path: '/etc/passwd' })).outsideWorkdir).toBe(true)
    expect((await byName.read_file.resolveRisk!({ path: '/etc/passwd' })).outsideWorkdir).toBe(true)

    // run_command：无越界信号 → false；含 cd 切换目录 / 绝对路径 → true
    expect((await byName.run_command.resolveRisk!({ command: 'echo hi' })).outsideWorkdir).toBe(false)
    expect((await byName.run_command.resolveRisk!({ command: 'cd /tmp && ls' })).outsideWorkdir).toBe(true)
    expect((await byName.run_command.resolveRisk!({ command: 'cat /etc/passwd' })).outsideWorkdir).toBe(true)

    await fs.rm(dir, { recursive: true, force: true })
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

  it('read_file 支持分段读取（startLine/endLine 1-based 包含）', async () => {
    const dir = join('/tmp', `shanhai-tools-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'f.txt'), 'line1\nline2\nline3\nline4\nline5\n')
    const readFileTool = createAtomicTools(() => dir).find((t) => t.name === 'read_file')!
    // 读取 2~4 行
    const sliced = await readFileTool.execute({ path: 'f.txt', startLine: 2, endLine: 4 })
    expect(sliced).toBe('line2\nline3\nline4')
    // 未指定行号 → 全文
    const full = await readFileTool.execute({ path: 'f.txt' })
    expect(full).toBe('line1\nline2\nline3\nline4\nline5\n')
    // 只给 endLine → 从第 1 行读到 endLine
    const head = await readFileTool.execute({ path: 'f.txt', endLine: 2 })
    expect(head).toBe('line1\nline2')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('edit_file 精确替换（唯一命中）', async () => {
    const dir = join('/tmp', `shanhai-tools-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'f.txt'), 'const a = 1\nconst b = 2\n')
    const editFileTool = createAtomicTools(() => dir).find((t) => t.name === 'edit_file')!
    const result = (await editFileTool.execute({ path: 'f.txt', oldText: 'const a = 1', newText: 'let a = 1' })) as {
      occurrences: number
      before: string
      after: string
    }
    expect(result.occurrences).toBe(1)
    expect(result.before).toBe('const a = 1\nconst b = 2\n')
    expect(result.after).toBe('let a = 1\nconst b = 2\n')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('edit_file replaceAll 替换全部命中', async () => {
    const dir = join('/tmp', `shanhai-tools-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'f.txt'), 'a-a-a')
    const editFileTool = createAtomicTools(() => dir).find((t) => t.name === 'edit_file')!
    const result = (await editFileTool.execute({ path: 'f.txt', oldText: 'a', newText: 'b', replaceAll: true })) as {
      occurrences: number
      after: string
    }
    expect(result.occurrences).toBe(3)
    expect(result.after).toBe('b-b-b')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('edit_file 未命中时报错，多命中未 replaceAll 时报错', async () => {
    const dir = join('/tmp', `shanhai-tools-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'f.txt'), 'hello hello')
    const editFileTool = createAtomicTools(() => dir).find((t) => t.name === 'edit_file')!
    // 未命中 → 报错
    await expect(editFileTool.execute({ path: 'f.txt', oldText: 'not-exist', newText: 'x' })).rejects.toThrow(/未找到 oldText/)
    // 多命中未 replaceAll → 报错
    await expect(editFileTool.execute({ path: 'f.txt', oldText: 'hello', newText: 'x' })).rejects.toThrow(/命中 2 处/)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
