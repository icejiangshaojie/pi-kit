/**
 * repeat-tool-reminder — 循环卫生防护（借鉴 deepseek-harness packages/guard/repeat-tool-reminder）
 *
 * 检测完全重复调用，注入 advisory 提醒（不阻断，只提示）。
 * 写后读取可能是格式化、生成文件或并发改动后的必要复核，不做启发式拦截。
 *
 * 提醒通过 pi.sendMessage({deliverAs:"steer"}) 在当前批工具执行完、下次 LLM 调用前送达。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const IDENTICAL_THRESHOLD = 3; // 连续完全相同调用次数阈值
const REMINDER_STEP = 2; // 提醒后需再重复多少次才再次提醒

function canonicalArgs(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const keys = Object.keys(args).sort();
	return keys.map((k) => `${k}=${JSON.stringify(args[k] ?? null)}`).join("&");
}

export default function (pi: ExtensionAPI) {
	// ── 状态（每个 agent run 重置）──
	let lastKey = "";
	let identicalCount = 0;
	let nextRemindAt = IDENTICAL_THRESHOLD;
	pi.on("agent_start", () => {
		lastKey = "";
		identicalCount = 0;
		nextRemindAt = IDENTICAL_THRESHOLD;
	});

	async function remind(ctx: { isIdle(): boolean }, content: string) {
		if (ctx.isIdle()) return; // idle 时 steer 无意义
		try {
			await pi.sendMessage(
				{ customType: "repeat-guard", content, display: true },
				{ deliverAs: "steer", triggerTurn: false },
			);
		} catch {
			/* 注入失败不影响主流程 */
		}
	}

	pi.on("tool_execution_start", async (event, ctx) => {
		const tool = event.toolName;
		const args = event.args as Record<string, unknown> | undefined;

		// 检测 1：完全重复
		const key = `${tool}|${canonicalArgs(args)}`;
		if (key === lastKey) {
			identicalCount++;
			if (identicalCount >= nextRemindAt) {
				nextRemindAt = identicalCount + REMINDER_STEP;
				await remind(
					ctx,
					`[guard] 「${tool}」已用完全相同的参数连续执行 ${identicalCount} 次，结果不会变化。` +
						`请停下来检查假设：路径是否写错？工具是否真的生效？必要时换一种方式验证，不要原样重试。`,
				);
			}
		} else {
			lastKey = key;
			identicalCount = 1;
			nextRemindAt = IDENTICAL_THRESHOLD;
		}

	});

	pi.on("tool_execution_end", async (event) => {
		// 工具失败后清空 identical 计数：失败重试本身合理，等成功后连续才算重复
		if (event.isError) {
			identicalCount = 0;
			nextRemindAt = IDENTICAL_THRESHOLD;
		}
	});
}
