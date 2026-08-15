/**
 * Plan-first workboard for Pi.
 *
 * `update_plan` is the only model-facing tool. The durable plan explains the
 * intended delivery and completion evidence; tool telemetry remains local and
 * is only shown through /work activity or /work log.
 */

import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type StepStatus = "pending" | "in_progress" | "completed";
type WorkEventKind = "agent" | "tool" | "output" | "control" | "warning" | "error";
type WorkEventLevel = "info" | "success" | "warning" | "error";

interface PlanStep {
	step: string;
	doneWhen: string;
	status: StepStatus;
	evidence?: string;
}

interface TrackedTask {
	id: string;
	objective: string;
	startedAt: number;
}

interface ScopingRequest {
	id: string;
	objective: string;
}

interface WorkEvent {
	at: number;
	kind: WorkEventKind;
	level: WorkEventLevel;
	text: string;
	/** The visible milestone when the event happened; omitted outside planned work. */
	phase?: string;
}

interface WorkboardState {
	schemaVersion: 3;
	goalId?: string;
	task?: TrackedTask;
	steps: PlanStep[];
	definitionOfDone: string[];
	progressSummary?: string;
	nextDeliverable?: string;
	blocker?: string;
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
	id: string;
	objective: string;
	status: "active" | "paused" | "complete" | "blocked";
	reason?: string;
}

const EMPTY_WORKBOARD: WorkboardState = {
	schemaVersion: 3,
	steps: [],
	definitionOfDone: [],
	paused: false,
	events: [],
};
const MAX_STEPS = 7;
const MAX_STEP_LENGTH = 120;
const MAX_DONE_WHEN_LENGTH = 160;
const MAX_DEFINITION_ITEMS = 3;
const MAX_DEFINITION_LENGTH = 160;
const MAX_PROGRESS_SUMMARY_LENGTH = 220;
const MAX_NOTE_LENGTH = 240;
const MAX_EVENTS = 30;
const MAX_EVENT_TEXT = 180;
const OUTPUT_EVENT_INTERVAL_MS = 15_000;
const MAX_UNPLANNED_READ_ONLY_CALLS = 3;
const MAX_UNPLANNED_BOUNDED_CHECKS = 1;
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const READ_ONLY_SHELL_COMMANDS = new Set([
	"rg", "grep", "ls", "find", "sed", "head", "tail", "pwd", "wc", "jq", "stat", "which", "date", "ps", "lsof",
]);
const READ_ONLY_GIT_COMMANDS = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "remote", "tag"]);
const HEARTBEAT_MS = 5_000;
const QUIET_AFTER_MS = 60_000;

function cloneState(state: WorkboardState): WorkboardState {
	return {
		schemaVersion: 3,
		steps: state.steps.map((step) => ({ ...step })),
		definitionOfDone: [...state.definitionOfDone],
		paused: state.paused,
		events: state.events.map((event) => ({ ...event })),
		...(state.goalId ? { goalId: state.goalId } : {}),
		...(state.task ? { task: { ...state.task } } : {}),
		...(state.progressSummary ? { progressSummary: state.progressSummary } : {}),
		...(state.nextDeliverable ? { nextDeliverable: state.nextDeliverable } : {}),
		...(state.blocker ? { blocker: state.blocker } : {}),
		...(state.focus ? { focus: state.focus } : {}),
		...(state.note ? { note: state.note } : {}),
	};
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

function cleanText(value: string, max: number): string {
	return truncate(redact(value).replace(/\s+/g, " ").trim(), max);
}

function cleanOptionalText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = cleanText(value, max);
	return cleaned || undefined;
}

function requestFromPrompt(prompt: string): ScopingRequest | undefined {
	const objective = cleanText(prompt, MAX_STEP_LENGTH);
	return objective ? { id: `task-${Date.now()}`, objective } : undefined;
}

function gitSubcommand(parts: string[]): string | undefined {
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (!part) continue;
		if (["-C", "-c", "--git-dir", "--work-tree", "--config-env"].includes(part)) {
			index += 1;
			continue;
		}
		if (!part.startsWith("-")) return part;
	}
	return undefined;
}

