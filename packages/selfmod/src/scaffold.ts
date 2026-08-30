import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

/**
 * 插件应用脚手架（升级方案第 5 步）。
 *
 * 把「插件应用」的骨架模板（host 半 + client 半 + 构建配置 + 说明）内联为本文件的字符串常量，
 * 使模板随 selfmod 包一起被打包进主进程产物（selfmod 被 runtime/desktop 以 noExternal 打包），
 * 终端用户环境「不读仓库源码」也能拿到模板。plugin_scaffold 工具据此生成可编译插件项目。
 *
 * 权威源说明：本文件是 plugin_scaffold 工具的运行时模板源；apps/desktop/plugin-template/ 是
 * 「可独立构建/预览的手写示例」，两者内容保持一致（改动任一处请同步另一处）。
 *
 * 占位符：<PLUGIN_ID> 插件英文 id、<PLUGIN_NAME> 显示名、<PLUGIN_PURPOSE> 用途说明。
 * 生成时统一替换为实际值。
 */

/** 脚手架模板文件清单（path 相对项目根，content 含占位符）。content 刻意避免反引号与 ${，便于内联。 */
export interface ScaffoldFile {
  path: string
  content: string
}

const HOST_TS = `/**
 * 插件 host 半（主进程侧，工程化编译产物）。
 *
 * 契约：必须 module.exports = (ctx) => disposer（不能写成裸箭头函数）。
 * ctx 提供五条能力：on / provide / tools.register / openWindow / closeWindow。
 * disposer 可为函数 / null / 数组 / Promise（撤销时逆序调用）。
 *
 * 构建：esbuild src/host.ts --bundle --platform=node --format=cjs --outfile=dist/host.cjs
 * 产物必须是「自包含 bundle」：第三方依赖打进产物，且不能 external electron / @shanhai/*，
 * 否则主进程 loadHostEntry 会拒绝加载。require 第三方依赖的方式就是直接 import，esbuild 会打包进去。
 */

/** host 半拿到的 facade（ctx）类型声明 */
interface PluginContext {
  on(name: string, listener: (...args: unknown[]) => unknown): void
  provide(name: string, impl: unknown): void
  tools: { register(tool: unknown): void }
  openWindow(appId?: string): void
  closeWindow(appId?: string): void
}

// 声明 CommonJS 的 module（host 半契约：module.exports = (ctx) => disposer）。
// 注意必须用 var 而非 const：const 是块级声明，会与 @types/node 的全局 var module（module.d.ts）
// 冲突，报「Cannot redeclare block-scoped variable module」；var 可与其共存，插件项目 typecheck 才不报重复声明。
declare var module: { exports: unknown }

module.exports = (ctx: PluginContext): (() => void) => {
  // 1) 窗口应用默认「不自动开窗」：安装/加载后由用户主动打开（点 Dock 图标 → openApp → loadFile dist/client.html）。
  //    如需程序化开窗（例如收到某个事件时），在事件回调里显式调 ctx.openWindow()。
  // ctx.openWindow()  // ← 取消注释即可在 install/run 阶段立即开窗（不推荐：会打断用户当前工作）

  // 2) 订阅内核事件示例（撤销时自动取消订阅）
  ctx.on('<PLUGIN_ID>:ping', (payload) => {
    console.log('[<PLUGIN_ID>] 收到事件：', payload)
  })

  // 3) 注册命名服务（plugin_inspect 可查 services 列表）。
  //    若 impl 是函数，client 半可通过 window.shanhaiPlugin.invokePluginService('<PLUGIN_ID>:getData', arg) 调用它（client → host RPC）。
  ctx.provide('<PLUGIN_ID>:getData', async (query: unknown) => ({ echo: String(query ?? ''), at: Date.now() }))

  // 4) 注册插件工具示例（收集进插件工具 Registry，经 plugin_tool 按 action 分派调用；撤销时自动注销）—— 需要时取消注释
  // ctx.tools.register({
  //   name: '<PLUGIN_ID>_echo',
  //   description: '回声工具示例',
  //   inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  //   execute: async (args) => ({ echo: String(args.text ?? '') }),
  // })

  // 5) 返回 disposer：插件卸载 / 停止时调用
  return () => {
    console.log('[<PLUGIN_ID>] host 半已卸载')
  }
}
`

