/**
 * Plan and execution workboard for Pi.
 *
 * `update_plan` is the only model-facing tool. Everything else is local
 * session telemetry: it is persisted for /resume but never added to model
 * context, keeping long-running work observable without increasing requests.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type StepStatus = "pending" | "in_progress" | "completed";
type WorkEventKind = "agent" | "tool" | "output" | "control" | "warning" | "error";
type WorkEventLevel = "info" | "success" | "warning" | "error";

interface PlanStep {
	step: string;
	status: StepStatus;
}

interface WorkEvent {
	at: number;
	kind: WorkEventKind;
	level: WorkEventLevel;
	text: string;
}

interface WorkboardState {
	steps: PlanStep[];
	paused: boolean;
	focus?: string;
	note?: string;
	events: WorkEvent[];
}

interface ActiveTool {
	id: string;
	name: string;
	startedAt: number;
	lastProgressAt: number;
	lastPreview?: string;
	updates: number;
	lastRecordedOutputAt: number;
	quietReported: boolean;
}

interface GoalSnapshot {
	objective: string;
	status: "active" | "complete" | "blocked";
}

const EMPTY_WORKBOARD: WorkboardState = { steps: [], paused: false, events: [] };
const MAX_STEPS = 7;
const MAX_STEP_LENGTH = 120;
const MAX_NOTE_LENGTH = 240;
const MAX_EVENTS = 30;
const MAX_EVENT_TEXT = 180;
const OUTPUT_EVENT_INTERVAL_MS = 15_000;
const HEARTBEAT_MS = 5_000;
const QUIET_AFTER_MS = 60_000;

function cloneState(state: WorkboardState): WorkboardState {
	return {
		steps: state.steps.map((step) => ({ ...step })),
		paused: state.paused,
		events: state.events.map((event) => ({ ...event })),
		...(state.focus ? { focus: state.focus } : {}),
		...(state.note ? { note: state.note } : {}),
	};
}

function isStep(value: unknown): value is PlanStep {
	if (!value || typeof value !== "object") return false;
	const step = value as Partial<PlanStep>;
	return (
		typeof step.step === "string" &&
		step.step.trim().length > 0 &&
		(step.status === "pending" || step.status === "in_progress" || step.status === "completed")
	);
}

function isWorkEvent(value: unknown): value is WorkEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<WorkEvent>;
	return (
		typeof event.at === "number" &&
		typeof event.text === "string" &&
		(event.kind === "agent" ||
			event.kind === "tool" ||
			event.kind === "output" ||
			event.kind === "control" ||
			event.kind === "warning" ||
			event.kind === "error") &&
		(event.level === "info" || event.level === "success" || event.level === "warning" || event.level === "error")
	);
}

function isWorkboardState(value: unknown): value is WorkboardState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<WorkboardState>;
	return (
		Array.isArray(state.steps) &&
		state.steps.every(isStep) &&
		typeof state.paused === "boolean" &&
		(state.focus === undefined || typeof state.focus === "string") &&
		(state.note === undefined || typeof state.note === "string") &&
		(state.events === undefined || (Array.isArray(state.events) && state.events.every(isWorkEvent)))
	);
}

function validateSteps(steps: PlanStep[]): string | undefined {
	if (steps.length === 0) return "steps cannot be empty";
	if (steps.length > MAX_STEPS) return `steps exceed ${MAX_STEPS}; split the work into phases`;
	if (steps.some((step) => step.step.length > MAX_STEP_LENGTH)) {
		return `each step must be ${MAX_STEP_LENGTH} characters or fewer`;
	}
	const active = steps.filter((step) => step.status === "in_progress").length;
	const complete = steps.every((step) => step.status === "completed");
	if (!complete && active !== 1) return "exactly one step must be in_progress until the plan is complete";
	return undefined;
}

function currentStep(state: WorkboardState): PlanStep | undefined {
	return state.steps.find((step) => step.status === "in_progress");
}

function progress(state: WorkboardState): { completed: number; total: number } {
	return {
		completed: state.steps.filter((step) => step.status === "completed").length,
		total: state.steps.length,
	};
}

function stepIcon(status: StepStatus): string {
	return status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]";
}

function eventIcon(event: WorkEvent): string {
	if (event.level === "error") return "[!]";
	if (event.level === "warning") return "[?]";
	if (event.level === "success") return "[x]";
	return event.kind === "output" ? "[.]" : ">";
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function truncate(text: string, max = MAX_EVENT_TEXT): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function redact(text: string): string {
	return text
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/((?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)\S+/gi, "$1[redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
}

function previewUnknown(value: unknown, depth = 0): string | undefined {
	if (depth > 3 || value === undefined || value === null) return undefined;
	if (typeof value === "string") return truncate(redact(value).replace(/\s+/g, " ").trim());
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const preview = previewUnknown(item, depth + 1);
			if (preview) return preview;
		}
		return undefined;
	}
	if (typeof value !== "object") return undefined;
	const object = value as Record<string, unknown>;
	for (const key of ["text", "output", "stdout", "stderr", "message", "content", "summary", "detail"]) {
		const preview = previewUnknown(object[key], depth + 1);
		if (preview) return preview;
	}
	return undefined;
}

function agentContext(state: WorkboardState): string | undefined {
	const current = currentStep(state);
	if (!current && !state.focus && !state.note && !state.paused) return undefined;

	const lines = ["[WORKBOARD]"];
	if (state.paused) {
		lines.push("Work is paused. Do not call tools or make changes until the user resumes it with /work resume.");
		return lines.join("\n");
	}
	if (current) lines.push(`Current plan step: ${current.step}`);
	if (state.focus) lines.push(`User priority: ${state.focus}`);
	if (state.note) lines.push(`User adjustment: ${state.note}`);
	lines.push("Keep the plan current with update_plan when the work materially changes.");
	return lines.join("\n");
}

function restoreState(entries: unknown[]): WorkboardState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
		if (entry?.type !== "custom" || entry.customType !== "workboard") continue;
		if (!isWorkboardState(entry.data)) return cloneState(EMPTY_WORKBOARD);
		return {
			...cloneState(EMPTY_WORKBOARD),
			...cloneState(entry.data),
			events: entry.data.events?.slice(-MAX_EVENTS).map((event) => ({ ...event })) ?? [],
		};
	}
	return cloneState(EMPTY_WORKBOARD);
}

function activeGoal(entries: unknown[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as
			| { type?: unknown; customType?: unknown; details?: { goal?: Partial<GoalSnapshot> | null } }
			| undefined;
		if (entry?.type !== "custom_message" || entry.customType !== "goal") continue;
		const goal = entry.details?.goal;
		return goal?.status === "active" && typeof goal.objective === "string" ? goal.objective : undefined;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let state = cloneState(EMPTY_WORKBOARD);
	const activeTools = new Map<string, ActiveTool>();
	let agentStartedAt: number | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

	function currentTool(): ActiveTool | undefined {
		let latest: ActiveTool | undefined;
		for (const tool of activeTools.values()) latest = tool;
		return latest;
	}

	function agentRunning(): boolean {
		return agentStartedAt !== undefined;
	}

	function persist(): void {
		// Custom entries survive /resume but are excluded from model context.
		pi.appendEntry("workboard", cloneState(state));
	}

	function addEvent(kind: WorkEventKind, level: WorkEventLevel, text: string, save = true): void {
		state = {
			...state,
			events: [...state.events, { at: Date.now(), kind, level, text: truncate(text) }].slice(-MAX_EVENTS),
		};
		if (save) persist();
	}

	function currentActivity(now = Date.now()): string {
		const tool = currentTool();
		if (state.paused) return "PAUSED";
		if (tool) {
			const quietFor = now - tool.lastProgressAt;
			const quiet = quietFor >= QUIET_AFTER_MS
				? ` quiet ${formatDuration(quietFor)}`
				: ` ${tool.lastPreview ? "out" : "active"} ${formatDuration(quietFor)}`;
			return `${tool.name} ${formatDuration(now - tool.startedAt)}${quiet}`;
		}
		if (agentStartedAt) return `thinking ${formatDuration(now - agentStartedAt)}`;
		return "idle";
	}

	function renderPlanLines(): string[] {
		return state.steps.map((step, index) => `${index + 1}. ${stepIcon(step.status)} ${step.step}`);
	}

	function renderEventLines(limit = 4): string[] {
		return state.events.slice(-limit).map((event) => `${formatTime(event.at)} ${eventIcon(event)} ${event.text}`);
	}

	function renderOverview(eventLimit = 4, goal?: string): string[] {
		const now = Date.now();
		const { completed, total } = progress(state);
		const current = currentStep(state);
		const tool = currentTool();
		const heading = total > 0 ? `WORK ${completed}/${total} | ${currentActivity(now)}` : `WORK | ${currentActivity(now)}`;
		const lines = [heading];
		if (goal) lines.push(`Goal: ${truncate(goal)}`);
		if (current) lines.push(`Step: ${current.step}`);
		if (tool) {
			lines.push(
				`Tool: ${tool.name} | updates ${tool.updates} | ${tool.lastPreview ? "last output" : "last activity"} ${formatDuration(now - tool.lastProgressAt)} ago`,
			);
			if (tool.lastPreview) lines.push(`Last: ${tool.lastPreview}`);
		}
		if (state.focus) lines.push(`Priority: ${state.focus}`);
		if (state.note) lines.push(`Note: ${state.note}`);
		if (state.steps.length > 0) lines.push(...renderPlanLines());
		const events = renderEventLines(eventLimit);
		if (events.length > 0) lines.push("Recent:", ...events);
		return lines;
	}

	function refresh(ctx: ExtensionContext): void {
		if (state.steps.length === 0 && !agentRunning() && activeTools.size === 0) {
			ctx.ui.setStatus("workboard", undefined);
			ctx.ui.setWidget("workboard", undefined);
			ctx.ui.setWorkingMessage(undefined);
			return;
		}

		const now = Date.now();
		const { completed, total } = progress(state);
		const current = currentStep(state);
		const tool = currentTool();
		const prefix = total > 0 ? `W ${completed}/${total}` : "W";
		ctx.ui.setStatus("workboard", `${prefix} | ${currentActivity(now)}`);
		ctx.ui.setWidget("workboard", renderOverview(4, activeGoal(ctx.sessionManager.getEntries())));
		if (agentRunning()) {
			const focus = tool ? `${tool.name} ${formatDuration(now - tool.startedAt)}` : current?.step ?? "planning";
			ctx.ui.setWorkingMessage(`Working: ${focus}`);
		} else {
			ctx.ui.setWorkingMessage(undefined);
		}
	}

	function safelyRefresh(ctx: ExtensionContext): void {
		try {
			refresh(ctx);
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("ctx is stale")) throw error;
		}
	}

	function workInstruction(ctx: ExtensionContext, instruction: string): void {
		if (ctx.isIdle()) {
			pi.sendUserMessage(instruction);
			return;
		}
		pi.sendUserMessage(instruction, { deliverAs: "steer" });
	}

	function heartbeat(ctx: ExtensionContext): void {
		if (!agentRunning()) return;
		const now = Date.now();
		for (const tool of activeTools.values()) {
			const quietFor = now - tool.lastProgressAt;
			if (quietFor >= QUIET_AFTER_MS && !tool.quietReported) {
				tool.quietReported = true;
				addEvent("warning", "warning", `${tool.name} has no progress event for ${formatDuration(quietFor)}`);
			}
		}
		safelyRefresh(ctx);
	}

	function startHeartbeat(ctx: ExtensionContext): void {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = setInterval(() => {
			try {
				heartbeat(ctx);
			} catch {
				// A replaced session owns a new context and its own timer.
			}
		}, HEARTBEAT_MS);
		if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
	}

	pi.on("session_start", (_event, ctx) => {
		state = restoreState(ctx.sessionManager.getEntries());
		activeTools.clear();
		agentStartedAt = undefined;
		startHeartbeat(ctx);
		safelyRefresh(ctx);
	});

	pi.on("session_shutdown", () => {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		activeTools.clear();
	});

	// Persist only the current compact instruction, not the telemetry history.
	pi.on("context", async (event) => {
		let newestContextIndex = -1;
		for (let index = event.messages.length - 1; index >= 0; index -= 1) {
			const message = event.messages[index] as { customType?: unknown } | undefined;
			if (message?.customType === "workboard-context") {
				newestContextIndex = index;
				break;
			}
		}
		if (newestContextIndex < 0) return;
		return {
			messages: event.messages.filter((message, index) => {
				const customType = (message as { customType?: unknown }).customType;
				return customType !== "workboard-context" || index === newestContextIndex;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		const content = agentContext(state);
		if (!content) return;
		return { message: { customType: "workboard-context", content, display: false } };
	});

	pi.on("agent_start", (_event, ctx) => {
		agentStartedAt = Date.now();
		addEvent("agent", "info", "Agent started");
		safelyRefresh(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		const elapsed = agentStartedAt ? formatDuration(Date.now() - agentStartedAt) : undefined;
		agentStartedAt = undefined;
		activeTools.clear();
		addEvent("agent", "info", `Agent idle${elapsed ? ` after ${elapsed}` : ""}`);
		safelyRefresh(ctx);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const now = Date.now();
		activeTools.set(event.toolCallId, {
			id: event.toolCallId,
			name: event.toolName,
			startedAt: now,
			lastProgressAt: now,
			updates: 0,
			lastRecordedOutputAt: now,
			quietReported: false,
		});
		addEvent("tool", "info", `${event.toolName} started`);
		safelyRefresh(ctx);
	});

	pi.on("tool_execution_update", (event, ctx) => {
		const tool = activeTools.get(event.toolCallId);
		if (!tool) return;
		const now = Date.now();
		const preview = previewUnknown(event.partialResult);
		tool.lastProgressAt = now;
		tool.updates += 1;
		tool.quietReported = false;
		if (preview) tool.lastPreview = preview;
		if (preview && now - tool.lastRecordedOutputAt >= OUTPUT_EVENT_INTERVAL_MS) {
			tool.lastRecordedOutputAt = now;
			addEvent("output", "info", `${tool.name}: ${preview}`);
		}
		safelyRefresh(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const tool = activeTools.get(event.toolCallId);
		activeTools.delete(event.toolCallId);
		const elapsed = tool ? formatDuration(Date.now() - tool.startedAt) : undefined;
		const preview = previewUnknown(event.result) ?? tool?.lastPreview;
		const outcome = event.isError ? "failed" : "completed";
		addEvent(
			event.isError ? "error" : "tool",
			event.isError ? "error" : "success",
			`${event.toolName} ${outcome}${elapsed ? ` in ${elapsed}` : ""}${preview ? `: ${preview}` : ""}`,
		);
		safelyRefresh(ctx);
	});

	pi.on("tool_call", (event) => {
		if (!state.paused) return;
		return {
			block: true,
			reason: "Workboard is paused. Wait for the user to run /work resume before calling tools.",
		};
	});

	pi.registerTool({
		name: "update_plan",
		label: "Update Plan (task checklist)",
		description:
			"Track task progress with a step checklist rendered to the user. Create a plan for non-trivial multi-step tasks (not for simple single-step queries). Each call replaces the full plan state. Keep steps short (5-7 words each, max 7 steps). There must be exactly one in_progress step until all are completed.",
		promptSnippet: "show a task checklist with pending/in_progress/completed steps for multi-step work",
		promptGuidelines: [
			"Use update_plan for non-trivial multi-step tasks: 3-7 short steps (5-7 words each). Not for single-step or simple queries.",
			"Mark the current step in_progress before working on it; mark completed when done. Exactly one in_progress until all completed.",
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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const nextSteps = params.steps.map((step) => ({ ...step, step: step.step.trim() }));
			const error = validateSteps(nextSteps);
			if (error) return { content: [{ type: "text", text: `Plan rejected: ${error}` }], isError: true };

			state = {
				...state,
				steps: nextSteps,
				...(state.focus && !nextSteps.some((step) => step.step === state.focus) ? { focus: undefined } : {}),
			};
			addEvent("control", "info", `Plan updated: ${progress(state).completed}/${state.steps.length}`);
			safelyRefresh(ctx);
			return { content: [{ type: "text", text: renderOverview(0, activeGoal(ctx.sessionManager.getEntries())).join("\n") }] };
		},
	});

	pi.registerCommand("work", {
		description: "Observe or control work: /work [plan|log|detail|focus <n>|note <text>|pause|resume|clear]",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input || input === "status") {
				ctx.ui.notify(renderOverview(8, activeGoal(ctx.sessionManager.getEntries())).join("\n"), "info");
				return;
			}

			if (input === "plan") {
				const header = state.steps.length === 0 ? "No active plan." : `Plan ${progress(state).completed}/${state.steps.length}`;
				ctx.ui.notify([header, ...renderPlanLines()].join("\n"), "info");
				return;
			}

			if (input === "log" || input === "events") {
				const lines = renderEventLines(MAX_EVENTS);
				ctx.ui.notify(lines.length > 0 ? ["Work log", ...lines].join("\n") : "No work events yet.", "info");
				return;
			}

			if (input === "detail") {
				ctx.ui.notify(renderOverview(MAX_EVENTS, activeGoal(ctx.sessionManager.getEntries())).join("\n"), "info");
				return;
			}

			if (input === "help") {
				ctx.ui.notify(
					[
						"/work - overview: plan, current tool, recent events",
						"/work plan - full checklist",
						"/work log - recent tool and agent events",
						"/work detail - checklist and complete local log",
						"/work focus <n> - prioritize a plan step",
						"/work note <text> - steer the current work",
						"/work pause - interrupt the turn and block tools",
						"/work resume - allow tools and continue",
						"/work clear - clear a completed workboard",
					].join("\n"),
					"info",
				);
				return;
			}

			if (input === "pause") {
				if (state.paused) {
					ctx.ui.notify("Work is already paused.", "info");
					return;
				}
				state = { ...state, paused: true };
				addEvent("control", "warning", "Work paused by user");
				safelyRefresh(ctx);
				if (!ctx.isIdle()) ctx.abort();
				ctx.ui.notify("Work paused. The current turn was interrupted and tools are blocked.", "info");
				return;
			}

			if (input === "resume") {
				if (!state.paused) {
					ctx.ui.notify("Work is not paused.", "info");
					return;
				}
				state = { ...state, paused: false };
				addEvent("control", "info", "Work resumed by user");
				safelyRefresh(ctx);
				workInstruction(ctx, "[Workboard] Resume the paused work. Continue from the current plan step and keep the plan updated.");
				return;
			}

			if (input === "clear") {
				if (state.steps.length === 0) {
					ctx.ui.notify("No workboard is active.", "info");
					return;
				}
				if (state.steps.some((step) => step.status !== "completed")) {
					ctx.ui.notify("Only a completed plan can be cleared.", "warning");
					return;
				}
				state = cloneState(EMPTY_WORKBOARD);
				persist();
				safelyRefresh(ctx);
				ctx.ui.notify("Completed workboard cleared.", "info");
				return;
			}

			if (input === "focus clear") {
				if (!state.focus) {
					ctx.ui.notify("No work priority is set.", "info");
					return;
				}
				state = { ...state, focus: undefined };
				addEvent("control", "info", "Temporary priority cleared");
				safelyRefresh(ctx);
				workInstruction(ctx, "[Workboard] Clear the temporary priority and follow the current plan order.");
				return;
			}

			if (input.startsWith("focus ")) {
				const requestedText = input.slice("focus ".length).trim();
				if (!/^\d+$/.test(requestedText)) {
					ctx.ui.notify("Usage: /work focus <step number>", "warning");
					return;
				}
				const requested = Number.parseInt(requestedText, 10);
				if (requested < 1 || requested > state.steps.length) {
					ctx.ui.notify("Usage: /work focus <step number>", "warning");
					return;
				}
				const step = state.steps[requested - 1];
				if (!step) return;
				state = { ...state, focus: step.step };
				addEvent("control", "info", `Priority set to step ${requested}: ${step.step}`);
				safelyRefresh(ctx);
				workInstruction(ctx, `[Workboard] Prioritize step ${requested}: ${step.step}. Re-plan first if this changes the safe execution order.`);
				return;
			}

			if (input.startsWith("note ")) {
				const note = input.slice("note ".length).trim();
				if (!note) {
					ctx.ui.notify("Usage: /work note <adjustment>", "warning");
					return;
				}
				const boundedNote = note.slice(0, MAX_NOTE_LENGTH);
				state = { ...state, note: boundedNote };
				addEvent("control", "info", `User adjustment: ${boundedNote}`);
				safelyRefresh(ctx);
				workInstruction(ctx, `[Workboard] User adjustment: ${boundedNote}`);
				return;
			}

			ctx.ui.notify("Unknown /work command. Use /work help.", "warning");
		},
	});
}
