# 山海插件协议规范（权威版）

> 本文是山海 AI「插件（selfmod / K5 自修改）」的**权威、唯一、机器可读**协议规范。
> 它由源码真实契约梳理而成，AI 开发插件前**必须先读本文，禁止靠猜或试错**。
> 若本文与工具描述文字冲突，以本文为准；若本文与源码实现冲突，以源码为准并回读本文修正。
>
> 内置同步：本文是**唯一权威源**。`packages/skills/src/plugin-protocol.generated.ts` 由
> `packages/skills/scripts/gen-plugin-protocol.mjs` 从本文自动生成，`skill.ts` 的内置技能 `plugin-protocol`（instructions）引用它。
> 改协议**只改本文**，再跑 `pnpm --filter @shanhai/skills gen:protocol`（`build` 前会自动执行）即可同步。
> 打包分发后 AI 通过 `skill_list` / `skill_read('plugin-protocol')` 即可读到本规范（无需读仓库源码）。

- 源码锚点（grep 定位用）：
  - `packages/selfmod/src/selfmod.ts` —— host 半契约 `HostFacade`、生命周期 `SelfModifyRuntime`、插件工具链
  - `packages/selfmod/src/build.ts` —— `plugin_build` 进程内构建器、越权审计
  - `packages/selfmod/src/scaffold.ts` —— `plugin_scaffold` 内置模板
  - `packages/kernel/src/selfmod/inventory.ts` —— `DynamicPackage`、`InstalledPackageMeta`、`PluginStore`（落盘）
  - `packages/kernel/src/runtime/dispose.ts` —— `DisposerStack`（disposer 收集/撤销）
  - `packages/kernel-modules/src/client/slot.ts` —— `CORE_SLOTS`（UI 插槽清单）
  - `apps/desktop/src/renderer/App.tsx` —— client 半 UI 插槽形态的执行/卸载
  - `apps/desktop/src/renderer/app/AppWindow.tsx` —— client 半窗口应用形态（快速原型路径）
  - `apps/desktop/src/preload/plugin.ts` —— 插件专用 preload（`window.shanhaiPlugin` 白名单桥）
  - `apps/desktop/src/main/ipc-handlers.ts` —— `plugin:invoke` 统一入口 + `PLUGIN_CAPABILITIES` 白名单
  - `apps/desktop/src/main/plugin-apps.ts` / `push.ts` —— 窗口应用注册表 + Dock 图标广播
  - `apps/runtime/src/bootstrap.ts` —— `SelfModifyHooks` 的实现装配

---

## 0. 两条链路总览

插件开发有两条链路，**并存、按「有无 dist 编译产物」自动选择**：

| 链路 | 载体 | 适用场景 | 工具流 |
|------|------|----------|--------|
| **快速原型** | 源码字符串（`code` / `client`） | 临时小组件、快速验证 | `plugin_define` → `plugin_run`/`plugin_test` → `plugin_install` |
| **工程化** | 独立构建产物（`dist/host.cjs` + `dist/client.html`） | 复杂界面、第三方依赖、长期使用 | `plugin_scaffold` → `plugin_build` → `plugin_test_load` → `plugin_verify` → `plugin_install` |

- 工程化链路的 host 半 / client 半产物一旦存在，`plugin_install` / `plugin_run` 会**自动优先使用产物**（跳过源码字符串）。
- 无产物时回退到快速原型路径（`node:vm` 评估 host 半、`new Function` 渲染 client 半）。

一个「插件」= 一个 **动态 package（DynamicPackage）**，最终由一个**目录**承载（见 §6）。

---

## 1. host 半契约

host 半在**进程内**运行，入口统一为**工厂函数 `(ctx) => disposer`**。有两种加载方式：

### 1.1 快速原型：`node:vm` 评估源码字符串（`code` 字段）

`evalHostCode` 的沙箱只注入 `module` / `exports` 两个对象：

```js
const sandbox = { module: { exports: {} }, exports: {} }
```

