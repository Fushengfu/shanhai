import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ToolTrace } from '../types'
import { AskCard } from '../components/AskCard'
import { ApprovalCard } from '../components/ApprovalCard'
import { SessionPicker } from '../components/SessionPicker'
import { ModelPicker } from '../components/ModelPicker'
import { RetryPromptCard } from '../components/RetryPrompt'
import { AssistantMessage } from '../components/AssistantMessage'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { makeMarkdownComponents, normalizeTreeBlocks, stripWrappedRecordTag } from '../components/Markdown'
import { ReasoningBlock } from '../components/ReasoningBlock'
import { StepStats, ToolGroup } from '../components/ToolStep'
import { t, tf } from '../../shared/i18n'
import { renderRich, useLocaleSync } from '../locale'
import { UserMessage } from '../components/UserMessage'
import { VirtualList } from '../components/VirtualList'
import { IconChevronDown, IconCode, IconRefresh } from '../components/icons'
import { btn, LiveDuration, ThinkingDots } from '../components/ui'
import { registerSlot, SlotView, AppendSlotView } from '../slots'
import { useUIContext } from '../ui-context'
import { useStreaming } from '../store-client'

/** AI 回复气泡通用底样（思考 + 工具步骤 + 正文聚合，与 AssistantMessage 保持一致） */
const AI_BUBBLE_STYLE: React.CSSProperties = {
  width: '85%',
  // 气泡宽度上限兜底：无论窗口如何缩放、内容 min-content 多宽，气泡都不会超过消息容器（≤ 容器 ≤ 窗口），避免右侧溢出
  // maxWidth: '100%',
  boxSizing: 'border-box',
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
  useLocaleSync()
  const ctx = useUIContext()
  const streaming = useStreaming(ctx.currentSessionId)
  const listRef = useRef<HTMLDivElement>(null)
  // 用户是否在底部：仅由滚动事件维护，不参与「内容增长」的计算。
  // 之前的实现每次内容更新都重算 nearBottom，流式内容一次性增长超过阈值时会被误判为「用户已上翻」而停止跟随。
  const atBottomRef = useRef(true)
  // 「回到最新消息」按钮的显隐：atBottomRef 是 ref（不触发重渲染），按钮要显隐必须另存一份可触发渲染的镜像。
  // 仅由滚动事件（handleScroll）与滚到底的动作同步，不参与「内容增长」计算 —— 与 atBottomRef 同一份真相，不引入第二套判定。
  const [showScrollBottom, setShowScrollBottom] = useState(false)

  // —— 卡顿优化：稳定历史消息交互回调引用。原先直接把不稳定的 ctx.resendMessage / ctx.editResend
  //     放进 history useMemo 依赖，导致每次 ui:state 广播（工具步骤等）都重新创建引用 → 全量重建历史列表。
  //     这里用 useRef 持最新回调 + useCallback 包装稳定引用，只让「确实新增/修改消息」才重建 history。
  const resendMsgRef = useRef(ctx.resendMessage)
  const editResendRef = useRef(ctx.editResend)
  resendMsgRef.current = ctx.resendMessage
  editResendRef.current = ctx.editResend
  const handleResend = useCallback((userIndex: number) => resendMsgRef.current(userIndex), [])
  const handleEditResend = useCallback((userIndex: number, newContent: string) => editResendRef.current(userIndex, newContent), [])
  const handlePreview = useCallback((url: string) => ctx.setPreviewImage(url), [ctx.setPreviewImage])

  // —— 流式当前气泡 markdown 节流：streaming.text 每帧都在变，逐帧全量解析 ReactMarkdown 很费；
  //     这里每 120ms 才把最新文本写入 state 渲染一次（长回复流中显著减少解析 / 重绘次数）。
  const textRef = useRef(streaming.text)
  textRef.current = streaming.text
  const lastRenderedTextRef = useRef('')
  const [streamedText, setStreamedText] = useState('')
  useEffect(() => {
    const iv = setInterval(() => {
      if (textRef.current !== lastRenderedTextRef.current) {
        lastRenderedTextRef.current = textRef.current
        setStreamedText(textRef.current)
      }
    }, 120)
    return () => clearInterval(iv)
  }, [])

  // 用户滚动（滚轮/拖条/键盘）时更新「是否在底部」状态
  const handleScroll = (): void => {
    const el = listRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    atBottomRef.current = atBottom
    // 不在底部才显示「回到最新消息」按钮（阈值与 atBottomRef 同一份判定，不另设数值）
    setShowScrollBottom(!atBottom)
  }

  // 消息更新 / 思考流 / 审批弹窗出现时：只要用户在底部就跟随滚到底。
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [ctx.cur.items, streaming.text, streaming.reasoning, ctx.curApproval])

  // 切换会话：重置「在底部」并立即滚到底
  useEffect(() => {
    atBottomRef.current = true
    setShowScrollBottom(false)
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [ctx.currentSessionId])

  // 点击「回到最新消息」：滚到底并收起按钮。
  // 滚底动作与既有两处（吸底 effect / 切会话 effect）写法一致（scrollTop = scrollHeight），不另抽公共函数。
  const handleScrollToBottom = (): void => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setShowScrollBottom(false)
  }

  // 历史消息节点缓存：streaming 变化时 items/busy 都不变，返回缓存的 nodes，
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
        <div key={`tools-${keyBase}`} style={{ minWidth: 0, maxWidth: '100%' }}>
          <ToolGroup tools={tools} />
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
            onResend={handleResend}
            onEditResend={handleEditResend}
            onPreviewImage={handlePreview}
          />
        )
      } else if (it.kind === 'assistant') {
        const tools = toolBuffer
        toolBuffer = []
        nodes.push(
          <AssistantMessage
            key={`a${seq++}`}
            content={it.content}
            reasoningContent={it.reasoningContent}
            toolSteps={tools}
            turnDuration={it.turnDuration}
            onPreviewImage={handlePreview}
          />
        )
      } else {
        toolBuffer.push(it.trace)
      }
    }
    // 非 busy 时残留的 tool（如任务中断）直接渲染；busy 时残留 tool 归入「正在生成」气泡
    if (!ctx.cur.busy) flushTools('tail')
    return { nodes, pendingTools: toolBuffer }
  }, [ctx.cur.items, ctx.cur.busy, handleResend, handleEditResend, handlePreview])

  return (
    <>
      {/* 「回到最新消息」按钮的定位容器（只包住消息列表）。
          为什么需要这一层：按钮用 position:absolute 定位，包含块决定了 bottom 从哪儿量。此前按钮直接挂在本层，
          包含块是主区容器（App.tsx 里那个 position:relative 的 flex 列，里面除聊天区外还有输入区与状态栏），
          于是 bottom:158 量的是「主区底 → 上 158」，而主区底还含着输入区与状态栏 —— 输入区一长高（窗口变窄，
          输入框内容换行）按钮就陷进输入区里，用户看到「按钮被挤进输入框」。
          本层 position:relative 后成为按钮的包含块：它的底边 === 聊天区底 === 输入区顶，
          输入区高度再怎么变都不影响按钮位置（纯 flex/CSS，不引入 ResizeObserver、不新增状态）。
          只包 VirtualList；审批卡 / 提问卡 / chat.below 仍留在外层，继续按原 bottom:158 锚定，行为一字未改。 */}
      <div
        style={{
          flex: ctx.isEmpty ? '0 0 auto' : 1,
          minWidth: 0,
          minHeight: 0,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
      <VirtualList
        containerRef={listRef}
        items={history.nodes}
        isEmpty={ctx.isEmpty}
        empty={<SlotView slot="shell.welcome" />}
        footer={
          <>
            {ctx.cur.busy && (
              <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <div style={AI_BUBBLE_STYLE}>
                  {/* 实时耗时 + 步数统计：任务执行中每秒跳动显示耗时，并实时统计已执行/成功/失败/执行中的步数 */}
                  {(ctx.cur.turnStartTs != null || history.pendingTools.length > 0) && (
                    <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>
                      {ctx.cur.turnStartTs != null && (
                        <>
                          {t('chat.time.elapsed')} <LiveDuration startTs={ctx.cur.turnStartTs} />
                        </>
                      )}
                      <StepStats tools={history.pendingTools} />
                    </div>
                  )}
                  {/* 当前轮已执行的工具步骤（实时） */}
                  {history.pendingTools.length > 0 && (
                    <div style={{ margin: '0 0 2px' }}>
                      <ToolGroup tools={history.pendingTools} live />
                    </div>
                  )}
                  {/* 思考过程折叠块：显示在正文之前，流式展开显示完整思考 */}
                  {streaming.reasoning && <ReasoningBlock content={streaming.reasoning} streaming />}
                  {/* 正式回答：只显示最终正文（流式实时按 Markdown 渲染，与历史气泡一致；已节流 120ms 渲染，避免逐帧全量解析） */}
                  {streamedText && (
                    <div style={{ minWidth: 0, maxWidth: '100%', overflowX: 'auto' }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeMarkdownComponents(handlePreview)}>
                        {normalizeTreeBlocks(stripWrappedRecordTag(streamedText))}
                      </ReactMarkdown>
                      <span style={{ animation: 'blink 1s step-start infinite' }}>▌</span>
                    </div>
                  )}
                  {/* 思考中三点动画：气泡底部（块级换行），任务结束才消失 */}
                  <div style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                    {t('chat.plugin.thinking')}
                    <ThinkingDots />
                  </div>
                </div>
              </div>
            )}
            {ctx.incompleteTurn && !ctx.cur.busy && (
              <div style={{ marginBottom: 8 }}>
                <button
                  onClick={ctx.resumeMessage}
                  title={t('chat.plugin.resumeTitle')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 14, border: '1px solid var(--accent)', background: 'var(--bg-panel)', color: 'var(--accent)', fontSize: 13, cursor: 'pointer' }}
                >
                  <IconRefresh />
                  {t('chat.plugin.resume')}
                </button>
              </div>
            )}
          </>
        }
        onScroll={handleScroll}
        style={
          ctx.isEmpty
            ? { flex: '0 0 auto', minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '36px 16px 4px', overflow: 'hidden' }
            : {
                flex: 1,
                minHeight: 0,
                width: '100%',
                maxWidth: '100%',
                minWidth: 0,
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                overflowY: 'auto',
                overflowX: 'hidden',
                padding: 16,
                background: 'var(--bg-sidebar)',
                contain: 'layout',
              }
        }
      />

        {/* 「回到最新消息」浮动按钮：用户上滑查看历史（不在底部）时才出现，点一下滚回底部并自动消失。
            锚定在上面那层定位容器里（不是消息滚动容器内 —— 该容器带 contain:'layout' + overflow，放进去会被裁），
            bottom 相对聊天区底 === 输入区顶，故输入区高度随窗口宽度变化也不再影响它。
            bottom:14 与 left:'50%'+translateX(-50%) 照抄全仓既有同款「滚回底部」按钮（MemberPanel 私信
            「有新消息」按钮 :1506-1513 就是这套写法），不另设第三种。 */}
        {showScrollBottom && (
          <button
            onClick={handleScrollToBottom}
            title={t('chat.plugin.scrollBottomTitle')}
            style={{
              position: 'absolute',
              bottom: 14,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 14px',
              borderRadius: 14,
              border: '1px solid var(--accent)',
              background: 'var(--bg-panel)',
              color: 'var(--accent)',
              fontSize: 13,
              cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--tint-blue-soft)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bg-panel)')}
          >
            <IconChevronDown />
            {t('chat.plugin.scrollBottom')}
          </button>
        )}
      </div>

      {/* 追加型扩展点：消息流下方（agent 往这里追加组件，不替换核心消息流） */}
      <AppendSlotView slot="chat.below" />

      {/* 审批弹窗（输入框上方浮动，会话级隔离：只显示当前会话的待审批请求） */}
      {ctx.curApproval && (
        <ApprovalCard req={ctx.curApproval} onAllow={() => void ctx.respondApproval('allowed-once')} onReject={() => void ctx.respondApproval('rejected')} />
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
            // 任务114：卡片整体不得超出视口安全区。外层原本只有 bottom:158 下锚点、无高度上限，
            // 内容（长问题 / 长审批参数）一多就向上撑高，绘制到顶部标题栏之上，盖住最小化/最大化/关闭按钮。
            // 227 = 158（既有下锚点，见上方 bottom）+ 69（标题栏安全区：管家窗口 WindowTitleBar
            // padding 16+16 + 最高子元素 WindowControlButton 36 + borderBottom 1 = 69；会话窗口 HeaderPlugin 同算法=61，取大者）。
            // 用 maxHeight 不用 height：内容少时按内容高，不留白（任务107 那类坑）。
            maxHeight: 'calc(100% - 227px)',
            overflowY: 'auto',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>
            <IconCode />
            {t('chat.clientRun.title')}
          </div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>
            {renderRich(tf('chat.clientRun.pkg'), { b1: <b>{ctx.curClientRunRequest.name}</b>, pkgId: <>{ctx.curClientRunRequest.pkgId}</> })}
          </div>
          {/* 任务114：purpose 由插件作者自定、长度不可控 → 限高滚动 */}
          <div style={{ color: 'var(--text-secondary)', marginBottom: 10, fontSize: 12, overflowWrap: 'break-word', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto' }}>
            {t('chat.clientRun.purpose', { purpose: ctx.curClientRunRequest.purpose })}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => void ctx.respondClientRun(true)} style={btn('var(--accent)', '#fff')}>
              {t('chat.clientRun.deliver')}
            </button>
            <button onClick={() => void ctx.respondClientRun(false)} style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}>
              {t('chat.approval.reject')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

registerSlot('shell.chat', 'core:chat', 'core', ChatSlot)
