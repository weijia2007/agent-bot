# NexusBot Studio

本地多 Agent 协同桌面工作台：在一个 Windows 桌面应用里同时驱动 **Claude Code / Codex / Antigravity**，
以「主管 Bot + 团队 Bot」的形式完成拆任务、派单、互相 `@`、交叉审查与汇总。

- 桌面壳：Electron 33 + Vite 6 + React 19 + TypeScript + Tailwind CSS 3
- 协同内核：从原 `NexusRelay/native` 演进而来的 .NET 10 C# Sidecar Engine（独立进程，AOT 友好、无反射 JSON）
- 形态：纯 GUI，无控制台黑框；所有后台子进程均以 `windowsHide: true` 拉起

> 本工程是**独立旁支**，不是对原版 NexusRelay 的升级或覆盖。原版的进程、端口、数据目录与配置注册项均不被读写。

---

## 目录结构

```
NexusBotStudio/
├─ engine/                     # C# 引擎（fork of native/，含改造与测试）
│  ├─ native/                  # RelayBox / EditGuard / Reservations / NativeSidecar / BotStudio / BotControl ...
│  ├─ tests/NexusRelay.Tests/  # 原有用例 + BotStudioTests.cs（Phase 1 新增）
│  └─ publish/NexusRelay.exe   # 已发布的可执行引擎（桌面端启动它）
├─ desktop/                    # Electron + Vite + React 桌面端
│  ├─ electron/
│  │  ├─ adapters/             # Claude / Codex / Antigravity 三端独立会话适配器
│  │  ├─ orchestrator/         # 主管编排、串行调度器、Git Worktree 隔离
│  │  ├─ engine.ts             # 引擎进程 + Bearer 控制面 + SSE
│  │  ├─ discovery.ts          # 本机三端真实安装探测
│  │  ├─ config.ts             # 全部隔离路径、端口、Token
│  │  ├─ main.ts / preload.ts  # BrowserWindow 与 contextBridge
│  ├─ src/                     # Grok Bot 风格三栏工作台 UI
│  └─ dist/ + dist-electron/   # 构建产物
├─ scripts/                    # 验收脚本
│  ├─ smoke-engine.mjs         # 引擎控制面 / SSE / MCP / 熔断端到端冒烟
│  ├─ smoke-desktop.mjs        # Electron 主进程启动 + 引擎拉起冒烟
│  └─ run-engine-tests.sh      # 隔离工具链下的一键 dotnet test
├─ docs/                       # Phase 0 探测报告、验收报告、日志
└─ .toolchain/                 # 隔离的 .NET SDK / Electron / 便携运行时（不进版本库）
```

---

## 快速开始

```bash
cd desktop
npm install          # 首次安装；离线环境见 docs/验收报告.md 的离线安装说明
npm run typecheck    # renderer + electron 双份 TypeScript 检查
npm run build        # vite build + esbuild 打包 main.cjs / preload.cjs
npm start            # 启动桌面应用（无黑框）
```

引擎可执行文件已随仓库放在 `engine/publish/NexusRelay.exe`；如需重新发布：

```bash
cd engine
dotnet publish native/NexusRelay.csproj -c Release -r win-x64 --self-contained true \
  -p:PublishAot=false -o publish --nologo
```

> 本机未安装 Visual Studio 的「Desktop Development for C++」工作负载，因此 **Native AOT 发布缺平台链接器**。
> 当前交付使用自包含非 AOT 发布（功能等价，`dotnet build -c Release` 仍是 0 警告 0 错误）。
> 装好 MSVC 后去掉 `-p:PublishAot=false` 即可恢复 AOT 产物。

一键验收：

```bash
node scripts/smoke-engine.mjs       # 13 项：鉴权 / 注册表 / SSE / MCP / 熔断 / 配额
node scripts/smoke-desktop.mjs      # 5 项：Electron 启动并拉起隔离引擎
bash scripts/run-engine-tests.sh    # 引擎全部单元测试 + 集成测试
```

---

## 隔离性保证（与原版 NexusRelay 完全分开）

| 项目 | 原版 | NexusBot Studio |
|---|---|---|
| 端口 | `16181` | `16191` |
| 数据目录 | `~\.nexus\relay` | `~\.nexus-bot-studio\relay` |
| 构建输出 | `~\.nexus\build\nexusrelay` | `NexusBotStudio\engine\.build` |
| 测试临时目录 | `~\.nexus\build\nexusrelay\test-scratch` | `~\.nexus-bot-studio\test-scratch` |
| 紧急停止标志 | `~\.nexus\stop`（只读兼容） | `~\.nexus-bot-studio\relay\stop` |
| MCP 注册项 | `~/.claude.json`、`~/.codex/config.toml` 中原有 `nexus-relay` | **不改动**；每 Bot 使用 `~\.nexus-bot-studio\mcp-configs\<bot_id>.json` 动态注入 |
| 鉴权 | 原 Token | 每次启动生成 256-bit Token，仅注入子进程与本地 MCP 配置 |

控制面只监听 `127.0.0.1`，所有 `/api/*` 路径都位于 Bearer Token 校验之后。

---

## 一个 Bot = 一个真实独立会话

| 引擎 | 会话标识 | 首次 | 后续 | 身份注入 |
|---|---|---|---|---|
| Claude Code | 独立 UUID | `--session-id <uuid>` | `--resume <uuid>` | 专属 `--mcp-config` → `/mcp?bot=<bot_id>` + `--append-system-prompt` |
| Codex | 独立 thread id | `codex exec --json` | `codex exec resume <threadId>` | 会话级 `-c mcp_servers.nexus_bot_studio.url=...` + Prompt 身份头 |
| Antigravity | 独立 `conversationId` | `agentapi new-conversation` | `agentapi send-message <id>` + `chokidar` 监听 `transcript.jsonl` | 静态插件无法带 `?bot=`，故唤醒 Prompt 头显式声明 `as_bot="<bot_id>"` |

引擎侧 `BotRegistry` 用 `^[a-z0-9][a-z0-9-]{0,47}$` 校验动态 id，注册过的 id 是**一等 party**，
`RelayPaths.NormalizeAgent` 不再把它折叠回 `claude`/`codex`/`antigravity`，因此每个 Bot 的收件箱与上下文互不串台。

---

## 安全护栏

- `trace_id` / `hop_count` / `max_hops = 10`：达到阈值写入 `paused=true`，**不自动唤醒**，发 `max_hops_reached` 交人工确认
- 顶部红色「紧急停止」：清空所有 Bot 队列并对每个进行中的 `sendTurn` 调 `abortTurn`
- `EditGuard` 文件锁 + Git Worktree 二选一隔离（`.nexus-worktrees/<room>/<bot_id>`）
- `spawn_bot` 只发 SSE 请求，由 Electron 真正创建会话；引擎不伪造 Bot
- Antigravity `agentapi` 超时/不可解析时标记 `uncertain`，**严禁自动重放**

---

## 详细验收材料

见 `docs/Phase0-环境探测报告.md` 与 `docs/验收报告.md`。
