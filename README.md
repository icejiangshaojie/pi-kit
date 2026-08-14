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
| GLM 配额 footer 与 `/usage` | 默认启用（禁用：`PI_USAGE_STATS=0 pi`） |
| Limao UI 对齐工具（项目扩展） | `PI_UI_ALIGN=1 pi` |

可组合多个变量，例如 `PI_MCP_BRIDGE=1 PI_SUBAGENTS=1 pi`。

## 内容

| 层 | 默认内容 | 模型 schema 成本 | 说明 |
|---|---|---:|---|
| 编辑 | `apply_patch` | 1 | 多文件 patch，替代冗长的 `edit` oldText |
| 目标与工作 | `create_goal` / `get_goal` / `update_goal` / `update_plan` | 4 | `/goal` 管理目标；`/work` 展示计划、工具、耗时和事件 |
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

## 工作进度控制

复杂任务由模型调用 `update_plan` 后，Pi 会把 `/goal`、计划与 agent/tool 事件汇总为 session 的本地 workboard。底部只显示紧凑摘要，编辑器上方显示目标、当前步骤、工具耗时、最后一次输出和最近事件；`/resume` 后仍可查看日志。

| 命令 | 作用 |
|---|---|
| `/work` | 查看计划、当前工具、耗时、最后输出和最近 8 条事件 |
| `/work plan` | 只查看完整 checklist |
| `/work log` | 查看最近的 agent/tool/输出/异常事件 |
| `/work detail` | 查看完整 checklist 与本地事件日志 |
| `/work focus <n>` | 将第 n 步作为最高优先级；空闲时开始新回合，执行中则中断并转向 |
| `/work note <内容>` | 给当前工作添加调整说明；空闲时开始新回合，执行中则中断并转向 |
| `/work pause` | 中断当前回合，并阻止后续 tool call |
| `/work resume` | 恢复 tool call，并从当前步骤继续 |
| `/work clear` | 清除已完成 checklist |

长时间工具没有发出 progress 事件时，workboard 会在一分钟后显示 `quiet` 并留下本地告警记录；这表示没有可观测进展，不等同于工具一定失败，原有 timeout policy 仍会在超时后中止该回合。

`/work` 本身不注册模型工具，不增加每次请求的 tool schema。计划、事件、输出摘要都保存为 session custom entry，不进入模型上下文；只有当前计划、用户优先级或说明需要影响执行时，才在下一回合注入一条简短上下文。
