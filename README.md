# Agent Bot 0.2 — 真实桌面对话协作

Windows 多 Agent 工作台。项目里的第一个 Bot 必须是主管，由用户选择主管的 Agent、模型和职责。群聊用来派单、上传任务文件和汇报；每个 Bot 的私聊显示用户指令、主管指令、原桌面对话和工具活动。

主管可把任务交给已连接的 Claude Code、Codex、Antigravity Bot。执行结束后，平台把结果送回主管的同一真实对话，主管再决定派给谁、继续做什么，或向用户汇总。

## 直接运行

本机成品：`desktop/release/win-unpacked/Agent Bot.exe`。桌面 `Agent Bot` 快捷方式指向该程序。分发时需要保留整个 `win-unpacked` 文件夹，不能只复制一个 EXE。

GitHub 的 **Actions → Windows desktop build** 会生成 `AgentBot-Windows-x64` 成品附件。下载并完整解压后，运行其中的 `Agent Bot.exe`。源代码仓库不提交 Electron、.NET 运行时和本机账户数据。

## 第一次使用

1. 打开并登录原 Agent 桌面应用。
2. 在 Agent Bot 左上角新建项目，选择项目文件夹。下一步必须设置主管 Bot，Agent 由用户选择。
3. 连接独立的真实桌面对话。每个对话只能绑定一个 Bot。
4. 继续连接执行 Bot，再到群聊发送总任务；也可以在某个 Bot 的私聊直接给它指令。
5. 点开 Bot 私聊查看正在调用的工具、参数摘要、输出和执行结果；工作结束后可展开保留的活动记录。

| 原 Agent | 连接方法 | 模型选择 | 权限 |
|---|---|---|---|
| Antigravity | 可从 Bot 内新建 Cascade 桌面对话，也可绑定已有对话；支持选择运行中的桌面账号 | 从该桌面账号实时读取具体模型和强度；下一轮在原会话中切换 | 继承原桌面设置；未公开的有效权限明确显示“未开放读取” |
| Codex | 在原桌面新建并打开独立对话，然后从列表选择；通过原桌面的 IPC 持有者执行任务 | 从本机目录读取模型；设置通过持有原对话的桌面应用提交 | 读取原会话的有效审批策略和沙箱；可配置继承、只读、审批、工作区自动执行 |
| Claude Code | 在原 Claude 桌面 Code 新建独立对话，启用 Remote Control、使用 Auto 模式并保持运行，再刷新列表 | 当前本地收件箱不开放修改模型；在原桌面选择，实际执行模型同步回来 | 继承原桌面权限；配置默认值和有效会话权限不会混为一谈 |

Claude、Codex 当前需要先在原应用准备独立对话。连接失败会保留可见错误，不自动降级、不伪造会话 ID、不向其他对话重放任务。

Claude 的本地收件箱没有远程中断能力：平台停止后续派单并提示用户到原对话停止。Codex 与反重力使用各自桌面中断接口；失败时会显示“停止未确认”，不会声称已经停止。

## 群聊和私聊

- 群聊默认交给当前主管，也可以指定执行 Bot；支持文件选择和拖放，每次最多 8 个任务附件。
- 私聊保留用户和主管发来的指令，明确标注发送方；从原应用发送的可见消息也会同步到该 Bot 私聊。
- 工具活动通常约 1 秒更新一次。展示公开消息、工具名称、参数和结果；不读取或展示加密的内部推理。
- 主管通过明确的派单指令驱动平台投递，不依赖模型口头声称“已发送”。执行 Bot 不必自行安装 MCP。
- 主管根据成员汇报继续派单时，平台随任务转交上游结果；群聊和目标 Bot 私聊都能展开这份参考汇报。
- 同一个 Bot 串行执行；不同 Bot 可以并行。任务有因果 ID、消息去重、跨项目限制和自动协作跳数上限。
- 急停会清空等待任务并请求中断原会话。取消、断线、超时和结果不确定不会自动重复执行有副作用的操作。

## 数据和版本

平台数据在 `~/.nexus-bot-studio/`，与原 NexusRelay 的 `~/.nexus/relay`、端口 `16181` 分开。Agent Bot 默认使用 `16191`。引擎以 `--bot-studio` 运行，旧版桌面唤醒、窗口维护、对话整理逻辑不会参与 Bot 的真实会话调度。

旧版 CLI Bot 不会自动冒充桌面 Bot：升级后显示为暂停，需要重新连接真实桌面对话。原会话和已有平台记录会保留。切换反重力模型沿用同一 Cascade，不会创建替代会话。

开发和验收可使用 `NEXUS_BOT_DATA_HOME`、`NEXUS_BOT_ENGINE_PORT` 隔离数据和端口。它们不影响原 Agent 登录和配置。

## 开发构建

需要 Node.js、.NET SDK **10.0.404**（版本见 `engine/global.json`）。

```powershell
cd engine
dotnet publish native/NexusRelay.csproj -c Release -r win-x64 --self-contained true -p:RuntimeIdentifiers=win-x64 -p:PublishAot=false -o publish
cd ../desktop
npm ci
npm run typecheck
npm test
npm run dist
npm run shortcut
```

本地原生测试：

```powershell
cd engine
dotnet test --project tests/NexusRelay.Tests/NexusRelay.Tests.csproj -c Release -p:RuntimeIdentifier=win-x64 -p:RuntimeIdentifiers=win-x64 --no-ansi
```

原生测试需要 `dotnet` 位于 PATH，且 Windows PowerShell 及 PowerShell 7 可用。便携 PowerShell 可设置 `NEXUS_BOT_PWSH_MODULES` 指向它的 `Modules` 目录。

实机验证和自查记录见 [桌面会话验收](docs/桌面会话验收-0.2.md)。旧版本的架构与验收材料保存在 `docs/`，其中的 CLI 连接说明属于历史版本。
