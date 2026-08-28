# 山海插件协议规范（权威版）

> 本文是山海 AI「插件（selfmod / K5 自修改）」的**权威、唯一、机器可读**协议规范。
> 它由源码真实契约梳理而成，AI 开发插件前**必须先读本文，禁止靠猜或试错**。
> 若本文与工具描述文字冲突，以本文为准；若本文与源码实现冲突，以源码为准并回读本文修正。

- 源码锚点（grep 定位用）：
  - `packages/selfmod/src/selfmod.ts` —— host 半契约 `HostFacade`、生命周期 `SelfModifyRuntime`
  - `packages/kernel/src/selfmod/inventory.ts` —— `DynamicPackage`、`InstalledPackageMeta`、`PluginStore`（落盘）
  - `packages/kernel/src/runtime/dispose.ts` —— `DisposerStack`（disposer 收集/撤销）
  - `packages/kernel-modules/src/client/slot.ts` —— `CORE_SLOTS`（UI 插槽清单）
  - `apps/desktop/src/renderer/App.tsx` —— client 半 UI 插槽形态的执行/卸载
  - `apps/desktop/src/renderer/app/AppWindow.tsx` —— client 半窗口应用形态的编译/渲染
  - `apps/desktop/src/main/plugin-apps.ts` / `push.ts` —— 窗口应用注册表 + Dock 图标广播
  - `apps/runtime/src/bootstrap.ts` —— `SelfModifyHooks` 的实现装配

---

## 1. 核心概念

一个「插件」= 一个 **动态 package（DynamicPackage）**，由两段**源码字符串**组成（可只提供其一）：

| 半 | 运行环境 | 契约入口 | 用途 |
|----|----------|----------|------|
| host 半（`code`） | 进程内（Node `vm` 沙箱） | `module.exports = (ctx) => disposer` | 注册服务/事件/工具、开/关窗口 |
| client 半（`client`） | 浏览器渲染进程（`new Function` 编译） | 见 §3 两种形态 | 挂 UI 组件（插槽）或渲染独立窗口 |

- 动态 package 默认**仅内存态**：`plugin_define` 只记录不落盘；只有 `plugin_install` 才落盘持久化。
- 会话隔离：`plugin_define` 产生的 package 归当前会话所有；`plugin_install` 后 `sessionId` 置为 `'*'`（全局）。

`DynamicPackage` 字段（`packages/kernel/src/selfmod/inventory.ts`）：

```ts
interface DynamicPackage {
  id: string          // define 时生成 'dyn-<n>'，install 后改为持久化 id
  name: string
  purpose: string
  code?: string       // host 半源码
  client?: string     // client 半源码
  version?: string
  status: 'defined' | 'running' | 'stopped' | 'installed'
  sessionId: string
}
```

---

## 2. host 半契约

### 2.1 入口：必须 `module.exports = (ctx) => disposer`

host 半在 `node:vm` 沙箱内执行，沙箱只注入 `module` / `exports` 两个对象：

```js
// evalHostCode 的真实沙箱：
const sandbox = { module: { exports: {} }, exports: {} }
```

执行后取 `sandbox.module.exports`，**必须是函数**，否则抛错：

```
host 半代码必须导出函数：(ctx) => disposer
```

> ⚠️ **坑 1**：host 半**必须**写成 `module.exports = (ctx) => {...}` 或 `module.exports = function (ctx) {...}`。
> 裸箭头函数 `(ctx) => {...}`（没有 `module.exports =`）会因 `module.exports` 为空对象而报错。

### 2.2 `ctx` 提供的能力（`HostFacade`，逐条）

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
| `ctx.on` | `(name, listener) => void` | 订阅内核事件总线（`kernel.ctx.on`），返回无 | ✅ 撤销时自动 off |
| `ctx.provide` | `(name, impl) => void` | 注册一个命名服务到内存 map（当前仅被 `plugin_inspect` 报告，无服务发现/注入消费） | ✅ 撤销时自动删除 |
| `ctx.tools.register` | `(tool: ToolContract) => void` | 向全局工具表注册一个 model-facing 工具 | ✅ 撤销时自动移除 |
| `ctx.openWindow` | `(appId?: string) => void` | 打开本插件的窗口应用（`appId` 缺省 = 插件 id） | ✅ 撤销时自动关闭该窗口 |
| `ctx.closeWindow` | `(appId?: string) => void` | 显式关闭本插件的窗口应用（`appId` 缺省 = 插件 id） | ❌ 主动关闭，不挂撤销 |

> ⚠️ **刻意不暴露 `effect()`**：host 半的 cleanup 只能走上面 4 条自动撤销路径（`on`/`provide`/`tools.register`/`openWindow`），
> 从机制上杜绝「裸副作用」导致插件无法热插拔。

`ctx.tools.register` 的 `ToolContract`（`packages/tools/src/tools.ts`）：

