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
| GLM 配额 footer 与 `/usage` | `PI_USAGE_STATS=1 pi` |
| Limao UI 对齐工具（项目扩展） | `PI_UI_ALIGN=1 pi` |

可组合多个变量，例如 `PI_MCP_BRIDGE=1 PI_SUBAGENTS=1 pi`。

## 内容

| 目录 | 说明 |
|---|---|
| `extensions/` | 默认核心：apply-patch、goal、plan、CodeGraph（仅已索引项目）；按需：mcp-bridge、subagent、usage-stats |
| `skills/` | 流程制度：agent-notes（决策记录）、defensive-patterns、postmortem、pre-push-checks |
| `prompts/` | `implement`、`implement-and-review`、`scout-and-plan` 子代理工作流模板 |
| `agents/` | 子代理定义（planner/reviewer/scout/worker/gpt-reviewer）。Pi packages 暂不支持 agents 资源类型，需软链：`ln -s <本仓库>/agents ~/.pi/agent/agents` |

## 外部依赖（按需）

- **GLM 用量监控**：仅在 `PI_USAGE_STATS=1` 时读取本机 provider 配置并请求配额。apiKey 支持 `!security …` keychain 前缀，密钥永不入仓。
- **浏览器自动化**：ego-browser skill 位于 `~/.agents/skills/ego-browser`（跨 harness 共享），CLI：`~/.local/bin/ego-browser`。
- 凭证/本地配置（`auth.json` / `models.json` / `mcp.json` / `settings.json`）一律不进本仓库。
