/**
 * Git Checkpoint Extension
 *
 * Creates git stash checkpoints at each turn so /fork can restore code state.
 * When forking, offers to restore code to that point in history.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Fork recovery is useful occasionally, but a stash snapshot on every turn
	// is unnecessary work for the normal agent loop.
	if (process.env.PI_GIT_CHECKPOINTS !== "1") return;

	const checkpoints = new Map<string, string>();
	let currentEntryId: string | undefined;

	// Track the current entry ID when user messages are saved
	pi.on("tool_result", async (_event, ctx) => {
		// 工具结果返回的瞬间 session 可能已被替换（dispose 不发 shutdown 事件），容忍 stale
		try {
			const leaf = ctx.sessionManager.getLeafEntry();
			if (leaf) currentEntryId = leaf.id;
		} catch {
			/* ctx stale：跳过本次 checkpoint 跟踪 */
		}
	});

	pi.on("turn_start", async () => {
		// Create a git stash entry before LLM makes changes
		// exec 期间 session 可能被替换/退出（pi/exec 会抛 ctx stale），容忍
		try {
			const { stdout } = await pi.exec("git", ["stash", "create"]);
			const ref = stdout.trim();
			if (ref && currentEntryId) {
				checkpoints.set(currentEntryId, ref);
			}
		} catch {
			/* ctx stale 或非 git 目录：跳过本次 checkpoint */
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const ref = checkpoints.get(event.entryId);
		if (!ref) return;

		if (!ctx.hasUI) {
			// In non-interactive mode, don't restore automatically
			return;
		}

		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);

		if (choice?.startsWith("Yes")) {
			await pi.exec("git", ["stash", "apply", ref]);
			ctx.ui.notify("Code restored to checkpoint", "info");
		}
	});

	pi.on("agent_end", async () => {
		// Clear checkpoints after agent completes
		checkpoints.clear();
	});
}
