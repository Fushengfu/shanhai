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
| `ctx.on` | `(name, listener) => void` | 订阅内核事件总线，返回无 | ✅ 撤销时自动 off |
| `ctx.provide` | `(name, impl) => void` | 注册命名服务到内存 map（当前仅被 `plugin_inspect` 报告，无服务发现/注入消费） | ✅ 撤销时自动删除 |
| `ctx.tools.register` | `(tool: ToolContract) => void` | 向全局工具表注册一个 model-facing 工具 | ✅ 撤销时自动移除 |
| `ctx.openWindow` | `(appId?: string) => void` | 打开本插件的窗口应用（`appId` 缺省 = 插件 id） | ✅ 撤销时自动关闭该窗口 |
| `ctx.closeWindow` | `(appId?: string) => void` | 显式关闭本插件的窗口应用（`appId` 缺省 = 插件 id） | ❌ 主动关闭，不挂撤销 |

> ⚠️ **刻意不暴露 `effect()`**：host 半的 cleanup 只能走上面 4 条自动撤销路径（`on`/`provide`/`tools.register`/`openWindow`）。

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
  - `window.shanhai`（宿主桥，**极度缩小**：仅 `windowType`/`platform`/`windowAppId`/`getPluginApp`/`closeApp`，无任何危险接口）。
- 构建配置要求：`base: './'`（Electron `loadFile(file://)` 下资源必须相对路径）。

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

1. 校验 package 存在、有可执行载体（`code`/`client`/`dist/host.cjs`/`dist/client.html` 至少其一）、store 已装配；
2. 用 `persistIdOf(name, persistId)` 生成持久化 id（name 转 kebab-case，仅允许 `[a-zA-Z0-9_-]`，否则报错）；
3. **部署产物**：若 `plugins/<id>/dist/` 无产物、但 `plugins-workspace/<id>/dist/` 有，自动复制（消除手动 cp）；
4. 探测 `entryHost` / `entryHtml`，写回 package；
5. 若已有同 id 的已安装插件 → 先 `uninstall` 旧的（视为升级）；
6. 若当前 package `running` → 先 `stop`；
7. `rename(dynId, persistId)` + `setSession('*')`；
8. `run(id, sessionId, { skipApproval: true })` —— **激活，且不再二次弹审批**；
9. `store.install(meta)` 落盘 `manifest.json`；
10. `setStatus('installed')`，返回 `{ id, installed: true }`。

### 4.4 openWindow / closeWindow 的配对与自动撤销

- `ctx.openWindow(appId?)`：`target = appId ?? pkg.id`，调 `openAppWindow(target)`，**并 `stack.collect(() => closeAppWindow(target))`** 注册撤销。
- 因此 `plugin_stop` / `plugin_uninstall` / `plugin_test`（撤回）时，**已打开窗口自动关闭**。
- `ctx.closeWindow(appId?)`：只主动关闭、不挂撤销。
- 窗口打开是**惰性**的：`openApp` 已有则聚焦、否则创建；`closeApp` 真正 `destroy()` 窗口。
- 窗口应用注册表（主进程 `plugin-apps.ts`）：`appId → { name, clientCode, entryHtml, icon, ... }`。

> ⚠️ **坑 6**：`ctx.openWindow()` 在 `run` 阶段被调用，`plugin_install` / `plugin_run` 一执行完窗口**已弹出**（非「点 Dock 图标才开窗」）。若产品预期「点 Dock 才开窗」，host 半不要在 `run` 阶段直接调 `openWindow`。

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
- **向后兼容**：只有 `code`/`client`、无 `dist`/`icon` 的「旧快速原型」格式（目录里仅一个 manifest.json）仍能正常 install/restore。

---

## 6. 安全模型：插件专用 preload + 白名单 IPC

插件窗口（`type:'app'` 且 `isPluginApp`）挂**专用 preload** `plugin.cjs`（`contextIsolation:true` + `nodeIntegration:false`），暴露 `window.shanhaiPlugin` 白名单桥。所有能力统一走主进程 `plugin:invoke` 入口，按「插件 id + 能力名」**双层校验**：

1. 能力必须在全局白名单 `PLUGIN_CAPABILITIES`；
2. 插件的 `manifest.permissions[]` 声明了该能力（install 时审批）。

未声明则抛错拒绝。**危险接口（`auth:*` / `chat:run` / `supervisor:*` / `model:switch` / `model:addCustom` / `remote:disable` / `approval:setPolicy` / `session:delete` / `settings:set` / `wallpaper:set` 等）永不进白名单，物理拿不到。**

## 7. 白名单能力清单（11 项）

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
| `closeApp` | 关闭当前插件自己的窗口（仅自身，无法越权关其它窗口） |
| `getWallpaper` | 读取桌面壁纸 |
| `getTokenStats` | token 用量快照（只读） |

> 完整可声明清单即上述 11 项；`permissions` 缺省 = 空数组 = 最小权限。

---

## 8. 注意事项 / 坑（速查）

1. **host 半必须 `module.exports = (ctx) => disposer`**（或 `export default`），不能裸箭头函数。
2. **client 半源码字符串 `new Function` 编译、不经过 JSX**，必须 `React.createElement`（工程化 client 半用 loadFile，可写 JSX）。
3. **窗口应用形态必须 return 组件函数**，不能 return 对象/箭头函数返回对象。
4. **窗口应用形态不能 `useUIContext()`**（独立进程、不在 Provider 内），只用 `helpers`（快速原型）或 `window.shanhaiPlugin`（工程化）。
5. **UI 插槽形态的 `slots` 只有 `register` 一个方法**。
6. **`openWindow` 在 `run` 阶段即开窗**，install 时窗口立即弹出（非点击 Dock 才开）。
7. **host 半无 `effect()`**，cleanup 只走 4 条自动撤销路径。
8. **`tools.register` 注册的是全局工具**（非会话隔离）。
9. **`provide` 的服务仅 `plugin_inspect` 报告用**，目前无服务发现/注入机制消费它。
10. **host 半编译产物必须自包含**，不得 external `electron` / `@shanhai/*`（越权审计拒绝加载）。
11. **client 半源码字符串跨渲染进程传输**（序列化），主进程 `plugin-apps` 维护注册表，Dock 图标经 `plugin-apps:changed` 广播刷新。
12. **`plugin_build` 产物在 workspace**，`plugin_install` 自动部署到 `plugins/<id>/dist/`（无需手动 cp）。
