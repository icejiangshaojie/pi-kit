/**
 * timeout-policy — 工具调用超时熔断（借鉴 deepseek-harness packages/guard/timeout-policy）
 *
 * 跟踪每个工具执行的时长，超过 deadline 时调用 ctx.abort() 终止挂起的 agent 回合
 * （等价于用户按 Esc），避免一个挂死工具拖住整个 session。
 *
 * 零配置默认：普通工具 10 分钟；长任务工具（build_install_app / subagent / align_audit 等）1 小时。
 * 可通过 ~/.pi/agent/guard-config.json 覆盖：
 *   { "timeouts": { "default": 600, "perTool": { "bash": 1800 } } }   // 单位秒
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_S = 600;
const LONG_RUNNING_S = 3600;
const LONG_RUNNING_TOOLS = new Set([
	"build_install_app",
	"subagent",
	"align_audit",
	"align_compare",
	"app_shot",
	"design_shot",
]);

interface GuardConfig {
	timeouts?: { default?: number; perTool?: Record<string, number> };
}

function loadConfig(agentDir: string): GuardConfig {
	const p = join(agentDir, "guard-config.json");
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, "utf8")) as GuardConfig;
	} catch {
		return {};
	}
}

export default function (pi: ExtensionAPI) {
	let agentDir = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pi", "agent");
	const config = loadConfig(agentDir);
	const defaultTimeoutS = config.timeouts?.default ?? DEFAULT_TIMEOUT_S;
	const perTool = config.timeouts?.perTool ?? {};

	const deadlineFor = (tool: string): number =>
		(perTool[tool] ?? (LONG_RUNNING_TOOLS.has(tool) ? LONG_RUNNING_S : defaultTimeoutS)) * 1000;

	const running = new Map<string, { tool: string; start: number; reported: boolean }>();
	let ticker: ReturnType<typeof setInterval> | undefined;

	function check(ctx: { abort(): void; isIdle(): boolean }) {
		const now = Date.now();
		for (const [id, r] of running) {
			const elapsed = now - r.start;
			const deadline = deadlineFor(r.tool);
			if (elapsed > deadline && !r.reported) {
				r.reported = true;
				const mins = Math.round(elapsed / 60000);
				console.error(
					`[timeout-policy] 工具 «${r.tool}» 已运行 ${mins} 分钟（上限 ${Math.round(deadline / 60000)} 分钟），` +
						`正在中止当前 agent 回合。若这是预期的长任务，请在 ~/.pi/agent/guard-config.json 里调高该工具的超时。`,
				);
				try {
					ctx.abort();
				} catch {
					/* already idle */
				}
			}
		}
	}

	pi.on("agent_start", (_event, ctx) => {
		if (!ticker) {
			ticker = setInterval(() => {
				if (running.size > 0) check(ctx);
			}, 30_000);
			// 不阻止进程退出
			if (typeof ticker.unref === "function") ticker.unref();
		}
	});

	pi.on("tool_execution_start", (event) => {
		running.set(event.toolCallId, { tool: event.toolName, start: Date.now(), reported: false });
	});

	pi.on("tool_execution_end", (event) => {
		running.delete(event.toolCallId);
	});

	pi.on("session_shutdown", () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		running.clear();
	});
}