执行后取 `sandbox.module.exports`，**必须是函数**，否则抛错 `host 半代码必须导出函数：(ctx) => disposer`。

> ⚠️ **坑 1**：host 半**必须**写成 `module.exports = (ctx) => {...}` 或 `module.exports = function (ctx) {...}`。
> 裸箭头函数 `(ctx) => {...}`（没有 `module.exports =`）会因 `module.exports` 为空对象而报错。

### 1.2 工程化：`require` 编译产物（`entryHost` 字段）

`loadHostEntry` 用 `require(~/.shanhai/plugins/<id>/dist/host.cjs)` 加载，从而能 **require 第三方 npm 依赖**。

**编译产物契约（必须满足，否则拒绝加载）：**

1. **自包含 bundle**：用 `esbuild src/host.ts --bundle --platform=node --format=cjs --outfile=dist/host.cjs` 打包，第三方依赖打进产物；主进程**不做运行时 node_modules 解析**。
2. **越权审计规则**：产物不得 `require('electron')` / `require('@shanhai/*')`。`loadHostEntry` 会正则扫描产物源码，命中则抛错 `host 半编译产物违规 external（electron / @shanhai/*）`。
3. **导出兼容**：`extractFactory` 兼容三种形态 —— `module.exports = fn`（mod 即 fn）、`export default fn`（mod.default）、`exports.factory = fn`（mod.factory）。

> ⚠️ **隔离本质**：`node:vm` 沙箱从来不是安全边界（`this.constructor.constructor('return process')()` 可逃逸），
> 改 require 后隔离强度**没有实质下降**。host 半始终是「本地代码、信任立场等同 bash」。真正的防护靠：
> facade 只暴露五条能力（不注入 `process`/`require`/`electron`/`module`/`ipcMain`）+ 产物 external 审计。

### 1.3 `ctx` 提供的能力（`HostFacade`，逐条）

```ts
interface HostFacade {
  on(name: string, listener: (...args: unknown[]) => unknown): void
  provide(name: string, impl: unknown): void
  tools: { register(tool: ToolContract): void }
  openWindow(appId?: string): void
  closeWindow(appId?: string): void
}
```

| 能力 | 签名 | 语义 | 是否自动撤销 |
|------|------|------|--------------|
| `ctx.on` | `(name, listener) => void` | 订阅内核事件总线，返回无（⚠️ 当前内核**不广播任何事件**，可订阅事件清单为空，见下） | ✅ 撤销时自动 off |
| `ctx.provide` | `(name, impl) => void` | 注册命名服务。**若 `impl` 是函数，client 半可经 `window.shanhaiPlugin.invokePluginService(name, ...args)` 调用它（client→host RPC，见 §7）** | ✅ 撤销时自动删除 |
| `ctx.tools.register` | `(tool: ToolContract) => void` | 注册一个「插件工具」：收集进插件工具 Registry（**不再进顶层工具表**），由统一调度工具 `plugin_tool` 按 action 分派调用（见 §9） | ✅ 撤销时自动移除 |
| `ctx.openWindow` | `(appId?: string) => void` | 打开本插件的窗口应用（`appId` 缺省 = 插件 id） | ✅ 撤销时自动关闭该窗口 |
| `ctx.closeWindow` | `(appId?: string) => void` | 显式关闭本插件的窗口应用（`appId` 缺省 = 插件 id） | ❌ 主动关闭，不挂撤销 |

> ⚠️ **刻意不暴露 `effect()`**：host 半的 cleanup 只能走上面 4 条自动撤销路径（`on`/`provide`/`tools.register`/`openWindow`）。

> ⚠️ **坑 14（`ctx.on` 无可订阅内核事件）**：`ctx.on` 桥接到内核事件总线 `kernel.ctx.on`，但当前内核**零 `emit` 调用**——没有内核事件会广播，可订阅事件清单**为空**。插件 `ctx.on('任意名字', ...)` 只是挂一个永远不会被触发的监听器（除非未来内核广播事件，或插件间协作，但 facade 也未暴露 emit）。开发时**不要依赖 `ctx.on` 接收内核事件**；它仅作为「未来内核事件 + 插件自定义协作」的占位能力保留。

