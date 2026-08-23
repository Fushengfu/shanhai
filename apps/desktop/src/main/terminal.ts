import { app } from 'electron'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import type { TerminalInfo, TerminalRunResult, TerminalService } from '@shanhai/terminal'

/**
 * Electron 终端后端：用 node-pty 提供真正的 PTY 持久 shell（/bin/zsh -i）。
 *
 * 与 run_command 的区别：run_command 每条命令起一个独立子进程（命令间不共享状态），
 * 终端则保持一个持久 shell，cd 目录切换、export 环境变量、后台进程都跨命令保留，
 * 也支持 vim/top 等全屏交互程序（PTY 原生能力）。
 *
 * 会话级隔离：terminalId 由运行时注入会话前缀（默认 = 会话 id），不同会话的终端互不可见。
 *
 * run 的完成判定用「哨兵标记 + 超时」：命令后追加 echo 唯一哨兵，检测到哨兵即命令结束；
 * 交互式/长任务（vim、开发服务器前台运行）不产生哨兵，超时返回已捕获输出并标记 timedOut。
 */

const DEFAULT_TERMINAL_ID = 'default'
const DEFAULT_TIMEOUT_MS = 120_000
/** 输出缓冲环形上限（防止长期复用终端导致内存无界增长） */
const MAX_BUFFER = 200_000

/** 每个终端的独立状态 */
interface TerminalState {
  proc: pty.IPty
  /** 终端用途描述（创建时传入） */
  name: string
  /** 累积输出缓冲（onData 持续追加，有界） */
  buffer: string
}

/** 去掉 ANSI 转义序列（CSI 颜色/光标 + OSC 序列） */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\r/g, '')
}

/** 截取哨兵之前的内容，去掉末尾残留的 echo 哨兵回显行 */
function extractOutput(slice: string, marker: string): string {
  const idx = slice.indexOf(marker)
  if (idx < 0) return stripAnsi(slice).trim()
  const out = slice.slice(0, idx)
  const lines = out.split('\n')
  while (lines.length > 0 && /echo\s+__SHANHAI_DONE_/.test(lines[lines.length - 1] ?? '')) {
    lines.pop()
  }
  return stripAnsi(lines.join('\n')).trim()
}

export function createElectronTerminalService(): TerminalService {
  const terminals = new Map<string, TerminalState>()
  /** 交互式输出订阅者：onData 把每个终端的原始输出（含 ANSI）实时转发给它们（用户手动终端用） */
  const dataListeners = new Set<(terminalId: string, data: string) => void>()

  // 应用退出时关闭所有终端，释放 PTY 与后台进程
  app.on('before-quit', () => {
    for (const st of terminals.values()) {
      try {
        st.proc.kill()
      } catch {
        // 忽略
      }
    }
    terminals.clear()
  })

  /** 取（或懒创建）指定 terminalId 的终端状态 */
  const stateOf = (terminalId?: string, name?: string, cwd?: string): TerminalState => {
    const id = terminalId ?? DEFAULT_TERMINAL_ID
    const existing = terminals.get(id)
    if (existing) return existing
    // `+o promptsp` 关闭 zsh 的 PROMPT_SP：否则 zsh 启动时会在第一行输出一个反色 `%`
    // （zsh 内部初始化产生非换行输出触发的「补换行」标记），干扰用户对终端首行的阅读。
    const proc = pty.spawn('/bin/zsh', ['-i', '+o', 'promptsp'], {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      // 初始工作目录：用户手动终端传当前会话工作目录（默认在其下打开），agent 终端技能不传则回退主目录
      cwd: cwd ?? homedir(),
      // 显式设置 UTF-8 locale：Electron 从 Finder 启动时 env 里的 LANG 可能是 C 或缺省，
      // 会导致 zsh 内 ls 等命令把中文文件名转义成八进制乱码。强制 zh_CN.UTF-8 保证中文正常显示。
      env: { ...process.env, TERM: 'xterm-256color', LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' } as Record<string, string>,
    })
    const st: TerminalState = { proc, name: name ?? '', buffer: '' }
    terminals.set(id, st)
    proc.onData((data) => {
      const cur = terminals.get(id)
      if (!cur) return
      cur.buffer = (cur.buffer + data).slice(-MAX_BUFFER)
      // 交互式输出：实时转发给订阅者（含 ANSI，供 xterm 渲染）
      for (const cb of dataListeners) {
        try {
          cb(id, data)
        } catch {
          // 订阅回调异常不阻断终端
        }
      }
    })
    proc.onExit(() => {
      terminals.delete(id)
    })
    return st
  }

  /** 在指定终端写入命令 + 哨兵，等待哨兵出现或超时 */
  const run = async (terminalId: string | undefined, command: string, timeoutMs: number): Promise<TerminalRunResult> => {
    const id = terminalId ?? DEFAULT_TERMINAL_ID
    const st = terminals.get(id) ?? stateOf(id)
    const marker = `__SHANHAI_DONE_${Date.now()}_${Math.random().toString(36).slice(2)}__`
    const startLen = st.buffer.length

    st.proc.write(`${command}\n`)
    // 哨兵打印退出码：命令正常结束后，这行输出会带 $? 的值
    st.proc.write(`echo ${marker} $?\n`)

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const slice = st.buffer.slice(startLen)
      if (slice.includes(marker)) {
        return { output: extractOutput(slice, marker), exitCode: 0 }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    // 超时：命令仍在运行（交互式/长任务），返回已捕获输出
    const slice = st.buffer.slice(startLen)
    return { output: extractOutput(slice, marker), timedOut: true }
  }

  return {
    async create(terminalId, name, cwd) {
      // 生成唯一短名：default → term-2 → term-3 …（后端短名，运行时在外层注入会话前缀）
      let id = terminalId && terminalId.trim() ? terminalId.trim().replace(/[^a-zA-Z0-9_-]/g, '-') : DEFAULT_TERMINAL_ID
      if (terminals.has(id)) {
        const base = id
        let n = 2
        while (terminals.has(id)) id = `${base}-${n++}`
      }
      stateOf(id, name, cwd)
      return id
    },

    run,

    async list(): Promise<TerminalInfo[]> {
      const out: TerminalInfo[] = []
      for (const [id, st] of terminals) {
        out.push({ terminalId: id, name: st.name || undefined })
      }
      return out
    },

    async close(terminalId) {
      const id = terminalId ?? DEFAULT_TERMINAL_ID
      const st = terminals.get(id)
      if (st) {
        try {
          st.proc.kill()
        } catch {
          // 已退出则忽略
        }
        terminals.delete(id)
      }
    },

    write(terminalId, data) {
      const id = terminalId ?? DEFAULT_TERMINAL_ID
      const st = terminals.get(id)
      if (!st) return
      st.proc.write(data)
    },

    onData(cb) {
      dataListeners.add(cb)
      return () => {
        dataListeners.delete(cb)
      }
    },

    resize(terminalId, cols, rows) {
      const id = terminalId ?? DEFAULT_TERMINAL_ID
      const st = terminals.get(id)
      if (!st) return
      const c = Math.max(2, Math.floor(cols) || 200)
      const r = Math.max(1, Math.floor(rows) || 50)
      st.proc.resize(c, r)
    },
  }
}
