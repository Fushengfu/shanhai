# 山海「插件应用」体系升级 —— 需求分析与技术方案设计

> 阶段：方案设计（未改运行逻辑代码）。结论均来自对当前源码的真实阅读。

## 关键事实纠正

任务背景称「插件窗口拿不到 preload 桥」——当前源码下不成立。

- `window-manager.ts` 的 `createWindow()` 里，所有窗口类型共用一个 preload（`../preload/index.cjs`）。
- preload 用 `contextBridge.exposeInMainWorld('shanhai', bridge)` 全量暴露 `ShanhaiBridge`（100+ 方法）。
- 插件窗口是 `openApp(插件id)` → `createWindow({ type:'app', appId })` 建的，已挂完整 preload，`window.shanhai` 可访问。

真实缺口三点：
1. `DynamicPluginWindow` 编译 client 半只注入 `React + {close,appId,name}`，未显式传桥、未文档化。
2. 无白名单 = 越权风险（插件可调 chat:run/auth:logout/remote:disable 等全部接口）。
3. client 半是 `new Function` 源码字符串，无依赖无编译，做不了复杂界面。

本质：插件窗口与内置 app 窗口在「窗口创建 + preload」完全同构，唯一区别是内容来源（字符串 vs 编译产物）。

## 现状架构

### 插件窗口创建链路
```
host ctx.openWindow → SelfModifyRuntime.facade → hooks.openAppWindow
  → runtime.openAppWindow → push.ts onOpenPluginApp → window-manager.openApp
  → createWindow({type:'app',appId}) → loadWindowContent → showWindow
```
Dock 图标点击 → `DockApp.window.shanhai.openApp(appId)` → IPC window:openApp → openApp（单实例复用）。

### 内容渲染链路
```
AppWindow({appId}) → window.shanhai.getPluginApp(appId)（IPC plugin-app:get）
  → 主进程 plugin-apps.ts getPluginApp（内存 Map）
  → { appId, name, clientCode }
  → DynamicPluginWindow → new Function('React','helpers',clientCode) → 渲染
```

### preload 桥
- 文件 `apps/desktop/src/preload/index.ts` → `index.cjs`，`exposeInMainWorld('shanhai', bridge)`，全量无裁剪。
- 内置 app 窗口用法：CustomModelDrawer 调 addCustomModel、TracePanel 调 onDelta 等。

### 主进程 IPC handler 清单（ipc-handlers.ts）
- 认证 / 会话 / 审批 / 聊天 / 管家 / 模型 / 语音 / 远程 / 壁纸 / 窗口 / 记忆 / 设置 / 终端 / 剪贴板 / 目录 / 文件 / 更新等 20+ 域。
- 适合开放给插件：只读 + 自身窗口域 + 无害（speak、clipboard、selectDirectory、getVersion、listSessions、readMemory、openApp/closeApp 自身等）。
- 高危不可开：auth:login/logout/register、chat:run、supervisor:*、model:switch、remote:disable、approval:setPolicy、session:delete、settings:set 等。

### 插件包结构 / 落盘
- 内存态 DynamicPackage：{ id, name, purpose, code?, client?, version?, status, sessionId, capabilities? }。
- 持久化 InstalledPackageMeta（manifest.json）：{ id, name, purpose, version?, code?, client?, installedAt }，权限 0o600，防路径穿越。
- 无产物/资源/权限/依赖字段。

### plugin_* 工具现状
- define（记录不运行）/ run（vm host + 投递 client 带审批）/ stop / undefine / test（临时跑撤回，非真测试）/ install（持久化激活）/ uninstall / inspect。
- 缺：编译 / 真测试 / 测试加载 / 验证 / 脚手架。

## 目标架构（推荐方案）

### 插件包结构（目录型）
```
~/.shanhai/plugins/<id>/
├── manifest.json        # 元数据 + 权限声明
├── dist/host.cjs        # host 半（主进程，可 require 依赖）
├── dist/client.js       # client 半（渲染进程，完整 React）
├── dist/client.html     # 插件窗口入口（loadFile）
├── dist/assets/         # 图标/静态资源
├── src/host.ts + client.tsx   # 源码（可选）
└── package.json         # 依赖声明（可选）
```
manifest 扩展字段：kind、entry{host,client}、permissions[]、icon、dependencies。

### preload + 安全隔离
- 插件 app 窗口挂专用 preload（`preload/plugin.cjs`），暴露精简 `window.shanhaiPlugin`。
- 统一入口 `plugin:invoke`（插件 id + 能力名双层校验），白名单由 permissions 决定，install 时审批。
- 隔离：专用 preload + contextIsolation + nodeIntegration:false；危险接口永不进白名单。

### 脚手架
- 内置模板（随包分发）+ `plugin_scaffold` 工具，生成可编译项目到 `~/.shanhai/plugins-workspace/<id>/`。

### 完整流水线（内置）
```
编写 src → 编译（esbuild bundle host.cjs + client.js）
  → 测试 → 测试加载（临时目录，不污染正式 plugins/）
  → 验证（GUI 截图 OCR）→ 安装（拷贝产物 + 写 manifest + 审批 + 激活）
```
- 产物：独立构建产物（host require(dist/host.cjs)，client loadFile(dist/client.html)）。
- 与现有链路关系：兼容 + 新增「工程化链路」；快速原型链路保留。

## 分阶段实施计划
1. 插件专用 preload + 白名单 IPC（安全底座）
2. client 半改独立构建产物 + loadFile（复杂界面）
3. host 半改 require(dist/host.cjs)（依赖 + 重新隔离）
4. 扩展 manifest + PluginStore 支持目录型包
5. 脚手架：模板 + plugin_scaffold
6. 流水线：plugin_build / plugin_test_load / plugin_verify
7. 协议/文档/工具描述同步

## 决策点（待用户拍板）
1. 插件形态：独立构建产物（推荐） vs 源码字符串
2. 公开接口：插件专用白名单 API（推荐） vs 全量复用现有桥 + 过滤
3. 流水线：内置（推荐） vs 独立 CLI
4. host 半：脱离 vm 沙箱改 require（推荐，但需重设计隔离） vs 保留 vm
5. 插件市场/远程分发：本次可不做，version 字段已预留
