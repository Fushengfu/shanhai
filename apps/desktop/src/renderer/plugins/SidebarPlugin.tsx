import { useState } from 'react'
import { SessionRow } from '../components/SessionRow'
import { AccountBar } from '../components/AccountPopover'
import { IconClose, IconPlus, IconSearch } from '../components/icons'
import { smallIconBtn } from '../components/ui'
import { registerSlot } from '../slots'
import { useUIContext } from '../ui-context'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

/**
 * 会话管家超级会话的固定 id（与 runtime 的 SUPERVISOR_ID、SupervisorApp 的 SUPERVISOR_SID 一致）。
 * 与 MemberPanel 同口径：本文件不复用别处的常量，各自声明一份字面量，避免渲染层跨模块耦合。
 */
const SUPERVISOR_SID = 'supervisor'

/** shell.sidebar 插件：会话列表侧边栏（可折叠，可被 selfmod 替换） */
function SidebarSlot(): React.JSX.Element {
  useLocaleSync()
  const ctx = useUIContext()
  const [search, setSearch] = useState('')
  // 会话管家条目的 hover 高亮（与 SessionRow 的 hover 口径一致：本地 state，非全局）
  const [supHovered, setSupHovered] = useState(false)
  // 【任务218】管家是否在执行：chat 窗口的快照里现在带了 sessionMap['supervisor']（见 main/ui-store.ts 的 chat 分支），
  // 因此 ctx.sessionBusy(管家 id) 拿到的是主进程 runningLoops 的真值（与管家窗口里的判断同源）。
  const supBusy = ctx.sessionBusy(SUPERVISOR_SID)
  // 【任务237 · 第2条】管家条目是否处于激活态（右列是否正在渲染管家面板）。就地取名，未新增任何全局状态。
  const supActive = ctx.mainView === 'supervisor'

  // 搜索过滤：标题 / 工作目录名 / 完整工作目录路径，大小写不敏感
  const q = search.trim().toLowerCase()
  const visibleSessions = q
    ? ctx.sortedSessions.filter((s) => {
        const workDirName = s.workDir ? (s.workDir.split(/[\\/]/).filter(Boolean).pop() ?? '') : ''
        return s.title.toLowerCase().includes(q) || s.workDir.toLowerCase().includes(q) || workDirName.toLowerCase().includes(q)
      })
    : ctx.sortedSessions

  return (
    <>
      <div style={{ padding: '12px 12px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{t('chat.sidebar.sessions')}</span>
        <button onClick={() => void ctx.createSession()} title={t('chat.sidebar.newSession')} style={smallIconBtn}>
          <IconPlus />
        </button>
      </div>
      {/*
        【任务218 · 单窗口合并】会话管家：左列**置顶合成条目**。
        - runtime 的 listSessions 刻意不返回管家会话（bootstrap 里 `.filter(s => !s.isSupervisor)`），
          所以这里按固定 id 合成一条，**不参与** sortedSessions 的「进行中置顶 + 最近活跃倒序」排序，
          永远排在最上面（与排序规则完全解耦）。
        - 点击 = setMainView('supervisor') → App 右列渲染管家面板；点普通会话/新建会话会自动切回会话视图。
        - 副标题显示状态：管家在跑时显示「处理中」（复用 chat.sessionRow.processing 词条），空闲时显示 sup.subtitle。
        - 视觉：左侧 2px 主题色竖条，其余尺寸/圆角/字号逐项照抄 SessionRow。
        【任务220 · 第1条】搜索框由本条目上方挪到**本条目下方**（顺序：管家条目 → 搜索 → 会话列表）。
        【任务220 · 第2条】去掉本条目左侧的管家图标，只保留文字标题 + 状态副标题（竖条保留，用户只要求去掉图标）。
        【任务237 · 第2条】可发现性：用户反馈「管家栏目不够明显，可能都不知道能点击」。
        做法**不新增任何视觉元素**（图标仍不加回来、不加右侧箭头/角标/小圆点），
        只把「它是个入口」这件事靠底色与描边做出来 —— 写法照抄**本文件下方搜索框**那套卡片样式
        （`background: 'var(--bg-panel)'` + `'1px solid var(--border)'` + borderRadius 8），
        并让标题**常驻主题紫 + 常驻 600 字重**：
          · 常态  = 卡片底 + 浅灰描边（不再是一段与背景同色的普通文字）
          · hover = `--bg-hover`（与 SessionRow 同口径）
          · 激活  = `--tint-purple` 底 + **紫色描边**（亮色下 tint 近乎白，靠描边把选中态做实）
        2px 紫色竖条按 229 既定口径**保留为常驻标识**，不随三态变化。
      */}
      <div style={{ padding: '0 0 6px', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div
          onClick={() => ctx.setMainView('supervisor')}
          onMouseEnter={() => setSupHovered(true)}
          onMouseLeave={() => setSupHovered(false)}
          title={t('sup.subtitle')}
          style={{
            margin: '0 8px 2px',
            padding: '8px 10px',
            borderRadius: 8,
            cursor: 'pointer',
            // 【任务237 · 第2条】常态底色由 transparent 改为与搜索框同款卡片底（--bg-panel），
            // 让它一眼看出是个可点的入口；hover / 激活两态取值与 218 起一致，未改。
            background: ctx.mainView === 'supervisor' ? 'var(--tint-purple)' : supHovered ? 'var(--bg-hover)' : 'var(--bg-panel)',
            // 【任务237 · 第2条】常态补 1px 浅灰描边（照抄搜索框的 border 写法），
            // 激活态改用主题紫描边 —— 亮色下 --tint-purple(#faf7ff) 与卡片底(#ffffff) 几乎同色，
            // 不靠描边的话选中态在亮色主题下等于看不见。
            borderTop: `1px solid ${supActive ? 'var(--purple)' : 'var(--border)'}`,
            borderRight: `1px solid ${supActive ? 'var(--purple)' : 'var(--border)'}`,
            borderBottom: `1px solid ${supActive ? 'var(--purple)' : 'var(--border)'}`,
            borderLeft: '2px solid var(--purple)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            transition: 'background 0.12s ease',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                lineHeight: '18px',
                // 【任务237 · 第2条】标题改为**常驻**主题紫 + 常驻 600 字重（原先只在激活态才变色/加粗）：
                // 这是不加任何新元素的前提下，让「它是个入口、且是特殊入口」最直接的表达。
                fontWeight: 600,
                color: 'var(--purple)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {t('common.supervisorSession')}
            </div>
            <div
              style={{
                fontSize: 11,
                lineHeight: '15px',
                color: supBusy ? 'var(--purple)' : 'var(--text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 1,
              }}
            >
              {supBusy ? t('chat.sessionRow.processing') : t('sup.subtitle')}
            </div>
          </div>
          {supBusy && (
            <span
              title={t('chat.sessionRow.runningTitle')}
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                border: '2px solid var(--tint-blue)',
                borderTopColor: 'var(--accent)',
                flexShrink: 0,
                animation: 'spin 0.8s linear infinite',
              }}
            />
          )}
        </div>
      </div>
      {/* 搜索框（【任务220】从管家条目上方挪到这里：管家条目 → 搜索 → 会话列表） */}
      <div style={{ padding: '0 12px 6px', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 8, background: 'var(--bg-panel)', border: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--text-muted)', display: 'inline-flex' }}>
            <IconSearch />
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('chat.sidebar.searchPlaceholder')}
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              background: 'transparent',
              outline: 'none',
              fontSize: 13,
              color: 'var(--text)',
              padding: 0,
            }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              title={t('common.clear')}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'inline-flex' }}
            >
              <IconClose />
            </button>
          )}
        </div>
      </div>
      {/*
        【任务219】会话管家条目与下方会话列表之间的**分组分隔线**。
        此前两者只是各带一点内边距、视觉上贴在一起，用户反馈「管家/子会话之间区分不够明显、没有分界线」。
        分隔写法照抄本文件既有实现（底部账号栏 `borderTop: '1px solid var(--border)'`），
        不新造色值/线宽；加在列表滚动容器的上边框上（边框不随内容滚动，恒定可见）。
      */}
      <div style={{ flex: 1, overflowY: 'auto', WebkitAppRegion: 'no-drag', padding: '4px 0 8px', borderTop: '1px solid var(--border)' } as React.CSSProperties}>
        {visibleSessions.length === 0 ? (
          <div style={{ padding: '16px 12px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>{q ? t('chat.sidebar.noMatch') : t('chat.sidebar.noSession')}</div>
        ) : (
          visibleSessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            /*
              【任务229】激活态互斥：右列一次只显示一个东西（管家面板 或 某会话的消息流），
              但管家条目的高亮看 `ctx.mainView === 'supervisor'`、会话行的高亮看 `s.id === ctx.currentSessionId` ——
              两位各自的判据互不相干，于是「切到管家后再看左列」会出现管家条目与会话行**同时高亮**（分不清在看谁）。
              这里给会话行补上与管家条目相反的判据：只要右列是管家面板，所有会话行都不点亮
              （currentSessionId 仍原样保留，点回去就能恢复，不动 runtime 的任何状态）。
            */
            active={s.id === ctx.currentSessionId && ctx.mainView !== 'supervisor'}
            busy={ctx.sessionBusy(s.id)}
            editing={ctx.editingSessionId === s.id}
            editingTitle={ctx.editingTitle}
            onTitleChange={ctx.setEditingTitle}
            onStartEdit={() => {
              ctx.setEditingSessionId(s.id)
              ctx.setEditingTitle(s.title)
            }}
            onCommitEdit={() => {
              void ctx.renameSession(s.id, ctx.editingTitle)
              ctx.setEditingSessionId(null)
            }}
            onCancelEdit={() => ctx.setEditingSessionId(null)}
            onDelete={() => void ctx.deleteSession(s.id)}
            onSelect={() => void ctx.switchToSession(s.id)}
          />
          ))
        )}
      </div>
      {/*
        侧边栏底部账号区（头像 + 昵称 + 退出登录）——【任务225】抽成 components/AccountPopover.tsx 的 AccountBar：
        同一份 DOM 原样搬过去（零外观变化），并在其上方新增「悬停查看用户信息 / 本机技能 / 本机 MCP 服务」的弹窗。
      */}
      <AccountBar />
    </>
  )
}

registerSlot('shell.sidebar', 'core:sidebar', 'core', SidebarSlot)
