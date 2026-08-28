# 山海

> 通用桌面端多 Agent 智能体 —— 自研插件内核，接口对齐 DSH（DeepSeek Hub）。

山海是一个运行在 macOS 桌面的智能体应用：多专家编排、真实工具执行、会话级隔离、可自我升级。后端内核自研（接口对齐 DSH 的 `ctx`/`inject`/`effect`/`slots`/`fiber` 语义），前端用 Electron + React 渲染，另配 Flutter 移动端。

## 功能

- **账号密码登录**：对接会员网关 `<YOUR_GATEWAY_DOMAIN>`（密码 SHA-256 加密），登录后拉取网关模型列表，也支持接入自定义 OpenAI 兼容端点
- **多专家编排**：Triage 任务拆解 + 专家 Agent 池（ReAct 循环），真实调用工具执行任务
- **会话管家（Supervisor）调度**：一个独立常驻的「管家」超级会话，统一监控/转发所有用户会话——查看各会话状态（busy/模型/审批策略/当前需求/已执行步数/上下文占用）、向任意会话转发消息、切换任意会话的模型与安全模式
- **工具执行**：读/写文件、执行命令（含超时进程组回收）、电脑操作（截图/OCR/键鼠 CGEvent）、内置浏览器自动化、持久终端
- **插件系统（K5 自修改）**：聊天式自我升级——`plugin_*` 工具链（define/run/stop/undefine/test/install/uninstall/scaffold/build/test_load/verify/inspect）+ 统一调度入口 `plugin_tool` + 应用列表 `plugin_apps`，插件工具经 Registry 集中管控、不污染顶层工具表；界面可热更新
- **技能与 MCP**：复合技能（内置 + `~/.shanhai/skills` 用户技能目录）+ MCP 客户端接入外部工具（`~/.shanhai/mcp.json`）
- **安全**：危险操作审批（会话级隔离）、写文件前快照回滚、能力清单强制
- **会话**：多会话并行、事件日志持久化、断点续跑、工作目录隔离、输入草稿隔离
- **长期记忆**：跨会话记忆（配置型 + 经验型）+ 记忆面板
- **上下文压缩**：token 预算超限自动压历史为摘要
- **语音**：TTS（macOS say）+ 麦克风录音识别
- **常驻托盘**：关闭窗口最小化到系统托盘，全局快捷键（⌘+Shift+Space）唤出/隐藏窗口
- **云存储上传**：走网关 upload-token，返回 https 链接
- **DeepSeek 桥接**：把已登录的 DeepSeek 网页版封装成 OpenAI 兼容 `/v1/chat/completions`

## 插件生态

插件由「插件协议规范」（`docs/plugin-protocol.md`）驱动，分「窗口应用」与「纯工具」两类，均经 `plugin_*` 工具链开发、`plugin_install` 安装后跨会话/跨重启留存。当前已装示例插件：

| 插件 | 版本 | 形态 | 能力 |
|------|------|------|------|
| kanban-board | 2.2.0 | 窗口应用 | 多列任务看板：增删改查、搜索/筛选/排序、拖拽换列、本地持久化、Markdown 导出、图表可视化，明暗双主题 + 主题跟随；host 半提供 `kanban_export_markdown` / `kanban_chart_stats` 工具（经 `plugin_tool` 调用） |
| product-catalog | 1.0.0 | 窗口应用 | 左右两栏商品目录：列表 + 详情联动、localStorage 持久化、主题跟随；host 半提供 `product_catalog_stats` 统计工具（数据桥） |

## 目录结构

