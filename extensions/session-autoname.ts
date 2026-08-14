/**
 * session-autoname — session 自动命名（借鉴 dsh session titles + 官方 session-name 示例）
 *
 * 问题：session 存储为 时间戳+UUID，/resume 列表看不出工作内容。
 * 方案：首轮 agent 结束后，自动取首条用户消息的核心内容作为 session 名
 *       （pi.setSessionName 的名字会显示在 /resume 选择器里）。
 *
 * 规则：
 *   - 已有名字的 session（resume / 用户 /name 过）绝不覆盖
 *   - 首条消息太短或太泛（"继续"、"好"）时，向后找第一条有实质内容的用户消息
 *   - ≤30 字符，去 markdown/换行/首部命令斜杠
 *   - 手动改回：/name <新名字>（原生命令）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_LEN = 30;
const MIN_LEN = 4;

function cleanTitle(raw: string): string {
	let t = raw
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[`*#>\[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (t.startsWith("/")) t = t.replace(/^\/\S+\s*/, ""); // 去掉命令本身，留参数描述
	return t;
}

function pickTitle(messages: Array<{ role?: string; content?: unknown }>): string | null {
	const userTexts: string[] = [];
	for (const m of messages) {
		if (m.role !== "user") continue;
		const c = m.content;
		let text = "";
		if (typeof c === "string") text = c;
		else if (Array.isArray(c)) {
			text = c
				.filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && "type" in (b as object))
				.map((b) => (b.type === "text" ? (b.text ?? "") : ""))
				.join(" ");
		}
		text = text.trim();
		// 跳过扩展注入的上下文消息和太短/泛的输入
		if (text.startsWith("[")) continue;
		if (text.length >= MIN_LEN && !/^(继续|好的?|ok|yes|嗯|go|开始|可以)[。.!！\s]*$/i.test(text)) userTexts.push(text);
	}
	const candidate = userTexts.find((t) => t.length >= MIN_LEN) ?? userTexts[0];
	if (!candidate) return null;
	const cleaned = cleanTitle(candidate);
	return cleaned.length >= MIN_LEN ? cleaned.slice(0, MAX_LEN) : null;
}

export default function (pi: ExtensionAPI) {
	let named = false;

	pi.on("session_start", () => {
		named = Boolean(pi.getSessionName());
	});

	pi.on("agent_end", async (event) => {
		if (named) return;
		if (pi.getSessionName()) {
			named = true;
			return;
		}
		const msgs = (event as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
		const title = pickTitle(msgs);
		if (title) {
			try {
				pi.setSessionName(title);
				named = true;
				console.error(`[session-autoname] 已命名本 session：${title}（可用 /name 修改）`);
			} catch {
				/* ctx stale（session 已被替换）：放弃命名 */
			}
		}
	});
}
