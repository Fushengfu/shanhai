import { useCallback, useEffect, useState } from 'react'

/** 会话列表项（与 window.shanhaiPlugin.listSessions 返回结构一致） */
interface SessionItem {
  id: string
  title: string
  workDir: string
  lastActiveAt: number
  busy: boolean
}

/** 精简 UI 状态（window.shanhaiPlugin.getUiState 返回结构） */
interface PluginUiState {
  loggedIn: boolean
  username: string | null
  wallpaper: string | null
}

/** 取插件桥（渲染进程经 preload contextBridge 暴露的白名单能力） */
const api = (): NonNullable<Window['shanhaiPlugin']> => {
  if (!window.shanhaiPlugin) throw new Error('window.shanhaiPlugin 不可用（插件专用 preload 未挂载）')
  return window.shanhaiPlugin
}

/** 状态卡片：展示 getUiState 拉取的精简登录态 */
function StatusCard(): JSX.Element {
  const [state, setState] = useState<PluginUiState | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void api()
      .getUiState()
      .then(setState)
      .catch((e: unknown) => setError(String(e)))
  }, [])

  return (
    <section className="card">
      <h2>登录状态</h2>
      {error ? (
        <p className="muted">获取失败：{error}</p>
      ) : state ? (
        <div className="row">
          <span className="badge">{state.loggedIn ? '已登录' : '未登录'}</span>
          <span>{state.username ?? '（匿名）'}</span>
        </div>
      ) : (
        <p className="muted">加载中…</p>
      )}
    </section>
  )
}

/** 版本卡片：展示 getVersion 拉取的应用版本 */
function VersionCard(): JSX.Element {
  const [version, setVersion] = useState('')

  useEffect(() => {
    void api()
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion('（获取失败）'))
  }, [])

  return (
    <section className="card">
      <h2>应用版本</h2>
      <p className="mono">{version || '…'}</p>
    </section>
  )
}

/** 会话列表卡片：展示 listSessions 拉取的用户会话 */
function SessionsCard(): JSX.Element {
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    void api()
      .listSessions()
      .then(setSessions)
      .catch((e: unknown) => setError(String(e)))
  }, [])

  return (
    <section className="card">
      <h2>会话列表（{sessions.length}）</h2>
      {error ? (
        <p className="muted">获取失败：{error}</p>
      ) : sessions.length === 0 ? (
        <p className="muted">暂无会话</p>
      ) : (
        <ul className="session-list">
          {sessions.slice(0, 5).map((s) => (
            <li key={s.id}>
              <span className="dot" data-busy={s.busy} />
              {s.title || s.id}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** 剪贴板卡片：演示 clipboardWriteText / clipboardReadText */
function ClipboardCard(): JSX.Element {
  const [value, setValue] = useState('')

  const read = useCallback(async () => {
    setValue(await api().clipboardReadText())
  }, [])

  const write = useCallback(async () => {
    const text = `山海插件测试 ${new Date().toLocaleTimeString()}`
    await api().clipboardWriteText(text)
    setValue(text)
  }, [])

  return (
    <section className="card">
      <h2>剪贴板</h2>
      <p className="muted mono">{value || '（空）'}</p>
      <div className="row">
        <button onClick={() => void write()}>写入</button>
        <button onClick={() => void read()}>读取</button>
      </div>
    </section>
  )
}

/** 交互卡片：计数器（状态演示）+ 语音播报 */
function ActionsCard(): JSX.Element {
  const [count, setCount] = useState(0)
  const [speaking, setSpeaking] = useState(false)

  const speak = useCallback(async () => {
    setSpeaking(true)
    try {
      await api().speak(`你好，这是插件语音播报，计数 ${count}`)
    } finally {
      setSpeaking(false)
    }
  }, [count])

  return (
    <section className="card">
      <h2>交互</h2>
      <div className="row">
        <button onClick={() => setCount((c) => c + 1)}>计数 +1</button>
        <span className="mono">{count}</span>
        <button onClick={() => void speak()} disabled={speaking}>
          {speaking ? '播报中…' : '语音播报'}
        </button>
      </div>
    </section>
  )
}

/** 取宿主桥（window.shanhai：仅 windowType/platform/windowAppId/getPluginApp/closeApp/minimizeWindow/toggleMaximizeWindow） */
const host = (): NonNullable<Window['shanhai']> => {
  if (!window.shanhai) throw new Error('window.shanhai 不可用（插件专用 preload 未挂载）')
  return window.shanhai
}

/** 内联窗口控制图标：与山海内置应用 WindowTitleBar 同款（16×16 SVG 描边，stroke=currentColor，随文字色） */
function IconWinApp(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

function IconWinMinimize(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
    </svg>
  )
}

function IconWinMaximize(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  )
}

function IconWinRestore(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="9" width="12" height="12" rx="2" />
      <path d="M9 5h10a2 2 0 0 1 2 2v10" />
    </svg>
  )
}

function IconWinClose(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

/** 标题栏：与山海内置应用 WindowTitleBar 同款（图标块 + 标题 + 副标题 + 28×28 SVG 三键窗口控制） */
function TitleBar(props: { title: string; subtitle?: string; onClose: () => void }): JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const handleToggleMaximize = async (): Promise<void> => {
    const next = await host().toggleMaximizeWindow()
    setMaximized(next ?? false)
  }
  return (
    <header className="titlebar">
      <span className="titlebar-icon">
        <IconWinApp />
      </span>
      <div className="titlebar-text">
        <div className="titlebar-title">{props.title}</div>
        {props.subtitle && <div className="titlebar-subtitle">{props.subtitle}</div>}
      </div>
      <div className="titlebar-spacer" />
      <div className="titlebar-winbtns">
        <button className="titlebar-winbtn" onClick={() => host().minimizeWindow()} title="最小化">
          <IconWinMinimize />
        </button>
        <button className="titlebar-winbtn" onClick={() => void handleToggleMaximize()} title={maximized ? '还原' : '最大化'}>
          {maximized ? <IconWinRestore /> : <IconWinMaximize />}
        </button>
        <button className="titlebar-winbtn" onClick={props.onClose} title="关闭">
          <IconWinClose />
        </button>
      </div>
    </header>
  )
}

/** 插件应用根组件：多组件 + 状态 + 样式，验证复杂 UI 与白名单能力调用 */
export function App(): JSX.Element {
  const [pluginAppId, setPluginAppId] = useState('')

  useEffect(() => {
    setPluginAppId(api().pluginAppId ?? '')
  }, [])

  return (
    <div className="app">
      <TitleBar title="插件窗口" subtitle="编译产物渲染" onClose={() => void api().closeApp()} />
      <main className="body">
        <p className="hero">Dock 图标测试成功 —— client 半已脱离 new Function，改用编译产物 + loadFile 渲染</p>
        <p className="muted">插件应用 id：{pluginAppId || '（未知）'}</p>
        <div className="grid">
          <StatusCard />
          <VersionCard />
          <SessionsCard />
          <ClipboardCard />
          <ActionsCard />
        </div>
      </main>
    </div>
  )
}
