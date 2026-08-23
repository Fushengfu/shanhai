/**
 * DeepSeek 桥接的内置工具集（自包含 ReAct 用）。
 *
 * 网页版 DeepSeek 没有原生工具调用能力，bridge 通过「标签协议」让模型输出
 * <tool_calls>，server 解析后执行这里的工具，再把结果回填继续推理，直到输出 <content>。
 *
 * 工具路径强制限制在工作目录内（safeResolve 防路径穿越）。工作目录随会话切换更新，
 * 通过 getWorkspace 回调取当前值（而非启动时固定）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 单次工具结果回填的最大字符数，避免 prompt 过长 */
const TOOL_RESULT_MAX = 4000

/** 工具执行结果（字符串文本，回填给模型） */
export type ToolResult = string

/** 内置工具定义 */
export interface BuiltinTool {
  description: string
  run(args: Record<string, unknown>): ToolResult
}

/** 工具注册表 */
export type BuiltinToolRegistry = Record<string, BuiltinTool>

/** 路径安全校验：resolve 后必须仍在工作目录内（或等于工作目录），防路径穿越 */
export function safeResolve(workspace: string, p: unknown): string {
  const abs = path.resolve(workspace, String(p ?? '.'))
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new Error('路径超出工作目录: ' + String(p))
  }
  return abs
}

/** 创建内置工具注册表。getWorkspace 返回当前会话工作目录（随会话切换更新）。 */
export function createBuiltinTools(getWorkspace: () => string): BuiltinToolRegistry {
  const ws = (): string => getWorkspace() || process.cwd()

  return {
    list_files: {
      description: '列出目录下的文件与子目录。参数 path: 目录路径（相对工作目录，默认 "."）',
      run(args) {
        const dir = safeResolve(ws(), args.path)
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        return entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n')
      },
    },
    read_file: {
      description: '读取文件内容。参数 path: 文件路径（相对工作目录）',
      run(args) {
        const p = safeResolve(ws(), args.path)
        return fs.readFileSync(p, 'utf8')
      },
    },
    search_content: {
      description: '在文件中搜索关键字。参数 pattern: 关键字, path: 目录（默认 "."）',
      run(args) {
        const dir = safeResolve(ws(), args.path)
        if (!args.pattern) throw new Error('缺少参数 pattern')
        const out = execFileSync('grep', ['-rn', String(args.pattern), dir], {
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        })
        return out || '(未匹配到任何内容)'
      },
    },
    write_file: {
      description: '写入文件内容（覆盖已有文件或创建新文件）。参数 path: 文件路径（相对工作目录）, content: 要写入的完整文本内容',
      run(args) {
        if (!args.path) throw new Error('缺少参数 path')
        if (typeof args.content !== 'string') throw new Error('缺少参数 content（字符串）')
        const p = safeResolve(ws(), args.path)
        fs.writeFileSync(p, args.content, 'utf8')
        return '已写入 ' + args.path + '（' + args.content.length + ' 字符）'
      },
    },
  }
}

/** 截断过长的工具结果（回填时避免 prompt 膨胀） */
export function truncateToolResult(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result)
  return text.length > TOOL_RESULT_MAX ? text.slice(0, TOOL_RESULT_MAX) + '\n...(已截断)' : text
}

/** 工具清单 + 标准标签协议说明（注入 system，告诉模型如何调用工具并输出标准标签） */
export function toolSystemPrompt(tools: BuiltinToolRegistry): string {
  const lines = ['你是一个能调用工具完成任务的智能助手。', '可用工具：']
  for (const [name, def] of Object.entries(tools)) {
    lines.push('- ' + name + '：' + def.description)
  }
  lines.push('')
  lines.push('你的每一次回复，必须用 <message> 包裹，role 按用途区分：')
  lines.push('  - 最终回复用 <message role="assistant">（含非空 <content>）')
  lines.push('  - 工具调用用 <message role="tool">（含 <tool_calls>，<content> 省略）')
  lines.push('子标签 <reasoning_content>（可选）与 <content> 按需出现：')
  lines.push('  <reasoning_content>思考过程</reasoning_content> —— 可选，写你的推理过程')
  lines.push('  <content>最终回答</content> —— 完成任务时输出')
  lines.push('')
  lines.push('工具调用示例：')
  lines.push('<message role="tool">')
  lines.push('  <reasoning_content>用户要读取文件，我应调用 read_file 工具。</reasoning_content>')
  lines.push('  <tool_calls>')
  lines.push('    <tool_call>')
  lines.push('      <id>call_1</id>')
  lines.push('      <type>function</type>')
  lines.push('      <function>')
  lines.push('        <name>read_file</name>')
  lines.push('        <arguments>{"path":"scripts/a.py"}</arguments>')
  lines.push('      </function>')
  lines.push('    </tool_call>')
  lines.push('  </tool_calls>')
  lines.push('</message>')
  lines.push('')
  lines.push('任务完成示例：')
  lines.push('<message role="assistant">')
  lines.push('  <reasoning_content>已获取到文件内容，现在给出最终回答。</reasoning_content>')
  lines.push('  <content>文件内容如下：……</content>')
  lines.push('</message>')
  lines.push('')
  lines.push('规则（严格遵守）：')
  lines.push('1. 完成判定：只有当 <content> 非空时才算完成任务；未完成时不得输出 <content>（或留空），而应输出 <tool_calls> 继续获取信息。')
  lines.push('2. 工具调用：需要获取信息或执行操作时输出 <message role="tool"> 且含 <tool_calls>（此时 <content> 省略）；可包含多个 <tool_call>。')
  lines.push('3. <content> 和 <reasoning_content> 直接写纯文本，不要用 CDATA 或引号包裹。')
  lines.push('4. <arguments> 内是标准 JSON 字符串，特殊字符需按 JSON 规则转义（例如换行写作 \\n、双引号写作 \\"）。')
  lines.push('5. 每个 <tool_call> 的 <id> 由你自己生成：全局唯一、递增不重复（如 call_1、call_2、call_3……）；同时含 <type>function</type>、<function> 内的 <name>（工具名）和 <arguments>（JSON 字符串）。')
  lines.push('6. 收到【工具返回结果】后继续推理：必要时再次输出 <tool_calls>，直到能输出非空 <content> 为止。')
  lines.push('7. 标签之外严禁输出任何文字、计划、总结或解释（例如禁止写"接下来我要…"之类的话）。')
  return lines.join('\n')
}
