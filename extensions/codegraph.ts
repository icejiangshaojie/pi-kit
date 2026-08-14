/**
 * CodeGraph Tools
 *
 * 把已安装的 `codegraph` CLI（代码知识图谱）封装成 pi 的默认工具。
 * 代码量大时，内置 read 会截断（50KB / 2000 行），靠逐文件阅读很难建立
 * “整体了解”。CodeGraph 把符号、定义、引用、调用关系建成图谱，可以用
 * 结构化查询替代盲目读大文件：
 *   - codegraph_explore  ：探索一片区域，一次拿到相关源码 + 调用路径
 *   - codegraph_node     ：单符号的源码 + caller/callee 轨迹，或带行号读文件
 *   - codegraph_search   ：按名字搜索符号
 *   - codegraph_refs     ：callers / callees / impact
 *   - codegraph_status   ：索引状态
 *
 * 全部为只读查询，不改文件、不重建索引。当项目尚未建立索引时，给出
 * `codegraph init` 的提示，方便一次性建好。
 *
 * 安装：放在 ~/.pi/agent/extensions/ 即为全局默认工具。
 * 前置：`codegraph` 已在 PATH 中（本机 /opt/homebrew/bin/codegraph）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CODEGRAPH_BIN = "codegraph";

/** 去掉 codegraph 输出里的 ANSI 颜色/光标控制码，给 LLM 干净文本。 */
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "").replace(/\r/g, "");
}
const NOT_INDEXED_HINT = (root: string) =>
	`CodeGraph index not found under ${root}.\n` +
	`Build it once in your terminal:\n` +
	`  cd ${root} && codegraph init\n` +
	`Then re-run this tool. Keep it fresh later with \`codegraph sync\`.\n` +
	`(This is a one-time setup per project.)`;

/** 从 cwd 向上查找项目根：优先含 .codegraph 的目录，否则含 .git 的目录，最后退回 cwd。 */
function findProjectRoot(startCwd: string): { root: string; indexed: boolean } {
	let dir = resolve(startCwd);
	let gitRoot: string | undefined;
	for (;;) {
		if (existsSync(join(dir, ".codegraph"))) return { root: dir, indexed: true };
		if (gitRoot === undefined && existsSync(join(dir, ".git"))) gitRoot = dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return { root: gitRoot ?? resolve(startCwd), indexed: false };
}

/** 运行 codegraph 子命令；非零退出时抛出带 stderr 的错误。 */
async function runCodeGraph(
	args: string[],
	root: string,
	signal?: AbortSignal,
): Promise<string> {
	const { stdout } = await execFileAsync(CODEGRAPH_BIN, args, {
		cwd: root,
		maxBuffer: 20 * 1024 * 1024,
		signal,
		timeout: 120_000,
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CLICOLOR: "0" },
	});
	return stripAnsi(stdout).trim();
}

/** 把超大输出截断到 pi 的上下文预算，超出部分落盘临时文件并给出指针。 */
async function formatOutput(output: string): Promise<string> {
	const t = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!t.truncated) return t.content;
	const tempFile = await writeTemp(output);
	return (
		t.content +
		`\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines ` +
		`(${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). ` +
		`Full output saved to: ${tempFile}]`
	);
}

async function writeTemp(content: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "codegraph-"));
	const file = join(dir, "output.txt");
	await writeFile(file, content, "utf8");
	return file;
}

/** 统一的执行包装：定位根目录 → 检查索引 → 运行 → 截断。 */
async function withIndex(
	ctx: { cwd: string },
	args: string[],
	signal: AbortSignal | undefined,
): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
	const { root, indexed } = findProjectRoot(ctx.cwd);
	if (!indexed) {
		return {
			content: [{ type: "text", text: NOT_INDEXED_HINT(root) }],
			details: { root, indexed: false },
		};
	}
	try {
		const raw = await runCodeGraph(args, root, signal);
		return {
			content: [{ type: "text", text: await formatOutput(raw) }],
			details: { root, indexed: true, args },
		};
	} catch (err) {
		const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
		const msg =
			(e.stderr?.toString().trim() || "") +
			(e.stdout?.toString().trim() || "") ||
			e.message ||
			String(err);
		return {
			content: [{ type: "text", text: `codegraph error:\n${msg.trim()}` }],
			details: { root, indexed: true, args, error: true },
		};
	}
}