const MAIN_TSX = `import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'

// 插件窗口独立渲染入口：主进程 openApp 检测到 dist/client.html 后 loadFile 加载本页面。
// 本入口跑在独立 app 渲染进程、挂插件专用 preload（plugin.cjs），
// 只能访问 window.shanhaiPlugin（白名单桥）与 window.shanhai（宿主桥，仅 getPluginApp/closeApp）。
const container = document.getElementById('root')
if (container) {
  createRoot(container).render(<App />)
}
`

const APP_TSX = `import { useCallback, useEffect, useState } from 'react'

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
    const text = '山海插件测试 ' + new Date().toLocaleTimeString()
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
      await api().speak('你好，这是插件语音播报，计数 ' + count)
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

/** 标题栏：frameless 窗口的统一自定义标题栏（拖动区 + 最小化/最大化/关闭，与山海内置应用同风格） */
function TitleBar(): JSX.Element {
  return (
    <header className="titlebar">
      <span className="title">插件窗口 · 编译产物渲染</span>
      <span className="spacer" />
      <div className="winbtns">
        <button className="winbtn" onClick={() => host().minimizeWindow()} title="最小化">
          ─
        </button>
        <button className="winbtn" onClick={() => void host().toggleMaximizeWindow()} title="最大化/还原">
          □
        </button>
        <button className="winbtn close" onClick={() => void api().closeApp()} title="关闭窗口">
          ✕
        </button>
      </div>
    </header>
  )
}

/** 插件应用根组件：多组件 + 状态 + 样式，演示复杂 UI 与白名单能力调用 */
export function App(): JSX.Element {
  const [pluginAppId, setPluginAppId] = useState('')

  useEffect(() => {
    setPluginAppId(api().pluginAppId ?? '')
  }, [])

  return (
    <div className="app">
      <TitleBar />
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
`

const PLUGIN_DTS = `/**
 * 插件专用 preload（plugin.cjs）暴露的白名单桥类型声明。
 *
 * 插件窗口（独立渲染进程）里 window.shanhaiPlugin 可调用的公开能力，每个方法统一走
 * 主进程 plugin:invoke 入口，按「插件 id + 能力名」双层校验（能力在全局白名单 +
 * 插件 manifest.permissions 声明了它），否则抛错拒绝。
 */
export interface ShanhaiPluginBridge {
  /** 当前插件应用 id（持久化 id，由主进程 additionalArguments 注入） */
  pluginAppId?: string
  /** 应用版本号 */
  getVersion(): Promise<string>
  /** 写剪贴板 */
  clipboardWriteText(text: string): Promise<void>
  /** 读剪贴板 */
  clipboardReadText(): Promise<string>
  /** 语音播报（TTS） */
  speak(text: string): Promise<void>
  /** 打开目录选择器，返回所选目录绝对路径，取消返回 null */
  selectDirectory(defaultPath?: string): Promise<string | null>
  /** 列出用户会话（只读） */
  listSessions(): Promise<Array<{ id: string; title: string; workDir: string; lastActiveAt: number; busy: boolean }>>
  /** 列出指定会话的长期记忆（只读） */
  listMemory(sessionId: string): Promise<unknown[]>
  /** 精简 UI 状态（只含登录态 + 用户名 + 壁纸，隔离敏感数据） */
  getUiState(): Promise<{ loggedIn: boolean; username: string | null; wallpaper: string | null }>
  /** 关闭当前插件自己的窗口（仅自身，无法越权关其它窗口） */
  closeApp(): Promise<void>
  /** 读取桌面壁纸（CSS backgroundImage 值） */
  getWallpaper(): Promise<string | null>
  /** token 用量快照（只读） */
  getTokenStats(sessionId?: string): Promise<unknown>
  /**
   * 调用本插件 host 半注册的自定义服务（client → host RPC）。
   * 入参：服务名（host 半 ctx.provide 注册的 name）+ 可变参数；返回值必须是 JSON 可序列化数据。
   * 默认放行（无需 permissions 声明）；只能调「本插件」的服务，无法越权调其它插件/内核。
   */
  invokePluginService(name: string, ...args: unknown[]): Promise<unknown>
  /**
   * 模型调用（受控单次文本生成）：用「当前选中的模型」生成一次文本。
   * 需显式声明 permissions: [\"modelCall\"]；不能指定模型 id、不能切模型，单次 maxTokens 上限由主进程固定。
   * 入参 { prompt: 必填用户提示词, systemPrompt?: 可选系统提示词 }，返回 { text, usage? }。
   */
  modelCall(input: { prompt: string; systemPrompt?: string }): Promise<{ text: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }>
}

declare global {
  interface Window {
    shanhaiPlugin?: ShanhaiPluginBridge
    /** 宿主桥（窗口控制 + 只读信息，按 sender 反查自身窗口，无法越权） */
    shanhai?: ShanhaiHostBridge
  }
}

/** 插件窗口宿主桥（window.shanhai）：窗口控制 + 只读信息，主进程按 sender 反查自身窗口 */
export interface ShanhaiHostBridge {
  windowType: string
  platform: string
  windowAppId?: string
  getPluginApp(appId: string): Promise<unknown>
  closeApp(appId: string): Promise<void>
  minimizeWindow(): void
  toggleMaximizeWindow(): Promise<boolean>
  /** 订阅主题变更（主进程 ui:theme 广播给所有窗口），返回取消订阅函数。插件窗口据此跟随内置应用亮/暗切换 */
  onThemeChange(cb: (theme: 'light' | 'dark') => void): () => void
}

export {}
`