`ctx.tools.register` 的 `ToolContract`（`packages/tools/src/tools.ts`）：

```ts
interface ToolContract {
  name: string
  description: string                          // 隐式 prompt：何时用/参数含义/返回什么
  inputSchema: Record<string, unknown>         // JSON Schema（object）
  riskLevel: 'readonly' | 'reversible' | 'irreversible' | 'high'
  approvalRequired?: boolean
  timeoutMs?: number                           // Infinity = 不超时（等用户交互）
  guide?: ToolGuide
  resolveRisk?: (args) => { riskLevel; approvalRequired?; outsideWorkdir? }
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>
}
```

### 1.4 disposer 的合法形式

`(ctx) => disposer` 的返回值交给 `DisposerStack.collect`，支持四种形式：

1. **函数** `() => void` 或 `() => Promise<void>`；
2. **`null` / `undefined`**（无副作用，忽略）；
3. **Iterable / AsyncIterable**，逐个 yield disposer；
4. **Promise<disposer>**。

disposer 在 `plugin_stop` / `plugin_uninstall` / `plugin_undefine` / `plugin_test`（撤回阶段）时**逆序**全部调用，单个失败不阻断其余。

---

## 2. client 半契约

client 半运行在浏览器渲染进程，两种形态二选一；工程化链路的窗口应用形态走 `loadFile` 独立入口。

### 2.1 形态 A：UI 插槽形态（默认，投递到聊天窗口）

编译方式（`App.tsx` `mountClientCode`）：`new Function('React', 'slots', 'useUIContext', code)`。

三个入参：

| 参数 | 类型/值 | 说明 |
|------|---------|------|
| `React` | React 命名空间 | 用 `React.createElement` 建元素 |
| `slots` | `{ register(reg) => dispose }` | **只有 `register` 一个方法**，不是完整 SlotRegistry |
| `useUIContext` | `() => UIContextValue` | 组件内读取框架派生的应用状态 |

```ts
slots.register({ slot: string, id: string, component: React.ComponentType }): () => void
```

> ⚠️ **坑 2**：client 半源码字符串用 `new Function` 编译，**不经过 JSX**，写组件**必须用 `React.createElement(...)`，禁止写 `<div>` 这类 JSX 语法**。

**最小骨架**：

```js
function (React, slots, useUIContext) {
  function MyWidget() {
    const ctx = useUIContext()
    return React.createElement('div', null, '当前会话: ' + ctx.currentSessionId)
  }
  slots.register({ slot: 'composer.below', id: 'my-widget', component: MyWidget })
  // 可选：return () => { /* cleanup */ }
}
```

### 2.2 形态 B：窗口应用形态（配合 host 半 `openWindow`）

窗口应用形态有**两条子路径**：

#### a. 快速原型：`new Function`（`client` 源码字符串）

编译方式（`AppWindow.tsx` `DynamicPluginWindow`）：`new Function('React', 'helpers', clientCode)`。

```ts
helpers = {
  close: () => void,   // 调用 window.shanhai.closeApp(appId)，关闭本窗口
  appId: string,       // 插件持久化 id（窗口 appId）
  name: string,        // 插件 name
}
```

> ⚠️ **坑 3**：**必须 `return` 一个 React 组件函数**（`function XxxWindow() {...}`），不能 `return` 对象、不能「箭头函数直接返回对象」；返回非函数时窗口显示「插件未提供窗口界面」占位。
> ⚠️ **坑 4**：窗口应用形态跑在**独立 app 渲染进程**、不在 `UIContext.Provider` 内，因此**不能调 `useUIContext()`**，只用 `helpers`。

**最小骨架**：

