/**
 * MCP Bridge Extension（懒加载网关，stdio + HTTP 双传输）
 *
 * pi 不内置 MCP 客户端（docs/usage.md:303）。本扩展给 pi 加一个极简 MCP
 * 客户端桥，把任意 MCP server 的工具，按「懒加载」方式暴露给 LLM：
 *
 *   1. mcp_servers  —— 列出已配置 server + 连接状态（不连接，便宜）
 *   2. mcp_tools    —— 连某个 server → tools/list → 回传工具清单+schema
 *   3. mcp_call     —— 转发 tools/call
 *
 * 支持两种 MCP 传输（按配置自动选择）：
 *   - stdio  ：command+args，spawn 子进程，JSON-RPC over stdin/stdout
 *              （如智谱官方视觉理解 @z_ai/mcp-server）
 *   - http   ：url + headers，Streamable HTTP（POST JSON-RPC，解析 JSON 或 SSE）
 *              （如智谱官方 search/reader/zread）
 *
 * 配置值支持 ${ENV_VAR} 展开。配置见 ~/.pi/agent/mcp.json 或 .pi/mcp.json。
 * 系统提示只增加 3 个工具；server 按需连接；会话结束清理。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";

// ----------------------------- 配置 -----------------------------

interface ServerConfig {
	// stdio
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	// http
	url?: string;
	headers?: Record<string, string>;
	// 公共
	enabled?: boolean;
	timeout?: number; // initialize 超时(ms)
}
interface McpConfig {
	servers: Record<string, ServerConfig>;
}

/** ${VAR} → process.env.VAR，缺省替换为空串。 */
function expandEnv(s: string): string {
	return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, v) => process.env[v] ?? "");
}
function expandMap(m?: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	if (m) for (const [k, v] of Object.entries(m)) out[k] = expandEnv(v);
	return out;
}

function loadConfig(): McpConfig {
	const merged: McpConfig = { servers: {} };
	const files = [
		join(homedir(), ".pi", "agent", "mcp.json"),
		join(process.cwd(), ".pi", "mcp.json"),
	];
	for (const p of files) {
		if (!existsSync(p)) continue;
		try {
			const cfg = JSON.parse(readFileSync(p, "utf8")) as McpConfig;
			if (cfg?.servers && typeof cfg.servers === "object") {
				Object.assign(merged.servers, cfg.servers);
			}
		} catch {
			/* 忽略格式错误 */
		}
	}
	return merged;
}

// ----------------------------- 公共 -----------------------------

const PROTOCOL_VERSION = "2024-11-05";

interface McpConn {
	readonly name: string;
	readonly alive: boolean;
	readonly transport: "stdio" | "http";
	listTools(): Promise<unknown[]>;
	callTool(name: string, args: unknown, timeoutMs?: number): Promise<unknown>;
	close(): void;
}

// 加载探针：验证 extension 代码是否被 reload 重新加载（排查后可删）
console.error(`[mcp-bridge] extension 代码已加载 @ ${new Date().toISOString()}`);