const STYLE_CSS = `:root {
  color-scheme: dark;
  --bg: #14161a;
  --panel: #1d2129;
  --border: #2a303b;
  --text: #e6e8ec;
  --muted: #8a93a3;
  --accent: #4c8dff;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  margin: 0;
  height: 100%;
}

body {
  font-family: system-ui, -apple-system, 'PingFang SC', sans-serif;
  background: var(--bg);
  color: var(--text);
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px 0 16px;
  height: 44px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
  user-select: none;
}

.title {
  font-weight: 600;
  font-size: 13px;
}

.spacer {
  flex: 1;
}

.winbtns {
  display: flex;
  align-items: center;
  gap: 4px;
  -webkit-app-region: no-drag;
}

.winbtn {
  -webkit-app-region: no-drag;
  border: none;
  background: transparent;
  color: var(--muted);
  width: 28px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}

.winbtn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}

.winbtn.close:hover {
  background: rgba(255, 82, 82, 0.2);
  color: #ff6b6b;
}

.body {
  flex: 1;
  overflow: auto;
  padding: 20px;
}

.hero {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 6px;
}

.muted {
  color: var(--muted);
  font-size: 12px;
}

.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
}

.card h2 {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text);
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(76, 141, 255, 0.15);
  color: var(--accent);
  font-size: 11px;
}

button {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 12px;
}

.session-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid var(--border);
}

.session-list li:last-child {
  border-bottom: none;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}

.dot[data-busy='true'] {
  background: #34c759;
}
`

const CLIENT_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title><PLUGIN_NAME></title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// 插件 client 半构建配置：产出 dist/client.html + dist/assets/*（含完整 React bundle，自包含）。
// base './'：Electron loadFile(file://) 下资源必须相对路径，否则 assets 找不到。
export default defineConfig({
  plugins: [react()],
  base: './',
  root: __dirname,
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'client.html'),
    },
  },
})
`

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"]
  },
  "include": ["src", "vite.config.ts"]
}
`

const PACKAGE_JSON = `{
  "name": "<PLUGIN_ID>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "<PLUGIN_PURPOSE>",
  "scripts": {
    "build:host": "esbuild src/host.ts --bundle --platform=node --format=cjs --outfile=dist/host.cjs --log-level=error",
    "build:client": "vite build",
    "build": "npm run build:host && npm run build:client"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "esbuild": "^0.25.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0"
  }
}
`