```
shanhai/
├── apps/
│   ├── desktop/                  # Electron 桌面端（主/预加载/渲染三进程）
│   │   ├── src/main/             #   主进程：index + runtime + ipc-handlers + push + browser
│   │   ├── src/preload/          #   contextBridge 白名单桥
│   │   ├── src/host/             #   boot host + RPC 分发
│   │   └── src/renderer/         #   React 渲染进程（App.tsx 组合根 + components/ 拆分）
│   ├── mobile/                   # Flutter 移动端（Android）
│   └── runtime/                  # host 运行时（bootstrap 装配 + cli + supervisor 管家 + prompts）
├── packages/
│   ├── kernel/                   # 内核（K1 组合运行时 + K2 版本 + K4 安全）
│   ├── kernel-modules/           # 模块系统（K3，双端）
│   ├── selfmod/                  # K5 自修改（plugin_* 工具链 + vm 沙箱 + 插件协议）
│   ├── agent/                    # AgentLoop + Triage 编排
│   ├── session/                  # 会话（类型化事件日志）
│   ├── approval/                 # 审批
│   ├── tools/                    # 原子工具（read/write/run_command + utility）
│   ├── ask/                      # 向用户提问（ask_user 工具）
│   ├── llm/                      # Model 接口 + provider 适配
│   ├── memory/                   # 分层记忆
│   ├── voice/                    # 语音（STT/TTS）
│   ├── computer-use/             # 电脑操作（截图/OCR/键鼠）
│   ├── browser-use/              # 内置浏览器自动化（16 工具）
│   ├── llm-gateway/              # 模型网关（路由三层 + 降级）
│   ├── auth/                     # 认证（登录/凭证）
│   ├── skills/                   # 复合技能（skill_list/skill_read/skill_run）
│   ├── mcp/                      # MCP 客户端（mcp_list_tools/mcp_call）
│   ├── terminal/                 # 终端（node-pty 持久 shell）
│   ├── storage/                  # 云存储上传（走网关 upload-token）
│   └── deepseek-bridge/          # DeepSeek 网页版 → OpenAI 兼容桥接
└── docs/                         # 设计文档（含 plugin-protocol.md 插件协议权威规范）
```

## 构建与打包

```bash
pnpm install          # 安装依赖
pnpm -r typecheck     # 全项目类型检查
pnpm -r test          # 运行测试

# ── 桌面端（Electron）──
pnpm --filter @shanhai/desktop build            # 构建桌面端（tsup + vite）
pnpm --filter @shanhai/desktop start            # 启动 Electron 应用（开发运行）
pnpm --filter @shanhai/desktop dist:mac:arm64   # 打包 macOS arm64（dmg + zip）
pnpm --filter @shanhai/desktop dist:win         # 打包 Windows x64（nsis 安装包 + portable 便携版）

# ── 手机端（Flutter，Android）──
cd apps/mobile && flutter build apk --release   # 打包 Android release APK
```

产物输出目录：

- 桌面端：`apps/desktop/release/`
  - mac：`Shanhai-<版本>-arm64.dmg`、`山海-<版本>-arm64-mac.zip`
  - win：`Shanhai-<版本>-x64-setup.exe`、`Shanhai-<版本>-x64-portable.exe`
- 手机端：`apps/mobile/build/app/outputs/flutter-apk/app-release.apk`

> win 打包为「在 mac 上交叉打包」，首次需下载 win 版 electron；若 GitHub 下载慢，可先设 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 走镜像。

## 技术栈

- **语言**：TypeScript（strict，全项目）
- **包管理**：pnpm workspace（`apps/*` + `packages/*`）
- **桌面**：Electron + Vite + React 18（renderer）
- **移动端**：Flutter（Android）
- **构建**：tsup（库包）+ vite（renderer）
- **测试**：vitest（包级 `tests/`）

## 设计文档

- [山海系统结构设计](docs/山海系统结构设计.md)
- [山海接口契约与数据模型](docs/山海接口契约与数据模型.md)
- [山海开发计划](docs/山海开发计划.md)
- [智能体设计文档](docs/智能体设计文档.md)
- [插件协议规范](docs/plugin-protocol.md)（插件开发权威契约，AI 开发插件前必读）