```js
function (React, helpers) {
  return function XxxWindow() {
    return React.createElement('div', { style: { padding: 24 } },
      React.createElement('h1', null, '窗口内容'),
      React.createElement('button', { onClick: helpers.close }, '关闭（helpers.close）')
    )
  }
}
```

#### b. 工程化：`loadFile` 加载 `dist/client.html`（`entryHtml` 字段）

主进程 `openApp` 检测到 `~/.shanhai/plugins/<id>/dist/client.html` 后，**`loadFile` 加载独立渲染入口**（脱离 `new Function`）：

- 窗口内容由 `dist/client.html` + `dist/assets/*`（vite 完整 React bundle）渲染，**可用完整 React + JSX + 任意依赖 + 复杂 UI**。
- 该入口挂**插件专用 preload**（`plugin.cjs`），暴露两个桥：
  - `window.shanhaiPlugin`（白名单桥，11 项能力，见 §7）—— 插件调山海公开接口的**唯一**通道；
  - `window.shanhai`（宿主桥，**极度缩小**：仅 `windowType`/`platform`/`windowAppId`/`getPluginApp`/`closeApp`/`minimizeWindow`/`toggleMaximizeWindow`，无任何危险接口）。
- 构建配置要求：`base: './'`（Electron `loadFile(file://)` 下资源必须相对路径）。

> ⚠️ **坑 13（frameless 窗口必读）**：插件窗口与山海其它窗口一样是 **frameless（`frame:false`、无系统标题栏）**，因此 **client 半必须自己提供统一标题栏**，否则「窗口拖不动、关不掉、找不到窗口控制」：
> 1. **拖动手柄**：顶部标题栏加 CSS `-webkit-app-region: drag;`（按钮等可点元素要 `-webkit-app-region: no-drag;` 否则点不到）；
> 2. **窗口控制三按钮**（最小化/最大化/关闭，与山海内置应用同风格）：
>    - 最小化 → `window.shanhai.minimizeWindow()`（宿主桥，按 sender 反查自身窗口，无需 permission）；
>    - 最大化/还原 → `window.shanhai.toggleMaximizeWindow()`（宿主桥，返回是否最大化）；
>    - 关闭 → `window.shanhaiPlugin.closeApp()`（工程化）或 `helpers.close`（快速原型）。`closeApp` 默认放行、无需声明 permission。
> - **脚手架模板已内置这套标题栏**（`TitleBar` 组件 + `.titlebar`/`.winbtn` 样式），AI 生成插件直接复用，不要自己另写一套。

---

## 3. UI 插槽清单（`CORE_SLOTS`）

`packages/kernel-modules/src/client/slot.ts` 定义，`plugin_inspect` 通过 `listSlots()` 暴露。

**覆盖型**（后注册整体替换、注销回退，用于「整体替换某区块」）：

```
shell.sidebar    shell.header      shell.chat        shell.composer
shell.statusbar  shell.terminal    shell.welcome     shell.panels
shell.overlays   dynamic-extension
```

**追加型**（全部注册依次渲染、互不覆盖，用于「加按钮/小组件」）：

```
composer.below   composer.actions  header.actions    chat.below
```

> ⚠️ **坑 5（历史缺口，现已修复）**：`shell.terminal` 曾一度漏在 `CORE_SLOTS` 之外，现版本已补进。

---

## 4. 生命周期与流水线

状态机：`defined` → `running` → `stopped` → `installed`。

### 4.1 快速原型链路（`plugin_*` 核心工具）