// MCP server stderr → 日志文件（不进 TUI）
function appendMcpLog(name: string, line: string): void {
	try {
		const agentDir = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pi", "agent");
		const logDir = join(agentDir, "logs");
		mkdirSync(logDir, { recursive: true });
		appendFileSync(join(logDir, `mcp-${name}.log`), `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* 日志写失败不影响主流程 */
	}
}

// ----------------------------- stdio 连接 -----------------------------

let nextId = 1;

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

class StdioConn implements McpConn {
	transport = "stdio" as const;
	child: ChildProcess | null = null;
	private pending = new Map<number, Pending>();
	private buffer = "";
	catalog: unknown[] | null = null;
	private startPromise: Promise<void> | null = null;

	constructor(
		public name: string,
		private cfg: ServerConfig,
	) {}

	get alive() {
		return !!this.child;
	}

	async start(): Promise<void> {
		if (this.startPromise) return this.startPromise;
		this.startPromise = this._start();
		return this.startPromise;
	}

	private async _start(): Promise<void> {
		const env = { ...process.env, ...expandMap(this.cfg.env) };
		this.child = spawn(this.cfg.command!, this.cfg.args || [], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout?.setEncoding("utf8");
		this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
		this.child.stderr?.on("data", (d: Buffer) => {
			// MCP server 的 stderr 一律写日志文件，绝不写 process.stderr：
			// ① INFO 横幅（含 version）会刷屏；② 工具名可能含 "Error" 字样
			// （如 vision 的 "Error Diagnosis tool registered"），按关键字过滤必误报。
			// 排查 server 问题看 ~/.pi/agent/logs/mcp-<name>.log
			const s = d.toString().trim();
			if (s) appendMcpLog(this.name, s);
		});
		this.child.on("exit", (code) => {
			const err = new Error(`MCP server '${this.name}' exited (code=${code})`);
			for (const p of this.pending.values()) {
				clearTimeout(p.timer);
				p.reject(err);
			}
			this.pending.clear();
			this.child = null;
		});
		this.child.on("error", (e) => {
			const err = new Error(`Failed to spawn '${this.name}': ${e.message}`);
			for (const p of this.pending.values()) {
				clearTimeout(p.timer);
				p.reject(err);
			}
			this.pending.clear();
		});

		await this.request(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-mcp-bridge", version: "0.2.0" },
			},
			this.cfg.timeout ?? 30000,
		);
		this.notify("notifications/initialized", {});
	}

	private onData(chunk: string) {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!line) continue;
			let msg: unknown;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			this.onMessage(msg as Record<string, unknown>);
		}
	}

	private onMessage(msg: Record<string, unknown>) {
		const id = msg.id as number | undefined;
		if (id == null || !this.pending.has(id)) return;
		const p = this.pending.get(id)!;
		this.pending.delete(id);
		clearTimeout(p.timer);
		const err = msg.error as { message?: string } | undefined;
		if (err) p.reject(new Error(err.message || JSON.stringify(err)));
		else p.resolve(msg.result);
	}

	private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.child?.stdin || this.child.stdin.destroyed) {
				reject(new Error(`MCP server '${this.name}' not connected`));
				return;
			}
			const id = nextId++;
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`MCP '${this.name}' ${method} timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.child.stdin.write(
				JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
				(e) => {
					if (e) {
						if (this.pending.has(id)) {
							clearTimeout(this.pending.get(id)!.timer);
							this.pending.delete(id);
						}
						reject(e);
					}
				},
			);
		});
	}

	private notify(method: string, params: unknown) {
		if (!this.child?.stdin || this.child.stdin.destroyed) return;
		this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
	}

	async listTools(): Promise<unknown[]> {
		if (this.catalog) return this.catalog;
		const res = (await this.request("tools/list", {}, 30000)) as { tools?: unknown[] };
		this.catalog = res?.tools ?? [];
		return this.catalog;
	}

	async callTool(name: string, args: unknown, timeoutMs = 120000): Promise<unknown> {
		return this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
	}

	close() {
		this.catalog = null;
		if (this.child) {
			try {
				this.child.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			this.child = null;
		}
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error("connection closed"));
		}
		this.pending.clear();
	}
}

// ----------------------------- HTTP(streamable)连接 -----------------------------

class HttpConn implements McpConn {
	transport = "http" as const;
	catalog: unknown[] | null = null;
	private sessionId: string | null = null;
	private started = false;
	private closed = false;

	constructor(
		public name: string,
		private cfg: ServerConfig,
	) {}

	get alive() {
		return this.started && !this.closed;
	}

