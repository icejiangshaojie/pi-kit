# pi-kit

icejiang 的 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 定制包。一条命令安装：

```bash
pi install git:github.com/icejiang/pi-kit
```

不想全装可用 `pi config` 按资源启停。更新：`pi update --extensions`。

## 内容

| 目录 | 说明 |
|---|---|
| `extensions/` | usage-stats（GLM 套餐用量 footer + `/usage`）、git-checkpoint、goal、plan、session-autoname、notify、mcp-bridge、codegraph 等 |
| `skills/` | 流程制度：agent-notes（决策记录）、defensive-patterns、postmortem、pre-push-checks |
| `prompts/` | implement / implement-and-review / scout-and-plan 模板 |
| `agents/` | 子代理定义（planner/reviewer/scout/worker/gpt-reviewer）。⚠️ pi packages 暂不支持 agents 资源类型，需手动软链：`ln -s <本仓库>/agents ~/.pi/agent/agents` |

## 外部依赖（按需）

- **GLM 用量监控**：`~/.pi/agent/models.json` 需有 baseUrl 含 `bigmodel.cn` 的 provider，apiKey 支持 `!security …` keychain 前缀（密钥永不入仓）。
- **浏览器自动化**：ego-browser skill 位于 `~/.agents/skills/ego-browser`（跨 harness 共享），CLI：`~/.local/bin/ego-browser`。
- 凭证/本地配置（`auth.json` / `models.json` / `mcp.json` / `settings.json`）一律不进本仓库。
