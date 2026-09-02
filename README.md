# 山海

> 通用桌面端多 Agent 智能体 —— 自研插件内核。

山海是一个运行在 macOS 桌面的智能体应用：多专家编排、真实工具执行、会话级隔离、可自我升级。后端内核自研（提供 `ctx`/`inject`/`effect`/`slots`/`fiber` 语义），前端用 Electron + React 渲染，另配 Flutter 移动端。

## 下载

- [🪟 Windows 版下载](https://store.bjctykj.com/app-versions/Windows/1788325471_Shanhai-0.6.0-x64.exe)（x64）
- [🍎 macOS 版下载](https://store.bjctykj.com/app-versions/macOS/1788325602_Shanhai-0.6.0-arm64.dmg)（Apple Silicon / arm64）

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

## 山海的能力

> 面向结束用户与开发者，逐项说明「是什么、能解决什么、适合谁用」。所有能力均对应真实实现（`apps/`、`packages/`、插件协议 `docs/plugin-protocol.md`），不包含规划中尚未落地的能力。

### 1. 多会话并行 + 会话管家调度

**是什么**：山海是「Electron 桌面端 + Flutter 手机端」的多会话智能体系统，一个独立常驻的「会话管家（Supervisor）」作为主控会话统一调度其它所有会话。

**能解决什么**：
- 同时开多个会话并行推进不同任务，互不干扰（工作目录、输入草稿、上下文均按会话隔离）。
- 管家统一监控、转发、切换各会话，避免在多窗口之间来回切换找任务。

**适合谁**：同时并行多项任务、需要统一调度入口的用户。

### 2. 插件系统（一切皆插件 + 工程化闭环）

**是什么**：山海内核遵循「一切皆插件」——宿主、工具、UI、语音、记忆、自升级都是插件。插件分「窗口应用」和「纯工具」两类，通过工程化闭环开发：`scaffold → build → test-load → verify → install → uninstall`，并支持 `publish` 打包发布到创意空间。

**能解决什么**：
- 用插件扩展山海能力，无需改动内核；插件经 `plugin_*` 工具链开发、`plugin_install` 安装后跨会话、跨重启留存。
- 插件声明 `capabilities`（最小权限）、走审批流程，越界访问会被内核拦截。

**适合谁**：想为山海开发自定义能力、复用他人插件的开发者；通过聊天即可「自我升级」的进阶用户。

### 3. 文件管理 + 电脑 / 浏览器 / 终端自动化

**是什么**：真实工具执行——读写文件、执行命令（含超时进程组回收）、电脑操作（截图/OCR/键鼠）、内置浏览器自动化（导航/点击/输入/提取）、持久终端（命令间状态保持）。

**能解决什么**：让 agent 直接操作系统完成真实任务，而非只给文字建议；持久终端支持多步命令的连续执行。

**适合谁**：需要自动化文件整理、脚本执行、网页操作、命令行工作的用户与开发者。

### 4. AI 生成类应用

**是什么**：通过官方插件与受控媒体生成能力提供内容创作——AI 视频工坊（shortdrama）支持分镜剧本 + AI 视频生成；插件窗口内可直接调用受控模型能力（`listModels` / `modelCall` / `modelCallStream`）与媒体生成能力（`videoGen` / `videoGenQuery` / `imageGen` / `imageGenQuery` / `tts` / `uploadFile`）。

**能解决什么**：在插件窗口内「一键生成」剧本、视频、图片、配音等，避免手动拼接流程。

**适合谁**：内容创作者、短剧/视频制作者。注：视频生成（`videoGen`）接口真实可用，图片（`imageGen`）与 TTS 目前桥已预留、依赖网关侧逐步放开。

### 5. 模型切换与安全模式

**是什么**：支持登录后拉取网关模型列表、切换任意会话所用模型、接入自定义 OpenAI 兼容端点，以及把已登录的 DeepSeek 网页版封装成 OpenAI 兼容端点（DeepSeek 桥接）。安全模式分 `ask`（每次询问）/ `workdir`（工作目录内免审批）/ `never`（全自动）三档。

**能解决什么**：按任务复杂度、成本、隐私灵活选模型；按风险偏好调节审批颗粒度。

**适合谁**：关注安全可控与模型成本/能力的用户。

### 6. 上下文管理与稳定性

**是什么**：到期窗口展示（token 用量状态栏）、上下文压缩（超阈值自动压历史为摘要）、断点续跑、历史回放隔离（`&lt;replay-assistant&gt;` / `&lt;replay-user&gt;` 标签隔离防幻觉）。

**能解决什么**：长对话/长任务不因上下文打满而中断，中断后可从卡点继续，避免历史回放被误当作本轮结果。

**适合谁**：跑长任务、需要稳定续跑能力的用户。

### 7. 长期记忆

**是什么**：跨会话记忆（配置型 + 经验型），配合记忆面板查看与管理。

**能解决什么**：让 agent 跨会话记住你的偏好、项目背景与环境约定，不再每次重复交代。

**适合谁**：长期高频使用、希望「越用越懂你」的用户。

### 8. 语音

**是什么**：TTS（macOS `say` 语音合成）+ 麦克风录音识别。

**能解决什么**：语音输入与语音播报，提升交互效率。

**适合谁**：倾向语音交互的用户。

### 9. 技能与 MCP 扩展

**是什么**：复合技能（内置 + `~/.shanhai/skills` 用户技能目录，经 `skill_list`/`skill_read`/`skill_run` 调用）+ MCP 客户端接入外部工具（`~/.shanhai/mcp.json`）。

**能解决什么**：把可复用流程沉淀为技能，或接入第三方 MCP 工具，扩展 agent 能力面。

**适合谁**：希望接入外部工具链、沉淀专属流程的用户与开发者。

### 10. 常驻托盘 + 全局快捷键 + 云存储

**是什么**：关闭窗口最小化到系统托盘，全局快捷键（⌘+Shift+Space）唤出/隐藏窗口；云存储上传走网关 `upload-token` 返回 `https` 链接。

**能解决什么**：后台常驻、随时唤起；把本地文件上传为公网链接供他人访问或喂给媒体生成接口。

**适合谁**：需要后台常驻、跨应用快速唤出、分享文件链接的用户。

## 使用场景

> 每个场景都对应真实可实现的工作流，非概念演示。

### 场景一：开发者——开发 / 安装山海内外插件

开发者想给山海加一个新能力（如自定义工具、专属 UI 窗口）。流程：读插件协议规范 → `plugin scaffold` 生成可编译项目 → `plugin build` 编译出 `dist/` → `plugin test-load` 干跑 → `plugin verify` 校验 → `plugin install` 安装进内核（落盘 `~/.shanhai/plugins/`，跨会话跨重启留存）→ 需要分发时 `plugin publish` 打包共享包提交创意空间。全程由插件协议与工程化工具链护航，不需要手写死代码。

### 场景二：日常办公——多项目并行 + 文件浏览编辑 + 自动化脚本

用户同时推进多个项目：每个项目开一个会话，配好各自的工作目录；让 agent 浏览目录、读取文件、改配置、跑构建、执行脚本。会话之间互不干扰，管家统一监控各会话状态（忙/闲、当前需求、已执行步数、上下文占用），随时切换到需要的会话继续推进。

### 场景三：内容创作——AI 视频 / 短剧 / 图文成片

创作者用「AI 视频工坊」插件搭建短剧工作台：先生成分镜剧本（受控模型调用），再分镜生成 AI 视频（`videoGen` 提交 + `videoGenQuery` 轮询进度），配图/配音走媒体生成接口，素材经 `uploadFile` 上传拿公网链接后转给视频生成接口。全程在插件窗口内完成，无需手动拼流程。

### 场景四：任务委托——把复杂多步任务交给会话，管家拆解监督

用户丢给一个复杂多步任务（如「排查并修复某个 bug，然后跑通测试」）。管家按「拆 → 配 → 问 → 发 → 报」拆解成子任务、匹配合适会话、必要时问用户要关键决策、下发执行、最后汇总汇报。用户只需要给目标，不需要盯每一步；执行轨迹以时间轴形式可视化，可随时回看每一步的先后关系与耗时。

### 场景五：深度自动化——电脑 / 浏览器 / 终端编排

用户需要跨系统的自动化：先用内置浏览器查资料、再用持久终端跑多步命令、必要时操作桌面应用（截图 / OCR 定位 / 键鼠）。这些能力以插件形态承载，agent 按需组合调用，适合数据采集、批量处理、重复性操作自动化。

### 场景六：模型与安全可控——切换模型、自定义端点、审批策略

用户希望按任务控制成本与风险：简单任务切到性价比模型、复杂推理切到旗舰模型；接入自定义 OpenAI 兼容端点做私有化；把安全模式调到 `ask` 让每一步写操作都确认，或调到 `workdir` 让工作目录内操作免审批、目录外仍询问。配合 `ask_user` 弹窗，在需要关键决策时精准打断用户。

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
