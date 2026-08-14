/**
 * Goal tracking for Pi sessions.
 *
 * One active objective keeps long-running work focused without turning a
 * checklist into permanent prompt context. State survives compaction in the
 * current Pi process and is recorded in the session transcript through tool
 * calls, but intentionally does not create project files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type GoalStatus = "active" | "complete" | "blocked";

interface Goal {
	objective: string;
	status: GoalStatus;
	startedAt: string;
	tokenBudget?: number;
	reason?: string;
}

let currentGoal: Goal | null = null;

function renderGoal(goal: Goal | null): string {
	if (!goal) return "No active goal.";
	const lines = [
		`Goal: ${goal.objective}`,
		`Status: ${goal.status}`,
		`Started: ${goal.startedAt}`,
	];
	if (goal.tokenBudget) lines.push(`Token budget: ${goal.tokenBudget}`);
	if (goal.reason) lines.push(`Reason: ${goal.reason}`);
	return lines.join("\n");
}

function createGoal(objective: string): string {
	const normalizedObjective = objective.trim();
	if (!normalizedObjective) return "A goal needs a concrete objective.";
	if (currentGoal?.status === "active") {
		return `An active goal already exists.\n${renderGoal(currentGoal)}`;
	}
	currentGoal = {
		objective: normalizedObjective,
		status: "active",
		startedAt: new Date().toISOString(),
	};
	return renderGoal(currentGoal);
}

function updateGoal(status: Exclude<GoalStatus, "active">, reason?: string): string {
	if (!currentGoal || currentGoal.status !== "active") return "No active goal to update.";
	const normalizedReason = reason?.trim();
	if (status === "blocked" && !normalizedReason) {
		return "A blocked goal requires a concrete reason.";
	}
	currentGoal = {
		...currentGoal,
		status,
		...(normalizedReason ? { reason: normalizedReason } : {}),
	};
	return renderGoal(currentGoal);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Set one concrete active goal for the current Pi session. Use only for a multi-step objective that should guide the rest of the session.",
		promptSnippet: "set the session's concrete active objective",
		promptGuidelines: [
			"Create a goal when the user gives a concrete multi-step outcome. Keep the objective outcome-based, not a list of implementation steps.",
			"Do not replace an unfinished active goal; finish it or report it blocked first.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Concrete outcome to achieve.", minLength: 1 }),
			token_budget: Type.Optional(Type.Number({ description: "Optional token budget for this goal.", minimum: 1 })),
		}, { description: "Goal creation input." }),
		async execute(_id, params) {
			const result = createGoal(params.objective);
			if (!currentGoal || !result.startsWith("Goal:")) {
				return {
					content: [{ type: "text", text: result }],
					isError: true,
				};
			}
			if (params.token_budget) currentGoal = { ...currentGoal, tokenBudget: params.token_budget };
			return { content: [{ type: "text", text: renderGoal(currentGoal) }] };
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Show the current Pi session goal and its status.",
		promptSnippet: "check the current session goal",
		parameters: Type.Object({}, { description: "No input is required." }),
		async execute() {
			return { content: [{ type: "text", text: renderGoal(currentGoal) }] };
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Mark the active Pi session goal complete or blocked. Blocked goals require a concrete reason.",
		promptSnippet: "finish or block the current session goal",
		promptGuidelines: [
			"Mark complete only after the requested outcome and its required verification are done.",
			"Mark blocked only when progress cannot continue without an external change or user decision; include the exact blocker.",
		],
		parameters: Type.Object({
			status: Type.Enum({ complete: "complete", blocked: "blocked" }),
			reason: Type.Optional(Type.String({ description: "Required when status is blocked." })),
		}, { description: "Goal status update input." }),
		async execute(_id, params) {
			const result = updateGoal(params.status, params.reason);
			return {
				content: [{ type: "text", text: result }],
				isError: !result.startsWith("Goal:"),
			};
		},
	});

	pi.registerCommand("goal", {
		description: "Manage the current session goal: /goal [objective|done|blocked <reason>|clear]",
		handler: async (args, ctx) => {
			const input = args.trim();
			let result: string;

			if (!input) {
				result = renderGoal(currentGoal);
			} else if (input === "done") {
				result = updateGoal("complete");
			} else if (input === "clear") {
				if (currentGoal?.status === "active") {
					result = "Cannot clear an active goal. Use /goal done or /goal blocked <reason> first.";
				} else if (!currentGoal) {
					result = "No goal to clear.";
				} else {
					currentGoal = null;
					result = "Goal cleared.";
				}
			} else if (input === "blocked" || input.startsWith("blocked ")) {
				result = updateGoal("blocked", input.slice("blocked".length));
			} else if (input === "help") {
				result = [
					"/goal <objective> - create a goal",
					"/goal - show the current goal",
					"/goal done - complete the active goal",
					"/goal blocked <reason> - mark it blocked",
					"/goal clear - clear a completed or blocked goal",
				].join("\n");
			} else {
				result = createGoal(input);
			}

			ctx.ui.notify(result, result.startsWith("Goal:") || result === "Goal cleared." ? "info" : "warning");
		},
	});
}