```ts
interface ToolContract {
  name: string
  description: string                          // 隐式 prompt：何时用/参数含义/返回什么
  inputSchema: Record<string, unknown>         // JSON Schema（object）
  riskLevel: 'readonly' | 'reversible' | 'irreversible' | 'high'
  approvalRequired?: boolean
  timeoutMs?: number                           // Infinity = 不超时（等用户交互）
  guide?: ToolGuide                            // 工具使用手册条目
  resolveRisk?: (args) => { riskLevel; approvalRequired?; outsideWorkdir? }
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>
}
```

### 2.3 disposer 的合法形式

`(ctx) => disposer` 的返回值交给 `DisposerStack.collect`，支持四种形式（`dispose.ts`）：

1. **函数** `() => void` 或 `() => Promise<void>` —— 撤销时调用；
2. **`null` / `undefined`** —— 无副作用，忽略；
3. **Iterable / AsyncIterable**，逐个 yield disposer；
4. **Promise<disposer>**。

disposer 在 `plugin_stop` / `plugin_uninstall` / `plugin_undefine` / `plugin_test`（撤回阶段）时**逆序**全部调用，单个失败不阻断其余。

---

## 3. client 半契约（两种形态，二选一）

client 半代码在浏览器里用 `new Function(...)` 编译，**不经过 JSX 编译**。
> ⚠️ **坑 2**：写组件**必须用 `React.createElement(...)`，禁止写 `<div>` 这类 JSX 语法**（否则 `new Function` 直接语法报错）。

### 3.1 形态 A：UI 插槽形态（默认，投递到聊天窗口）

编译方式（`App.tsx` `mountClientCode`）：

```js
new Function('React', 'slots', 'useUIContext', code)
factory(React, slotsForPkg, useUIContext)
```

三个入参：

| 参数 | 类型/值 | 说明 |
|------|---------|------|
| `React` | React 命名空间 | 用 `React.createElement` 建元素 |
| `slots` | `{ register(reg) => dispose }` | **只有 `register` 一个方法**，不是完整 SlotRegistry |
| `useUIContext` | `() => UIContextValue` | 在组件内读取框架派生的应用状态 |

`slots.register` 的参数：

```ts
slots.register({ slot: string, id: string, component: React.ComponentType }): () => void
// slot:      目标插槽名（见 §4）
// id:        本包内的注册 id（会拼成 `${pkgId}:${id}`）
// component: React 函数组件（内部可调 useUIContext()）
```

返回的 `factory(...)` 结果若是函数，会作为该包的 browser 半 disposer 存起来（卸载时调用）。

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

### 3.2 形态 B：窗口应用形态（配合 host 半 `openWindow`）

编译方式（`AppWindow.tsx` `DynamicPluginWindow`）：

```js
new Function('React', 'helpers', clientCode)
const result = factory(React, { close: onClose, appId, name })
```

`helpers` 三个字段：

```ts
helpers = {
  close: () => void,   // 调用 window.shanhai.closeApp(appId)，关闭本窗口
  appId: string,       // 插件持久化 id（窗口 appId）
  name: string,        // 插件 name
}
```

> ⚠️ **坑 3**：**必须 `return` 一个 React 组件函数**（`function XxxWindow() {...}`），
> 不能 `return` 一个对象、也不能写「箭头函数直接返回对象」。
> 若 `factory` 返回的不是函数，窗口会显示「插件未提供窗口界面」占位。

> ⚠️ **坑 4**：窗口应用形态的 client 半在**独立 app 渲染进程**执行，**不在 `UIContext.Provider` 内**，
> 因此**不能调 `useUIContext()`**，只能通过 `helpers.close` / `helpers.appId` / `helpers.name` 拿信息。

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

---

## 4. UI 插槽清单（`CORE_SLOTS`）

`packages/kernel-modules/src/client/slot.ts` 定义，`plugin_inspect` 通过 `listSlots()` 向 agent 暴露。

**覆盖型**（`SlotView` 取「最后注册」渲染，后注册覆盖、注销回退，用于「整体替换某区块」）：

```
shell.sidebar    shell.header      shell.chat        shell.composer
shell.statusbar  shell.terminal    shell.welcome     shell.panels
shell.overlays   dynamic-extension
```

**追加型**（`AppendSlotView` 把「全部注册」依次渲染、互不覆盖，用于「加按钮/小组件」）：

```
composer.below   composer.actions  header.actions    chat.below
```

> ⚠️ **坑 5（历史缺口，现已修复）**：`shell.terminal` 之前被内置插件注册（`TerminalPlugin.tsx`）并在 `App.tsx` 消费，
> 但曾一度漏在 `CORE_SLOTS` 之外，导致 agent 通过 `plugin_inspect` 看不到这个可挂载 slot。
> 现版本已把 `shell.terminal` 补进 `CORE_SLOTS`。

---

## 5. 生命周期（define → test → install → run/stop → uninstall）

状态机：`defined` → `running` → `stopped` → `installed`。