| 工具 | 做什么 | status 变化 | 是否落盘 |
|------|--------|-------------|----------|
| `plugin_define` | 记录 package（不语法检查、不运行），返回 `dyn-<n>` id | → `defined` | 否 |
| `plugin_run` | 评估 host 半 + 投递 client 半（有 client 时 **round-trip 审批**） | → `running` | 否 |
| `plugin_stop` | 撤销 host 半（disposer）+ browser 半（removeClient），定义保留 | → `stopped` | 否 |
| `plugin_undefine` | `stop` 后遗忘定义 | 移除 | 否 |
| `plugin_test` | 幂等「撤回 → 运行 → 撤回」，返回 `{ ok, clientDelivered }` | 不变 | 否 |
| `plugin_install` | 见下 | → `installed` | ✅ |
| `plugin_uninstall` | disposer + removeClient + 删落盘目录 | 移除 | 删目录 |
| 启动 `restoreAll` | 加载所有已安装插件并重新激活（免审批） | → `installed` | 读目录 |

### 4.2 工程化流水线（`plugin_scaffold` → `build` → `test_load` → `verify` → `install`）

| 工具 | 做什么 | 产物 |
|------|--------|------|
| `plugin_scaffold` | 从内置模板生成可编译项目到 `~/.shanhai/plugins-workspace/<id>/` | src + 构建配置 + package.json |
| `plugin_build` | 进程内编译（esbuild host + vite client） | `dist/host.cjs` + `dist/client.html` + `dist/assets/*` |
| `plugin_test_load` | 把产物复制到临时目录 `~/.shanhai/plugins-test/<id>/` 干跑加载，验证能跑 + 能卸载 | 校验报告（不污染正式目录） |
| `plugin_verify` | 产物存在性 + 越权审计 + host 可加载 + client.html 结构 | verdict（pass/fail） |
| `plugin_install` | 持久化安装（自动部署产物到 `plugins/<id>/dist/`） | `~/.shanhai/plugins/<id>/` |

> `plugin_build` 用山海进程内已有的 esbuild/vite 构建，**不依赖用户手动 npm install / node**。
> `plugin_test_load` 全程用 mock hooks + 独立 runtime，不触达正式 `~/.shanhai/plugins/`、不注册 Dock 图标。

### 4.3 `plugin_install` 的精确顺序

1. 校验 package 存在、store 已装配（`!store` 报错）；生成持久化 id（`persistIdOf`，name 转 kebab-case，仅允许 `[a-zA-Z0-9_-]`）；
2. 若已有同 id 的已安装插件 → 先 `uninstall` 旧的（视为升级：撤销运行 + 删除旧目录含旧 dist）；
3. **部署产物**：若 `plugins/<id>/dist/` 无产物、但 `plugins-workspace/<id>/dist/` 有，自动复制（消除手动 cp）——覆盖升级时旧目录已在上一步删除，此处会正常部署新产物；
4. **探测** `entryHost` / `entryHtml`（部署后产物才可见），写回 package；
5. **校验可执行载体**：`code` / `client` / `dist/host.cjs` / `dist/client.html` 至少其一（部署后 dist 产物才参与判定），否则报错「没有可安装的代码」；
6. 若当前 package `running` → 先 `stop`；
7. `rename(dynId, persistId)` + `setSession('*')`；
8. `run(id, sessionId, { skipApproval: true })` —— **激活，且不再二次弹审批**；
9. `store.install(meta)` 落盘 `manifest.json`；
10. `setStatus('installed')`，返回 `{ id, installed: true }`。

> 顺序要点：**先 uninstall 旧的（覆盖升级）→ 部署 workspace 产物 → 探测 entryHost/entryHtml → 再做可执行载体校验**。
> 关键：`uninstall` 必须在 `deployArtifacts` **之前**——否则旧 dist 会让 deployArtifacts「已有产物即跳过」→ 新产物不部署，而随后 uninstall 又把旧 dist 整个目录删掉，最终 manifest 指向已删除文件（覆盖升级产物丢失）。

### 4.4 openWindow / closeWindow 的配对与自动撤销

