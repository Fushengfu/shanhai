# 插件应用模板（Plugin App Template）

山海「插件应用」的**手写示例模板**（升级方案第 5 步）。

> 权威源说明：`plugin_scaffold` 工具的内置模板（运行时真正使用的）在
> `packages/selfmod/src/scaffold.ts` 的 `SCAFFOLD_FILES` 常量里（随包分发）。
> 本目录是「可独立构建/预览的手写示例」，两者内容保持一致——改任一处请同步另一处。

## 这是什么

一个**独立渲染产物**的插件窗口模板。插件作者用完整 React + JSX 开发复杂界面，
构建后得到 `dist/host.cjs`（host 半）+ `dist/client.html` + `dist/assets/*`（client 半），
放入插件落盘目录后，山海主进程：
- `openApp` 检测到 `dist/client.html` 就用 `loadFile` 加载它（不再是 `new Function` 源码字符串）；
- `loadHostEntry` require `dist/host.cjs`（host 半编译产物，可 require 第三方依赖）。

## 目录结构

```
plugin-template/
├── src/
│   ├── host.ts            # host 半（主进程侧）：module.exports = (ctx) => disposer
│   ├── main.tsx           # client 半入口（React 挂载）
│   ├── App.tsx            # 根组件（多个子组件 + 状态 + 样式 + 调白名单桥）
│   ├── style.css          # 样式
│   └── shanhai-plugin.d.ts # window.shanhaiPlugin 白名单桥类型声明
├── client.html            # 窗口入口 HTML（vite 输入，loadFile 加载）
├── vite.config.ts         # client 半构建配置（base './' + 入口 client.html）
├── tsconfig.json          # 独立类型检查
├── package.json           # 依赖声明 + build 脚本
└── README.md
```

## 怎么构建

```bash
# 方式一：在本目录独立构建（需先 npm install）
cd apps/desktop/plugin-template
npm install
npm run build

# 方式二：复用 workspace 的依赖（在 apps/desktop 下执行）
pnpm --filter @shanhai/desktop exec vite build --config plugin-template/vite.config.ts
pnpm --filter @shanhai/desktop exec esbuild plugin-template/src/host.ts --bundle --platform=node --format=cjs --outfile=plugin-template/dist/host.cjs
```

产物：

```
dist/host.cjs          # host 半（自包含 bundle，可 require 第三方依赖）
dist/client.html       # client 半窗口入口（loadFile 加载）
dist/assets/*          # client bundle（js/css，自包含）
```

## 怎么安装到插件包

构建后把 `dist/` 内容复制到插件落盘目录：

```
~/.shanhai/plugins/<插件id>/dist/host.cjs
~/.shanhai/plugins/<插件id>/dist/client.html
~/.shanhai/plugins/<插件id>/dist/assets/*
```

主进程 `openApp(<插件id>)` 检测到 `dist/client.html` 即走独立渲染入口；
`loadHostEntry` 检测到 `dist/host.cjs` 即 require host 半编译产物。

## host 半契约（src/host.ts）

```ts
// 必须 module.exports = (ctx) => disposer（不能写成裸箭头函数）
module.exports = (ctx) => {
  // ctx.openWindow()               // 打开本插件独立窗口（默认「不自动开窗」，用户点 Dock 图标主动打开）
  ctx.on('event:name', (p) => {})  // 订阅内核事件（撤销时自动取消订阅）
  ctx.provide('svc:name', {})      // 注册命名服务（plugin_inspect 可查）
  ctx.tools.register({ name, description, inputSchema, execute })  // 注册全局工具
  return () => {}                  // disposer：卸载/停止时调用
}
```

`ctx` 五条能力：`on` / `provide` / `tools.register` / `openWindow` / `closeWindow`。
disposer 可为 函数 / null / 数组 / Promise（撤销时逆序调用）。

## 插件能调什么（白名单桥）

窗口里通过 `window.shanhaiPlugin` 调用山海公开接口，当前白名单（第 1 步就绪）：

- `getVersion()` / `getUiState()` / `getWallpaper()` / `getTokenStats()`
- `listSessions()` / `listMemory(sessionId)`
- `clipboardWriteText(text)` / `clipboardReadText()`
- `speak(text)` / `selectDirectory(defaultPath?)`
- `closeApp()`（仅关闭自身窗口）

每个方法都经主进程 `plugin:invoke` 按「插件 id + 能力名」双层校验，
插件 manifest 的 `permissions[]` 声明了对应能力才会放行（未声明则抛错）。

## 注意

- 本入口跑在独立 app 渲染进程、挂插件专用 preload（plugin.cjs），
  只有 `window.shanhaiPlugin`（白名单）+ `window.shanhai`（宿主桥，仅 getPluginApp/closeApp），
  没有 chat 窗口的 `useUIContext` / `SlotRegistry`，也拿不到全量 `window.shanhai`。
- 无编译产物时，窗口自动降级走旧链路（renderer/index.html → AppWindow → DynamicPluginWindow new Function），
  快速原型链路不受影响。