const README_MD = `# <PLUGIN_NAME>（<PLUGIN_ID>）

山海「插件应用」脚手架生成的项目。一个真正的窗口应用：host 半在主进程运行、
client 半在独立窗口渲染（完整 React + JSX + 任意依赖），并通过 window.shanhaiPlugin
白名单桥调用山海公开接口。

## 目录结构

  <PLUGIN_ID>/
  ├── src/host.ts             # host 半（主进程侧）：module.exports = (ctx) => disposer
  ├── src/main.tsx            # client 半入口（React 挂载）
  ├── src/App.tsx             # 根组件（复杂 UI 演示，可改）
  ├── src/style.css           # 样式
  ├── src/shanhai-plugin.d.ts # window.shanhaiPlugin 白名单桥类型声明
  ├── client.html             # 窗口入口（vite 输入，loadFile 加载）
  ├── vite.config.ts          # client 半构建配置
  ├── tsconfig.json           # 类型检查
  └── package.json            # 依赖声明 + build 脚本

## 怎么改

  1. 改 src/host.ts：定义 host 半行为（openWindow / on / provide / tools.register）。
  2. 改 src/App.tsx：定义窗口界面，需要时用 window.shanhaiPlugin 调白名单能力。
  3. 如需第三方依赖：在 host 半直接 import（esbuild --bundle 会打进 host.cjs）；
     在 client 半直接 import（vite 会打进 client bundle）。

## 怎么编译

  方式一（推荐，山海 AI 进程内编译，免 npm install）：

    plugin_build(id="<PLUGIN_ID>")

  方式二（手动 npm，需先 npm install）：

    cd <PLUGIN_ID>
    npm install
    npm run build

产物：

  dist/host.cjs          # host 半（自包含 bundle，可 require 第三方依赖）
  dist/client.html       # client 半窗口入口（loadFile 加载）
  dist/assets/*          # client bundle（js/css，自包含）

## 怎么安装

  安装激活（plugin_install 会自动把 workspace 产物部署到 plugins/<PLUGIN_ID>/dist/，无需手动 cp）：

    plugin_define(
      name="<PLUGIN_ID>",
      purpose="<PLUGIN_PURPOSE>",
      permissions=["getVersion","getUiState","listSessions","clipboardWriteText","clipboardReadText","speak"]
    )
    plugin_install(persistId="<PLUGIN_ID>")

  说明：permissions 声明插件要调的白名单能力（模板 App.tsx 用到上述 6 项）；
  closeApp（关闭自己窗口）无需声明、默认放行。漏声明会导致对应 window.shanhaiPlugin 调用被拒。

  完整流水线：plugin_scaffold → plugin_build → plugin_test_load → plugin_verify → plugin_install。

## 插件能调什么（白名单桥）

窗口里通过 window.shanhaiPlugin 调用山海公开接口，当前白名单：

  getVersion / clipboardWriteText / clipboardReadText / speak / selectDirectory
  listSessions / listMemory / getUiState(精简版) / closeApp(仅自身) / getWallpaper / getTokenStats

每个方法都经主进程 plugin:invoke 按「插件 id + 能力名」双层校验，
插件 manifest.permissions 声明了对应能力才会放行（未声明则抛错）。

## 注意

  - host 半契约：必须 module.exports = (ctx) => disposer，disposer 可为函数/null/数组/Promise。
  - 窗口应用默认「不自动开窗」：安装/加载后由用户点 Dock 图标主动打开（openApp → loadFile dist/client.html）；
    如需程序化开窗，在事件回调里显式调 ctx.openWindow()。
  - client 半跑在独立渲染进程、挂插件专用 preload，只有 window.shanhaiPlugin（白名单）
    与 window.shanhai（宿主桥，仅 getPluginApp/closeApp），没有 chat 窗口的 useUIContext。
`

/** 默认插件应用图标（SVG，时钟占位主题）：scaffold 默认生成 icon.svg，install 时随产物自动部署到 plugins/<id>/icon.svg */
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4f8cff"/>
      <stop offset="1" stop-color="#7c5cff"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#g)"/>
  <circle cx="64" cy="64" r="40" fill="none" stroke="#ffffff" stroke-width="8"/>
  <line x1="64" y1="64" x2="64" y2="40" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
  <line x1="64" y1="64" x2="80" y2="72" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
  <circle cx="64" cy="64" r="5" fill="#ffffff"/>
