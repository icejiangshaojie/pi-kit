/**
 * usage-stats — GLM Coding Plan 用量（footer 常驻 + /usage 详情 + 高水位告警）
 *
 * 数据源（逆向自 ZCode usage-stats 模块）：
 *   GET https://open.bigmodel.cn/api/monitor/usage/quota/limit   5h 窗口/周用量/MCP 次数
 *   GET https://open.bigmodel.cn/api/biz/subscription/list       订阅有效期（尽力而为）
 *
 * 展示（footer 样式参考官方示例 status-line.ts）：
 *   常驻状态栏：GLM ⚡53%|14% （5h窗口已用|周已用，<70% 绿 / <85% 黄 / ≥85% 红）
 *   /usage    ：完整条形图 + 重置时间 + MCP 明细 + 套餐等级 + 订阅有效期
 *
 * 刷新时机：session_start / 每 10 分钟 / 每轮 agent 结束（用量刚变化）。
 * API key 从 ~/.pi/agent/models.json 中 baseUrl 含 bigmodel.cn 的 provider 读取。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const SUB_PATH = "/api/biz/subscription/list";
const REFRESH_MS = 10 * 60 * 1000;
const WARN_THRESHOLD = 85;

interface Limit {
	type: string;
	unit: number;
	number?: number;
	usage?: number;
	currentValue?: number;
	remaining?: number;
	percentage?: number;
	nextResetTime?: number;
	usageDetails?: Array<{ modelCode: string; usage: number }>;
}
interface Snapshot {
	fiveHour: { pct: number; resetTs?: number } | null;
	weekly: { pct: number; resetTs?: number } | null;
	mcp: { used: number; total: number; details: Array<{ modelCode: string; usage: number }> } | null;
	level: string | null;
	expiry: string | null;
}
type FetchResult = { ok: true; snap: Snapshot } | { ok: false; error: string };

interface CacheTurn {
	at?: string;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	provider?: string;
	model?: string;
}

let cached: { t: number; res: FetchResult } | null = null;

function resolveBigModelKey(agentDir: string): { key: string; baseUrl: string } | null {
	const p = join(agentDir, "models.json");
	if (!existsSync(p)) return null;
	try {
		const cfg = JSON.parse(readFileSync(p, "utf8")) as {
			providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
		};
		for (const prov of Object.values(cfg.providers ?? {})) {
			if (prov.baseUrl?.includes("bigmodel.cn") && prov.apiKey) {
				const key = prov.apiKey.startsWith("!security ")
					? execFileSync("zsh", ["-lc", prov.apiKey.slice(1)], { encoding: "utf8", timeout: 3000 }).trim()
					: prov.apiKey;
				return { key, baseUrl: prov.baseUrl.replace(/\/api\/.*$/, "") };
			}
		}
	} catch {
		/* ignore */
	}
	return null;
}

