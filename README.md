# pi-kit

icejiang 的 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 定制包。

```bash
pi install git:github.com/icejiang/pi-kit
```

本机开发配置通过 `~/.pi/agent/settings.json` 中相对 `agentDir` 的 `../../pi-kit` 路径加载本仓库。其他机器可用 `pi install git:github.com/icejiang/pi-kit`，并在更新后检查 package 版本和资源状态。

## 启动 Profiles

默认 `pi` 只加载 coding 核心工具。重型能力使用环境变量显式启用，避免每个模型请求都携带无关 tool schema：

| 场景 | 启动方式 |
|---|---|
| 常规编码 | `pi` |
| MCP 搜索、浏览器、模拟器服务 | `PI_MCP_BRIDGE=1 pi` |
| 委派 scout / planner / worker / reviewer | `PI_SUBAGENTS=1 pi` |
| GLM 配额 footer、`/usage` 与本地 `/usage cache` | 默认启用（禁用：`PI_USAGE_STATS=0 pi`） |
| Limao UI 对齐工具（项目扩展） | `PI_UI_ALIGN=1 pi` |

可组合多个变量，例如 `PI_MCP_BRIDGE=1 PI_SUBAGENTS=1 pi`。

## 内容

| 层 | 默认内容 | 模型 schema 成本 | 说明 |
|---|---|---:|---|
| 编辑 | `apply_patch` | 1 | 多文件 patch，替代冗长的 `edit` oldText |
| 目标与工作 | `create_goal` / `get_goal` / `update_goal` / `update_plan` | 4 | `/goal` 管理目标；常驻任务投影与 `/work` 展示交付计划 |
| 代码理解 | CodeGraph | 5，仅已索引项目 | 未发现 `.codegraph` 时完全不注册 |
| 运行护栏 | timeout、repeat reminder、session autoname、notify | 0 | 本地事件处理和 slash command，不进模型 schema |
| 用量状态 | usage footer 与 `/usage` | 0 | 可用 `PI_USAGE_STATS=0` 关闭 |
| 按需能力 | MCP bridge、subagent、git checkpoint、Limao UI 对齐 | 0，未启用时 | 仅对应环境变量开启后才注册工具 |
| 工作流资源 | `skills/`、`prompts/`、`agents/` | 按需加载 | 只在任务匹配或用户调用时进入上下文 |

`agents/` 包含 planner/reviewer/scout/worker/gpt-reviewer。Pi packages 暂不支持 agents 资源类型，需软链：`ln -s <本仓库>/agents ~/.pi/agent/agents`。

## 外部依赖（按需）

- **GLM 用量监控**：默认启用；设 `PI_USAGE_STATS=0` 可关闭。读取本机 provider 配置并请求配额，apiKey 支持 `!security …` keychain 前缀，密钥永不入仓。
- **浏览器自动化**：ego-browser skill 位于 `~/.agents/skills/ego-browser`（跨 harness 共享），CLI：`~/.local/bin/ego-browser`。
- 凭证/本地配置（`auth.json` / `models.json` / `mcp.json` / `settings.json`）一律不进本仓库。

## Goal 生命周期

`/goal <目标>` 创建一个明确的交付目标，并立即启动一次仅用于建立计划的 agent 回合。在这份计划写入前，Pi 会阻止该 goal 下的执行工具调用；因此 `Planning gate` 是一个短暂、可解释的控制点，而不是无信息的等待状态。

| 命令 | 作用 |
|---|---|
| `/goal <目标>` | 创建新的交付目标，并要求 agent 先建立交付计划 |
| `/goal` | 查看目标、状态和原因 |
| `/goal pause` | 暂停目标；执行中的当前回合会中断 |
| `/goal resume` | 恢复目标，并继续计划或当前里程碑 |
| `/goal done` | 仅当绑定计划的所有里程碑均完成且有证据时完成目标 |
| `/goal blocked <原因>` | 标记为外部决策或条件阻塞 |
| `/goal clear` | 清除已完成或已阻塞目标 |