- `ctx.openWindow(appId?)`：`target = appId ?? pkg.id`，调 `openAppWindow(target)`，**并 `stack.collect(() => closeAppWindow(target))`** 注册撤销。
- 因此 `plugin_stop` / `plugin_uninstall` / `plugin_test`（撤回）时，**已打开窗口自动关闭**。
- `ctx.closeWindow(appId?)`：只主动关闭、不挂撤销。
- 窗口打开是**惰性**的：`openApp` 已有则聚焦、否则创建；`closeApp` 真正 `destroy()` 窗口。
- 窗口应用注册表（主进程 `plugin-apps.ts`）：`appId → { name, clientCode, entryHtml, icon, ... }`。

> ⚠️ **坑 6**：窗口应用默认「**不自动开窗**」——脚手架模板的 host 半**不**直接调 `ctx.openWindow()`，安装/加载后由用户点 Dock 图标主动打开（`openApp → loadFile dist/client.html`）。只有插件作者**主动**在事件回调里调 `ctx.openWindow()` 才会立即开窗（会打断用户当前工作，不推荐）。

---

## 5. 落盘格式（目录型）

一个插件 = 一个目录 `~/.shanhai/plugins/<id>/`，内含 `manifest.json` + `dist/`（产物）+ 可选 `icon` / `assets` / `src` / `package.json`：

```
~/.shanhai/plugins/<id>/
├── manifest.json        # 元数据 + 权限（见下）
├── dist/
│   ├── host.cjs         # host 半编译产物（工程化）
│   ├── client.html      # client 半窗口入口（工程化）
│   └── assets/*         # client bundle（js/css 等）
├── icon.png             # 可选：Dock 图标（或 assets/icon.png）
├── assets/              # 可选：附加静态资源
├── src/                 # 可选：源码（供改后重编译）
└── package.json         # 可选：依赖声明
```

### 5.1 `manifest.json` 完整 schema（`InstalledPackageMeta`）

```ts
interface InstalledPackageMeta {
  id: string                       // 持久化 id（= 目录名）
  name: string
  purpose: string
  version?: string
  // —— 快速原型（源码字符串）——
  code?: string                    // host 半源码
  client?: string                  // client 半源码
  // —— 工程化（编译产物 + 资源）——
  entryHost?: string               // host 半产物绝对路径 dist/host.cjs
  entryHtml?: string               // client 半窗口入口绝对路径 dist/client.html
  icon?: string                    // 图标相对路径（相对插件目录）
  assets?: string[]                // 附加资源相对路径索引
  dependencies?: Record<string, string>  // 依赖声明（包名→版本，仅审计用）
  kind?: 'source' | 'bundled'      // source=快速原型，bundled=工程化（自动判定）
  installedAt: number
  permissions?: string[]           // 已审批权限清单（plugin:invoke 白名单能力名）
}
```

- 落盘权限 `0o600`；id 仅允许 `[a-zA-Z0-9_-]`，resolve 后强制校验落在仓库目录内，杜绝路径穿越。
- `uninstall` 递归删除整个 `<id>` 目录（不存在静默成功）。
- **版本号 `version`**：`plugin_define` 工具入参可选 `version`（如 `2.0.0`），`install` 时随 manifest 落盘；覆盖升级时用于标识版本（不改目录结构、不参与 id 计算）。工程化插件若只想用 `package.json` 的 version 表达，可二选一，但「install 落盘的版本」以 `plugin_define(version)` / manifest 为准。
- **向后兼容**：只有 `code`/`client`、无 `dist`/`icon` 的「旧快速原型」格式（目录里仅一个 manifest.json）仍能正常 install/restore。

---

## 6. 安全模型：插件专用 preload + 白名单 IPC

插件窗口（`type:'app'` 且 `isPluginApp`）挂**专用 preload** `plugin.cjs`（`contextIsolation:true` + `nodeIntegration:false`），暴露 `window.shanhaiPlugin` 白名单桥。所有能力统一走主进程 `plugin:invoke` 入口，按「插件 id + 能力名」**双层校验**：

1. 能力必须在全局白名单 `PLUGIN_CAPABILITIES`；
2. 插件的 `manifest.permissions[]` 声明了该能力（install 时审批）。