function fmtTime(ts: number | undefined): string {
	if (!ts) return "—";
	const d = new Date(ts);
	const diffMin = Math.round((ts - Date.now()) / 60000);
	const rel = diffMin >= 60 ? `${Math.floor(diffMin / 60)}h${diffMin % 60}m后` : `${diffMin}m后`;
	return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}(${rel})`;
}

function bar(pct: number): string {
	const filled = Math.round((pct / 100) * 10);
	return "█".repeat(filled) + "░".repeat(10 - filled);
}

async function fetchSnapshot(agentDir: string): Promise<FetchResult> {
	const resolved = resolveBigModelKey(agentDir);
	if (!resolved) return { ok: false, error: "未找到 bigmodel provider（检查 ~/.pi/agent/models.json）" };
	const headers = { Authorization: `Bearer ${resolved.key}` };
	try {
		const r = (await (
			await fetch(`${resolved.baseUrl}${QUOTA_PATH}`, { headers, signal: AbortSignal.timeout(15000) })
		).json()) as { code: number; msg?: string; data?: { limits?: Limit[]; level?: string } };
		if (r.code !== 200 || !r.data?.limits) return { ok: false, error: r.msg ?? `code ${r.code}` };

		const snap: Snapshot = {
			fiveHour: null,
			weekly: null,
			mcp: null,
			level: r.data.level?.trim() || null,
			expiry: null,
		};
		for (const l of r.data.limits) {
			if (l.type === "TOKENS_LIMIT" && l.unit === 3)
				snap.fiveHour = { pct: l.percentage ?? 0, resetTs: l.nextResetTime };
			else if (l.type === "TOKENS_LIMIT" && l.unit === 6)
				snap.weekly = { pct: l.percentage ?? 0, resetTs: l.nextResetTime };
			else if (l.type === "TIME_LIMIT") {
				const used = l.currentValue ?? 0;
				const total = (l.usage ?? 0) || used + (l.remaining ?? 0);
				snap.mcp = { used, total, details: l.usageDetails ?? [] };
			}
		}

		// 订阅有效期（尽力而为，失败不影响）
		try {
			const s = (await (
				await fetch(`${resolved.baseUrl}${SUB_PATH}`, { headers, signal: AbortSignal.timeout(10000) })
			).json()) as { data?: Array<{ valid?: string }> };
			const m = s.data?.[0]?.valid?.match(/\d{4}-\d{2}-\d{2}/g);
			if (m?.length) snap.expiry = m[m.length - 1];
		} catch {
			/* ignore */
		}
		return { ok: true, snap };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : "fetch failed" };
	}
}

function getSnapshot(agentDir: string, force = false): Promise<FetchResult> {
	if (!force && cached && Date.now() - cached.t < REFRESH_MS) return Promise.resolve(cached.res);
	return fetchSnapshot(agentDir).then((res) => {
		cached = { t: Date.now(), res };
		return res;
	});
}

/** footer 常驻状态：GLM ⚡余84%|77% M17/4k（5h|周 剩余 + MCP 已用/总次数） */
function renderStatusText(res: FetchResult, fg: (color: string, text: string) => string): string | null {
	if (!res.ok) return fg("dim", "GLM ?");
	const { fiveHour, weekly, mcp } = res.snap;
	if (!fiveHour) return null;
	const used = fiveHour.pct;
	const remaining = Math.max(0, 100 - used);
	const color = used >= WARN_THRESHOLD ? "error" : used >= 70 ? "warning" : "success";
	const label = `⚡余${remaining}%`;
	const weeklyPart = weekly ? `|${Math.max(0, 100 - weekly.pct)}%` : "";
	let mcpPart = "";
	if (mcp && mcp.total > 0) {
		const mcpPct = (mcp.used / mcp.total) * 100;
		const mcpColor = mcpPct >= 90 ? "error" : mcpPct >= 70 ? "warning" : "dim";
		mcpPart = fg(mcpColor, ` M${fmtCompact(mcp.used)}/${fmtCompact(mcp.total)}`);
	}
	return fg("dim", "GLM ") + fg(color, label) + fg("dim", weeklyPart) + mcpPart;
}

function fmtCompact(n: number): string {
	return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

function renderDetail(res: FetchResult): string {
	if (!res.ok) return `❌ 查询失败: ${res.error}`;
	const s = res.snap;
	const lines: string[] = [`🪙 GLM Coding Plan${s.level ? ` [${s.level}]` : ""}`];
	if (s.fiveHour)
		lines.push(`  5h 窗口  ${bar(s.fiveHour.pct)} ${s.fiveHour.pct}%  重置 ${fmtTime(s.fiveHour.resetTs)}`);
	if (s.weekly) lines.push(`  周用量    ${bar(s.weekly.pct)} ${s.weekly.pct}%  重置 ${fmtTime(s.weekly.resetTs)}`);
	if (s.mcp) {
		const pct = s.mcp.total > 0 ? Math.round((s.mcp.used / s.mcp.total) * 100) : 0;
		const detail = s.mcp.details.slice(0, 3).map((d) => `${d.modelCode}:${d.usage}`).join(" ");
		lines.push(`  MCP 次数  ${bar(pct)} ${s.mcp.used}/${s.mcp.total}${detail ? ` (${detail})` : ""}`);
	}
	if (s.expiry) lines.push(`  订阅有效期至 ${s.expiry}`);
	return lines.join("\n");
}

function usageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function cacheTurns(entries: unknown[]): CacheTurn[] {
	const turns: CacheTurn[] = [];
	for (const entry of entries) {
		const record = entry as {
			type?: unknown;
			timestamp?: unknown;
			message?: {
				role?: unknown;
				provider?: unknown;
				model?: unknown;
				usage?: {
					input?: unknown;
					cacheRead?: unknown;
					cacheWrite?: unknown;
					cacheWrite1h?: unknown;
				};
			};
		};
		if (record.type !== "message" || record.message?.role !== "assistant" || !record.message.usage) continue;
		const usage = record.message.usage;
		const input = usageNumber(usage.input);
		const cacheRead = usageNumber(usage.cacheRead);
		if (input === 0 && cacheRead === 0) continue;
		turns.push({
			...(typeof record.timestamp === "string" ? { at: record.timestamp } : {}),
			input,
			cacheRead,
			cacheWrite: usageNumber(usage.cacheWrite) + usageNumber(usage.cacheWrite1h),
			...(typeof record.message.provider === "string" ? { provider: record.message.provider } : {}),
			...(typeof record.message.model === "string" ? { model: record.message.model } : {}),
		});
	}
	return turns;
}

function tokenCount(value: number): string {
	return value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value);
}

function cacheRate(turn: CacheTurn): number | undefined {
	const total = turn.input + turn.cacheRead;
	return total > 0 ? turn.cacheRead / total : undefined;
}

function timeGap(current: CacheTurn, previous: CacheTurn | undefined): string {
	if (!current.at || !previous?.at) return "-";
	const elapsed = Date.parse(current.at) - Date.parse(previous.at);
	if (!Number.isFinite(elapsed) || elapsed < 0) return "-";
	const seconds = Math.round(elapsed / 1000);
	return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h${Math.round((seconds % 3600) / 60)}m` : seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${seconds}s`;
}

export function renderCacheAudit(entries: unknown[]): string {
	const turns = cacheTurns(entries);
	if (turns.length === 0) return "Cache audit: this session has no provider usage records yet.";
	const recent = turns.slice(-12);
	const totalInput = recent.reduce((sum, turn) => sum + turn.input, 0);
	const totalCached = recent.reduce((sum, turn) => sum + turn.cacheRead, 0);
	const totalWritten = recent.reduce((sum, turn) => sum + turn.cacheWrite, 0);
	const weightedRate = totalInput + totalCached > 0 ? totalCached / (totalInput + totalCached) : 0;
	const coldTurns = recent.filter((turn) => (cacheRate(turn) ?? 0) < 0.1).length;
	const lines = [
		`Cache audit | last ${recent.length} provider turns`,
		`Weighted hit: ${Math.round(weightedRate * 100)}% | cache read ${tokenCount(totalCached)} / total ${tokenCount(totalInput + totalCached)}${totalWritten > 0 ? ` | cache write ${tokenCount(totalWritten)}` : ""}`,
		`Low-cache turns: ${coldTurns}/${recent.length} (TTL expiry, compaction, routing, or context changes require comparison; this is not a cost estimate).`,
		"Recent:",
	];
	for (const [index, turn] of recent.entries()) {
		const previous = recent[index - 1];
		const rate = cacheRate(turn);
		const route = [turn.provider, turn.model].filter(Boolean).join("/");
		lines.push(
			`${index + 1}. +${timeGap(turn, previous)} | ${rate === undefined ? "-" : `${Math.round(rate * 100)}%`} | in ${tokenCount(turn.input)} cache ${tokenCount(turn.cacheRead)}${route ? ` | ${route}` : ""}`,
		);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	// 防回归：默认注册（footer + /usage），禁用必须显式 PI_USAGE_STATS=0。
	// 曾两次被改为 opt-in（需 PI_USAGE_STATS=1），导致用户侧“工具凭空消失”，勿再反转。
	if (process.env.PI_USAGE_STATS === "0") return;

	const agentDir = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pi", "agent");

	// session 替换（/fork /new /resume /reload）走 dispose() 只 invalidate 不发
	// session_shutdown，延迟回调/interval 再碰 ctx 会抛 "ctx is stale ..."
	function isStaleCtx(e: unknown): boolean {
		return e instanceof Error && e.message.includes("ctx is stale");
	}

	async function refreshStatus(ctx: { ui: { setStatus(k: string, t: string | null): void; theme: { fg(c: string, s: string): string } } }) {
		const res = await getSnapshot(agentDir, true);
		// getSnapshot 期间 session 可能被替换，之后的 ctx.ui 调用全部容忍 stale
		let text: string;
		try {
			text = renderStatusText(res, ctx.ui.theme.fg.bind(ctx.ui.theme));
			ctx.ui.setStatus("usage-stats", text);
		} catch (e) {
			if (isStaleCtx(e)) return;
			throw e;
		}
		if (res.ok && res.snap.fiveHour && res.snap.fiveHour.pct >= WARN_THRESHOLD) {
			console.error(
				`[usage-stats] ⚠️ GLM Coding Plan 5h 窗口已用 ${res.snap.fiveHour.pct}%（重置 ${fmtTime(res.snap.fiveHour.resetTs)}），接近限流请控制用量。/usage 查看详情`,
			);
		}
	}

	let statusTimer: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		// 先放占位（避免 footer 闪烁），再异步刷新
		ctx.ui.setStatus("usage-stats", ctx.ui.theme.fg("dim", "GLM …"));
		await refreshStatus(ctx);
		// 每 10 分钟定时刷新；refreshStatus 内部已容忍 stale ctx
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = setInterval(() => void refreshStatus(ctx).catch(() => {}), REFRESH_MS);
		if (typeof statusTimer.unref === "function") statusTimer.unref();
	});

	pi.on("session_shutdown", () => {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
	});

	// 每轮 agent 结束后刷新（token 刚被消耗，数字最有意义）
	pi.on("agent_settled", async (_event, ctx) => {
		await refreshStatus(ctx).catch((e) => {
			if (!isStaleCtx(e)) console.error("[usage-stats] refresh failed:", e);
		});
	});

	pi.registerCommand("usage", {
		description: "查看 GLM 用量；/usage cache 查看本会话 provider cache 诊断",
		handler: async (args, ctx) => {
			if (args.trim() === "cache") {
				ctx.ui.notify(renderCacheAudit(ctx.sessionManager.getEntries()), "info");
				return;
			}
			const res = await getSnapshot(agentDir, true);
			ctx.ui.notify(renderDetail(res), "info");
		},
	});
}
