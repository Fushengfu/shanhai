/** 会话选择器中的单个会话选项（choose_session 工具专用，带状态副标题，供 UI 渲染「会话卡片」） */
export interface AskSessionOption {
  id: string
  title: string
  /** 是否正在执行任务 */
  busy: boolean
  /** 是否当前激活会话 */
  active: boolean
  /** 当前生效模型显示名 */
  modelName: string
  /** 工作目录 */
  workDir: string
  /** 上下文窗口占比 0~1 */
  contextUsageRatio: number
  /** 当前需求（最后一条用户消息，空串=无） */
  currentRequest: string
}

/** 模型选择器中的单个模型选项（choose_model 工具专用） */
export interface AskModelOption {
  id: string
  name: string
}

/** AI 向用户提问请求（需要用户协助做选择/补充信息时，UI 在输入框上方弹交互式卡片：单选/多选/填空/选择器） */
export interface AskRequest {
  /** 提问请求 id（UI 应答时回传定位） */
  id: string
  /** 发起提问的会话 id（并行会话时用于路由展示 + 删除会话时取消） */
  sessionId?: string
  /** 问题描述 */
  question: string
  /** 可选项（提供则渲染单选/多选；不提供则自由文本输入） */
  options?: string[]
  /** 是否多选（默认单选；仅 options 提供时生效） */
  multiple?: boolean
  /** 自由文本输入时的占位提示 */
  placeholder?: string
  /** 交互类型：text=普通提问/填空（默认）、session-picker=会话选择器、model-picker=模型选择器 */
  kind?: 'text' | 'session-picker' | 'model-picker'
  /** 会话选择器数据（kind=session-picker 时提供） */
  sessionOptions?: AskSessionOption[]
  /** 模型选择器数据（kind=model-picker 时提供） */
  modelOptions?: AskModelOption[]
}

/** 用户取消回答/选择时的特殊标记（工具据此返回「用户取消」而非把标记当答案回喂模型） */
export const ASK_CANCELLED = '__ASK_CANCELLED__'

/**
 * 提问服务（对齐 dsh 的「向用户请求输入」能力）。
 *
 * - ask：发起提问并阻塞等待用户回答（Promise 直到 respond/cancel 才 resolve）
 * - onRequest：订阅提问请求（UI 监听后弹卡片）
 * - respond：用户提交回答，resolve 对应提问
 * - cancel：用户取消回答/选择，resolve 为 ASK_CANCELLED 标记
 * - cancelSession：取消某会话所有待回答提问（删除会话时避免 agent 永久卡在等待）
 */
export class AskService {
  private readonly pending = new Map<string, { resolve: (answer: string) => void; sessionId?: string }>()
  private readonly listeners = new Set<(req: AskRequest) => void>()

  /** 发起提问并阻塞等待用户回答 */
  ask(
    question: string,
    opts?: {
      options?: string[]
      multiple?: boolean
      placeholder?: string
      sessionId?: string
      kind?: 'text' | 'session-picker' | 'model-picker'
      sessionOptions?: AskSessionOption[]
      modelOptions?: AskModelOption[]
    },
  ): Promise<string> {
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const req: AskRequest = {
      id,
      sessionId: opts?.sessionId,
      question,
      options: opts?.options,
      multiple: opts?.multiple,
      placeholder: opts?.placeholder,
      kind: opts?.kind,
      sessionOptions: opts?.sessionOptions,
      modelOptions: opts?.modelOptions,
    }
    return new Promise<string>((resolve) => {
      this.pending.set(id, { resolve, sessionId: opts?.sessionId })
      this.listeners.forEach((cb) => cb(req))
    })
  }

  /** 订阅提问请求（返回取消订阅函数） */
  onRequest(cb: (req: AskRequest) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 用户提交回答（resolve 对应提问） */
  respond(id: string, answer: string): void {
    const p = this.pending.get(id)
    if (p) {
      p.resolve(answer)
      this.pending.delete(id)
    }
  }

  /** 用户取消回答/选择（resolve 为 ASK_CANCELLED 标记，工具据此返回「用户取消」） */
  cancel(id: string): void {
    const p = this.pending.get(id)
    if (p) {
      p.resolve(ASK_CANCELLED)
      this.pending.delete(id)
    }
  }

  /** 取消指定会话所有待回答提问（删除会话时调用，避免 agent 永久卡在等待用户回答） */
  cancelSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId === sessionId) {
        p.resolve(ASK_CANCELLED)
        this.pending.delete(id)
      }
    }
  }
}