goal 与 plan 有绑定 id。开始新 goal 会清除旧 goal 的 workboard，避免把上一任务的 `2/5` 误显示为新任务的进度。Goal 与 Workboard 都作为 session custom entry 持久化，不进入 LLM context；`token_budget` 仍可被记录为说明性字段，但 Pi 没有可靠的通用 token 计量来源，因此不会伪装为强制停止条件。

## 工作进度控制

`/goal` 用于跨多轮的长期交付。没有 goal 时，Pi 不会把每句问答伪装成计划：普通请求只显示为 `REQUEST | INSPECTING`，不会向模型注入任务看板。每个 agent 回合最多可进行三次只读检查和一次受限验证（测试、lint、静态分析）；只有超过该预算、准备写入、或用户显式使用 `/work start` 时，才通过 `update_plan` 创建当前 Task。纯问答和轻量查证不会污染看板；`/goal` 下的执行仍始终先有计划。

默认 workboard 是一个常驻的任务投影，而不是命令日志：先显示目标或 Task、`2/5` 这类已验证进度、阶段索引、当前阶段、正在执行或最近行动、最近成果、下一交付与阻塞项。底栏只显示 `P 2/5 | Stage 3/5` 这类计划状态，不把工具名称、耗时或原始输出误作进度。

每个里程碑都有 `done_when`，标记为完成时必须附带 `evidence`。这使“2/5”代表已经达到两个可验证的阶段结果，而不是执行过两次工具。工具运行、输出和事件是诊断信息：默认任务投影只显示当前阶段的行动摘要；`/trace` 显示按阶段标记的本地事件时间线；原始命令、代码、diff 与输出仍在对应工具行，通过 `Ctrl+O` 按需展开。

## 工具轨迹

默认工具行不再直接铺开命令、代码或完整输出，而是以三段式显示：`意图`（为什么做）、`工具`（使用什么）和 `结果`（发生了什么）。`bash`、`read`、`edit`、`write`、`apply_patch` 与 `update_plan` 均采用这一视图；按 `Ctrl+O` 可在当前工具行展开完整命令、代码、diff、计划和原始输出，再按一次收起。该渲染只在 TUI 本地生效，不进入模型上下文，也不增加 token。

| 命令 | 作用 |
|---|---|
| `/work` | 查看交付计划、完成条件、当前阶段、最近成果、下一交付和阻塞项 |
| `/work plan` | 查看交付计划主视图 |
| `/work trace` 或 `/trace` | 查看按阶段归属的本地执行时间线；对应工具行按 `Ctrl+O` 查看原始详情 |
| `/work start <目标>` | 显式建立一个当前 Task，并要求 agent 先发布计划 |
| `/work replace <目标>` | 放弃当前 Task 的未完成计划，显式切换到新 Task |
| `/work activity` | 查看实时工具、耗时、输出摘要和最近诊断事件 |
| `/work log` | 查看本地 agent/tool/输出/异常事件时间线 |
| `/work detail` | 查看计划、activity 与完整本地事件日志 |
| `/work focus <n>` | 将第 n 个里程碑作为最高优先级；空闲时开始新回合，执行中则转向 |
| `/work note <内容>` | 给当前工作添加调整说明；空闲时开始新回合，执行中则中断并转向 |
| `/work pause` | 中断当前回合，并阻止后续 tool call |
| `/work resume` | 恢复 tool call，并从当前步骤继续 |
| `/work clear` | 清除所有里程碑都已完成的交付计划 |

长时间工具没有发出 progress 事件时，`/work activity` 会在一分钟后记录 `quiet` 告警；这表示没有可观测的工具输出，不等同于计划阶段失败，原有 timeout policy 仍会在超时后中止该回合。

`/work` 本身不注册模型工具，不增加每次请求的 tool schema。Task、计划、目标绑定和用户控制操作保存为 session custom entry，但工具启动、输出和结束仅作为本地诊断，避免每个工具事件复制完整看板。持久化快照不进入模型上下文；显式 `/goal`、`/work` 控制操作和工具闸门拒绝会各自发送一次必要指令，普通续作不会重复注入状态。

`/usage cache` 读取当前 session 已持久化的 provider usage，展示最近 12 个回合的 cache read、输入量、加权命中率与时间间隔。它不发送模型请求、不读取用户文本，也不把缓存比例伪装成精确费用或单一根因。