function shellParts(input: unknown): string[] | undefined {
	if (!input || typeof input !== "object") return undefined;
	const command = (input as { command?: unknown }).command;
	if (typeof command !== "string") return undefined;
	const normalized = command.trim();
	if (!normalized || /&&|\|\||[|;`<>]|\$\(|[\r\n]/.test(normalized)) return undefined;
	const parts = normalized.split(/\s+/);
	let executable = parts.shift();
	if (executable === "rtk") executable = parts.shift();
	return executable ? [executable, ...parts] : undefined;
}

function isReadOnlyBash(input: unknown): boolean {
	const parts = shellParts(input);
	if (!parts) return false;
	const executable = parts.shift();
	if (!executable) return false;
	if (executable === "git") {
		const subcommand = gitSubcommand(parts);
		return subcommand !== undefined && READ_ONLY_GIT_COMMANDS.has(subcommand);
	}
	if (!READ_ONLY_SHELL_COMMANDS.has(executable)) return false;
	if (executable === "find" && parts.some((part) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(part))) return false;
	if (executable === "sed" && parts.some((part) => /^-i/.test(part) || part === "--in-place")) return false;
	return true;
}

function isBoundedVerification(input: unknown): boolean {
	const parts = shellParts(input);
	if (!parts) return false;
	const [executable, ...args] = parts;
	const firstArgument = args.find((argument) => !argument.startsWith("-"));
	if (executable === "pytest" || executable === "vitest" || executable === "jest") return true;
	if (executable === "flutter" || executable === "dart" || executable === "go" || executable === "cargo") {
		return firstArgument === "test" || firstArgument === "analyze" || firstArgument === "vet" || firstArgument === "check";
	}
	if (executable === "npm" || executable === "pnpm" || executable === "yarn") {
		return firstArgument === "test" || firstArgument === "lint" || firstArgument === "typecheck" ||
			(args[0] === "run" && ["test", "lint", "typecheck"].includes(args[1] ?? ""));
	}
	return false;
}

function isReadOnlyInspection(toolName: string, input: unknown): boolean {
	return READ_ONLY_TOOLS.has(toolName) || (toolName === "bash" && isReadOnlyBash(input));
}

function isStepStatus(value: unknown): value is StepStatus {
	return value === "pending" || value === "in_progress" || value === "completed";
}

function storedStep(value: unknown): PlanStep | undefined {
	if (!value || typeof value !== "object") return undefined;
	const source = value as Record<string, unknown>;
	const step = cleanOptionalText(source.step, MAX_STEP_LENGTH);
	if (!step || !isStepStatus(source.status)) return undefined;
	const doneWhen = cleanOptionalText(source.doneWhen ?? source.done_when, MAX_DONE_WHEN_LENGTH)
		?? "Completion condition was not recorded.";
	const evidence = cleanOptionalText(source.evidence, MAX_PROGRESS_SUMMARY_LENGTH);
	return { step, doneWhen, status: source.status, ...(evidence ? { evidence } : {}) };
}

function storedTask(value: unknown): TrackedTask | undefined {
	if (!value || typeof value !== "object") return undefined;
	const source = value as Record<string, unknown>;
	const id = cleanOptionalText(source.id, MAX_STEP_LENGTH);
	const objective = cleanOptionalText(source.objective, MAX_STEP_LENGTH);
	const startedAt = typeof source.startedAt === "number" && Number.isFinite(source.startedAt)
		? source.startedAt
		: undefined;
	if (!id || !objective || startedAt === undefined) return undefined;
	return { id, objective, startedAt };
}

function storedEvent(value: unknown): WorkEvent | undefined {
	if (!value || typeof value !== "object") return undefined;
	const event = value as Partial<WorkEvent>;
	if (
		typeof event.at !== "number" ||
		typeof event.text !== "string" ||
		!["agent", "tool", "output", "control", "warning", "error"].includes(event.kind ?? "") ||
		!["info", "success", "warning", "error"].includes(event.level ?? "")
	) {
		return undefined;
	}
	const phase = cleanOptionalText(event.phase, MAX_STEP_LENGTH);
	return {
		at: event.at,
		kind: event.kind,
		level: event.level,
		text: cleanText(event.text, MAX_EVENT_TEXT),
		...(phase ? { phase } : {}),
	};
}

function validateSteps(steps: PlanStep[]): string | undefined {
	if (steps.length === 0) return "steps cannot be empty";
	if (steps.length > MAX_STEPS) return `steps exceed ${MAX_STEPS}; split the work into phases`;
	if (steps.some((step) => step.step.length > MAX_STEP_LENGTH)) {
		return `each step must be ${MAX_STEP_LENGTH} characters or fewer`;
	}
	if (steps.some((step) => step.doneWhen.length === 0 || step.doneWhen.length > MAX_DONE_WHEN_LENGTH)) {
		return `each step needs a completion condition of ${MAX_DONE_WHEN_LENGTH} characters or fewer`;
	}
	if (steps.some((step) => step.status === "completed" && !step.evidence)) {
		return "each completed step needs concise evidence of the achieved result";
	}
	const active = steps.filter((step) => step.status === "in_progress").length;
	const complete = steps.every((step) => step.status === "completed");
	if (!complete && active !== 1) return "exactly one step must be in_progress until the plan is complete";
	return undefined;
}

function validateDefinitionOfDone(items: string[]): string | undefined {
	if (items.length === 0) return "definition_of_done cannot be empty for a new plan";
	if (items.length > MAX_DEFINITION_ITEMS) return `definition_of_done has at most ${MAX_DEFINITION_ITEMS} items`;
	if (items.some((item) => item.length === 0 || item.length > MAX_DEFINITION_LENGTH)) {
		return `each definition_of_done item must be ${MAX_DEFINITION_LENGTH} characters or fewer`;
	}
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

function hasIncompletePlan(state: WorkboardState): boolean {
	return state.steps.some((step) => step.status !== "completed");
}

function isInternalWorkInstruction(prompt: string): boolean {
	return prompt.startsWith("[Workboard]") || prompt.startsWith("[Goal lifecycle]");
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

function previewUnknown(value: unknown, depth = 0): string | undefined {
	if (depth > 3 || value === undefined || value === null) return undefined;
	if (typeof value === "string") return cleanOptionalText(value, MAX_EVENT_TEXT);
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

function restoreState(entries: unknown[]): WorkboardState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
		if (entry?.type !== "custom" || entry.customType !== "workboard" || !entry.data || typeof entry.data !== "object") continue;
		const source = entry.data as Record<string, unknown>;
		const steps = Array.isArray(source.steps)
			? source.steps.flatMap((step): PlanStep[] => {
				const restored = storedStep(step);
				return restored ? [restored] : [];
			})
			: [];
		const rawDefinitionOfDone = source.definitionOfDone ?? source.definition_of_done;
		const definitionOfDone = Array.isArray(rawDefinitionOfDone)
			? rawDefinitionOfDone
				.flatMap((item): string[] => {
					const text = cleanOptionalText(item, MAX_DEFINITION_LENGTH);
					return text ? [text] : [];
				})
				.slice(0, MAX_DEFINITION_ITEMS)
			: [];
		const events = Array.isArray(source.events)
			? source.events.flatMap((event): WorkEvent[] => {
				const restored = storedEvent(event);
				return restored ? [restored] : [];
			}).slice(-MAX_EVENTS)
			: [];
		const progressSummary = cleanOptionalText(source.progressSummary ?? source.progress_summary, MAX_PROGRESS_SUMMARY_LENGTH);
		const nextDeliverable = cleanOptionalText(source.nextDeliverable ?? source.next_deliverable, MAX_PROGRESS_SUMMARY_LENGTH);
		const blocker = cleanOptionalText(source.blocker, MAX_PROGRESS_SUMMARY_LENGTH);
		const focus = cleanOptionalText(source.focus, MAX_STEP_LENGTH);
		const note = cleanOptionalText(source.note, MAX_NOTE_LENGTH);
		const goalId = cleanOptionalText(source.goalId, MAX_STEP_LENGTH);
		const task = storedTask(source.task);
		return {
			schemaVersion: 3,
			steps,
			definitionOfDone,
			paused: source.paused === true,
			events,
			...(goalId ? { goalId } : {}),
			...(task ? { task } : {}),
			...(progressSummary ? { progressSummary } : {}),
			...(nextDeliverable ? { nextDeliverable } : {}),
			...(blocker ? { blocker } : {}),
			...(focus ? { focus } : {}),
			...(note ? { note } : {}),
		};
	}
	return cloneState(EMPTY_WORKBOARD);
}

function latestGoal(entries: unknown[]): GoalSnapshot | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as
			| { type?: unknown; customType?: unknown; data?: Partial<GoalSnapshot> | null; details?: { goal?: Partial<GoalSnapshot> | null } }
			| undefined;
		if (entry?.customType !== "goal") continue;
		const goal = entry.type === "custom" ? entry.data : entry.type === "custom_message" ? entry.details?.goal : undefined;
		if (
			!goal ||
			typeof goal.objective !== "string" ||
			(goal.status !== "active" && goal.status !== "paused" && goal.status !== "complete" && goal.status !== "blocked")
		) {
			return undefined;
		}
		const id = typeof goal.id === "string" && goal.id ? goal.id : `goal-${goal.objective}`;
		const reason = cleanOptionalText(goal.reason, MAX_PROGRESS_SUMMARY_LENGTH);
		return {
			id,
			objective: cleanText(goal.objective, MAX_STEP_LENGTH),
			status: goal.status,
			...(reason ? { reason } : {}),
		};
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let state = cloneState(EMPTY_WORKBOARD);
	const activeTools = new Map<string, ActiveTool>();
	let agentStartedAt: number | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let sessionGoal: GoalSnapshot | undefined;
	let scopingRequest: ScopingRequest | undefined;
	let pendingRequest: ScopingRequest | undefined;
	let unplannedReadOnlyCalls = 0;
	let unplannedBoundedChecks = 0;

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

	function addEvent(kind: WorkEventKind, level: WorkEventLevel, text: string, persistState = false): void {
		const phase = currentStep(state)?.step;
		state = {
			...state,
			events: [
				...state.events,
				{
					at: Date.now(),
					kind,
					level,
					text: cleanText(text, MAX_EVENT_TEXT),
					...(phase ? { phase: cleanText(phase, MAX_STEP_LENGTH) } : {}),
				},
			].slice(-MAX_EVENTS),
		};
		if (persistState) persist();
	}

	function bindGoal(goal: GoalSnapshot | undefined): void {
		if (!goal || (goal.status !== "active" && goal.status !== "paused")) return;
		if (state.goalId === goal.id) return;
		const hadPriorTask = Boolean(state.task || state.steps.length > 0 || state.goalId);
		state = { ...cloneState(EMPTY_WORKBOARD), goalId: goal.id };
		addEvent("control", "info", `${hadPriorTask ? "New goal started" : "Goal bound"}: ${goal.objective}`, true);
	}

	function syncGoal(ctx: ExtensionContext): GoalSnapshot | undefined {
		sessionGoal = latestGoal(ctx.sessionManager.getEntries());
		bindGoal(sessionGoal);
		return sessionGoal;
	}

	function taskForPlan(goal: GoalSnapshot | undefined, action: "continue" | "replace", objective?: string): TrackedTask | undefined {
		if (action === "continue" && state.task) return state.task;
		const taskObjective = objective ?? scopingRequest?.objective ?? pendingRequest?.objective ?? goal?.objective;
		if (!taskObjective) return undefined;
		return {
			id: scopingRequest?.id ?? `task-${Date.now()}`,
			objective: taskObjective,
			startedAt: Date.now(),
		};
	}

	function goalForWorkboard(goal: GoalSnapshot | undefined): GoalSnapshot | undefined {
		return goal && state.goalId === goal.id ? goal : undefined;
	}

	function planStateLabel(goal?: GoalSnapshot): string {
		const workGoal = goalForWorkboard(goal);
		const { completed, total } = progress(state);
		if (state.paused) return "PAUSED";
		if (workGoal?.status === "paused") return "GOAL PAUSED";
		if (workGoal?.status === "blocked") return "GOAL BLOCKED";
		if (state.blocker) return "BLOCKED";
		const current = currentStep(state);
		if (current) {
			const index = state.steps.indexOf(current) + 1;
			return `Stage ${index}/${total}`;
		}
		if (total > 0 && completed === total) return "READY FOR REVIEW";
		if (total > 0) return "PLAN READY";
		if (scopingRequest) return "SCOPING";
		if (workGoal?.status === "active") return "PLANNING GATE";
		if (workGoal?.status === "complete") return "GOAL ACHIEVED";
		return agentRunning() ? "INSPECTING" : "IDLE";
	}

	function planFooter(goal?: GoalSnapshot): string {
		const { completed, total } = progress(state);
		const prefix = total > 0 ? `P ${completed}/${total}` : scopingRequest || agentRunning() ? "REQUEST" : "P";
		const current = currentStep(state);
		return `${prefix} | ${planStateLabel(goal)}${current ? `: ${truncate(current.step, 42)}` : ""}`;
	}

	function latestOutcome(): string | undefined {
		if (state.progressSummary) return state.progressSummary;
		for (let index = state.steps.length - 1; index >= 0; index -= 1) {
			const step = state.steps[index];
			if (step?.status === "completed" && step.evidence) return step.evidence;
		}
		return undefined;
	}

	function nextDelivery(): string | undefined {
		if (state.nextDeliverable) return state.nextDeliverable;
		const current = currentStep(state);
		if (current) return current.doneWhen;
		const next = state.steps.find((step) => step.status === "pending");
		return next ? `${next.step}: ${next.doneWhen}` : undefined;
	}

	function phaseLine(step: PlanStep, index: number): string {
		return `  ${stepIcon(step.status)} ${index + 1}. ${truncate(step.step, 96)}`;
	}

	function phaseSummary(step: PlanStep, index: number): string {
		const evidence = step.status === "completed" ? step.evidence : undefined;
		const detail = evidence ?? (step.status === "in_progress" ? step.doneWhen : undefined);
		return `${phaseLine(step, index)}${detail ? ` · ${truncate(detail, 72)}` : ""}`;
	}

	function latestPhaseEvent(phase: string): WorkEvent | undefined {
		for (let index = state.events.length - 1; index >= 0; index -= 1) {
			const event = state.events[index];
			if (event?.phase === phase && (event.kind === "tool" || event.kind === "output" || event.kind === "error")) return event;
		}
		return undefined;
	}

	function tracePhase(event: WorkEvent): string {
		if (!event.phase) return "";
		const index = state.steps.findIndex((step) => step.step === event.phase);
		return index >= 0 ? `S${index + 1} ` : "";
	}

	/**
	 * The default task surface deliberately stays smaller than `/work`. It is a
	 * stable projection of delivery state plus the current execution episode;
	 * tool cards keep their own rich detail behind Ctrl+O.
	 */
	function renderTaskSurface(goal?: GoalSnapshot): string[] {
		const workGoal = goalForWorkboard(goal);
		const { completed, total } = progress(state);
		const current = currentStep(state);
		const unplannedRequest = total === 0 && !scopingRequest && !workGoal && agentRunning();
		const lines = [
			total > 0
				? `工作 | ${completed}/${total} 完成 | ${planStateLabel(workGoal)}`
				: unplannedRequest
					? "请求 | 正在检查"
					: `工作 | ${planStateLabel(workGoal)}`,
		];

		const objective = workGoal?.objective ?? state.task?.objective ?? scopingRequest?.objective;
		if (objective) lines.push(`${workGoal ? "目标" : "任务"}: ${truncate(objective, 104)}`);

		if (total === 0) {
			if (workGoal?.status === "active") {
				lines.push("下一交付: 建立包含完成条件的交付计划");
			} else if (workGoal?.status === "paused" || state.paused) {
				lines.push("状态: 已暂停，使用 /goal resume 或 /work resume 继续");
			} else if (scopingRequest) {
				lines.push("状态: 正在判断是否需要进入受控执行");
			}
			return lines;
		}

		lines.push("阶段:", ...state.steps.map(phaseLine));
		if (current) {
			lines.push(`当前: ${truncate(current.step, 96)}`);
			const active = [...activeTools.values()];
			if (active.length > 0) {
				const action = active[active.length - 1];
				if (action) {
					lines.push(`行动: ${action.name} · ${formatDuration(Date.now() - action.startedAt)}${action.lastPreview ? ` · ${truncate(action.lastPreview, 80)}` : ""}`);
				}
			} else {
				const event = latestPhaseEvent(current.step);
				if (event) lines.push(`最近行动: ${event.text}`);
			}
		}

		const outcome = latestOutcome();
		if (outcome) lines.push(`最近成果: ${truncate(outcome, 116)}`);
		const next = nextDelivery();
		if (next) lines.push(`下一交付: ${truncate(next, 116)}`);
		if (state.blocker) lines.push(`阻塞: ${truncate(state.blocker, 116)}`);
		if (state.paused || workGoal?.status === "paused") lines.push("状态: 已暂停");
		lines.push("控制: /work pause · /work note <调整> · /trace");
		return lines;
	}

	function renderTrace(goal?: GoalSnapshot): string[] {
		const { completed, total } = progress(state);
		const workGoal = goalForWorkboard(goal);
		const lines = [
			`TRACE | ${total > 0 ? `${completed}/${total} 里程碑` : planStateLabel(workGoal)}`,
			"原始命令、代码、diff 与输出：选中对应工具行后按 Ctrl+O。",
		];
		if (workGoal) lines.push(`目标: ${workGoal.objective}`);
		else if (state.task) lines.push(`任务: ${state.task.objective}`);

		if (state.steps.length > 0) {
			lines.push("阶段轨迹:");
			for (const [index, step] of state.steps.entries()) {
				const events = state.events.filter((event) => event.phase === step.step);
				lines.push(`${phaseLine(step, index)}${events.length > 0 ? ` · ${events.length} 条事件` : ""}`);
				lines.push(...events.map((event) => `    ${formatEventLine(event, false)}`));
			}
			const unassigned = state.events.filter((event) => !event.phase || !state.steps.some((step) => step.step === event.phase));
			if (unassigned.length > 0) lines.push("会话事件:", ...unassigned.map((event) => formatEventLine(event, false)));
			return lines;
		}

		const events = renderEventLines();
		lines.push(events.length > 0 ? "时间线:" : "时间线: 暂无本地执行事件。");
		if (events.length > 0) lines.push(...events);
		return lines;
	}

	function renderPlanLines(): string[] {
		return state.steps.flatMap((step, index) => {
			const title = `${stepIcon(step.status)} ${index + 1}. ${step.step}`;
			if (step.status === "completed") return [title, `    Evidence: ${step.evidence ?? "not recorded"}`];
			return [title, `    Complete when: ${step.doneWhen}`];
		});
	}

	function renderOverview(goal?: GoalSnapshot): string[] {
		const workGoal = goalForWorkboard(goal);
		const { completed, total } = progress(state);
		const current = currentStep(state);
		const unplannedRequest = total === 0 && !scopingRequest && !workGoal && agentRunning();
		const lines = [
			total > 0
				? `PLAN ${completed}/${total} | ${planStateLabel(workGoal)}`
				: unplannedRequest
					? "REQUEST | INSPECTING"
					: `PLAN | ${planStateLabel(workGoal)}`,
		];
		if (workGoal) {
			lines.push(`Goal: ${workGoal.objective} (${workGoal.status})`);
			if (workGoal.reason) lines.push(`Goal note: ${workGoal.reason}`);
		}
		if (state.task) lines.push(`Task: ${state.task.objective}`);
		if (state.definitionOfDone.length > 0) {
			lines.push("Done when:", ...state.definitionOfDone.map((item) => `- ${item}`));
		}
		if (state.steps.length === 0) {
			if (scopingRequest) {
				lines.push(
					`Request: ${scopingRequest.objective}`,
					"Status: deciding whether this request needs execution.",
					"Execution gate: a task plan is required before the first tool call.",
				);
			} else if (workGoal?.status === "active") {
				lines.push(
					"Planning gate: no execution tools run until the agent stores delivery milestones.",
					"Next delivery: an evidence-driven plan with completion conditions.",
				);
			} else if (workGoal?.status === "paused") {
				lines.push("Goal is paused. Run /goal resume to create or continue its delivery plan.");
			} else {
				lines.push("No tracked execution task. Direct questions do not create a plan.");
			}
			return lines;
		}
		lines.push("Milestones:", ...renderPlanLines());
		if (current) {
			lines.push(`Now: ${current.step}`, `Current completion: ${current.doneWhen}`);
		}
		const outcome = latestOutcome();
		if (outcome) lines.push(`Latest outcome: ${outcome}`);
		const next = nextDelivery();
		if (next) lines.push(`Next delivery: ${next}`);
		if (state.blocker) lines.push(`Attention: ${state.blocker}`);
		if (state.paused) lines.push("Attention: work is paused by the user.");
		if (state.focus) lines.push(`User priority: ${state.focus}`);
		if (state.note) lines.push(`User adjustment: ${state.note}`);
		return lines;
	}

	function formatEventLine(event: WorkEvent, showPhase: boolean): string {
		return `${formatTime(event.at)} ${showPhase ? tracePhase(event) : ""}${eventIcon(event)} ${event.text}`;
	}

	function renderEventLines(limit = MAX_EVENTS): string[] {
		return state.events.slice(-limit).map((event) => formatEventLine(event, true));
	}

	function renderActivity(): string[] {
		const now = Date.now();
		const tools = [...activeTools.values()];
		const lines = ["Activity (diagnostic; not plan progress)"];
		if (tools.length === 0 && !agentRunning()) lines.push("No active tools.");
		if (tools.length === 0 && agentRunning()) lines.push("Agent is working between tool calls.");
		for (const tool of tools) {
			const quietFor = now - tool.lastProgressAt;
			lines.push(`- ${tool.name} | ${formatDuration(now - tool.startedAt)} | ${tool.updates} updates | last activity ${formatDuration(quietFor)} ago`);
			if (tool.lastPreview) lines.push(`  Last output: ${tool.lastPreview}`);
		}
		const events = renderEventLines(8);
		if (events.length > 0) lines.push("Recent diagnostics:", ...events);
		return lines;
	}

	function refresh(ctx: ExtensionContext): void {
		const goal = syncGoal(ctx);
		const workGoal = goalForWorkboard(goal);
		if (state.steps.length === 0 && !state.task && !scopingRequest && !workGoal && !agentRunning() && activeTools.size === 0) {
			ctx.ui.setStatus("workboard", undefined);
			ctx.ui.setWidget("workboard", undefined);
			ctx.ui.setWorkingMessage(undefined);
			return;
		}

		const current = currentStep(state);
		ctx.ui.setStatus("workboard", planFooter(goal));
		ctx.ui.setWidget("workboard", renderTaskSurface(goal));
		if (agentRunning()) {
			ctx.ui.setWorkingMessage(`Working: ${current?.step ?? (scopingRequest ? "planning the delivery" : "inspecting the request")}`);
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

	function beginExplicitTask(ctx: ExtensionContext, objective: string, mode: "start" | "replace"): void {
		const goal = syncGoal(ctx);
		state = {
			...cloneState(EMPTY_WORKBOARD),
			...(goal?.status === "active" ? { goalId: goal.id } : {}),
		};
		scopingRequest = {
			id: `task-${Date.now()}`,
			objective,
		};
		pendingRequest = undefined;
		addEvent("control", "info", `User ${mode === "replace" ? "replaced" : "started"} task: ${objective}`, true);
		safelyRefresh(ctx);
		workInstruction(
			ctx,
			`[Workboard] The user explicitly ${mode === "replace" ? "replaced the current task" : "started a tracked task"}: ${objective}. Before any other tool call, store its evidence-driven plan with update_plan.`,
		);
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
		scopingRequest = undefined;
		pendingRequest = undefined;
		unplannedReadOnlyCalls = 0;
		unplannedBoundedChecks = 0;
		syncGoal(ctx);
		startHeartbeat(ctx);
		safelyRefresh(ctx);
	});

	pi.on("session_shutdown", () => {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		activeTools.clear();
		pendingRequest = undefined;
		unplannedReadOnlyCalls = 0;
		unplannedBoundedChecks = 0;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const goal = syncGoal(ctx);
		const isOpenGoal = goal?.status === "active" || goal?.status === "paused";
		if (!isOpenGoal && !isInternalWorkInstruction(event.prompt) && !hasIncompletePlan(state)) {
			pendingRequest = requestFromPrompt(event.prompt);
		} else {
			pendingRequest = undefined;
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		const goal = syncGoal(ctx);
		agentStartedAt = Date.now();
		unplannedReadOnlyCalls = 0;
		unplannedBoundedChecks = 0;
		addEvent("agent", goal?.status === "paused" ? "warning" : "info", goal?.status === "paused" ? "Agent started while goal is paused" : "Agent started");
		safelyRefresh(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		const elapsed = agentStartedAt ? formatDuration(Date.now() - agentStartedAt) : undefined;
		agentStartedAt = undefined;
		activeTools.clear();
		if (scopingRequest && !hasIncompletePlan(state)) scopingRequest = undefined;
		pendingRequest = undefined;
		unplannedReadOnlyCalls = 0;
		unplannedBoundedChecks = 0;
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

	pi.on("tool_call", (event, ctx) => {
		if (sessionGoal?.status === "paused") {
			return {
				block: true,
				reason: "The session goal is paused. Wait for the user to run /goal resume before calling tools.",
			};
		}
		if (sessionGoal?.status === "blocked") {
			return {
				block: true,
				reason: "The session goal is blocked. Wait for the user to create a new goal or resolve the blocker before calling tools.",
			};
		}
		if (state.paused) {
			return {
				block: true,
				reason: "Workboard is paused. Wait for the user to run /work resume before calling tools.",
			};
		}
		if (sessionGoal?.status === "active" && state.steps.length === 0 && event.toolName !== "update_plan" && event.toolName !== "get_goal") {
			return {
				block: true,
				reason: "This goal has no delivery plan yet. Call update_plan with completion conditions and milestones before executing other tools.",
			};
		}
		if (sessionGoal?.status !== "active" && scopingRequest && !hasIncompletePlan(state) && event.toolName !== "update_plan" && event.toolName !== "get_goal") {
			return {
				block: true,
				reason: "This request now needs a tracked execution task. Call update_plan before additional tool calls, or reply directly when no execution is needed.",
			};
		}
		if (sessionGoal?.status !== "active" && !hasIncompletePlan(state) && event.toolName !== "update_plan" && event.toolName !== "get_goal") {
			if (isReadOnlyInspection(event.toolName, event.input) && unplannedReadOnlyCalls < MAX_UNPLANNED_READ_ONLY_CALLS) {
				unplannedReadOnlyCalls += 1;
				return;
			}
			if (event.toolName === "bash" && isBoundedVerification(event.input) && unplannedBoundedChecks < MAX_UNPLANNED_BOUNDED_CHECKS) {
				unplannedBoundedChecks += 1;
				return;
			}
			if (!scopingRequest) {
				scopingRequest = pendingRequest ?? requestFromPrompt("Current user request");
				if (scopingRequest) {
					addEvent("control", "info", "Additional execution requested; a delivery plan is now required", true);
					safelyRefresh(ctx);
				}
			}
			return {
				block: true,
				reason: `Up to ${MAX_UNPLANNED_READ_ONLY_CALLS} read-only inspections and ${MAX_UNPLANNED_BOUNDED_CHECKS} bounded verification are allowed without a plan. Before additional or other execution tools, call update_plan with a concise delivery plan.`,
			};
		}
		return;
	});

	pi.registerTool({
		name: "update_plan",
		label: "Update Plan (delivery milestones)",
		description:
			"Create or maintain the visible, evidence-driven plan for an execution task. Before the first tool call, create a plan. Then update it only when a milestone, result, next delivery, blocker, or task objective materially changes. Each milestone states its completion condition; completed milestones include concise evidence.",
		promptSnippet: "maintain a delivery plan with completion conditions and evidence",
		promptGuidelines: [
			"Before the first tool call, create a plan for the execution task. Use one milestone for a small task and 3-7 for multi-step work. State 1-3 user-visible completion conditions for the whole delivery.",
			"Write milestones as deliverables, not tool operations. Give every milestone a concrete done_when condition.",
			"When marking a milestone completed, include evidence of the achieved result. Keep progress_summary factual and name the next_deliverable.",
			"When the user's request clearly replaces an unfinished task, set task_action to replace and give a concise task_objective. Otherwise continue the current task.",
			"Report a blocker only when work cannot proceed without a decision or external change; clear blocker with an empty string once resolved.",
		],
		parameters: Type.Object({
			task_action: Type.Optional(Type.Enum({
				continue: "continue",
				replace: "replace",
			}, { description: "Continue the current task or explicitly replace it." })),
			task_objective: Type.Optional(Type.String({ description: "Required when replacing an unfinished task; concise outcome to deliver." })),
			definition_of_done: Type.Optional(
				Type.Array(Type.String({ description: "User-visible completion condition." }), {
					description: "1-3 conditions that define a complete delivery. Required for a new plan.",
					minItems: 1,
					maxItems: MAX_DEFINITION_ITEMS,
				}),
			),
			progress_summary: Type.Optional(Type.String({ description: "Concise factual outcome since the last plan update." })),
			next_deliverable: Type.Optional(Type.String({ description: "The next user-visible result the agent will deliver." })),
			blocker: Type.Optional(Type.String({ description: "Current blocker, or an empty string to clear it." })),
			steps: Type.Array(
				Type.Object({
					step: Type.String({ description: "Short milestone or deliverable." }),
					done_when: Type.String({ description: "Observable condition required before this milestone is complete." }),
					status: Type.Enum({
						pending: "pending",
						in_progress: "in_progress",
						completed: "completed",
					}),
					evidence: Type.Optional(Type.String({ description: "Concise achieved result. Required when status is completed." })),
				}),
				{ description: "Full milestone state, replacing the prior plan. 1-7 items." },
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const goal = syncGoal(ctx);
			const requestedObjective = cleanOptionalText(params.task_objective, MAX_STEP_LENGTH);
			const replacingIncompleteTask = params.task_action === "replace" && hasIncompletePlan(state);
			if (replacingIncompleteTask && !requestedObjective) {
				return { content: [{ type: "text", text: "Plan rejected: replacing an unfinished task requires task_objective" }], isError: true };
			}
			const taskAction = params.task_action ?? (hasIncompletePlan(state) ? "continue" : "replace");
			const task = taskForPlan(goal, taskAction, requestedObjective);
			if (!task) {
				return { content: [{ type: "text", text: "Plan rejected: task_objective is required when no current request is available" }], isError: true };
			}
			const replacingTask = taskAction === "replace" || !state.task || !hasIncompletePlan(state);
			const priorState = replacingTask
				? { ...cloneState(EMPTY_WORKBOARD), ...(goal?.status === "active" ? { goalId: goal.id } : {}) }
				: state;
			const nextSteps = params.steps.map((step) => ({
				step: cleanText(step.step, MAX_STEP_LENGTH),
				doneWhen: cleanText(step.done_when, MAX_DONE_WHEN_LENGTH),
				status: step.status,
				...(cleanOptionalText(step.evidence, MAX_PROGRESS_SUMMARY_LENGTH)
					? { evidence: cleanOptionalText(step.evidence, MAX_PROGRESS_SUMMARY_LENGTH) }
					: {}),
			}));
			const stepError = validateSteps(nextSteps);
			if (stepError) return { content: [{ type: "text", text: `Plan rejected: ${stepError}` }], isError: true };

			const definitionOfDone = params.definition_of_done === undefined
				? priorState.definitionOfDone
				: params.definition_of_done.map((item) => cleanText(item, MAX_DEFINITION_LENGTH)).filter(Boolean);
			const definitionError = validateDefinitionOfDone(definitionOfDone);
			if (definitionError) return { content: [{ type: "text", text: `Plan rejected: ${definitionError}` }], isError: true };

			const progressSummary = params.progress_summary === undefined
				? priorState.progressSummary
				: cleanOptionalText(params.progress_summary, MAX_PROGRESS_SUMMARY_LENGTH);
			const nextDeliverable = params.next_deliverable === undefined
				? priorState.nextDeliverable
				: cleanOptionalText(params.next_deliverable, MAX_PROGRESS_SUMMARY_LENGTH);
			const blocker = params.blocker === undefined
				? priorState.blocker
				: cleanOptionalText(params.blocker, MAX_PROGRESS_SUMMARY_LENGTH);
			state = {
				...priorState,
				...(goal?.status === "active" ? { goalId: goal.id } : {}),
				task,
				steps: nextSteps,
				definitionOfDone,
				...(progressSummary ? { progressSummary } : { progressSummary: undefined }),
				...(nextDeliverable ? { nextDeliverable } : { nextDeliverable: undefined }),
				...(blocker ? { blocker } : { blocker: undefined }),
				...(priorState.focus && !nextSteps.some((step) => step.step === priorState.focus) ? { focus: undefined } : {}),
			};
			scopingRequest = undefined;
			const { completed, total } = progress(state);
			addEvent("control", "info", `${replacingTask ? "Task plan created" : "Plan updated"}: ${completed}/${total} milestones`, true);
			safelyRefresh(ctx);
			return {
				content: [{
					type: "text",
					text: `Task plan stored: ${task.objective}. ${completed}/${total} milestones. ${currentStep(state) ? `Current: ${currentStep(state)?.step}.` : "All milestones are complete; await review."}`,
				}],
			};
		},
		renderCall(params, theme) {
			const current = params.steps.find((step) => step.status === "in_progress")?.step;
			return new Text(
				theme.fg("toolTitle", "▸ 意图：") + theme.fg("text", "发布或更新交付计划") +
				`\n  ${theme.fg("muted", `工具：update_plan · ${params.steps.length} 个里程碑${current ? ` · 当前：${truncate(current, 56)}` : ""}`)}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "  结果：正在保存计划..."), 0, 0);
			const output = result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n").trim();
			const failed = result.isError === true || context.isError;
			const steps = Array.isArray(context.args?.steps) ? context.args.steps : [];
			const completed = steps.filter((step) => step && typeof step === "object" && (step as { status?: unknown }).status === "completed").length;
			const current = steps.find((step) => step && typeof step === "object" && (step as { status?: unknown }).status === "in_progress") as { step?: unknown } | undefined;
			const currentLabel = typeof current?.step === "string" ? truncate(current.step, 56) : undefined;
			let text = failed
				? theme.fg("error", `✗ 结果：${truncate(output || "计划更新失败", 140)}`)
				: theme.fg("success", `✓ 结果：已保存计划 · ${completed}/${steps.length} 个里程碑${currentLabel ? ` · 当前：${currentLabel}` : ""}`);
			if (expanded) {
				text += `\n${theme.fg("muted", "完整计划")}\n${theme.fg("toolOutput", JSON.stringify(context.args ?? {}, null, 2))}`;
				if (output) text += `\n${theme.fg("muted", "工具输出")}\n${theme.fg("toolOutput", output)}`;
			} else {
				text += `\n  ${theme.fg("muted", keyHint("app.tools.expand", "查看完整计划"))}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("work", {
		description: "Observe or control work: /work [plan|trace|activity|log|detail|start <task>|replace <task>|focus <n>|note <text>|pause|resume|clear]",
		handler: async (args, ctx) => {
			const input = args.trim();
			const goal = syncGoal(ctx);
			if (!input || input === "status" || input === "plan") {
				ctx.ui.notify(renderOverview(goal).join("\n"), "info");
				return;
			}

			if (input === "activity") {
				ctx.ui.notify(renderActivity().join("\n"), "info");
				return;
			}

			if (input === "trace" || input === "timeline") {
				ctx.ui.notify(renderTrace(goal).join("\n"), "info");
				return;
			}

			if (input === "log" || input === "events") {
				const lines = renderEventLines();
				ctx.ui.notify(lines.length > 0 ? ["Work log", ...lines].join("\n") : "No work events yet.", "info");
				return;
			}

			if (input === "detail") {
				ctx.ui.notify([...renderOverview(goal), "", ...renderActivity(), "", "Work log", ...renderEventLines()].join("\n"), "info");
				return;
			}

			if (input === "help") {
				ctx.ui.notify(
					[
						"/work - tracked task: goal, done conditions, milestones, outcome, next delivery",
						"/work plan - delivery plan only",
						"/work trace - phase-aware local timeline; Ctrl+O expands the selected tool row",
						"/work start <task> - explicitly create a tracked execution task",
						"/work replace <task> - replace the current task and require a new plan",
						"/work activity - live tools and diagnostic output",
						"/work log - local event history",
						"/work detail - plan, activity and event history",
						"/work focus <n> - prioritize a milestone",
						"/work note <text> - steer the current work",
						"/work pause - interrupt the turn and block tools",
						"/work resume - allow tools and continue",
						"/work clear - clear a completed delivery plan",
					].join("\n"),
					"info",
				);
				return;
			}

			if (input.startsWith("start ") || input.startsWith("replace ")) {
				if (state.paused) {
					ctx.ui.notify("Work is paused. Run /work resume before starting a task.", "warning");
					return;
				}
				if (goal?.status === "paused") {
					ctx.ui.notify("The session goal is paused. Run /goal resume before starting a task.", "warning");
					return;
				}
				if (goal?.status === "blocked") {
					ctx.ui.notify("The session goal is blocked. Resolve or clear it before starting a task.", "warning");
					return;
				}
				const mode = input.startsWith("replace ") ? "replace" : "start";
				const objective = cleanText(input.slice(mode.length).trim(), MAX_STEP_LENGTH);
				if (!objective) {
					ctx.ui.notify(`Usage: /work ${mode} <task objective>`, "warning");
					return;
				}
				if (mode === "start" && hasIncompletePlan(state)) {
					ctx.ui.notify("A task is already in progress. Use /work replace <task objective> to change it.", "warning");
					return;
				}
				beginExplicitTask(ctx, objective, mode);
				ctx.ui.notify(`${mode === "replace" ? "Task replaced" : "Task started"}. The agent will publish its plan before execution.`, "info");
				return;
			}

			if (input === "pause") {
				if (state.paused) {
					ctx.ui.notify("Work is already paused.", "info");
					return;
				}
				if (!hasIncompletePlan(state) && !scopingRequest) {
					ctx.ui.notify("No task is in progress.", "info");
					return;
				}
				state = { ...state, paused: true };
				addEvent("control", "warning", "Work paused by user", true);
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
				addEvent("control", "info", "Work resumed by user", true);
				safelyRefresh(ctx);
				workInstruction(ctx, "[Workboard] Resume the paused work. Continue from the current milestone, preserve its completion condition, and update the plan after a material result.");
				return;
			}

			if (input === "clear") {
				if (state.steps.length === 0) {
					ctx.ui.notify("No delivery plan is active.", "info");
					return;
				}
				if (state.steps.some((step) => step.status !== "completed")) {
					ctx.ui.notify("Only a completed delivery plan can be cleared.", "warning");
					return;
				}
				state = cloneState(EMPTY_WORKBOARD);
				scopingRequest = undefined;
				persist();
				safelyRefresh(ctx);
				ctx.ui.notify("Completed delivery plan cleared.", "info");
				return;
			}

			if (input === "focus clear") {
				if (!state.focus) {
					ctx.ui.notify("No work priority is set.", "info");
					return;
				}
				state = { ...state, focus: undefined };
				addEvent("control", "info", "Temporary priority cleared", true);
				safelyRefresh(ctx);
				workInstruction(ctx, "[Workboard] Clear the temporary priority and follow the current delivery plan order.");
				return;
			}

			if (input.startsWith("focus ")) {
				const requestedText = input.slice("focus ".length).trim();
				if (!/^\d+$/.test(requestedText)) {
					ctx.ui.notify("Usage: /work focus <milestone number>", "warning");
					return;
				}
				const requested = Number.parseInt(requestedText, 10);
				if (requested < 1 || requested > state.steps.length) {
					ctx.ui.notify("Usage: /work focus <milestone number>", "warning");
					return;
				}
				const step = state.steps[requested - 1];
				if (!step) return;
				state = { ...state, focus: step.step };
				addEvent("control", "info", `Priority set to milestone ${requested}: ${step.step}`, true);
				safelyRefresh(ctx);
				workInstruction(ctx, `[Workboard] Prioritize milestone ${requested}: ${step.step}. Re-plan first if this changes the safe execution order.`);
				return;
			}

			if (input.startsWith("note ")) {
				if (!hasIncompletePlan(state)) {
					ctx.ui.notify("No task is in progress. Use /work start <task objective> first.", "warning");
					return;
				}
				const note = cleanText(input.slice("note ".length), MAX_NOTE_LENGTH);
				if (!note) {
					ctx.ui.notify("Usage: /work note <adjustment>", "warning");
					return;
				}
				state = { ...state, note };
				addEvent("control", "info", `User adjustment: ${note}`, true);
				safelyRefresh(ctx);
				workInstruction(ctx, `[Workboard] User adjustment: ${note}`);
				return;
			}

			ctx.ui.notify("Unknown /work command. Use /work help.", "warning");
		},
	});

	pi.registerCommand("trace", {
		description: "Show the phase-aware local execution trace; Ctrl+O expands a selected tool row.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(renderTrace(syncGoal(ctx)).join("\n"), "info");
		},
	});
}