</svg>
`

/** 脚手架模板文件清单（权威源；与 apps/desktop/plugin-template/ 保持一致） */
export const SCAFFOLD_FILES: ScaffoldFile[] = [
  { path: 'src/host.ts', content: HOST_TS },
  { path: 'src/main.tsx', content: MAIN_TSX },
  { path: 'src/App.tsx', content: APP_TSX },
  { path: 'src/shanhai-plugin.d.ts', content: PLUGIN_DTS },
  { path: 'src/style.css', content: STYLE_CSS },
  { path: 'client.html', content: CLIENT_HTML },
  { path: 'vite.config.ts', content: VITE_CONFIG },
  { path: 'tsconfig.json', content: TSCONFIG_JSON },
  { path: 'package.json', content: PACKAGE_JSON },
  { path: 'icon.svg', content: ICON_SVG },
  { path: 'README.md', content: README_MD },
]

/** 脚手架工作区根目录（与插件落盘目录 ~/.shanhai/plugins 区分） */
export const SCAFFOLD_WORKSPACE_DIR = join(homedir(), '.shanhai', 'plugins-workspace')

/** 校验插件 id（与 SelfModifyRuntime.persistIdOf 一致：仅 [a-zA-Z0-9_-]） */
function validateId(id: string): string {
  const raw = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!raw) {
    throw new Error('插件 id 需含字母/数字/连字符（如 todo-list），请给一个英文短 id')
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new Error(`非法插件 id（仅允许字母/数字/下划线/连字符）: ${raw}`)
  }
  return raw
}

export interface ScaffoldResult {
  /** 生成的项目根目录绝对路径 */
  dir: string
  /** 相对项目根的已生成文件清单 */
  files: string[]
  /** 下一步操作说明（编译 / 安装） */
  nextSteps: string[]
}

/**
 * 从内置模板生成一个可编译的插件应用项目到 ~/.shanhai/plugins-workspace/<id>/。
 * 目录已存在时覆盖刷新（幂等：重新生成会覆盖同名文件，便于重复生成）。
 */
export async function scaffoldPlugin(id: string, opts: { name?: string; purpose?: string } = {}): Promise<ScaffoldResult> {
  const pid = validateId(id)
  const name = (opts.name ?? '').trim() || pid
  const purpose = (opts.purpose ?? '').trim() || '山海插件应用'

  const root = resolve(SCAFFOLD_WORKSPACE_DIR)
  const dir = join(SCAFFOLD_WORKSPACE_DIR, pid)
  const target = resolve(dir)
  if (target !== join(root, pid) && !target.startsWith(root + sep)) {
    throw new Error(`插件 id 越界: ${pid}`)
  }

  const files: string[] = []
  for (const f of SCAFFOLD_FILES) {
    const content = f.content
      .split('<PLUGIN_ID>').join(pid)
      .split('<PLUGIN_NAME>').join(name)
      .split('<PLUGIN_PURPOSE>').join(purpose)
    const abs = join(dir, f.path)
    await fs.mkdir(join(abs, '..'), { recursive: true })
    await fs.writeFile(abs, content)
    files.push(f.path)
  }

  return {
    dir,
    files,
    nextSteps: [
      `1. 编辑 ${pid}/src/host.ts（host 半）与 ${pid}/src/App.tsx（client 半），按需修改`,
      `2. 编译：plugin_build(id="${pid}")（进程内 esbuild/vite，免 npm install，产出 dist/host.cjs + dist/client.html）`,
      `3. 测试加载：plugin_test_load(id="${pid}")（临时目录干跑，不污染正式目录）`,
      `4. 验证：plugin_verify(id="${pid}")（越权审计 + 产物结构校验）`,
      `5. 安装：plugin_define(name="${name}", purpose="${purpose}", permissions=["getVersion","getUiState","listSessions","clipboardWriteText","clipboardReadText","speak"]) → plugin_install(persistId="${pid}")（自动部署产物到 plugins/${pid}/dist/，无需手动 cp；closeApp 默认放行无需声明）`,
    ],
  }
}
