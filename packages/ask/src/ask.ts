/** AI 向用户提问请求（需要用户协助做选择/补充信息时，UI 在输入框上方弹交互式卡片：单选/多选/填空） */
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
}

/**
 * 提问服务（对齐 dsh 的「向用户请求输入」能力）。
 *
 * - ask：发起提问并阻塞等待用户回答（Promise 直到 respond 才 resolve）
 * - onRequest：订阅提问请求（UI 监听后弹卡片）
 * - respond：用户提交回答，resolve 对应提问
 * - cancelSession：取消某会话所有待回答提问（删除会话时避免 agent 永久卡在等待）
 */
export class AskService {
  private readonly pending = new Map<string, { resolve: (answer: string) => void; sessionId?: string }>()
  private readonly listeners = new Set<(req: AskRequest) => void>()

  /** 发起提问并阻塞等待用户回答 */
  ask(question: string, opts?: { options?: string[]; multiple?: boolean; placeholder?: string; sessionId?: string }): Promise<string> {
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const req: AskRequest = {
      id,
      sessionId: opts?.sessionId,
      question,
      options: opts?.options,
      multiple: opts?.multiple,
      placeholder: opts?.placeholder,
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

  /** 取消指定会话所有待回答提问（删除会话时调用，避免 agent 永久卡在等待用户回答） */
  cancelSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId === sessionId) {
        p.resolve('（会话已删除，提问已取消）')
        this.pending.delete(id)
      }
    }
  }
}
