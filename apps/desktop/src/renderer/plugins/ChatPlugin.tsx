import { useEffect, useMemo, useRef } from 'react'
import type { ToolTrace } from '../types'
import { AskCard } from '../components/AskCard'
import { SessionPicker } from '../components/SessionPicker'
import { ModelPicker } from '../components/ModelPicker'
import { RetryPromptCard } from '../components/RetryPrompt'
import { AssistantMessage } from '../components/AssistantMessage'
import { ExpertTraces } from '../components/ExpertTraces'
import { ReasoningBlock } from '../components/ReasoningBlock'
import { StepStats, ToolStep, toolDisplayName, riskLevelLabel } from '../components/ToolStep'
import { UserMessage } from '../components/UserMessage'
import { IconCode, IconRefresh, IconWarn } from '../components/icons'
import { btn, formatArgs, LiveDuration, ThinkingDots } from '../components/ui'
import { registerSlot, SlotView, AppendSlotView } from '../slots'
import { useUIContext } from '../ui-context'
import { useStreaming } from '../store-client'

/** AI 回复气泡通用底样（思考 + 工具步骤 + 正文聚合，与 AssistantMessage 保持一致） */
const AI_BUBBLE_STYLE: React.CSSProperties = {
  maxWidth: '85%',
  padding: '10px 14px',
  borderRadius: 16,
  borderTopLeftRadius: 4,
  background: 'var(--bg-panel)',
  boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
  fontSize: 14,
  lineHeight: 1.65,
  color: 'var(--text)',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  minWidth: 0,
  userSelect: 'text',
  WebkitUserSelect: 'text',
}