未声明则抛错拒绝。**默认放行的例外（无需 `permissions` 声明）**：
- `closeApp`（关闭自身窗口）：「appId 由窗口反查、无法越权关其它窗口」的无害能力，避免漏声明导致窗口无法关闭。
- `invokePluginService`（client→host RPC）：只能调「本插件」host 半注册的服务（appId 反查 + host 服务按插件 id 分组隔离），无法越权调其它插件/内核服务，属插件内部前后端通信。

**危险接口（`auth:*` / `chat:run` / `supervisor:*` / `model:switch` / `model:addCustom` / `remote:disable` / `approval:setPolicy` / `session:delete` / `settings:set` / `wallpaper:set` 等）永不进白名单，物理拿不到。**

## 7. 白名单能力清单（12 项）

| 能力 | 说明 |
|------|------|
| `getVersion` | 应用版本号 |
| `clipboardWriteText` | 写剪贴板 |
| `clipboardReadText` | 读剪贴板 |
| `speak` | 语音播报（TTS） |
| `selectDirectory` | 打开目录选择器，返回绝对路径 |
| `listSessions` | 列出用户会话（只读） |
| `listMemory` | 列出指定会话长期记忆（只读） |
| `getUiState` | 精简 UI 状态（登录态 + 用户名 + 壁纸，隔离敏感数据） |
| `closeApp` | 关闭当前插件自己的窗口（仅自身，无法越权关其它窗口）。**默认放行**：无需在 `permissions` 声明，窗口关闭按钮始终可用 |
| `getWallpaper` | 读取桌面壁纸 |
| `getTokenStats` | token 用量快照（只读） |
| `invokePluginService` | 调用本插件 host 半注册的自定义服务（client→host RPC，见 §1.3 `ctx.provide`）。入参：服务名 + 可变参数，返回值须 JSON 可序列化。**默认放行**：无需 `permissions` 声明 |

> 完整可声明清单即上述 12 项；`permissions` 缺省 = 空数组 = 最小权限。

---

## 8. 注意事项 / 坑（速查）

1. **host 半必须 `module.exports = (ctx) => disposer`**（或 `export default`），不能裸箭头函数。
2. **client 半源码字符串 `new Function` 编译、不经过 JSX**，必须 `React.createElement`（工程化 client 半用 loadFile，可写 JSX）。
3. **窗口应用形态必须 return 组件函数**，不能 return 对象/箭头函数返回对象。
4. **窗口应用形态不能 `useUIContext()`**（独立进程、不在 Provider 内），只用 `helpers`（快速原型）或 `window.shanhaiPlugin`（工程化）。
5. **UI 插槽形态的 `slots` 只有 `register` 一个方法**。
6. **窗口应用默认「不自动开窗」**，安装/加载后由用户点 Dock 图标主动打开（非自动弹出）。
7. **host 半无 `effect()`**，cleanup 只走 4 条自动撤销路径。
8. **`tools.register` 注册的是「插件工具」**：收集进插件工具 Registry，**不再作为顶层 function 暴露给模型**，由统一调度工具 `plugin_tool` 按 action 分派调用（先用 `plugin_apps` 或 `plugin_inspect` 的 `pluginTools` 字段查可用工具名，见 §9）。插件工具不再直接污染模型顶层工具表。
9. **`provide` 的函数 impl 可被 client 半 `invokePluginService` 调用**（client→host RPC，见 §7）；非函数 impl 仅 `plugin_inspect` 报告用。
10. **host 半编译产物必须自包含**，不得 external `electron` / `@shanhai/*`（越权审计拒绝加载）。
11. **client 半源码字符串跨渲染进程传输**（序列化），主进程 `plugin-apps` 维护注册表，Dock 图标经 `plugin-apps:changed` 广播刷新。
12. **`plugin_build` 产物在 workspace**，`plugin_install` 自动部署到 `plugins/<id>/dist/`（无需手动 cp）。
13. **插件窗口主题跟随**：宿主桥 `window.shanhai.onThemeChange(cb)` 订阅主进程 `ui:theme` 广播（内置应用切换亮/暗时实时下发）。**回调签名写死为 `onThemeChange(cb: (theme: 'light' | 'dark') => void)`**：cb 收到的参数是**裸字符串** `'light' | 'dark'`（不是对象，主进程 `ipc-handlers.ts` 的 `safeSend(win, 'ui:theme', theme)` 塞的就是字符串），直接 `theme === 'dark'` 判断即可，不要按对象 `{ theme }` 解包。插件窗口挂载时读 `localStorage.getItem('shanhai-theme')` 得到初始主题，`document.documentElement.setAttribute('data-theme', theme)` 驱动 CSS 变量。脚手架模板的 `style.css` 已内嵌与内置应用一致的主题变量（`--bg-subtle`/`--text-muted`/`--accent` 等），AI 生成插件开箱即随主题切换。**AI 真机自验如何切主题**：主题切换入口是「聊天窗口顶栏右侧的月亮/太阳图标按钮」（无文字、hover 提示「切换到暗色/亮色模式」）或「会话管家窗口标题栏右侧的月亮/太阳按钮」，点一下即切换亮/暗并广播给所有窗口（含插件窗口）；**无快捷键**。
14. **`ctx.on` 无可订阅内核事件**：内核事件总线零 `emit`，`ctx.on` 仅作占位能力保留。

