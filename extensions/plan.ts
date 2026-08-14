/**
 * update_plan — Codex 风格的任务计划跟踪工具
 *
 * 让模型在复杂任务中维护一个可见的 step-by-step checklist，
 * 用户能实时看到进度，模型也更容易保持任务结构。
 *
 * 用法（模型侧）：
 *   update_plan({ steps: [
 *     { step: "定位 IM 发送链路", status: "completed" },
 *     { step: "修补 message provider", status: "in_progress" },
 *     { step: "运行 limao_core 测试", status: "pending" },
 *   ]})
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	let planHistory: string[] = [];

	pi.registerTool({
		name: "update_plan",
		label: "Update Plan (task checklist)",
		description:
			"Track task progress with a step checklist rendered to the user. Create a plan for non-trivial multi-step tasks (NOT for simple single-step queries). Each call REPLACES the full plan state. Keep steps short (5-7 words each, max 7 steps). There must be exactly one in_progress step until all are completed.",
		promptSnippet: "show a task checklist with pending/in_progress/completed steps for multi-step work",
		promptGuidelines: [
			"Use update_plan for non-trivial multi-step tasks: 3-7 short steps (5-7 words each). Not for single-step or simple queries",
			"Mark the current step in_progress before working on it; mark completed when done. Exactly one in_progress until all completed",
		],
		parameters: Type.Object({
			steps: Type.Array(
				Type.Object({
					step: Type.String({ description: "Short step description (5-7 words)" }),
					status: Type.Enum({
						pending: "pending",
						in_progress: "in_progress",
						completed: "completed",
					}),
				}),
				{ description: "Full plan state (replaces previous). 1-7 steps." },
			),
		}),
		async execute(_id, params) {
			const { steps } = params;
			if (steps.length === 0) {
				return { content: [{ type: "text", text: "✗ steps 不能为空" }], isError: true };
			}
			if (steps.length > 7) {
				return { content: [{ type: "text", text: `✗ steps 超过 7 个（当前 ${steps.length}），拆分为多个阶段` }], isError: true };
			}

			const icon = (s: string) => (s === "completed" ? "[✓]" : s === "in_progress" ? "[▶]" : "[ ]");
			const rendered = steps.map((s) => `${icon(s.status)} ${s.step}`).join("\n");

			// 统计
			const done = steps.filter((s) => s.status === "completed").length;
			const bar = "█".repeat(done) + "░".repeat(steps.length - done);
			const summary = `${bar} ${done}/${steps.length}`;

			// 记录历史供渲染
			planHistory.push(`${summary}\n${rendered}`);
			if (planHistory.length > 20) planHistory.shift();

			return {
				content: [{ type: "text", text: `${summary}\n${rendered}` }],
			};
		},
	});
}
