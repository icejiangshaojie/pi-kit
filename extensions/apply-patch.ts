/**
 * apply_patch — Codex 风格的 diff 格式文件编辑工具
 *
 * 相比 pi 内置 edit 工具的优势：
 *  - 上下文只需 3 行（edit 需要完整复现 oldText）
 *  - @@ 锚点定位作用域，不依赖盲匹配
 *  - 一次调用可改多个文件（Add/Update/Delete/Move 混合）
 *  - token 消耗约为 edit 的 30-50%
 *
 * 格式（与 Codex CLI 完全兼容）：
 * *** Begin Patch
 * *** Update File: path/to/file.dart
 * @@ class SomeClass        ← 可选锚点（缩小搜索范围）
 *   context line            ← 空格前缀 = 上下文
 * -old line                 ← 减号 = 要删除的行
 * +new line                 ← 加号 = 要替换的行
 * *** Add File: new/path.dart
 * +完整文件内容
 * *** Delete File: old/path.dart
 * *** End Patch
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ── Patch 解析 ────────────────────────────────────────────────

interface Hunk {
	anchor: string | null;
	lines: Array<{ type: "ctx" | "del" | "add"; text: string }>;
}
interface FileOp {
	kind: "update" | "add" | "delete";
	path: string;
	moveTo?: string;
	hunks: Hunk[];
	addContent: string[];
}

export function parsePatch(patch: string): FileOp[] {
	const lines = patch.split("\n");
	const ops: FileOp[] = [];
	let cur: FileOp | null = null;
	let curHunk: Hunk | null = null;

	for (const raw of lines) {
		// 容错：去掉 \r
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

		if (line === "*** Begin Patch") continue;
		if (line === "*** End Patch") break;

		if (line.startsWith("*** Update File: ")) {
			cur = { kind: "update", path: line.slice(17).trim(), hunks: [] };
			ops.push(cur);
			curHunk = null;
		} else if (line.startsWith("*** Add File: ")) {
			cur = { kind: "add", path: line.slice(14).trim(), hunks: [], addContent: [] };
			ops.push(cur);
			curHunk = null;
		} else if (line.startsWith("*** Delete File: ")) {
			cur = { kind: "delete", path: line.slice(17).trim(), hunks: [] };
			ops.push(cur);
			curHunk = null;
		} else if (line.startsWith("*** Move to: ")) {
			if (cur) cur.moveTo = line.slice(13).trim();
		} else if (line === "*** End of File") {
			curHunk = null;
		} else if (line.startsWith("@@")) {
			if (!cur) throw new Error(`@@ 出现在任何 *** File 操作之前`);
			curHunk = { anchor: line.slice(2).trim() || null, lines: [] };
			cur.hunks.push(curHunk);
		} else if (cur?.kind === "add") {
			// Add File: 所有 + 行是文件内容
			if (line.startsWith("+")) cur.addContent.push(line.slice(1));
			else if (line === "") cur.addContent.push("");
		} else if (cur && curHunk) {
			if (line.startsWith("+")) curHunk.lines.push({ type: "add", text: line.slice(1) });
			else if (line.startsWith("-")) curHunk.lines.push({ type: "del", text: line.slice(1) });
			else if (line.startsWith(" ")) curHunk.lines.push({ type: "ctx", text: line.slice(1) });
			else if (line === "") curHunk.lines.push({ type: "ctx", text: "" });
			// 其他行忽略（安全跳过）
		}
		// 未匹配任何状态的行静默忽略（比如 patch 前的空行）
	}
	return ops;
}

// ── hunk 应用逻辑 ─────────────────────────────────────────────

/** 从 hunk 构造 old/new 文本块 */
function hunkToOldNew(hunk: Hunk): { oldText: string; newText: string } {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	// diff 语义：连续的 del 块和 add 块交替，按出现顺序投影
	let i = 0;
	while (i < hunk.lines.length) {
		const line = hunk.lines[i];
		if (line.type === "ctx") {
			oldLines.push(line.text);
			newLines.push(line.text);
			i++;
		} else if (line.type === "del") {
			// 收集连续 del
			while (i < hunk.lines.length && hunk.lines[i].type === "del") {
				oldLines.push(hunk.lines[i].text);
				i++;
			}
			// 接着收集连续 add（对应同一替换点）
			while (i < hunk.lines.length && hunk.lines[i].type === "add") {
				newLines.push(hunk.lines[i].text);
				i++;
			}
		} else if (line.type === "add") {
			// 纯插入（前面没有 del）
			newLines.push(line.text);
			i++;
		}
	}
	return { oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

/** 精确匹配 → 模糊匹配（忽略行首空白差异） */
function findMatch(content: string, oldText: string, anchor: string | null): { start: number; matched: string } | null {
	// 1) 精确匹配
	const idx = content.indexOf(oldText);
	if (idx !== -1) {
		// 检查唯一性
		const second = content.indexOf(oldText, idx + 1);
		if (second !== -1 && anchor) {
			// 有锚点时尝试用锚点消歧
			return disambiguateWithAnchor(content, oldText, anchor) ?? { start: idx, matched: oldText };
		}
		return { start: idx, matched: oldText };
	}

	// 2) 模糊匹配：逐行 trim 比较
	const oldLines = oldText.split("\n");
	const contentLines = content.split("\n");
	const contentJoined = contentLines.map((l) => l.trim()).join("\n");
	const oldTrimmed = oldLines.map((l) => l.trim()).join("\n");
	const fIdx = contentJoined.indexOf(oldTrimmed);
	if (fIdx === -1) return null;

	// 从 joined index 恢复到原始行号
	let charCount = 0;
	let startLine = 0;
	for (let li = 0; li < contentLines.length; li++) {
		if (charCount >= fIdx) {
			startLine = li;
			break;
		}
		charCount += contentLines[li].trim().length + 1;
	}
	// 取原始行拼接为 matched（保留原文件的缩进）
	const matched = contentLines.slice(startLine, startLine + oldLines.length).join("\n");
	return { start: content.split("\n").slice(0, startLine).join("\n").length + (startLine > 0 ? 1 : 0), matched };
}

function disambiguateWithAnchor(content: string, oldText: string, anchor: string): { start: number; matched: string } | null {
	// 找锚点行位置，在其附近 ±80 行内搜索
	const anchorIdx = content.indexOf(anchor);
	if (anchorIdx === -1) return null;
	const searchStart = Math.max(0, anchorIdx - 3000);
	const region = content.slice(searchStart, anchorIdx + 3000);
	const rIdx = region.indexOf(oldText);
	if (rIdx !== -1) return { start: searchStart + rIdx, matched: oldText };
	return null;
}

function applyHunks(content: string, hunks: Hunk[], filePath: string): string {
	let result = content;
	// 从后往前应用，避免偏移失效（先按首匹配位置排序）
	const applied: Array<{ start: number; matched: string; newText: string; anchor: string | null }> = [];
	for (const h of hunks) {
		const { oldText, newText } = hunkToOldNew(h);
		if (oldText === "" && newText === "") continue; // 空 hunk
		if (oldText === "") {
			// 纯插入无位置锚定 — 不支持，要求至少 1 行上下文
			throw new Error(`${filePath}: hunk 无删除行也无上下文，纯插入需要至少 1 行上下文定位`);
		}
		const m = findMatch(result, oldText, h.anchor);
		if (!m) {
			const preview = oldText.split("\n").slice(0, 3).join("\\n");
			throw new Error(
				`${filePath}: 未找到匹配（锚点: ${h.anchor ?? "无"}）。搜索内容开头: "${preview.slice(0, 100)}"。请检查上下文行是否与文件一致。`,
			);
		}
		applied.push({ ...m, newText, anchor: h.anchor });
	}
	// 按位置倒序应用
	applied.sort((a, b) => b.start - a.start);
	for (const a of applied) {
		result = result.slice(0, a.start) + a.newText + result.slice(a.start + a.matched.length);
	}
	return result;
}

// ── 工具注册 ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "apply_patch",
		label: "Apply Patch (diff-style multi-file edit)",
		description:
			"Use this tool to edit local files with a diff-based patch format. More token-efficient than edit: only 3 context lines needed per change, @@ anchors scope the search, and one call can modify multiple files (Add/Update/Delete/Move). Prefer this over edit/write for code changes. Format: '*** Begin Patch\\n*** Update File: path\\n@@ anchor\\n context\\n-old\\n+new\\n*** End Patch'",
		promptSnippet: "diff-style multi-file edit (Add/Update/Delete/Move files, more token-efficient than edit)",
		promptGuidelines: [
			"Prefer apply_patch over edit/write for code changes: it needs only 3 context lines per hunk and can modify multiple files in one call",
			"apply_patch format: '*** Update File: path' / '*** Add File: path' (+ lines = full content) / '*** Delete File: path' / '*** Move to: newpath'; hunks start with '@@ optional-anchor'; ' ' prefix = context, '-' = remove, '+' = add",
			"Use @@ anchors (e.g. '@@ class Foo' or '@@ def bar():') when the snippet might appear multiple times in a file",
		],
		parameters: Type.Object({
			patch: Type.String({
				description:
					"The complete patch text. Must start with '*** Begin Patch' and end with '*** End Patch'. Paths are relative to cwd.",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = ctx.cwd;
			const results: string[] = [];
			let failed = false;

			let ops: FileOp[];
			try {
				ops = parsePatch(params.patch);
			} catch (e) {
				return {
					content: [{ type: "text", text: `✗ patch 解析失败: ${e instanceof Error ? e.message : String(e)}` }],
					isError: true,
				};
			}
			if (ops.length === 0) {
				return { content: [{ type: "text", text: "✗ patch 中没有文件操作（需要 *** Update/Add/Delete File 指令）" }], isError: true };
			}

			for (const op of ops) {
				// 路径安全检查：不允许绝对路径或跳出 cwd
				const abs = resolve(root, op.path);
				if (!abs.startsWith(root)) {
					results.push(`✗ ${op.path}: 路径越界（不允许绝对路径或 ../ 跳出工作目录）`);
					failed = true;
					continue;
				}
				try {
					if (op.kind === "add") {
						if (existsSync(abs)) {
							results.push(`✗ ${op.path}: 文件已存在（Add File 不能覆盖已有文件，用 Update）`);
							failed = true;
							continue;
						}
						mkdirSync(dirname(abs), { recursive: true });
						writeFileSync(abs, op.addContent.join("\n") + (op.addContent.length ? "\n" : ""));
						results.push(`✓ Add ${op.path} (${op.addContent.length} lines)`);
					} else if (op.kind === "delete") {
						if (!existsSync(abs)) {
							results.push(`✗ ${op.path}: 文件不存在`);
							failed = true;
							continue;
						}
						unlinkSync(abs);
						results.push(`✓ Delete ${op.path}`);
					} else {
						// update
						if (!existsSync(abs)) {
							results.push(`✗ ${op.path}: 文件不存在（新建文件用 *** Add File）`);
							failed = true;
							continue;
						}
						if (op.hunks.length === 0 && !op.moveTo) {
							results.push(`✗ ${op.path}: Update 没有 hunk（至少一个 @@ 段）`);
							failed = true;
							continue;
						}
						const original = readFileSync(abs, "utf8");
						const updated = applyHunks(original, op.hunks, op.path);
						if (updated !== original || op.moveTo) {
							if (op.moveTo) {
								const moveAbs = resolve(root, op.moveTo);
								if (!moveAbs.startsWith(root)) {
									results.push(`✗ ${op.path}: Move to 路径越界`);
									failed = true;
									continue;
								}
								writeFileSync(abs, updated, "utf8");
								mkdirSync(dirname(moveAbs), { recursive: true });
								renameSync(abs, moveAbs);
								results.push(`✓ Update+Move ${op.path} → ${op.moveTo} (${op.hunks.length} hunks)`);
							} else {
								writeFileSync(abs, updated, "utf8");
								const addCount = op.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === "add").length, 0);
								const delCount = op.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === "del").length, 0);
								results.push(`✓ Update ${op.path} (${op.hunks.length} hunks, +${addCount}/-${delCount})`);
							}
						} else {
							results.push(`○ ${op.path}: 无实际变更`);
						}
					}
				} catch (e) {
					results.push(`✗ ${op.path}: ${e instanceof Error ? e.message : String(e)}`);
					failed = true;
				}
			}

			return {
				content: [{ type: "text", text: results.join("\n") }],
				isError: failed,
			};
		},
	});
}