---

## 9. 插件工具统一调度与插件应用列表

插件 host 半用 `ctx.tools.register(tool)` 注册的工具，**不再作为顶层 function 暴露给模型**，而是统一收集进「插件工具 Registry」（按工具名索引，条目含 `name / tool / pkgId / pkgName`，即来源插件 + 风险标记）。模型通过两个专用工具访问：

| 工具 | 用途 |
|------|------|
| `plugin_tool` | **统一调度入口**：`plugin_tool action=<插件工具名> args={...}`。查 Registry 找到对应插件工具并执行，返回其结果；找不到给明确报错（含当前已注册的插件工具清单）。**动态风险**：`resolveRisk` 按具体插件工具的 `riskLevel` / `approvalRequired` 转发，审批粒度与直接调用该工具一致。 |
| `plugin_apps` | **列出所有已安装插件应用**：返回 `id / name / purpose / version / hasWindow / kind / services / tools`。`kind` 区分「有窗口的应用插件（`app`，`hasWindow=true`）」与「纯工具插件（`tool`，`hasWindow=false`）」。拿到列表后：用 `plugin_tool` 调插件的工具，或对「有窗口的应用插件」用 computer_use / browser_use 做 UI 自动化操作。 |

**关键语义（避免 AI 搞错）：**

1. **Registry 生命周期**：插件 `run` 时 `ctx.tools.register` 收集进 Registry，`plugin_stop` / `plugin_uninstall` / `plugin_undefine` / `plugin_test`（撤回阶段）时自动移除对应工具——卸载后 `plugin_tool` 再调它会报「插件工具不存在」。
2. **不进顶层工具表**：插件工具不再 `push` 进全局 `ctx.tools`，模型顶层 function 里看不到 `kanban_export_markdown` 这类插件工具名，只能看到 `plugin_tool` / `plugin_apps`。已装插件越多，顶层工具表**不膨胀**（这是本机制的目的：把「每装一个插件顶层 +N 个工具」收敛为「固定 +2 个调度工具」）。
3. **管家 vs 普通会话**：`plugin_tool` / `plugin_apps` 是普通会话工具（进 `ctx.tools`）；管家会话用 `supervisorLoopTools` 白名单，默认**不**含插件工具（如需管家也能调，需另确认）。
4. **查询入口**：插件工具名经 `plugin_inspect` 的 `pluginTools` 字段、或 `plugin_apps` 的 `tools` 字段暴露，AI 调用前先查清单。