| 工具 | 做什么 | status 变化 | 是否落盘 |
|------|--------|-------------|----------|
| `plugin_define` | 记录 package（不语法检查、不运行），返回 `dyn-<n>` id | → `defined` | 否 |
| `plugin_run` | vm 评估 host 半 + 投递 client 半（有 client 时 **round-trip 审批**） | → `running` | 否 |
| `plugin_stop` | 撤销 host 半（disposer）+ browser 半（removeClient），定义保留 | → `stopped` | 否 |
| `plugin_undefine` | `stop` 后遗忘定义 | 移除 | 否 |
| `plugin_test` | 幂等「撤回 → 运行 → 撤回」，返回 `{ ok, clientDelivered }` | 不变 | 否 |
| `plugin_install` | 见下 | → `installed` | ✅ |
| `plugin_uninstall` | disposer + removeClient + 删落盘文件 | 移除 | 删文件 |
| 启动 `restoreAll` | 加载所有已安装插件并重新激活（免审批） | → `installed` | 读文件 |

### 5.1 `plugin_install` 的精确顺序

1. 校验 package 存在、有 code/client、store 已装配；
2. 用 `persistIdOf(name, persistId)` 生成持久化 id（name 转 kebab-case，仅允许 `[a-zA-Z0-9_-]`，否则报错）；
3. 若已有同 id 的已安装插件 → 先 `uninstall` 旧的（视为升级）；
4. 若当前 package `running` → 先 `stop`（用旧 id 正确卸载 client）；
5. `rename(dynId, persistId)` + `setSession('*')`；
6. `run(id, sessionId, { skipApproval: true })` —— **激活，且不再二次弹审批**（install 工具顶层已审批）；
7. `store.install(meta)` 落盘 `manifest.json`；
8. `setStatus('installed')`，返回 `{ id, installed: true }`。

### 5.2 openWindow / closeWindow 的配对与自动撤销

- `ctx.openWindow(appId?)`：`target = appId ?? pkg.id`，调 `openAppWindow(target)`，**并 `stack.collect(() => closeAppWindow(target))`** 注册撤销。
- 因此：`plugin_stop` / `plugin_uninstall` / `plugin_test`（撤回）时，**已打开的窗口会被自动关闭**（closeWindow 撤销路径）。
- `ctx.closeWindow(appId?)`：`closeAppWindow(appId ?? pkg.id)`，只主动关闭、不挂撤销。
- 窗口打开是**惰性**的：`openApp` 已有则聚焦、否则创建；`closeApp` 真正 `destroy()` 窗口。
- 窗口应用注册表（主进程 `plugin-apps.ts`）：`appId → { name, clientCode }`，client 半源码字符串天然可跨渲染进程传输。

> ⚠️ **坑 6**：`ctx.openWindow()` 是在 `run` 阶段被调用的，因此 `plugin_install` / `plugin_run` 一执行完，窗口就**已经弹出**了，而不是「装完只挂 Dock 图标、点图标才开窗」。若产品预期是「点击 Dock 图标才开窗」，则 host 半**不要**在 `run` 阶段直接调 `openWindow`，而应把开窗交给 Dock 图标点击触发的 `openApp` 链路。

---

## 6. 落盘格式（`~/.shanhai/plugins/<id>/manifest.json`）

`PluginStore.install` 落盘，权限 `0o600`，目录 `<id>` 与 id 同名。

```json
{
  "id": "todo-list",
  "name": "待办清单",
  "purpose": "在聊天窗口加一个待办小组件",
  "version": "1.0.0",
  "code": "module.exports = (ctx) => { ... }",
  "client": "function (React, slots, useUIContext) { ... }",
  "installedAt": 1720000000000
}
```

对应 `InstalledPackageMeta`：

```ts
interface InstalledPackageMeta {
  id: string
  name: string
  purpose: string
  version?: string
  code?: string      // host 半
  client?: string    // client 半
  installedAt: number
}
```

- 安全：id 仅允许 `[a-zA-Z0-9_-]`，且 resolve 后强制校验落在仓库目录内，杜绝路径穿越。
- `uninstall` 删除整个 `<id>` 目录（不存在静默成功）。

---

## 7. 注意事项 / 坑（速查）

1. **host 半必须 `module.exports = (ctx) => disposer`**，不能裸箭头函数。
2. **client 半 `new Function` 编译，不经过 JSX**，必须 `React.createElement`。
3. **窗口应用形态必须 return 组件函数**，不能 return 对象/箭头函数返回对象。
4. **窗口应用形态不能 `useUIContext()`**（独立进程、不在 Provider 内），只用 `helpers`。
5. **UI 插槽形态的 `slots` 只有 `register` 一个方法**。
6. **`openWindow` 在 `run` 阶段即开窗**，install 时窗口立即弹出（非点击 Dock 才开）。
7. **host 半无 `effect()`**，cleanup 只走 4 条自动撤销路径。
8. **`tools.register` 注册的是全局工具**（`ctx.tools.push`），非会话隔离。
9. **`provide` 的服务仅 `plugin_inspect` 报告用**，目前无服务发现/注入机制消费它。
10. client 半源码字符串跨渲染进程传输（序列化），主进程 `plugin-apps` 维护 `appId → { name, clientCode }`，Dock 图标经 `plugin-apps:changed` 广播刷新。
