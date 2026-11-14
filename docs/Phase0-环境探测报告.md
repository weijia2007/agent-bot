# Phase 0 · 本机环境真实探测报告

探测时间：2026-11-14 00:08 – 01:20 (GMT+8)
探测方式：只读命令（版本查询、进程/端口/注册表查询、文件存在性检查），未修改任何原版配置。
新工程路径：`C:\Users\17839\Desktop\NexusBotStudio\`（采用任务书中的建议路径；任务中途用户授权「自行完成，明早验收」，故未再中断等待路径确认）。

---

## 1. 操作系统与基础工具

| 项目 | 实测结果 |
|---|---|
| OS | Microsoft Windows 11 家庭中文版，10.0.26100 |
| Shell | Git Bash (MINGW64_NT-10.0-26100 3.6.9) |
| .NET SDK（探测时） | **未安装**：`dotnet` 不在 PATH；C:/D: 全盘深度搜索无 `dotnet.exe`；注册表无 .NET SDK 卸载项；`DOTNET_ROOT` 未设置 |
| global.json | `sdk.version = 10.0.404`, `rollForward = disable`（要求精确版本） |
| Node.js | v22.22.2（托管）/ `C:\Program Files\nodejs\node.exe`（系统，真实存在） |
| npm | 10.9.7，registry = https://registry.npmjs.org/ |
| git | 2.55.0.windows.3 |
| 磁盘 | C: 51.5 GB 可用，D: 433.9 GB 可用 |

### 阻塞点 1 及处置
`.NET 10 SDK` 缺失会使 `engine/` 无法编译，且 `global.json` 禁止版本回滚。
处置：从官方源下载 `dotnet-sdk-10.0.404-win-x64.zip`（303,618,098 字节），解压到
**新工程隔离目录** `NexusBotStudio\.toolchain\dotnet\`，不写系统 PATH、不写注册表、不装到 Program Files。
单连接下载在 122 MB 处超时（`curl: (28)`），改用 6 路 HTTP Range 并行续传，逐段校验字节数后合并，
实测 `dotnet --version` → `10.0.404`，`--list-sdks` → `10.0.404 [NexusBotStudio\.toolchain\dotnet\sdk]`。

---

## 2. 三大本地 Agent 底座（真实探测）

### 2.1 Claude Code
- 可执行文件：`C:\Users\17839\AppData\Local\Claude-3p\claude-code\2.1.309\9078b9c1d466\claude.exe`（另有 reclaude 多账号副本 2.1.308）
- `claude --version` → `2.1.309 (Claude Code)`
- 登录态：`~/.claude.json` 存在且 `oauthAccount` 字段存在（未读取/输出任何 token）
- 关键能力（`--help` 实测）：`--session-id <uuid>`、`--resume <id>`、`--mcp-config <path>`、`--strict-mcp-config`、
  `--append-system-prompt`、`--permission-mode`、`-p`、`--input-format stream-json`、`--output-format stream-json`、`--verbose`
- 结论：**满足「一个 Bot = 一个独立持久会话」的主路径**

### 2.2 Codex
- CLI：`D:\Codex\codex`（sh wrapper）→ `codex.cmd` → `node.exe D:\Codex\node_modules\@openai\codex\bin\codex.js`
- 版本：`codex-cli 0.157.1`
- 登录态：`~/.codex/auth.json` 存在，含 `auth_mode`、`tokens`、`last_refresh`（未输出值）
- 原版配置：`~/.codex/config.toml` 中已有 `mcp_servers.nexus-relay` → `http://127.0.0.1:16181/mcp?agent=codex`
  **未做任何修改**；新软件通过会话级 `-c mcp_servers.nexus_bot_studio.url=...` 动态注入。
- `app-server` 子命令存在（experimental），支持 `--listen stdio://`，`generate-json-schema` 可导出完整协议。
- 协议实测（本地 stdio JSON-RPC）：
  - `initialize` → **成功**，返回 `userAgent`、`codexHome`、`platformFamily`
  - `thread/list` → **成功**，返回真实历史 threads
  - `thread/start`（带 `{cwd}` 与 `{}` 两种参数，各等待 3 s）→ **无响应**；
    stderr 出现 `ERROR codex_models_manager::manager: failed to refresh available models: request timed out`