export default function codegraphExtension(pi: ExtensionAPI) {
	// 1) 索引状态
	pi.registerTool({
		name: "codegraph_status",
		label: "CodeGraph Status",
		description:
			"Show CodeGraph index status & stats (symbol count, freshness). Use to check whether the codebase is indexed before using other codegraph_* tools.",
		promptSnippet: "check CodeGraph index health/stats",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			return withIndex(ctx, ["status"], signal);
		},
	});

	// 2) 按名字搜索符号
	pi.registerTool({
		name: "codegraph_search",
		label: "CodeGraph Search",
		description:
			"Search for symbols (functions/classes/etc.) by name across the codebase. Returns matching symbols with locations. Faster and more precise than grep for finding definitions.",
		promptSnippet: "find symbols by name across the codebase",
		promptGuidelines: [
			"Prefer codegraph_search over grep when locating a function/class/method definition by name.",
		],
		parameters: Type.Object({
			search: Type.String({ description: "Symbol name or substring to search for." }),
			kind: Type.Optional(
				Type.String({
					description: "Filter by node kind, e.g. function, class, method.",
				}),
			),
			limit: Type.Optional(
				Type.Number({ description: "Maximum results. Default 10.", minimum: 1 }),
			),
		}),
		async execute(_id, p, signal, _onUpdate, ctx) {
			const args = ["query", p.search];
			if (p.kind) args.push("-k", p.kind);
			if (p.limit != null) args.push("-l", String(p.limit));
			return withIndex(ctx, args, signal);
		},
	});

	// 3) 探索一片区域：相关符号源码 + 调用路径
	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph Explore",
		description:
			"Explore an area of the codebase in one shot: relevant symbols' source plus call paths. Best for building an overall understanding of a feature/module without reading many large files individually.",
		promptSnippet: "explore a feature/area: source + call paths in one shot",
		promptGuidelines: [
			"Use codegraph_search or codegraph_node first. Use codegraph_explore only for a precisely named, bounded feature after locating its symbols; set max_files to the smallest useful number (usually 2-4).",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Natural-language or symbol query describing the area to explore.",
			}),
			max_files: Type.Optional(
				Type.Number({
					description: "Maximum number of files to include source from.",
					minimum: 1,
				}),
			),
		}),
		async execute(_id, p, signal, _onUpdate, ctx) {
			const args = ["explore", p.query];
			if (p.max_files != null) args.push("--max-files", String(p.max_files));
			return withIndex(ctx, args, signal);
		},
	});

	// 4) 单符号的源码 + caller/callee 轨迹；或带行号读文件 + 依赖
	pi.registerTool({
		name: "codegraph_node",
		label: "CodeGraph Node",
		description:
			"Get one symbol's source plus its caller/callee trail. In file mode (-f), read a file with line numbers plus its symbol map and dependents — a context-aware alternative to read for understanding a file's role.",
		promptSnippet: "one symbol's source + call trail, or read a file w/ dependents",
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Symbol name (symbol mode)." }),
			),
			file: Type.Optional(
				Type.String({
					description: "File path to read in file mode (relative to project root).",
				}),
			),
			offset: Type.Optional(
				Type.Number({
					description: "File mode: 1-based start line.",
					minimum: 1,
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "File mode: maximum lines to read.",
					minimum: 1,
				}),
			),
			symbols_only: Type.Optional(
				Type.Boolean({
					description: "File mode: return only the symbol map + dependents, no source.",
				}),
			),
		}),
		async execute(_id, p, signal, _onUpdate, ctx) {
			const args = ["node"];
			if (p.file) {
				args.push("-f", p.file);
				if (p.offset != null) args.push("--offset", String(p.offset));
				if (p.limit != null) args.push("--limit", String(p.limit));
				if (p.symbols_only) args.push("--symbols-only");
			} else if (p.name) {
				args.push(p.name);
			} else {
				return {
					content: [
						{
							type: "text",
							text: "Provide either `name` (symbol mode) or `file` (file mode).",
						},
					],
					details: { error: true },
				};
			}
			return withIndex(ctx, args, signal);
		},
	});

	// 5) 调用关系 / 影响面
	pi.registerTool({
		name: "codegraph_refs",
		label: "CodeGraph Refs",
		description:
			"Find callers, callees, or impact of changing a symbol. direction: 'callers' (who calls it), 'callees' (what it calls), 'impact' (blast radius of a change).",
		promptSnippet: "find callers / callees / change-impact of a symbol",
		promptGuidelines: [
			"Use codegraph_refs before refactoring to see a symbol's callers/callees/impact instead of grepping.",
		],
		parameters: Type.Object({
			symbol: Type.String({ description: "Symbol name to analyze." }),
			direction: StringEnum(["callers", "callees", "impact"] as const),
			limit: Type.Optional(
				Type.Number({
					description: "callers/callees: max results. Default 20.",
					minimum: 1,
				}),
			),
			depth: Type.Optional(
				Type.Number({
					description: "impact: traversal depth. Default 2.",
					minimum: 1,
				}),
			),
		}),
		async execute(_id, p, signal, _onUpdate, ctx) {
			const args = [p.direction, p.symbol];
			if (p.direction === "impact") {
				if (p.depth != null) args.push("-d", String(p.depth));
			} else if (p.limit != null) {
				args.push("-l", String(p.limit));
			}
			return withIndex(ctx, args, signal);
		},
	});
}