/** shell.chat 插件：消息流主体 + 浮动交互层（审批弹窗 / 提问卡片 / browser 半投递弹窗，可被 selfmod 替换） */
function ChatSlot(): React.JSX.Element {
  const ctx = useUIContext()
  const streaming = useStreaming(ctx.currentSessionId)
  const listRef = useRef<HTMLDivElement>(null)
  // 用户是否在底部：仅由滚动事件维护，不参与「内容增长」的计算。
  // 之前的实现每次内容更新都重算 nearBottom，流式内容一次性增长超过阈值时会被误判为「用户已上翻」而停止跟随。
  const atBottomRef = useRef(true)

  // 用户滚动（滚轮/拖条/键盘）时更新「是否在底部」状态
  const handleScroll = (): void => {
    const el = listRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  // 消息更新 / 思考流 / 多专家轨迹 / 审批弹窗出现时：只要用户在底部就跟随滚到底。
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [ctx.cur.items, streaming.text, streaming.reasoning, ctx.curExpertTraces, ctx.curApproval])

  // 切换会话：重置「在底部」并立即滚到底
  useEffect(() => {
    atBottomRef.current = true
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [ctx.currentSessionId])

  // 当前这一轮（最后一个 user 消息）的序号；用于任务执行中实时渲染多专家协作卡片（不等任务结束）
  const lastUserTurnSeq = [...ctx.cur.items].reverse().find((it) => it.kind === 'user')?.turnSeq
  // 当前轮是否已有 assistant 回复（任务完成）；已完成则交给历史分支（assistant 之后）渲染，实时区不再重复
  const lastTurnHasAssistant = ctx.cur.items.some((it) => it.kind === 'assistant' && it.turnSeq === lastUserTurnSeq)
  const liveTraces =
    lastUserTurnSeq != null && !lastTurnHasAssistant ? ctx.curExpertTraces.filter((t) => t.turnSeq === lastUserTurnSeq) : []

  // 历史消息节点缓存：streaming 变化时 items/expertTraces/busy 都不变，返回缓存的 nodes，
  // 避免每个 token 都重建全部历史消息 VNode（React 对相同 element 引用做 bailout，跳过子树渲染）。
  const history = useMemo(() => {
    const nodes: React.ReactNode[] = []
    let userIdx = 0
    let toolBuffer: ToolTrace[] = []

    const flushTools = (keyBase: string): void => {
      if (toolBuffer.length === 0) return
      const tools = toolBuffer
      toolBuffer = []
      nodes.push(
        <div key={`tools-${keyBase}`}>
          {tools.map((t) => (
            <ToolStep key={t.callId} trace={t} />
          ))}
        </div>
      )
    }

    // 按轮次分组：user 消息后收集 tool 步骤，遇 assistant 消息时聚合进同一个回复气泡
    let seq = 0
    for (const it of ctx.cur.items) {
      if (it.kind === 'user') {
        flushTools(`u${seq}`)
        const idx = userIdx++
        nodes.push(
          <UserMessage
            key={`u${seq++}`}
            content={it.content}
            images={it.images}
            userIndex={idx}
            busy={ctx.cur.busy}
            pending={it.pending}
            onResend={ctx.resendMessage}
            onEditResend={ctx.editResend}
            onPreviewImage={(url) => ctx.setPreviewImage(url)}
          />
        )
      } else if (it.kind === 'assistant') {
        const turnTraces = it.turnSeq != null ? ctx.curExpertTraces.filter((t) => t.turnSeq === it.turnSeq) : []
        const tools = toolBuffer
        toolBuffer = []
        nodes.push(
          <AssistantMessage
            key={`a${seq++}`}
            content={it.content}
            reasoningContent={it.reasoningContent}
            toolSteps={tools}
            expertTraces={turnTraces}
            turnDuration={it.turnDuration}
            onPreviewImage={(url) => ctx.setPreviewImage(url)}
          />
        )
      } else {
        toolBuffer.push(it.trace)
      }
    }
    // 非 busy 时残留的 tool（如任务中断）直接渲染；busy 时残留 tool 归入「正在生成」气泡
    if (!ctx.cur.busy) flushTools('tail')
    return { nodes, pendingTools: toolBuffer }
  }, [ctx.cur.items, ctx.curExpertTraces, ctx.cur.busy, ctx.resendMessage, ctx.editResend, ctx.setPreviewImage])

  return (
    <>
      <div
        ref={listRef}
        onScroll={handleScroll}
        style={
          ctx.isEmpty
            ? { flex: '0 0 auto', minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '36px 16px 4px', overflow: 'hidden' }
            : { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 16, background: 'var(--bg-sidebar)' }
        }
      >
        {ctx.isEmpty ? (
          <SlotView slot="shell.welcome" />
        ) : (
          <>
            <>
              {history.nodes}
              {ctx.cur.busy && (
                <>
                  <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                    <div style={AI_BUBBLE_STYLE}>
                      {/* 实时耗时 + 步数统计：任务执行中每秒跳动显示耗时，并实时统计已执行/成功/失败/执行中的步数 */}
                      {(ctx.cur.turnStartTs != null || history.pendingTools.length > 0) && (
                        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>
                          {ctx.cur.turnStartTs != null && (
                            <>
                              耗时 <LiveDuration startTs={ctx.cur.turnStartTs} />
                            </>
                          )}
                          <StepStats tools={history.pendingTools} />
                        </div>
                      )}
                      {/* 当前轮已执行的工具步骤（实时） */}
                      {history.pendingTools.length > 0 && (
                        <div style={{ margin: '0 0 2px' }}>
                          {history.pendingTools.map((t) => (
                            <ToolStep key={t.callId} trace={t} />
                          ))}
                        </div>
                      )}
                      {/* 多专家协作卡片：显示在正文之前 */}
                      <ExpertTraces traces={liveTraces} />
                      {/* 思考过程折叠块：显示在正文之前，流式展开显示完整思考 */}
                      {streaming.reasoning && <ReasoningBlock content={streaming.reasoning} streaming />}
                      {/* 正式回答：只显示最终正文 */}
                      {streaming.text && (
                        <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                          {streaming.text}
                          <span style={{ animation: 'blink 1s step-start infinite' }}>▌</span>
                        </span>
                      )}
                      {/* 思考中三点动画：气泡底部（块级换行），任务结束才消失 */}
                      <div style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                        思考中
                        <ThinkingDots />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </>
            {ctx.incompleteTurn && !ctx.cur.busy && (
              <div style={{ marginBottom: 8 }}>
                <button
                  onClick={ctx.resumeMessage}
                  title="上次任务未完成，点击继续执行"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 14, border: '1px solid var(--accent)', background: 'var(--bg-panel)', color: 'var(--accent)', fontSize: 13, cursor: 'pointer' }}
                >
                  <IconRefresh />
                  继续执行
                </button>
              </div>
            )}
          </>
        )}
        {/* 自修改（K5）动态扩展区：browser 半通过 slots.register 注册的组件渲染在这里（UI 热更新落点） */}
        {ctx.dynamicExtensions.map((reg) => (
          <div key={reg.id} style={{ marginBottom: 8, width: '100%' }}>
            <reg.Component />
          </div>
        ))}
      </div>

      {/* 追加型扩展点：消息流下方（agent 往这里追加组件，不替换核心消息流） */}
      <AppendSlotView slot="chat.below" />

      {/* 审批弹窗（输入框上方浮动，会话级隔离：只显示当前会话的待审批请求） */}
      {ctx.curApproval && (
        <div
          style={{
            position: 'absolute',
            bottom: 158,
            left: 16,
            right: 16,
            padding: 14,
            borderRadius: 12,
            border: '1px solid var(--tint-red-strong)',
            background: 'var(--tint-red)',
            fontSize: 13,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>
            <IconWarn />
            需要确认操作
          </div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>工具：{toolDisplayName(ctx.curApproval.toolName, ctx.curApproval.args)}（{riskLevelLabel(ctx.curApproval.riskLevel)}）</div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 10, fontSize: 12, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
            {formatArgs(ctx.curApproval.args)}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => void ctx.respondApproval('allowed-once')} style={btn('var(--accent)', '#fff')}>
              允许一次
            </button>
            <button onClick={() => void ctx.respondApproval('rejected')} style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}>
              拒绝
            </button>
          </div>
        </div>
      )}

      {/* AI 向用户提问卡片 / 会话选择器 / 模型选择器（输入框上方浮动，会话级隔离，按 kind 分派） */}
      {ctx.curAsk && ctx.curAsk.kind === 'session-picker' ? (
        <SessionPicker req={ctx.curAsk} onSubmit={(answer) => void ctx.respondAsk(answer)} onCancel={() => void ctx.cancelAsk()} />
      ) : ctx.curAsk && ctx.curAsk.kind === 'model-picker' ? (
        <ModelPicker req={ctx.curAsk} onSubmit={(answer) => void ctx.respondAsk(answer)} onCancel={() => void ctx.cancelAsk()} />
      ) : ctx.curAsk ? (
        <AskCard req={ctx.curAsk} onSubmit={(answer) => void ctx.respondAsk(answer)} onCancel={() => void ctx.cancelAsk()} />
      ) : null}

      {/* 任务失败重试弹窗（网络/余额不足等可重试错误自动重试耗尽后弹出：重试=重新发网络请求 / 取消=保留继续执行入口）。
          会话级：只在失败会话显示（切到别的会话自动隐藏，切回重新出现）。 */}
      {ctx.retryPrompt && ctx.retryPrompt.sessionId === ctx.currentSessionId && (
        <RetryPromptCard
          prompt={ctx.retryPrompt}
          onRetry={() => ctx.respondRetry('retry')}
          onCancel={() => ctx.respondRetry('cancel')}
        />
      )}

      {/* 自修改（K5）：browser 半投递审批弹窗（agent 想往界面挂 UI 时需用户确认） */}
      {ctx.curClientRunRequest && (
        <div
          style={{
            position: 'absolute',
            bottom: 158,
            left: 16,
            right: 16,
            padding: 14,
            borderRadius: 12,
            border: '1px solid var(--accent)',
            background: 'var(--tint-blue-soft)',
            fontSize: 13,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>
            <IconCode />
            确认投递界面组件
          </div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>
            动态包：<b>{ctx.curClientRunRequest.name}</b>（{ctx.curClientRunRequest.pkgId}）
          </div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 10, fontSize: 12, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
            用途：{ctx.curClientRunRequest.purpose}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => void ctx.respondClientRun(true)} style={btn('var(--accent)', '#fff')}>
              投递到界面
            </button>
            <button onClick={() => void ctx.respondClientRun(false)} style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}>
              拒绝
            </button>
          </div>
        </div>
      )}
    </>
  )
}

registerSlot('shell.chat', 'core:chat', 'core', ChatSlot)
