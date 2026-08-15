import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import crypto from "node:crypto";
//#region lib/types/index.js
/**
* Opt-in request-preparation IDE context. Eligible step attempts append
* durable, source-attributed context naming what the user is doing in their
* IDE right now: the files currently open, and the current text selection
* (file, line/character range, selected text) — as reported by the Claude
* Code IDE integration's MCP-over-WebSocket bridge (IntelliJ IDEA and
* Visual Studio Code both speak the same protocol).
*
* The plugin keeps one background WebSocket connection to the IDE named by
* the newest `~/.claude/ide/<port>.lock` file (the same lock files the
* Claude Code CLI reads). It performs the MCP handshake, subscribes to the
* IDE's `selection_changed` notifications, and — depending on which tools the
* IDE registers — polls `getCurrentSelection`/`getLatestSelection` (VS Code)
* and `get_all_opened_file_paths`/`getOpenEditors` for the opened-file list.
* Every reading is a no-op unless the IDE is present, reachable, and
* authenticated: connection failures, expired tokens, and missing lock files
* are logged as warnings and never fail a turn.
*
* On each eligible turn the plugin prepends one sourced `UserMessage`
* carrying the latest IDE snapshot, re-injecting only when the rendered
* snapshot differs from its last injection (an optional `refreshIntervalMs`
* floor applies between injections). Sessions schedule independently and the
* suppression scan uses only durable session events, so scheduling survives
* compaction and resumed processes.
*
* @module @deepseek-ai/dsh-ide-context
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "ide-context";
/** The agent registry that owns pre-step processing. */
const inject = ["agents"];
/** Schemastery validation for {@link Config}. */
const Config = z.object({
	refreshIntervalMs: z.number(),
	pollIntervalMs: z.number(),
	lockDir: z.string()
});
/** Lock-file directory default, shared with the Claude Code CLI. */
const DEFAULT_LOCK_DIR = join(homedir(), ".claude", "ide");
/** How often the lock directory is rescanned for a newer/rotated lock file. */
const LOCK_SCAN_INTERVAL_MS = 2e3;
/** Upper bound on the reconnect backoff. */
const MAX_RECONNECT_DELAY_MS = 3e4;
/** MCP protocol version negotiated with the IDE bridge. */
const PROTOCOL_VERSION = "2024-11-05";
/** MCP subprotocol required by the Ktor/extension WebSocket servers. */
const WS_SUBPROTOCOL = "mcp";
/** Prefix marking the volatile turn/step preamble line of a rendered reading. */
const READING_PREFIX = "ide context (turn ";
/** Minimal WebSocket client speaking single text frames, used for the IDE bridge. */
var RawWs = class {
	url;
	headers;
	socket;
	buffer = Buffer.alloc(0);
	closed = false;
	constructor(url, headers) {
		this.url = url;
		this.headers = headers;
	}
	onopen;
	onmessage;
	onclose;
	onerror;
	/** Open the WebSocket connection (RFC 6455 handshake). */
	connect() {
		const u = new URL(this.url);
		const key = crypto.randomBytes(16).toString("base64");
		const req = http.request({
			host: u.hostname,
			port: u.port,
			path: u.pathname || "/",
			headers: {
				Host: `${u.hostname}:${u.port}`,
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": key,
				"Sec-WebSocket-Protocol": WS_SUBPROTOCOL,
				...this.headers
			}
		});
		req.on("upgrade", (_res, socket) => {
			this.socket = socket;
			socket.on("data", (chunk) => {
				this.consume(chunk);
			});
			socket.on("close", () => {
				if (!this.closed) {
					this.closed = true;
					this.onclose?.(1006, "socket closed");
				}
			});
			socket.on("error", (error) => this.onerror?.(error));
			this.onopen?.();
		});
		req.on("response", (res) => {
			this.onerror?.(/* @__PURE__ */ new Error(`handshake rejected: HTTP ${res.statusCode}`));
			res.resume();
		});
		req.on("error", (error) => this.onerror?.(error));
		req.end();
	}
	/** Send one masked text frame. */
	send(text) {
		const payload = Buffer.from(text, "utf8");
		const mask = crypto.randomBytes(4);
		for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
		let header;
		if (payload.length < 126) header = Buffer.from([129, 128 | payload.length]);
		else if (payload.length < 65536) {
			header = Buffer.alloc(4);
			header[0] = 129;
			header[1] = 254;
			header.writeUInt16BE(payload.length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 129;
			header[1] = 255;
			header.writeBigUInt64BE(BigInt(payload.length), 2);
		}
		this.socket?.write(Buffer.concat([
			header,
			mask,
			payload
		]));
	}
	/** Close the connection (client-initiated). */
	close() {
		this.closed = true;
		this.socket?.end();
	}
	consume(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 2) {
			const firstByte = this.buffer[0] ?? 0;
			const secondByte = this.buffer[1] ?? 0;
			const opcode = firstByte & 15;
			let length = secondByte & 127;
			let offset = 2;
			if (length === 126) {
				if (this.buffer.length < 4) return;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.buffer.length < 10) return;
				length = Number(this.buffer.readBigUInt64BE(2));
				offset = 10;
			}
			if (this.buffer.length < offset + length) return;
			const payload = this.buffer.subarray(offset, offset + length);
			this.buffer = this.buffer.subarray(offset + length);
			if (opcode === 1) this.onmessage?.(payload.toString("utf8"));
			else if (opcode === 9) {
				const pong = Buffer.concat([
					Buffer.from([138]),
					Buffer.from([payload.length]),
					payload
				]);
				this.socket?.write(pong);
			} else if (opcode === 8) {
				this.closed = true;
				const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
				const reason = payload.length > 2 ? payload.subarray(2).toString() : "";
				this.onclose?.(code, reason);
			}
		}
	}
};
/**
* Read and parse every `<port>.lock` under the lock directory, newest first,
* or `undefined` when the directory is missing/unreadable or holds no
* readable lock files. Unreadable or token-less files are skipped with a
* warning (matching the newest-only reader's prior behavior).
* Exported for tests and for the {@link scanLatestLock} wrapper.
*/
function scanLocks(lockDir, logger) {
	let entries;
	try {
		entries = readdirSync(lockDir);
	} catch (error) {
		logger.warn(`ide-context: cannot read lock directory ${lockDir}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const candidates = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".lock")) continue;
		const path = join(lockDir, entry);
		let mtime;
		try {
			mtime = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		const fileName = path.split(/[\\/]/).pop();
		if (fileName === void 0) continue;
		const port = Number(fileName.replace(".lock", ""));
		if (!Number.isInteger(port) || port <= 0) continue;
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			logger.warn(`ide-context: unreadable lock file ${path}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const root = parsed;
		if (typeof root.authToken !== "string" || root.authToken.length === 0) continue;
		const folders = Array.isArray(root.workspaceFolders) ? root.workspaceFolders.filter((item) => typeof item === "string") : [];
		candidates.push({
			path,
			mtime,
			lock: {
				port,
				ideName: typeof root.ideName === "string" ? root.ideName : void 0,
				pid: typeof root.pid === "number" ? root.pid : void 0,
				workspaceFolders: folders,
				authToken: root.authToken
			}
		});
	}
	candidates.sort((a, b) => b.mtime - a.mtime);
	return candidates;
}
/**
* Read the newest `<port>.lock` under the lock directory, or `undefined` when
* the directory is missing/unreadable or holds no lock files. The newest file
* is selected by modification time, matching the Claude Code CLI's own
* selection rule (`getSortedIdeLockfiles` in `src/utils/ide.ts`).
* Exported for tests and for embedders that want to inspect lock files
* without starting a bridge.
*/
function scanLatestLock(lockDir, logger) {
	return scanLocks(lockDir, logger)?.[0]?.lock;
}
/**
* Select one lock to follow. When a session working directory is supplied and
* some candidate lists it exactly as one of its workspace folders, the newest
* such candidate wins — so an IntelliJ and a VS Code both running pick the one
* whose project is the current session. With no cwd, or no exact match, the
* plain newest lock wins.
* Exported for tests.
*/
function selectLockByWorkspace(candidates, cwd) {
	if (cwd !== void 0) {
		let best;
		for (const candidate of candidates) {
			if (!candidate.lock.workspaceFolders.includes(cwd)) continue;
			if (best === void 0 || candidate.mtime > best.mtime) best = candidate;
		}
		if (best !== void 0) return best;
	}
	return candidates[0];
}
/** Candidate tool names for the opened-file list, probed against tools/list. */
const OPENED_FILES_TOOLS = ["get_all_opened_file_paths", "getOpenEditors"];
/** Candidate tool names for the current selection, probed against tools/list. */
const SELECTION_TOOLS = ["getCurrentSelection", "getLatestSelection"];
/**
* Background bridge to the IDE's MCP-over-WebSocket server. Owns the
* connection lifecycle (lock scan, handshake, reconnects with backoff, ping
* replies) and the current {@link IdeSnapshot}. All failures degrade to a
* warning and leave the snapshot untouched; nothing here can fail a turn.
*
* Registered on the context as `ctx.ideContext`; tests may replace it with a
* stub exposing {@link IdeBridge.latest} only.
*/
var IdeBridge = class {
	lockDir;
	pollIntervalMs;
	logger;
	snapshot = {
		ideName: void 0,
		workspaceFolders: [],
		openedFiles: []
	};
	ws;
	knownTools = [];
	lockPath;
	nextRequestId = 1;
	pending = /* @__PURE__ */ new Map();
	lockTimer;
	pollTimer;
	reconnectDelayMs = 500;
	disposed = false;
	constructor(lockDir, pollIntervalMs, logger) {
		this.lockDir = lockDir;
		this.pollIntervalMs = pollIntervalMs;
		this.logger = logger;
	}
	/** Latest IDE snapshot, or `undefined` before any data arrived. */
	latest() {
		const { snapshot } = this;
		if (snapshot.ideName === void 0 && snapshot.openedFiles.length === 0 && snapshot.selection === void 0) return;
		return snapshot;
	}
	/**
	* Re-select the lock by a session working directory: prefer a lock whose
	* workspace folder exactly equals `cwd`, else the newest lock. Reconnects
	* only when the chosen lock differs from the current one.
	* @param cwd - the session's working directory, or `undefined` to follow the newest lock.
	*/
	followWorkspace(cwd) {
		if (this.disposed) return;
		const selected = selectLockByWorkspace(scanLocks(this.lockDir, this.logger) ?? [], cwd);
		const lock = selected?.lock;
		const path = selected === void 0 ? void 0 : `${lock?.port}.lock`;
		if (path === this.lockPath) return;
		this.lockPath = path;
		this.knownTools = [];
		this.snapshot = {
			ideName: lock?.ideName,
			workspaceFolders: lock?.workspaceFolders ?? [],
			openedFiles: []
		};
		if (lock !== void 0) this.connect(lock);
	}
	/** Start lock scanning and polling. */
	start() {
		this.rescan();
		this.lockTimer = setInterval(() => {
			this.rescan();
		}, LOCK_SCAN_INTERVAL_MS);
		this.pollTimer = setInterval(() => {
			this.poll();
		}, this.pollIntervalMs);
	}
	/** Tear down the bridge: close the socket and all timers. */
	dispose() {
		this.disposed = true;
		if (this.lockTimer !== void 0) clearInterval(this.lockTimer);
		if (this.pollTimer !== void 0) clearInterval(this.pollTimer);
		this.ws?.close();
		this.ws = void 0;
	}
	/** Re-evaluate the newest lock file; switch connections when it changed. */
	rescan() {
		if (this.disposed) return;
		const lock = scanLatestLock(this.lockDir, this.logger);
		const path = lock === void 0 ? void 0 : `${lock.port}.lock`;
		if (path === this.lockPath) return;
		this.lockPath = path;
		this.knownTools = [];
		this.snapshot = {
			ideName: lock?.ideName,
			workspaceFolders: lock?.workspaceFolders ?? [],
			openedFiles: []
		};
		if (lock !== void 0) this.connect(lock);
	}
	/** Open (or re-open) the WebSocket + MCP session to one lock file. */
	connect(lock) {
		this.ws?.close();
		const url = `ws://127.0.0.1:${lock.port}`;
		this.logger.debug(`ide-context: connecting to ${url} (${lock.ideName ?? "IDE"})`);
		const ws = new RawWs(url, { "X-Claude-Code-Ide-Authorization": lock.authToken });
		this.ws = ws;
		ws.onopen = () => {
			this.reconnectDelayMs = 500;
			this.logger.debug("ide-context: websocket connected");
			this.rpc("initialize", {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: {
					name: "dsh-ide-context",
					version: "0.1.0"
				}
			}).then((result) => {
				if (result !== void 0 && typeof result === "object" && result.error === void 0) {
					this.ws?.send(JSON.stringify({
						jsonrpc: "2.0",
						method: "notifications/initialized"
					}));
					this.rpc("tools/list", {}).then((toolsResult) => {
						this.handleToolsList(toolsResult);
					});
				}
			});
		};
		ws.onmessage = (raw) => {
			this.handleMessage(raw);
		};
		ws.onclose = (code, reason) => {
			this.logger.warn(`ide-context: connection closed (${code} ${reason}); will retry`);
			this.scheduleReconnect();
		};
		ws.onerror = (error) => {
			this.logger.warn(`ide-context: connection error: ${error.message}`);
			this.scheduleReconnect();
		};
		ws.connect();
	}
	scheduleReconnect() {
		if (this.disposed) return;
		const delay = this.reconnectDelayMs;
		this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
		setTimeout(() => {
			if (this.disposed) return;
			const lock = scanLatestLock(this.lockDir, this.logger);
			if (lock !== void 0) this.connect(lock);
		}, delay);
	}
	/** Fire a JSON-RPC request; responses resolve via {@link handleMessage}. */
	rpc(method, params) {
		const id = String(this.nextRequestId++);
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.ws?.send(JSON.stringify({
				jsonrpc: "2.0",
				id,
				method,
				params
			}));
		});
	}
	/** Dispatch one inbound JSON-RPC message. */
	handleMessage(raw) {
		let message;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		const method = typeof message.method === "string" ? message.method : void 0;
		if (message.id !== void 0 && method !== void 0 && message.result === void 0 && message.error === void 0) {
			this.ws?.send(JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: {}
			}));
			return;
		}
		if (typeof message.id === "string" && this.pending.has(message.id)) {
			const resolve = this.pending.get(message.id);
			if (resolve !== void 0) {
				this.pending.delete(message.id);
				resolve(message.error ?? message.result);
			}
			return;
		}
		if (method === "selection_changed") this.applySelectionChanged(message.params);
	}
	/** Update the snapshot from a `selection_changed` notification. */
	applySelectionChanged(params) {
		const p = params;
		if (p === void 0) return;
		const filePath = typeof p.filePath === "string" ? p.filePath : void 0;
		const selection = p.selection;
		const text = typeof p.text === "string" ? p.text : "";
		if (filePath === void 0) return;
		if (selection === null || selection === void 0) {
			this.snapshot.selection = {
				filePath,
				start: {
					line: 0,
					character: 0
				},
				end: {
					line: 0,
					character: 0
				},
				text
			};
			return;
		}
		const start = selection.start;
		const end = selection.end;
		if (start === void 0 || end === void 0) return;
		this.snapshot.selection = {
			filePath,
			start: {
				line: Number(start.line) || 0,
				character: Number(start.character) || 0
			},
			end: {
				line: Number(end.line) || 0,
				character: Number(end.character) || 0
			},
			text
		};
	}
	/** Periodically refresh opened files and (where exposed) the selection. */
	poll() {
		if (this.ws === void 0 || this.disposed) return;
		this.refreshOpenedFiles();
		this.refreshSelection();
	}
	async refreshOpenedFiles() {
		const tool = OPENED_FILES_TOOLS.find((candidate) => this.knownTools.includes(candidate));
		if (tool === void 0) return;
		const files = extractOpenedFiles(await this.rpc("tools/call", {
			name: tool,
			arguments: {}
		}));
		if (files !== void 0) this.snapshot.openedFiles = files;
	}
	async refreshSelection() {
		const tool = SELECTION_TOOLS.find((candidate) => this.knownTools.includes(candidate));
		if (tool === void 0) return;
		const selection = extractSelectionToolResult(await this.rpc("tools/call", {
			name: tool,
			arguments: {}
		}));
		if (selection !== void 0) this.snapshot.selection = selection;
	}
	/** Record the tool list once `tools/list` is answered. */
	setKnownTools(tools) {
		this.knownTools = tools;
		this.logger.debug(`ide-context: IDE tools: ${tools.join(", ")}`);
		this.refreshOpenedFiles();
		this.refreshSelection();
	}
	/** Wire the `tools/list` response into {@link setKnownTools}. */
	handleToolsList(result) {
		const tools = result?.tools;
		if (!Array.isArray(tools)) return;
		this.setKnownTools(tools.map((tool) => typeof tool.name === "string" ? tool.name : ""));
	}
};
/** Parse opened-file paths out of a tool result (both IDE dialects). Exported for tests. */
function extractOpenedFiles(result) {
	const content = extractToolText(result);
	if (content === void 0) return void 0;
	const trimmed = content.trim();
	const parsed = parseJson(trimmed);
	if (parsed !== null && typeof parsed === "object") return extractFilePaths(parsed);
	const files = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("[") && !line.startsWith("{"));
	return files.length > 0 ? files : void 0;
}
/** Parse `text` as JSON, or `undefined` when it is not JSON. */
function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
/** Pull file paths out of a `getOpenEditors` JSON value (array or `{ tabs: [...] }`). */
function extractFilePaths(parsed) {
	const items = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" && Array.isArray(parsed.tabs) ? parsed.tabs : void 0;
	if (items === void 0) return [];
	return items.map((item) => itemFilePath(item)).filter((file) => typeof file === "string" && file.length > 0);
}
/** Normalize one opened-editor entry to a filesystem path, or `undefined`. */
function itemFilePath(item) {
	if (typeof item === "string") return item;
	if (item === null || typeof item !== "object") return void 0;
	const record = item;
	if (typeof record.fileName === "string") return record.fileName;
	if (typeof record.path === "string") return record.path;
	if (typeof record.uri === "string") return fileUriToPath(record.uri);
}
/** Convert a `file://` URL to a filesystem path; pass non-file URLs through. */
function fileUriToPath(uri) {
	if (!uri.startsWith("file://")) return uri;
	const rest = uri.slice(7);
	try {
		return decodeURIComponent(rest);
	} catch {
		return rest;
	}
}
/**
* Extract the first `text` block from an MCP tool result, or the stringified
* `text` field when the server returns a plain object instead of content
* blocks (both shapes occur across IDE versions).
*/
function extractToolText(result) {
	if (result === null || typeof result !== "object") return void 0;
	const content = result.content;
	if (Array.isArray(content)) {
		for (const block of content) if (typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string") return block.text;
		return;
	}
	const text = result.text;
	return typeof text === "string" ? text : void 0;
}
/** Parse a selection out of a `getCurrentSelection`/`getLatestSelection` result. Exported for tests. */
function extractSelectionToolResult(result) {
	const text = extractToolText(result);
	if (text === void 0) return void 0;
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return;
	}
	const filePath = typeof data.filePath === "string" ? data.filePath : void 0;
	if (filePath === void 0) return void 0;
	const selection = data.selection;
	const selectedText = typeof data.text === "string" ? data.text : "";
	if (selection === null || selection === void 0) return {
		filePath,
		start: {
			line: 0,
			character: 0
		},
		end: {
			line: 0,
			character: 0
		},
		text: selectedText
	};
	const start = selection.start;
	const end = selection.end;
	if (start === void 0 || end === void 0) return void 0;
	return {
		filePath,
		start: {
			line: Number(start.line) || 0,
			character: Number(start.character) || 0
		},
		end: {
			line: Number(end.line) || 0,
			character: Number(end.character) || 0
		},
		text: selectedText
	};
}
/** Render the stable state block: the part compared for change suppression. */
function renderState(snapshot) {
	const lines = [];
	if (snapshot.ideName !== void 0) lines.push(`ide: ${snapshot.ideName}`);
	if (snapshot.openedFiles.length > 0) {
		lines.push(`opened files (${snapshot.openedFiles.length}):`);
		for (const file of snapshot.openedFiles) lines.push(`- ${file}`);
	}
	const selection = snapshot.selection;
	if (selection !== void 0 && (selection.start.line !== 0 || selection.start.character !== 0 || selection.end.line !== 0 || selection.end.character !== 0 || selection.text.length > 0)) {
		const startLine = selection.start.line + 1;
		const endLine = selection.end.line + 1;
		const linesLabel = startLine === endLine ? `line ${startLine}` : `lines ${startLine} to ${endLine}`;
		lines.push(`The user selected ${linesLabel} from ${selection.filePath}:`);
		if (selection.text.length > 0) lines.push(selection.text);
		lines.push("");
		lines.push("This may or may not be related to the current task.");
	}
	return lines.join("\n");
}
/** Render the full durable reading, including the volatile turn preamble. */
function renderReading(snapshot, turn) {
	return `${READING_PREFIX}${turn}):\n${renderState(snapshot)}`;
}
/**
* The stable state block of this plugin's latest durable injection, or
* `undefined` when the session has none. Scans raw durable events so the
* schedule survives compaction and resumed processes without process-local
* cache state.
*/
function latestInjectedState(agent) {
	for (const event of [...agent.session.events].reverse()) if (event.type === "user/message" && event.data.source.kind === "plugin" && event.data.source.plugin === "ide-context") {
		const [block] = event.data.content;
		if (block?.type !== "text") return void 0;
		const newline = block.text.indexOf("\n");
		return {
			state: newline === -1 ? "" : block.text.slice(newline + 1),
			time: event.time
		};
	}
}
/** Reject non-negative non-safe-integer intervals. */
function validatePositiveInteger(value, field) {
	if (value !== void 0 && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`ide-context: ${field} must be a non-negative safe integer, got ${String(value)}`);
}
/**
* Register a prepended pre-step listener plus the background IDE bridge for
* the lifetime of `ctx`.
* @param ctx - plugin context; the listener and bridge are disposed with it.
* @param config - scheduling and bridge tuning.
*/
function apply(ctx, config) {
	const refreshIntervalMs = config.refreshIntervalMs;
	const pollIntervalMs = config.pollIntervalMs ?? 5e3;
	const lockDir = config.lockDir ?? DEFAULT_LOCK_DIR;
	validatePositiveInteger(refreshIntervalMs, "refreshIntervalMs");
	validatePositiveInteger(pollIntervalMs, "pollIntervalMs");
	const bridge = ctx.get("ideContext") ?? new IdeBridge(lockDir, pollIntervalMs, ctx.logger);
	if (ctx.get("ideContext") === void 0) {
		ctx.provide("ideContext", bridge);
		ctx.effect(() => {
			bridge.start();
			return () => {
				bridge.dispose();
			};
		}, `${name} bridge`);
	}
	ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted || step !== 1) return decision;
		bridge.followWorkspace(agent.session.header.cwd);
		const previous = latestInjectedState(agent);
		if (refreshIntervalMs !== void 0 && refreshIntervalMs > 0 && previous !== void 0) {
			const now = Date.now();
			if (now >= previous.time && now - previous.time < refreshIntervalMs) return decision;
		}
		const snapshot = bridge.latest();
		if (snapshot === void 0) return decision;
		const state = renderState(snapshot);
		if (state.length === 0) return decision;
		if (previous !== void 0 && previous.state === state) return decision;
		const text = renderReading(snapshot, turn);
		return {
			kind: "enter",
			messages: [createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: {
					kind: "plugin",
					plugin: name,
					form: "snapshot",
					sections: [{
						name,
						text
					}]
				}
			}), ...decision.messages]
		};
	}, { prepend: true });
}
//#endregion
export { Config, IdeBridge, apply, extractOpenedFiles, extractSelectionToolResult, inject, name, renderState, scanLatestLock, scanLocks, selectLockByWorkspace };
