/**
 * Notify Extension — agent 完成/需要人介入时多通道提醒
 *
 * 触发事件:
 *   - agent_settled: agent 完全结束（无重试/压缩/排队），等待人类 ← 主信号
 *   - 可选: /notify 命令手动测试
 *
 * 通知通道 (通过 ~/.pi/agent/notify-config.json 配置):
 *   1. sound       — macOS 系统音效 (afplay)            [零配置]
 *   2. tts         — macOS 中文语音播报 (say)            [零配置]
 *   3. notifier    — macOS 原生通知 (terminal-notifier)  [已装]
 *   4. ntfy        — 手机推送 (ntfy.sh, 免费无注册)      [需 brew install ntfy + 手机装 App]
 *   5. serverchan  — 微信服务号推送                       [需 sct.ftqq.com 注册获取 SendKey]
 *   6. xiaoai      — 小爱音箱 TTS 播报 (miservice)       [需小米账号 token]
 *
 * 配置示例 (~/.pi/agent/notify-config.json):
 * {
 *   "channels": {
 *     "sound":      { "enabled": true, "sound": "Glass" },
 *     "tts":        { "enabled": false, "voice": "Ting", "phrase": "任务完成" },
 *     "notifier":   { "enabled": true },
 *     "ntfy":       { "enabled": false, "topic": "your-secret-topic", "server": "https://ntfy.sh" },
 *     "serverchan": { "enabled": false, "sendkey": "SCTxxxxxxxx" },
 *     "xiaoai":     { "enabled": false }
 *   }
 * }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const pexec = promisify(exec);

// ── 配置加载 ─────────────────────────────────────────────────
interface ChannelConfig {
	enabled: boolean;
	[key: string]: unknown;
}
interface NotifyConfig {
	channels: Record<string, ChannelConfig>;
}

const DEFAULT_CONFIG: NotifyConfig = {
	channels: {
		sound: { enabled: true, sound: "Glass" },
		tts: { enabled: true, voice: "Ting", phrase: "任务完成" },
		notifier: { enabled: true },
		ntfy: { enabled: false, topic: "", server: "https://ntfy.sh" },
		serverchan: { enabled: false, sendkey: "" },
		xiaoai: { enabled: false },
	},
};

function loadConfig(agentDir: string): NotifyConfig {
	const path = join(agentDir, "notify-config.json");
	if (!existsSync(path)) return DEFAULT_CONFIG;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		// 合并默认值（保证新增通道有默认行为）
		const merged: NotifyConfig = { channels: {} };
		for (const [name, def] of Object.entries(DEFAULT_CONFIG.channels)) {
			merged.channels[name] = { ...def, ...(raw.channels?.[name] ?? {}) };
		}
		return merged;
	} catch {
		return DEFAULT_CONFIG;
	}
}

// ── 通知通道实现（每个都 try-catch，互不影响）───────────────────
type SendResult = { ok: boolean; detail: string };

async function chSound(title: string, _body: string, cfg: ChannelConfig, _agentDir: string): Promise<SendResult> {
	const sound = String(cfg.sound ?? "Glass");
	await pexec(`afplay /System/Library/Sounds/${sound}.aiff`, { timeout: 5000 });
	return { ok: true, detail: `played ${sound}` };
}

async function chTTS(title: string, body: string, cfg: ChannelConfig, _agentDir: string): Promise<SendResult> {
	const voice = String(cfg.voice ?? "Ting");
	const phrase = String(cfg.phrase ?? "任务完成");
	// 用自定义短语；若配置 phrase 为 "auto" 则播报 title
	const text = phrase === "auto" ? title : phrase;
	await pexec(`say -v ${voice} ${JSON.stringify(text)}`, { timeout: 10000 });
	return { ok: true, detail: `said "${text}" via ${voice}` };
}

async function chNotifier(title: string, body: string, _cfg: ChannelConfig, _agentDir: string): Promise<SendResult> {
	const esc = (s: string) => s.replace(/"/g, '\\"').slice(0, 200);
	await pexec(
		`terminal-notifier -title ${JSON.stringify(esc(title))} -message ${JSON.stringify(esc(body))} -sound Glass -group pi-notify`,
		{ timeout: 8000 },
	);
	return { ok: true, detail: "macOS notification sent" };
}

async function chNtfy(title: string, body: string, cfg: ChannelConfig, _agentDir: string): Promise<SendResult> {
	const topic = String(cfg.topic ?? "");
	if (!topic) return { ok: false, detail: "ntfy topic 未配置" };
	const server = String(cfg.server ?? "https://ntfy.sh");
	const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
		method: "POST",
		body: `${title}\n${body}`.slice(0, 4000),
		headers: { Title: "pi agent", Priority: "high", Tags: "robot" },
		signal: AbortSignal.timeout(8000),
	});
	return res.ok ? { ok: true, detail: `ntfy pushed to ${topic}` } : { ok: false, detail: `ntfy HTTP ${res.status}` };
}

async function chServerChan(title: string, body: string, cfg: ChannelConfig, _agentDir: string): Promise<SendResult> {
	const sendkey = String(cfg.sendkey ?? "");
	if (!sendkey) return { ok: false, detail: "serverchan sendkey 未配置" };
	const res = await fetch(`https://sctapi.ftqq.com/${sendkey}.send`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ title: title.slice(0, 32), desp: body.slice(0, 30000) }),
		signal: AbortSignal.timeout(10000),
	});
	const data = (await res.json().catch(() => ({}))) as { code?: number };
	return data.code === 0 ? { ok: true, detail: "serverchan pushed to WeChat" } : { ok: false, detail: `serverchan HTTP ${res.status}` };
}

async function chXiaoai(title: string, _body: string, cfg: ChannelConfig, agentDir: string): Promise<SendResult> {
	// 通过 micli (miservice) 让小爱播报
	const text = String(cfg.phrase ?? "任务完成，请查看");
	const script = join(agentDir, "scripts", "xiaoai-tts.sh");
	const { stdout } = await pexec(`bash ${JSON.stringify(script)} ${JSON.stringify(text)}`, { timeout: 20000 });
	return { ok: true, detail: stdout.trim() || "xiaoai tts sent" };
}

const CHANNELS: Record<string, (t: string, b: string, c: ChannelConfig, d: string) => Promise<SendResult>> = {
	sound: chSound,
	tts: chTTS,
	notifier: chNotifier,
	ntfy: chNtfy,
	serverchan: chServerChan,
	xiaoai: chXiaoai,
};

// ── 从最后一条 assistant 消息提取摘要 ──────────────────────────
function summarizeLastMessage(messages: unknown[]): { title: string; body: string } {
	type Msg = { role?: string; content?: unknown };
	const last = [...messages].reverse().find((m): m is Msg => {
		const msg = m as Msg;
		return msg?.role === "assistant";
	});
	let text = "";
	if (last) {
		const c = last.content;
		if (typeof c === "string") text = c;
		else if (Array.isArray(c)) {
			text = c
				.filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && "type" in (b as object))
				.map((b) => (b.type === "text" ? (b.text ?? "") : ""))
				.join(" ");
		}
	}
	// 清理 markdown/换行，截断
	text = text.replace(/[#*`>\[\]]/g, "").replace(/\s+/g, " ").trim();
	const title = text ? "pi: " + text.slice(0, 60) : "pi agent 任务完成";
	const body = text ? text.slice(0, 300) : "agent 已结束，等待你的下一步指令";
	return { title, body };
}

// ── 扩展入口 ─────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	// agent_settled 后不立即通知：用户可能马上输入下一条。短延迟 + 检查是否仍在 idle
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let running = false;

	async function dispatch(title: string, body: string) {
		if (running) return; // 避免重复通知
		running = true;
		try {
			const agentDir = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pi", "agent");
			const config = loadConfig(agentDir);
			const results: string[] = [];
			for (const [name, ch] of Object.entries(config.channels)) {
				if (!ch.enabled) continue;
				const fn = CHANNELS[name];
				if (!fn) continue;
				try {
					const r = await fn(title, body, ch, agentDir);
					results.push(`${name}: ${r.ok ? "✓" : "✗"} ${r.detail}`);
				} catch (err) {
					results.push(`${name}: ✗ ${err instanceof Error ? err.message.slice(0, 80) : "failed"}`);
				}
			}
			if (results.length) console.error(`[notify] ${results.join(" | ")}`);
		} finally {
			running = false;
		}
	}

	pi.on("agent_settled", async () => {
		// 短暂延迟：如果用户在 2 秒内开始输入则跳过通知
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(async () => {
			// 从 event 提取不了 messages（agent_settled 没有 payload），用 agent_end 存的状态
			await dispatch(lastSummary.title, lastSummary.body);
		}, 2000);
	});

	// agent_end 时记录摘要（agent_settled 不带 messages）
	let lastSummary = { title: "pi agent 任务完成", body: "agent 已结束，等待你的下一步指令" };
	pi.on("agent_end", async (event) => {
		const msgs = (event as { messages?: unknown[] }).messages ?? [];
		if (msgs.length) lastSummary = summarizeLastMessage(msgs);
	});

	// 手动测试命令: /notify [自定义文本]
	pi.registerCommand("notify", {
		description: "测试通知通道 (发送测试消息到所有已启用通道)",
		handler: async (args) => {
			const text = args.trim() || "这是一条测试通知";
			await dispatch(`pi 测试: ${text}`, text);
		},
	});

	// 停止时清理
	pi.on("session_shutdown", () => {
		if (settleTimer) clearTimeout(settleTimer);
	});
}
