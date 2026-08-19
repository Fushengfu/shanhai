# 山海

> 通用桌面端多 Agent 智能体 —— 自研插件内核，接口对齐 DSH（DeepSeek Hub）。

山海是一个运行在 macOS 桌面的智能体应用：多专家编排、真实工具执行、会话级隔离、可自我升级。后端内核自研（接口对齐 DSH 的 `ctx`/`inject`/`effect`/`slots`/`fiber` 语义），前端用 Electron + React 渲染。

## 功能

- **账号密码登录**：对接会员网关 `agent.bjctykj.com`（密码 SHA-256 加密），登录后拉取网关模型列表，也支持接入自定义 OpenAI 兼容端点
- **多专家编排**：Triage 任务拆解 + 专家 Agent 池（ReAct 循环），真实调用工具执行任务
- **工具执行**：读/写文件、执行命令、电脑操作（截图/OCR/键鼠）、内置浏览器自动化（16 工具）
- **安全**：危险操作审批（会话级隔离）、写文件前快照回滚、能力清单强制
- **会话**：多会话并行、事件日志持久化、断点续跑、工作目录隔离、输入草稿隔离
- **长期记忆**：跨会话记忆（配置型 + 经验型）+ 记忆面板
- **自修改（K5）**：聊天式自我升级，动态包 `cordis_*` 工具 + 界面热更新
- **上下文压缩**：token 预算超限自动压历史为摘要
- **语音**：TTS（macOS say）+ 麦克风录音识别

## 目录结构

```
shanhai/
├── apps/
│   ├── desktop/                  # Electron 桌面端（主/预加载/渲染三进程）
│   │   ├── src/main/             #   主进程：index + runtime + ipc-handlers + push + browser
│   │   ├── src/preload/          #   contextBridge 白名单桥
│   │   ├── src/host/             #   boot host + RPC 分发
│   │   └── src/renderer/         #   React 渲染进程（App.tsx 组合根 + components/ 拆分）
│   └── runtime/                  # host 运行时（bootstrap 装配 + cli）
├── packages/
│   ├── kernel/                   # ① 内核（K1 组合运行时 + K2 版本 + K4 安全 + K5 自修改）
│   ├── kernel-modules/           # ② 模块系统（K3，双端）
│   ├── agent/                    # ③ AgentLoop + Triage 编排
│   ├── session/                  # ④ 会话（类型化事件日志）
│   ├── approval/                 # ⑤ 审批
│   ├── compaction/               # ⑥ 上下文压缩
│   ├── tools/                    # ⑦ 原子工具（read/write/run_command）
│   ├── llm/                      # ⑧ Model 接口 + provider 适配
│   ├── memory/                   # ⑨ 分层记忆
│   ├── voice/                    # ⑩ 语音（STT/TTS）
│   ├── computer-use/             # ⑪ 电脑操作（截图/OCR/键鼠）
│   ├── browser-use/              # ⑫ 内置浏览器自动化（16 工具）
│   ├── llm-gateway/              # ⑬ 模型网关（路由三层 + 降级）
│   └── auth/                     # ⑭ 认证（登录/凭证）
└── docs/                         # 设计文档
```

## 启动

```bash
pnpm install          # 安装依赖
pnpm -r typecheck     # 全项目类型检查
pnpm -r test          # 运行测试
pnpm --filter @shanhai/desktop build   # 构建桌面端
pnpm --filter @shanhai/desktop start   # 启动 Electron 应用
```

## 技术栈

- **语言**：TypeScript（strict，全项目）
- **包管理**：pnpm workspace（`apps/*` + `packages/*`）
- **桌面**：Electron + Vite + React（renderer）
- **构建**：tsup（库包）+ vite（renderer）
- **测试**：vitest（包级 `tests/`）

## 设计文档

- [山海系统结构设计](docs/山海系统结构设计.md)
- [山海接口契约与数据模型](docs/山海接口契约与数据模型.md)
- [山海开发计划](docs/山海开发计划.md)
- [智能体设计文档](docs/智能体设计文档.md)