	private get url() {
		return expandEnv(this.cfg.url ?? "");
	}
	private get baseHeaders(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...expandMap(this.cfg.headers),
		};
	}

	async start(): Promise<void> {
		const res = await this.rpc(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-mcp-bridge", version: "0.2.0" },
			},
			true,
			this.cfg.timeout ?? 30000,
		);
		void res;
		await this.notify("notifications/initialized", {});
		this.started = true;
	}

	/** 发一个 JSON-RPC 请求，解析 JSON 或 SSE 响应，返回 result。 */
	private async rpc(
		method: string,
		params: unknown,
		captureSession: boolean,
		timeoutMs: number,
	): Promise<unknown> {
		const id = nextId++;
		const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		const headers = { ...this.baseHeaders };
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		let resp: Response;
		try {
			resp = await fetch(this.url, { method: "POST", headers, body, signal: ctrl.signal });
		} finally {
			clearTimeout(timer);
		}
		if (captureSession) {
			const sid = resp.headers.get("mcp-session-id");
			if (sid) this.sessionId = sid;
		}
		if (!resp.ok) {
			const t = await resp.text().catch(() => "");
			throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${t.trim().slice(0, 300)}`);
		}
		const ct = resp.headers.get("content-type") || "";
		if (ct.includes("text/event-stream")) {
			const text = await resp.text();
			for (const line of text.split("\n")) {
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (!data) continue;
				try {
					const msg = JSON.parse(data) as Record<string, unknown>;
					if (msg.id !== id) continue;
					const err = msg.error as { message?: string } | undefined;
					if (err) throw new Error(err.message || JSON.stringify(err));
					return msg.result;
				} catch (e) {
					if (e instanceof Error && e.message.startsWith("HTTP")) throw e;
					const me = e as Error;
					if (me.message && !/Unexpected token/.test(me.message)) throw me;
				}
			}
			throw new Error("no matching response in SSE stream");
		}
		const msg = (await resp.json()) as Record<string, unknown>;
		// 非 JSON-RPC 错误体（如 bigmodel 的 {success:false,code,msg}）→ 转成清晰错误
		if (!msg || (typeof msg === "object" && !("jsonrpc" in msg) && (msg.success === false || msg.code != null))) {
			const m = (msg as { msg?: string })?.msg || JSON.stringify(msg);
			throw new Error(`server error (HTTP ${resp.status}): ${m}`);
		}
		const err = msg.error as { message?: string } | undefined;
		if (err) throw new Error(err.message || JSON.stringify(err));
		return msg.result;
	}

	private async notify(method: string, params: unknown) {
		const body = JSON.stringify({ jsonrpc: "2.0", method, params });
		const headers = { ...this.baseHeaders };
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
		try {
			await fetch(this.url, { method: "POST", headers, body });
		} catch {
			/* 通知失败忽略 */
		}
	}

	async listTools(): Promise<unknown[]> {
		if (this.catalog) return this.catalog;
		const res = (await this.rpc("tools/list", {}, false, 30000)) as { tools?: unknown[] };
		this.catalog = res?.tools ?? [];
		return this.catalog;
	}

	async callTool(name: string, args: unknown, timeoutMs = 120000): Promise<unknown> {
		return this.rpc("tools/call", { name, arguments: args ?? {} }, false, timeoutMs);
	}

	close() {
		this.closed = true;
		this.catalog = null;
		this.started = false;
	}
}

// ----------------------------- 连接管理 -----------------------------

const conns = new Map<string, McpConn>();

function makeConn(name: string, cfg: ServerConfig): McpConn {
	if (cfg.url) return new HttpConn(name, cfg);
	return new StdioConn(name, cfg);
}

async function getConn(name: string, cfg: ServerConfig): Promise<McpConn> {
	const existing = conns.get(name);
	if (existing && existing.alive) return existing;
	const c = makeConn(name, cfg);
	conns.set(name, c);
	try {
		await (c as StdioConn | HttpConn).start();
	} catch (e) {
		conns.delete(name);
		throw e;
	}
	return c;
}

// ----------------------------- 输出格式化 -----------------------------

const ANSI_RE =
	/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

async function writeTemp(content: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mcp-"));
	const file = join(dir, "output.txt");
	await writeFile(file, content, "utf8");
	return file;
}

async function formatOutput(text: string): Promise<string> {
	const t = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!t.truncated) return t.content;
	const tempFile = await writeTemp(text);
	return (
		t.content +
		`\n\n[Output truncated: ${t.outputLines}/${t.totalLines} lines ` +
		`(${formatSize(t.outputBytes)}/${formatSize(t.totalBytes)}). Full: ${tempFile}]`
	);
}

interface McpCallResult {
	content?: Array<{
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
		resource?: { uri?: string };
	}>;
	isError?: boolean;
}

function resultToText(result: McpCallResult | string | unknown): string {
	if (typeof result === "string") return stripAnsi(result);
	const r = result as McpCallResult;
	const content = r?.content;
	if (Array.isArray(content)) {
		return content
			.map((b) => {
				if (b?.type === "text") return stripAnsi(String(b.text ?? ""));
				if (b?.type === "image")
					return `[image: ${b.mimeType ?? "image"}, ${(b.data ?? "").length} bytes — not inlined]`;
				if (b?.type === "resource")
					return `[resource: ${b.resource?.uri ?? "?"}]`;
				return `[${b?.type ?? "unknown"} block]`;
			})
			.join("\n")
			.trim();
	}
	return stripAnsi(JSON.stringify(result ?? {}, null, 2));
}

function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

function coerceArgs(a: unknown): Record<string, unknown> {
	if (a == null) return {};
	if (typeof a === "string") {
		const s = a.trim();
		if (!s) return {};
		try {
			const parsed = JSON.parse(s);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: { value: parsed };
		} catch {
			return { text: a };
		}
	}
	if (typeof a === "object" && !Array.isArray(a)) return a as Record<string, unknown>;
	return { value: a };
}

// ----------------------------- 工具注册 -----------------------------

export default function mcpBridgeExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "mcp_servers",
		label: "MCP Servers",
		description:
			"List configured MCP (Model Context Protocol) servers, their transport (stdio/http) and connection status. Does NOT start any server — cheap. Call this first to see what's available.",
		promptSnippet:
			"gateway to external MCP tool servers (vision/search/reader/zread/...) — list / discover / invoke",
		promptGuidelines: [
			"MCP tools are lazy-loaded via 3 steps: (1) mcp_servers to list, (2) mcp_tools {server} to discover that server's tools (connects on demand), (3) mcp_call {server, tool, arguments} to invoke. The first call to a server may be slow. Prefer built-in tools (read/grep/bash/ego-browser) when they suffice; use MCP for capabilities they lack.",
		],
		parameters: Type.Object({}),
		async execute() {
			const cfg = loadConfig();
			const names = Object.keys(cfg.servers);
			if (!names.length) {
				return {
					content: [
						{
							type: "text",
							text:
								"No MCP servers configured.\n" +
								"Add servers to ~/.pi/agent/mcp.json (global) or .pi/mcp.json (project). Supports stdio (command/args) and http (url/headers). Values support ${ENV_VAR} expansion.",
						},
					],
					details: {},
				};
			}
			const rows = names.map((n) => {
				const s = cfg.servers[n];
				const c = conns.get(n);
				const status = c?.alive ? "● connected" : "○ not connected (lazy)";
				const disabled = s.enabled === false ? " [disabled]" : "";
				const tp = s.url ? "http" : "stdio";
				const where = s.url ? expandEnv(s.url) : `${s.command} ${(s.args || []).join(" ")}`;
				return `• ${n}${disabled} — ${tp} · ${status}\n    ${where}`;
			});
			return {
				content: [
					{
						type: "text",
						text:
							"MCP servers (none started until mcp_tools/mcp_call):\n\n" +
							rows.join("\n") +
							"\n\nNext: mcp_tools { server: \"<name>\" } to discover its tools.",
					},
				],
				details: { servers: names },
			};
		},
	});

	pi.registerTool({
		name: "mcp_tools",
		label: "MCP Tools",
		description:
			"Discover tools offered by one MCP server. Connects on demand and returns each tool's name, description, and input schema. Connection is reused for later mcp_call.",
		promptSnippet: "discover a server's MCP tools (connects lazily)",
		parameters: Type.Object({
			server: Type.String({ description: "Server name from mcp_servers." }),
		}),
		async execute(_id, p) {
			const cfg = loadConfig();
			const s = cfg.servers[p.server];
			if (!s)
				return {
					content: [{ type: "text", text: `Unknown MCP server '${p.server}'. Call mcp_servers to list.` }],
					details: { error: true },
				};
			if (s.enabled === false)
				return {
					content: [{ type: "text", text: `Server '${p.server}' is disabled in config.` }],
					details: { error: true },
				};
			let conn: McpConn;
			try {
				conn = await getConn(p.server, s);
			} catch (e) {
				return {
					content: [{ type: "text", text: `Failed to connect '${p.server}': ${errMsg(e)}` }],
					details: { error: true },
				};
			}
			let tools: unknown[];
			try {
				tools = await conn.listTools();
			} catch (e) {
				return {
					content: [{ type: "text", text: `tools/list failed for '${p.server}': ${errMsg(e)}` }],
					details: { error: true },
				};
			}
			const lines = (tools as Array<Record<string, unknown>>).map((t, i) => {
				const desc = t.description ? " — " + String(t.description).split("\n")[0].slice(0, 160) : "";
				const schema = t.inputSchema ? "\n   args: " + JSON.stringify(t.inputSchema) : "\n   args: (none)";
				return `${i + 1}. ${t.name}${desc}${schema}`;
			});
			const text =
				`MCP tools on '${p.server}' (${tools.length}):\n\n` +
				lines.join("\n\n") +
				`\n\nInvoke with: mcp_call { server: "${p.server}", tool: "<name>", arguments: {...} }`;
			return {
				content: [{ type: "text", text: await formatOutput(text) }],
				details: { server: p.server, count: tools.length },
			};
		},
	});

	pi.registerTool({
		name: "mcp_call",
		label: "MCP Call",
		description:
			"Invoke a tool on an MCP server. Connects lazily if not already connected. `arguments` matches the tool's input schema (see mcp_tools); omit if the tool takes none.",
		promptSnippet: "invoke a tool on an MCP server (lazy connect)",
		parameters: Type.Object({
			server: Type.String({ description: "Server name from mcp_servers." }),
			tool: Type.String({ description: "Tool name from mcp_tools." }),
			arguments: Type.Optional(
				Type.Any({ description: "Arguments object matching the tool's input schema. Omit if none." }),
			),
		}),
		async execute(_id, p) {
			const cfg = loadConfig();
			const s = cfg.servers[p.server];
			if (!s)
				return {
					content: [{ type: "text", text: `Unknown MCP server '${p.server}'.` }],
					details: { error: true },
				};
			let conn: McpConn;
			try {
				conn = await getConn(p.server, s);
			} catch (e) {
				return {
					content: [{ type: "text", text: `Failed to connect '${p.server}': ${errMsg(e)}` }],
					details: { error: true },
				};
			}
			let result: unknown;
			try {
				result = await conn.callTool(p.tool, coerceArgs(p.arguments));
			} catch (e) {
				return {
					content: [{ type: "text", text: `mcp_call '${p.server}/${p.tool}' failed: ${errMsg(e)}` }],
					details: { error: true },
				};
			}
			const isError = (result as McpCallResult)?.isError === true;
			const text = resultToText(result);
			const out = `[${p.server}/${p.tool}]${isError ? " (server reported error)" : ""}\n` + (text || "(no output)");
			return {
				content: [{ type: "text", text: await formatOutput(out) }],
				details: { server: p.server, tool: p.tool, isError },
			};
		},
	});

	pi.on("session_shutdown", async () => {
		for (const c of conns.values()) c.close();
		conns.clear();
	});
	process.on("exit", () => {
		for (const c of conns.values()) {
			if (c instanceof StdioConn) {
				try {
					c.child?.kill("SIGKILL");
				} catch {
					/* ignore */
				}
			}
		}
	});
}
