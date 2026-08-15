/** Compact TUI traces for Pi's four default coding tools. */

import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	keyHint,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type Args = Record<string, unknown>;
type Result = {
	content?: Array<{ type?: string; text?: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
};

function shorten(value: string, max = 132): string {
	return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function output(result: Result): string {
	return (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n").trim();
}

function firstLine(value: string): string {
	return value.split("\n").map((line) => line.trim()).find(Boolean) ?? "命令完成，没有文本输出";
}

function hint(theme: { fg: (color: string, text: string) => string }): string {
	return `\n  ${theme.fg("muted", keyHint("app.tools.expand", "查看完整内容"))}`;
}

function intent(command: string): string {
	const value = command.toLowerCase();
	if (/\bflutter\s+test\b|\bdart\s+test\b|\bpytest\b|\bnpm\s+(run\s+)?test\b/.test(value)) return "运行测试验证";
	if (/\bflutter\s+analyze\b|\bdart\s+analyze\b|\beslint\b|\btsc\b/.test(value)) return "检查代码问题";
	if (/\bflutter\s+build\b|\bdart\s+compile\b|\bnpm\s+run\s+build\b/.test(value)) return "构建交付物";
	if (/\b(?:git|gh)\s+(?:status|diff|log|show|branch)\b/.test(value)) return "检查版本状态";
	if (/\b(?:rg|grep|codegraph)\b/.test(value)) return "查找相关代码";
	if (/\b(?:sed|head|tail|cat)\b/.test(value)) return "读取指定内容";
	if (/\b(?:ls|find|fd)\b/.test(value)) return "查看文件范围";
	return "执行本地命令";
}

function bashOutcome(value: string, failed: boolean): string {
	if (failed) return firstLine(value);
	if (/no issues found|0 errors?|analysis passed/i.test(value)) return "检查通过";
	if (/all tests passed|\+\d+: all tests passed|test successful/i.test(value)) return "测试通过";
	return firstLine(value);
}

function detail(title: string, value: string, theme: { fg: (color: string, text: string) => string }): string {
	return `\n${theme.fg("muted", title)}\n${theme.fg("toolOutput", value || "(无输出)")}`;
}

function register(
	pi: ExtensionAPI,
	name: "bash" | "read" | "edit" | "write",
	original: any,
): void {
	pi.registerTool({
		name,
		label: name,
		description: original.description,
		parameters: original.parameters,
		async execute(...args: any[]) {
			return original.execute(...args);
		},
		renderCall(args: Args, theme) {
			if (name === "bash") {
				const command = typeof args.command === "string" ? args.command : "";
				return new Text(
					theme.fg("toolTitle", "▸ 意图：") + theme.fg("text", intent(command)) + `\n  ${theme.fg("muted", "工具：bash")}`,
					0,
					0,
				);
			}
			const labels = { read: "查看源代码或配置", edit: "应用精确代码修改", write: "创建或覆盖文件" };
			const path = typeof args.path === "string" ? shorten(args.path, 72) : "(unknown file)";
			const change = name === "edit" && Array.isArray(args.edits) ? ` · ${args.edits.length} change${args.edits.length === 1 ? "" : "s"}` : "";
			const lines = name === "write" && typeof args.content === "string" ? ` · ${args.content.split("\n").length} lines` : "";
			return new Text(
				theme.fg("toolTitle", "▸ 意图：") + theme.fg("text", labels[name]) + `\n  ${theme.fg("muted", `工具：${name} · ${path}${change}${lines}`)}`,
				0,
				0,
			);
		},
		renderResult(result: Result, options: { expanded: boolean; isPartial?: boolean }, theme, context: { args?: Args; isError?: boolean }) {
			if (options.isPartial) return new Text(theme.fg("warning", "  结果：执行中..."), 0, 0);
			const value = output(result);
			const failed = result.isError === true || context.isError === true;
			let summary: string;
			if (name === "bash") summary = bashOutcome(value, failed);
			else if (failed) summary = firstLine(value);
			else if (name === "read") summary = `已读取 ${value ? value.split("\n").length : 0} 行`;
			else if (name === "edit") {
				const diff = typeof result.details?.diff === "string" ? result.details.diff : value;
				const added = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
				const removed = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
				summary = `已应用修改 (+${added} / -${removed})`;
			} else summary = "文件已写入";

			let text = (failed ? theme.fg("error", "✗ 结果：") : theme.fg("success", "✓ 结果：")) + theme.fg("text", shorten(summary));
			if (options.expanded) {
				if (name === "bash") text += detail("完整命令", String(context.args?.command ?? "(不可用)"), theme) + detail("完整输出", value, theme);
				if (name === "read") text += detail("文件", String(context.args?.path ?? "(不可用)"), theme) + detail("完整内容", value, theme);
				if (name === "edit") {
					text += detail("文件", String(context.args?.path ?? "(不可用)"), theme);
					text += detail("完整 diff", String(result.details?.diff ?? value), theme);
				}
				if (name === "write") text += detail("文件", String(context.args?.path ?? "(不可用)"), theme) + detail("完整内容", String(context.args?.content ?? ""), theme);
			} else {
				text += hint(theme);
			}
			return new Text(text, 0, 0);
		},
	});
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	register(pi, "bash", createBashTool(cwd));
	register(pi, "read", createReadTool(cwd));
	register(pi, "edit", createEditTool(cwd));
	register(pi, "write", createWriteTool(cwd));
}
