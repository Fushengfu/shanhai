/**
 * terminal 能力：持久终端会话（create / run / list / close）。
 *
 * 与 browser-use / computer-use 同类：都是「有状态、有生命周期的组装能力」。
 * 终端提供一个持久 shell（node-pty 真实 PTY），命令之间状态保持（cd / export / 后台进程），
 * agent 可在一个终端里连续执行多步命令、跑长任务，而不用每条命令都走一次 run_command 的
 * 独立进程（那些进程之间不共享状态）。
 *
 * 本包只定义能力缝接口 + mock 兜底；真实后端由宿主（Electron 主进程的 node-pty）注入。
 */

/** 一个终端会话的简要信息 */
export interface TerminalInfo {
  /** 终端短标识（默认 'default'，create 自动生成 term-2/term-3…） */
  terminalId: string
  /** 终端用途描述（创建时传入，供 AI 区分多个终端用途） */
  name?: string
  /** 当前工作目录（后端维护，cd 后刷新） */
  cwd?: string
}

/** 一次 run 的结果 */
export interface TerminalRunResult {
  /** 命令输出（去掉 ANSI 转义与提示符） */
  output: string
  /** 退出码；命令未产生退出码（如交互式程序超时）时为 undefined */
  exitCode?: number
  /** 是否因超时而返回（命令仍在后台运行，可继续观察） */
  timedOut?: boolean
}

/**
 * 终端能力缝：所有终端操作收敛到这个接口。
 * 每个终端是一个持久 shell 会话，命令间状态保持。
 *
 * 除批处理式 run（哨兵判定完成，供 agent 用）外，还提供交互式能力：
 * write（原始写入，不带哨兵）/ onData（实时输出订阅）/ resize（调整 PTY 行列），
 * 用于「用户手动终端」——实时看到输出、支持 vim/top/密码输入等交互式程序、多开多个。
 */
export interface TerminalService {
  /** 创建持久终端会话，返回终端标识 terminalId（可选短标识 terminalId、用途名 name、初始工作目录 cwd；短标识省略自动生成，cwd 省略用宿主默认目录） */
  create(terminalId?: string, name?: string, cwd?: string): Promise<string>
  /** 在指定终端执行命令，返回输出；状态保持（cd/export/后台进程），timeoutMs 默认 120s */
  run(terminalId: string | undefined, command: string, timeoutMs?: number): Promise<TerminalRunResult>
  /** 列出当前活跃的终端会话 */
  list(): Promise<TerminalInfo[]>
  /** 关闭指定终端，释放资源 */
  close(terminalId: string | undefined): Promise<void>
  /** 原始写入（不带哨兵）：交互式终端用，支持 vim/top/密码输入等需要持续输入的场景 */
  write(terminalId: string, data: string): void
  /** 订阅终端原始输出（onData 实时转发，含 ANSI 转义序列），返回取消订阅函数 */
  onData(cb: (terminalId: string, data: string) => void): () => void
  /** 调整终端窗口尺寸（行列），前端 xterm 尺寸变化时调用以保持渲染对齐 */
  resize(terminalId: string, cols: number, rows: number): void
}

/** mock：空操作（CLI 模式 / 离线 / 测试兜底） */
export function createMockTerminalService(): TerminalService {
  return {
    create: async () => 'default',
    run: async () => ({ output: '', exitCode: 0 }),
    list: async () => [],
    close: async () => {},
    write: () => {},
    onData: () => () => {},
    resize: () => {},
  }
}
