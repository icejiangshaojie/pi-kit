/**
 * Goal lifecycle for Pi sessions.
 *
 * A goal names the delivery; update_plan owns its milestones and evidence.
 * Creating or resuming a goal starts a planning turn. Goal completion is only
 * allowed when the bound delivery plan has complete, evidenced milestones.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type GoalStatus = "active" | "paused" | "complete" | "blocked";

interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	startedAt: string;
	tokenBudget?: number;
	reason?: string;
}

interface WorkboardSnapshot {
	goalId?: unknown;
	definitionOfDone?: unknown;
	steps?: unknown;
	blocker?: unknown;
}

let currentGoal: Goal | null = null;

function renderGoal(goal: Goal | null): string {
	if (!goal) return "No session goal.";
	const lines = [
		`Goal: ${goal.objective}`,
		`Status: ${goal.status}`,
		`Started: ${goal.startedAt}`,
	];
	if (goal.tokenBudget) lines.push(`Token budget (advisory): ${goal.tokenBudget}`);
	if (goal.reason) lines.push(`Reason: ${goal.reason}`);
	return lines.join("\n");
}

function isOpen(goal: Goal | null): goal is Goal {
	return Boolean(goal && (goal.status === "active" || goal.status === "paused"));
}

function createGoal(objective: string): string {
	const normalizedObjective = objective.trim();
	if (!normalizedObjective) return "A goal needs a concrete objective.";
	if (isOpen(currentGoal)) return `An unfinished goal already exists.\n${renderGoal(currentGoal)}`;
	const startedAt = new Date().toISOString();
	currentGoal = {
		id: `goal-${startedAt}`,
		objective: normalizedObjective,
		status: "active",
		startedAt,
	};
	return renderGoal(currentGoal);
}

function goalCompletion(entries: unknown[], goal: Goal): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
		if (entry?.type !== "custom" || entry.customType !== "workboard" || !entry.data || typeof entry.data !== "object") continue;
		const plan = entry.data as WorkboardSnapshot;
		if (plan.goalId !== goal.id) return "this goal has no bound delivery plan";
		if (!Array.isArray(plan.definitionOfDone) || plan.definitionOfDone.length === 0) {
			return "the delivery plan has no completion conditions";
		}
		if (typeof plan.blocker === "string" && plan.blocker.trim()) return `the plan is blocked: ${plan.blocker.trim()}`;
		if (!Array.isArray(plan.steps) || plan.steps.length === 0) return "the delivery plan has no milestones";
		for (const step of plan.steps) {
			if (!step || typeof step !== "object") return "the delivery plan contains an invalid milestone";
			const candidate = step as { status?: unknown; evidence?: unknown };
			if (candidate.status !== "completed") return "not all delivery milestones are complete";
			if (typeof candidate.evidence !== "string" || !candidate.evidence.trim()) {
				return "a completed milestone has no evidence";
			}
		}
		return undefined;
	}
	return "this goal has no delivery plan";
}

function updateGoal(status: GoalStatus, entries: unknown[], reason?: string): string {
	if (!currentGoal || !isOpen(currentGoal)) return "No unfinished goal to update.";
	const normalizedReason = reason?.trim();
	if (status === "blocked" && !normalizedReason) return "A blocked goal requires a concrete reason.";
	if (status === "complete") {
		const incomplete = goalCompletion(entries, currentGoal);
		if (incomplete) return `Cannot complete goal: ${incomplete}.`;
	}
	if (status === "paused" && currentGoal.status !== "active") return "Only an active goal can be paused.";
	if (status === "active" && currentGoal.status !== "paused") return "Only a paused goal can be resumed.";
	currentGoal = {
		...currentGoal,
		status,
		...(normalizedReason ? { reason: normalizedReason } : {}),
	};
	return renderGoal(currentGoal);
}

function isGoal(value: unknown): value is Goal {
	if (!value || typeof value !== "object") return false;
	const goal = value as Partial<Goal>;
	return (
		typeof goal.objective === "string" &&
		typeof goal.startedAt === "string" &&
		(goal.id === undefined || typeof goal.id === "string") &&
		(goal.status === "active" || goal.status === "paused" || goal.status === "complete" || goal.status === "blocked") &&
		(goal.tokenBudget === undefined || (typeof goal.tokenBudget === "number" && goal.tokenBudget > 0)) &&
		(goal.reason === undefined || typeof goal.reason === "string")
	);
}

function normalizedGoal(goal: Goal): Goal {
	return goal.id ? goal : { ...goal, id: `goal-${goal.startedAt}` };
}

function publishGoal(pi: ExtensionAPI): void {
	// Goal state is for the lifecycle/UI, not recurring model context.
	pi.appendEntry("goal", currentGoal);
}

function restoreGoal(entries: unknown[]): void {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as
			| { type?: unknown; customType?: unknown; data?: unknown; details?: { goal?: unknown } }
			| undefined;
		if (entry?.customType !== "goal") continue;
		const stored = entry.type === "custom" ? entry.data : entry.type === "custom_message" ? entry.details?.goal : undefined;
		currentGoal = stored === null ? null : isGoal(stored) ? normalizedGoal(stored) : null;
		return;
	}
	currentGoal = null;
}

function planningInstruction(goal: Goal): string {
	return [
		"[Goal lifecycle]",
		`Objective: ${goal.objective}`,
		"Before any research, edit, or other tool call, create an evidence-driven delivery plan with update_plan.",
		"The plan must state user-visible completion conditions, milestones, the first current milestone, and its completion condition.",
		"Do not execute tools until the plan is stored. Then keep it updated with evidence, a factual outcome, and the next delivery.",
	].join("\n");
}

function beginPlanning(pi: ExtensionAPI, ctx: ExtensionContext, goal: Goal): void {
	const instruction = planningInstruction(goal);
	if (ctx.isIdle()) {
		pi.sendUserMessage(instruction);
		return;
	}
	pi.sendUserMessage(instruction, { deliverAs: "steer" });
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		restoreGoal(ctx.sessionManager.getEntries());
	});

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description: "Set one concrete, multi-step delivery goal for the current Pi session.",
		promptSnippet: "set the session's concrete delivery objective",
		promptGuidelines: [
			"Create a goal only when the user gave an explicit multi-step outcome. Keep it outcome-based, not a list of actions.",
			"After creating a goal, call update_plan before any execution tool. Do not replace an unfinished goal.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Concrete outcome to achieve.", minLength: 1 }),
			token_budget: Type.Optional(Type.Number({ description: "Advisory token budget; Pi does not enforce it.", minimum: 1 })),
		}, { description: "Goal creation input." }),
		async execute(_id, params) {
			const result = createGoal(params.objective);
			if (!currentGoal || !result.startsWith("Goal:")) {
				return { content: [{ type: "text", text: result }], isError: true };
			}
			if (params.token_budget) currentGoal = { ...currentGoal, tokenBudget: params.token_budget };
			publishGoal(pi);
			return { content: [{ type: "text", text: `${renderGoal(currentGoal)}\nCreate the delivery plan now with update_plan.` }] };
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Show the current Pi session goal and its lifecycle state.",
		promptSnippet: "check the current session goal",
		parameters: Type.Object({}, { description: "No input is required." }),
		async execute() {
			return { content: [{ type: "text", text: renderGoal(currentGoal) }] };
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Pause, resume, complete, or block the current session goal. Completion requires complete, evidenced milestones.",
		promptSnippet: "update the current session goal lifecycle",
		promptGuidelines: [
			"Mark complete only after every delivery milestone is complete with evidence and the requested outcome is verified.",
			"Mark blocked only when work cannot proceed without a decision or external change; include the exact blocker.",
		],
		parameters: Type.Object({
			status: Type.Enum({ active: "active", paused: "paused", complete: "complete", blocked: "blocked" }),
			reason: Type.Optional(Type.String({ description: "Required for blocked; optional explanation for other transitions." })),
		}, { description: "Goal status update input." }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = updateGoal(params.status, ctx.sessionManager.getEntries(), params.reason);
			if (result.startsWith("Goal:")) publishGoal(pi);
			return { content: [{ type: "text", text: result }], isError: !result.startsWith("Goal:") };
		},
	});

	pi.registerCommand("goal", {
		description: "Manage delivery goal: /goal [objective|pause|resume|done|blocked <reason>|clear]",
		handler: async (args, ctx) => {
			const input = args.trim();
			const previousGoal = renderGoal(currentGoal);
			let result: string;
			let shouldBeginPlanning = false;

			if (!input) {
				result = renderGoal(currentGoal);
			} else if (input === "done") {
				result = updateGoal("complete", ctx.sessionManager.getEntries());
			} else if (input === "pause") {
				result = updateGoal("paused", ctx.sessionManager.getEntries());
				if (result.startsWith("Goal:") && !ctx.isIdle()) ctx.abort();
			} else if (input === "resume") {
				result = updateGoal("active", ctx.sessionManager.getEntries());
				shouldBeginPlanning = result.startsWith("Goal:");
			} else if (input === "clear") {
				if (isOpen(currentGoal)) {
					result = "Cannot clear an unfinished goal. Use /goal done or /goal blocked <reason> first.";
				} else if (!currentGoal) {
					result = "No goal to clear.";
				} else {
					currentGoal = null;
					result = "Goal cleared.";
				}
			} else if (input === "blocked" || input.startsWith("blocked ")) {
				result = updateGoal("blocked", ctx.sessionManager.getEntries(), input.slice("blocked".length));
			} else if (input === "help") {
				result = [
					"/goal <objective> - create a delivery goal and start plan creation",
					"/goal - show the current goal",
					"/goal pause - pause the goal and interrupt current work",
					"/goal resume - resume and continue planning or execution",
					"/goal done - complete only after evidenced milestones",
					"/goal blocked <reason> - mark the goal blocked",
					"/goal clear - clear a completed or blocked goal",
				].join("\n");
			} else {
				result = createGoal(input);
				shouldBeginPlanning = result.startsWith("Goal:");
			}

			if (previousGoal !== renderGoal(currentGoal)) publishGoal(pi);
			ctx.ui.notify(result, result.startsWith("Goal:") || result === "Goal cleared." ? "info" : "warning");
			if (shouldBeginPlanning && currentGoal?.status === "active") beginPlanning(pi, ctx, currentGoal);
		},
	});
}