- 结论：本机 app-server 的 `thread/start` 因模型列表刷新超时不可用。按任务书允许的策略降级为
  **受控独立 `codex exec --json` 子进程**（支持 `exec resume <id>` 恢复会话），绝不模拟桌面点击。
  已通过 `codex app-server generate-json-schema --experimental` 导出协议 Schema 到 `docs/codex-protocol/` 备查。

### 2.3 Antigravity（反重力）
- 安装：`C:\Users\17839\AppData\Local\Programs\antigravity\`
- `resources\bin\language_server.exe` 存在；`agentapi --help` 返回：
  `get-conversation-metadata`、`new-conversation`、`send-message`
- 会话数据：`~/.gemini/antigravity/brain` 下有 551 个会话目录，`conversations/*.db` 存在
- **关键发现**：`agentapi` 直接调用返回 `{"error":"ANTIGRAVITY_LS_ADDRESS is not set"}`。
  该变量由 Antigravity sidecar 父进程注入，Electron 主进程不会继承。
  进一步实测：每个 `language_server.exe` 进程监听一对 127.0.0.1 端口，其中**较高端口的 `/healthz` 返回 200**
  （例：PID 21956 → `127.0.0.1:5594`，CSRF token 来自该进程命令行的 `--csrf_token`）。
  设置 `ANTIGRAVITY_LS_ADDRESS=127.0.0.1:5594` + `ANTIGRAVITY_CSRF_TOKEN=<token>` 后，
  `agentapi get-conversation-metadata <uuid>` 返回结构化 JSON（该旧会话不在本实例故为 NotFound，
  但 **RPC 链路真实打通**）。
- 结论：适配器内置自动探测（`Get-CimInstance Win32_Process` + `Get-NetTCPConnection` + `/healthz` 探测），
  也允许用环境变量覆盖；探测不到时 healthCheck 如实返回 unavailable，不伪造。

---

## 3. 原版 NexusRelay 环境（绝对未触碰）

| 项目 | 实测 |
|---|---|
| 端口 | `127.0.0.1:16181` 处于 LISTEN，OwningProcess = 48288（原版引擎运行中） |
| 进程 | `NexusRelay` × 3 正在运行 |
| 数据目录 | `~\.nexus\relay` 存在（`v1/`, `NexusRelay/`, `agy-projet/`, `codex-projet/` 等） |
| 全局配置 | `~/.claude.json`、`~/.codex/config.toml` 中的原版注册项保持原样 |
| `%LOCALAPPDATA%\NexusRelay` | 不存在 |
| `~\.nexus\stop` | 不存在 |
| 端口 16191 | **空闲**，选作新软件端口 |
| 新数据根 `~\.nexus-bot-studio` | 探测时不存在（全新） |

隔离措施（已落到代码）：
- `NEXUS_RELAY_HOME = ~\.nexus-bot-studio\relay`
- `NEXUS_BOT_PORT = 16191`（`Program.cs` 保持 16181 作为未注入时的默认，兼容原测试）
- `Directory.Build.props` 输出路径改为 `NexusBotStudio\engine\.build\<project>`（不再写 `~\.nexus\build`）
- 测试临时目录改为 `~\.nexus-bot-studio\test-scratch`
- 每个 Bot 独立 MCP 配置写在 `~\.nexus-bot-studio\mcp-configs\<bot_id>.json`，URL 带 `?bot=<bot_id>`
- 紧急停止标志写在 `NEXUS_RELAY_HOME/stop`，并保留读取原版 `~/.nexus/stop` 的兼容逻辑（只读）

---

## 4. 已知限制（如实列出，未伪造）

1. **.NET SDK 原本缺失** —— 已在隔离目录自行安装 10.0.404，不污染系统。
2. **Codex app-server `thread/start` 无响应** —— 走 `codex exec --json` 降级；`exec resume` 用于保持会话上下文。
3. **Claude Code `-p / stream-json` 没有运行时审批回传通道** —— `ask_ui` 模式可上报 `approval_required` 卡片并中断回合，
   但无法像 SDK 的 `canUseTool` 那样逐工具拦截后继续执行；细粒度运行时审批列为后续增强项。
4. **Antigravity 静态 MCP 插件** —— 每个唤醒 Prompt 头显式携带 `as_bot="<bot_id>"` 身份声明，引擎侧按同引擎白名单校验。
5. 端到端真实多 Bot 演练需要真实账号额度与三端同时在线，是否执行及结果见 `验收报告.md`。
