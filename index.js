// src/index.ts
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import http from "node:http";
import crypto from "node:crypto";
var name = "ide-context";
var inject = ["agents"];
var Config = z.object({
  refreshIntervalMs: z.number(),
  pollIntervalMs: z.number(),
  lockDir: z.string()
});
var DEFAULT_LOCK_DIR = join(homedir(), ".claude", "ide");
var LOCK_SCAN_INTERVAL_MS = 2e3;
var MAX_RECONNECT_DELAY_MS = 3e4;
var PROTOCOL_VERSION = "2024-11-05";
var WS_SUBPROTOCOL = "mcp";
var DATA_READY_TIMEOUT_MS = 1500;
var READING_PREFIX = "ide context (turn ";
var RawWs = class {
  constructor(url, headers) {
    this.url = url;
    this.headers = headers;
  }
  url;
  headers;
  socket;
  buffer = Buffer.alloc(0);
  closed = false;
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
      this.onerror?.(new Error(`handshake rejected: HTTP ${res.statusCode}`));
      res.resume();
    });
    req.on("error", (error) => this.onerror?.(error));
    req.end();
  }
  /** Send one masked text frame. */
  send(text) {
    const payload = Buffer.from(text, "utf8");
    const mask = crypto.randomBytes(4);
    for (let i = 0; i < payload.length; i++) {
      const byte = payload[i] ?? 0;
      const key = mask[i % 4] ?? 0;
      payload[i] = byte ^ key;
    }
    let header;
    if (payload.length < 126) {
      header = Buffer.from([128 | 1, 128 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 128 | 1;
      header[1] = 128 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 128 | 1;
      header[1] = 128 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket?.write(Buffer.concat([header, mask, payload]));
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
      if (opcode === 1) {
        this.onmessage?.(payload.toString("utf8"));
      } else if (opcode === 9) {
        const pong = Buffer.concat([Buffer.from([138]), Buffer.from([payload.length]), payload]);
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
function scanLocks(lockDir, logger) {
  let entries;
  try {
    entries = readdirSync(lockDir);
  } catch (error) {
    logger.warn(`ide-context: cannot read lock directory ${lockDir}: ${error instanceof Error ? error.message : String(error)}`);
    return void 0;
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
function scanLatestLock(lockDir, logger) {
  return scanLocks(lockDir, logger)?.[0]?.lock;
}
function normalizePathForCompare(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function isWithinRoot(path, root) {
  const p = normalizePathForCompare(path);
  const r = normalizePathForCompare(root);
  if (p === r) return true;
  return p.startsWith(`${r}${sep}`);
}
function uniqueRoots(roots) {
  const out = [];
  for (const root of roots) {
    if (root.length === 0) continue;
    if (out.some((existing) => isWithinRoot(root, existing))) continue;
    out.push(root);
  }
  return out;
}
function selectLockByWorkspace(candidates, cwd) {
  if (cwd !== void 0) {
    let best;
    for (const candidate of candidates) {
      if (!candidate.lock.workspaceFolders.some((folder) => isWithinRoot(cwd, folder))) continue;
      if (best === void 0 || candidate.mtime > best.mtime) best = candidate;
    }
    if (best !== void 0) return best;
  }
  return candidates[0];
}
function filterFilesUnderRoots(files, roots) {
  if (roots.length === 0) return files;
  return files.filter((file) => roots.some((root) => isWithinRoot(file, root)));
}
var OPENED_FILES_TOOLS = ["get_all_opened_file_paths", "getOpenEditors"];
var SELECTION_TOOLS = ["getCurrentSelection", "getLatestSelection"];
var IdeBridge = class {
  constructor(lockDir, pollIntervalMs, logger) {
    this.lockDir = lockDir;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
  }
  lockDir;
  pollIntervalMs;
  logger;
  snapshot = {
    ideName: void 0,
    workspaceFolders: [],
    openedFiles: []
  };
  /** Roots every opened file / selection must live under; empty means no filter. */
  workspaceRoots = [];
  ws;
  knownTools = [];
  lockPath;
  /** Session working directory the bridge currently follows; `undefined` until first follow call. */
  cwd;
  /** Workspace folders of the lock currently selected (used to detect same-port content changes). */
  selectedFolders = [];
  nextRequestId = 1;
  pending = /* @__PURE__ */ new Map();
  lockTimer;
  pollTimer;
  reconnectDelayMs = 500;
  disposed = false;
  /** Waiters blocking `awaitLatest` until substantive data (files/selection) arrives. */
  readyWaiters = /* @__PURE__ */ new Set();
  /**
   * Latest IDE snapshot, or `undefined` before any substantive data arrived.
   * `ideName` alone is connection metadata, not context: it is written as soon
   * as a lock is adopted, before the first async poll of opened files and the
   * selection returns. Treating it as "data" would emit a half-empty rendering
   * (just `ide: <name>`) on a fresh session's first step.
   */
  latest() {
    const { snapshot } = this;
    if (snapshot.openedFiles.length === 0 && snapshot.selection === void 0) {
      return void 0;
    }
    return snapshot;
  }
  /**
   * Resolve to the latest snapshot, blocking up to `timeoutMs` for the first
   * substantive data to arrive. On a fresh connection the async handshake and
   * first poll have not returned yet when an eligible step fires; without this
   * wait that first step would inject nothing. Returns `undefined` when no data
   * arrives within the timeout.
   */
  async awaitLatest(timeoutMs) {
    const immediate = this.latest();
    if (immediate !== void 0) return immediate;
    if (this.disposed) return void 0;
    return await new Promise((resolve2) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.readyWaiters.delete(onData);
        clearTimeout(timer);
        resolve2(this.latest());
      };
      const onData = () => {
        done();
      };
      const timer = setTimeout(done, timeoutMs);
      this.readyWaiters.add(onData);
    });
  }
  /** Wake any {@link awaitLatest} waiters once files/selection have arrived. */
  notifyData() {
    const { snapshot } = this;
    if (snapshot.openedFiles.length === 0 && snapshot.selection === void 0) return;
    for (const waiter of this.readyWaiters) waiter();
    this.readyWaiters.clear();
  }
  /**
   * Re-select the lock by a session working directory: prefer a lock whose
   * workspace folder exactly equals `cwd`, else the newest lock. Reconnects
   * only when the chosen lock differs from the current one. The selected lock
   * is identified by its port *and* workspace folders — a same-port lock whose
   * `workspaceFolders` content changed (the same editor window switched
   * projects) still triggers a rebuild, unlike a bare port comparison.
   * @param cwd - the session's working directory, or `undefined` to follow the newest lock.
   */
  followWorkspace(cwd) {
    if (this.disposed) return;
    this.cwd = cwd;
    this.reselect();
  }
  /**
   * Re-scan locks and adopt the lock selected for {@link cwd}, or `undefined`.
   * Rebuilds workspace filters and reconnects whenever the selected lock's
   * identity (port or workspace folders) changed since the last adoption.
   */
  reselect() {
    if (this.disposed) return;
    const candidates = scanLocks(this.lockDir, this.logger) ?? [];
    const selected = selectLockByWorkspace(candidates, this.cwd);
    const lock = selected?.lock;
    const folders = lock?.workspaceFolders ?? [];
    if (lock !== void 0 && this.sameSelection(lock.port, folders)) return;
    this.adoptLock(selected);
  }
  /** True when `port` + `folders` describe the lock already adopted. */
  sameSelection(port, folders) {
    const path = `${port}.lock`;
    if (path !== this.lockPath) return false;
    if (folders.length !== this.selectedFolders.length) return false;
    for (let i = 0; i < folders.length; i++) {
      if (folders[i] !== this.selectedFolders[i]) return false;
    }
    return true;
  }
  /** Adopt a selected lock (or `undefined`): reset filters and reconnect. */
  adoptLock(selected) {
    const lock = selected?.lock;
    const folders = lock?.workspaceFolders ?? [];
    this.lockPath = selected === void 0 ? void 0 : `${lock?.port}.lock`;
    this.selectedFolders = folders;
    this.knownTools = [];
    this.workspaceRoots = uniqueRoots([...folders, ...this.cwd !== void 0 ? [this.cwd] : []]);
    this.snapshot = {
      ideName: lock?.ideName,
      workspaceFolders: folders,
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
  /** Re-evaluate the selected lock file; switch connections when it changed. */
  rescan() {
    this.reselect();
  }
  /** Open (or re-open) the WebSocket + MCP session to one lock file. */
  connect(lock) {
    this.ws?.close();
    const url = `ws://127.0.0.1:${lock.port}`;
    this.logger.debug(`ide-context: connecting to ${url} (${lock.ideName ?? "IDE"})`);
    const ws = new RawWs(url, {
      "X-Claude-Code-Ide-Authorization": lock.authToken
    });
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelayMs = 500;
      this.logger.debug("ide-context: websocket connected");
      void this.rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "@deepseek-ai/dsh-ide-context", version: "0.1.0" }
      }).then((result) => {
        if (result !== void 0 && typeof result === "object" && result.error === void 0) {
          this.ws?.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
          void this.rpc("tools/list", {}).then((toolsResult) => {
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
      const candidates = scanLocks(this.lockDir, this.logger) ?? [];
      const selected = selectLockByWorkspace(candidates, this.cwd);
      if (selected !== void 0) this.adoptLock(selected);
    }, delay);
  }
  /** Fire a JSON-RPC request; responses resolve via {@link handleMessage}. */
  rpc(method, params) {
    const id = String(this.nextRequestId++);
    return new Promise((resolve2) => {
      this.pending.set(id, resolve2);
      this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
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
      this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      return;
    }
    if (typeof message.id === "string" && this.pending.has(message.id)) {
      const resolve2 = this.pending.get(message.id);
      if (resolve2 !== void 0) {
        this.pending.delete(message.id);
        resolve2(message.error ?? message.result);
      }
      return;
    }
    if (method === "selection_changed") {
      this.applySelectionChanged(message.params);
    }
  }
  /** Update the snapshot from a `selection_changed` notification. */
  applySelectionChanged(params) {
    const p = params;
    if (p === void 0) return;
    const filePath = typeof p.filePath === "string" ? p.filePath : void 0;
    const selection = p.selection;
    const text = typeof p.text === "string" ? p.text : "";
    if (filePath === void 0) return;
    if (!this.isInWorkspace(filePath)) return;
    if (selection === null || selection === void 0) {
      this.snapshot.selection = { filePath, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, text };
      this.notifyData();
      return;
    }
    const start = selection.start;
    const end = selection.end;
    if (start === void 0 || end === void 0) return;
    this.snapshot.selection = {
      filePath,
      start: { line: Number(start.line) || 0, character: Number(start.character) || 0 },
      end: { line: Number(end.line) || 0, character: Number(end.character) || 0 },
      text
    };
    this.notifyData();
  }
  /** Periodically refresh opened files and (where exposed) the selection. */
  poll() {
    if (this.ws === void 0 || this.disposed) return;
    void this.refreshOpenedFiles();
    void this.refreshSelection();
  }
  async refreshOpenedFiles() {
    const tool = OPENED_FILES_TOOLS.find((candidate) => this.knownTools.includes(candidate));
    if (tool === void 0) return;
    const result = await this.rpc("tools/call", { name: tool, arguments: {} });
    const files = extractOpenedFiles(result);
    if (files !== void 0) {
      this.snapshot.openedFiles = filterFilesUnderRoots(files, this.workspaceRoots);
      this.notifyData();
    }
  }
  async refreshSelection() {
    const tool = SELECTION_TOOLS.find((candidate) => this.knownTools.includes(candidate));
    if (tool === void 0) return;
    const result = await this.rpc("tools/call", { name: tool, arguments: {} });
    const selection = extractSelectionToolResult(result);
    if (selection === void 0) return;
    if (!this.isInWorkspace(selection.filePath)) return;
    this.snapshot.selection = selection;
    this.notifyData();
  }
  /** True when `path` belongs under one of the current workspace roots (no roots = accept). */
  isInWorkspace(path) {
    return this.workspaceRoots.length === 0 || this.workspaceRoots.some((root) => isWithinRoot(path, root));
  }
  /** Record the tool list once `tools/list` is answered. */
  setKnownTools(tools) {
    this.knownTools = tools;
    this.logger.debug(`ide-context: IDE tools: ${tools.join(", ")}`);
    void this.refreshOpenedFiles();
    void this.refreshSelection();
  }
  /** Wire the `tools/list` response into {@link setKnownTools}. */
  handleToolsList(result) {
    const tools = result?.tools;
    if (!Array.isArray(tools)) return;
    this.setKnownTools(tools.map((tool) => typeof tool.name === "string" ? tool.name : ""));
  }
};
function extractOpenedFiles(result) {
  const content = extractToolText(result);
  if (content === void 0) return void 0;
  const trimmed = content.trim();
  const parsed = parseJson(trimmed);
  if (parsed !== null && typeof parsed === "object") {
    return extractFilePaths(parsed);
  }
  const files = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("[") && !line.startsWith("{"));
  return files.length > 0 ? files : void 0;
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function extractFilePaths(parsed) {
  const items = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" && Array.isArray(parsed.tabs) ? parsed.tabs : void 0;
  if (items === void 0) return [];
  return items.map((item) => itemFilePath(item)).filter((file) => typeof file === "string" && file.length > 0);
}
function itemFilePath(item) {
  if (typeof item === "string") return fileUriToPath(item);
  if (item === null || typeof item !== "object") return void 0;
  const record = item;
  if (typeof record.fileName === "string" && isDiskPath(record.fileName)) return record.fileName;
  if (typeof record.path === "string" && isDiskPath(record.path)) return record.path;
  if (typeof record.uri === "string") return fileUriToPath(record.uri);
  return void 0;
}
function isDiskPath(path) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) ? path.startsWith("file://") : true;
}
function fileUriToPath(uri) {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) return uri;
  if (!uri.startsWith("file://")) return void 0;
  const rest = uri.slice("file://".length);
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}
function extractToolText(result) {
  if (result === null || typeof result !== "object") return void 0;
  const content = result.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
    }
    return void 0;
  }
  const text = result.text;
  return typeof text === "string" ? text : void 0;
}
function extractSelectionToolResult(result) {
  const text = extractToolText(result);
  if (text === void 0) return void 0;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return void 0;
  }
  const filePath = typeof data.filePath === "string" ? data.filePath : void 0;
  if (filePath === void 0) return void 0;
  const selection = data.selection;
  const selectedText = typeof data.text === "string" ? data.text : "";
  if (selection === null || selection === void 0) {
    return { filePath, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, text: selectedText };
  }
  const start = selection.start;
  const end = selection.end;
  if (start === void 0 || end === void 0) return void 0;
  return {
    filePath,
    start: { line: Number(start.line) || 0, character: Number(start.character) || 0 },
    end: { line: Number(end.line) || 0, character: Number(end.character) || 0 },
    text: selectedText
  };
}
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
function renderReading(snapshot, turn) {
  return `${READING_PREFIX}${turn}):
${renderState(snapshot)}`;
}
async function readSnapshot(bridge, timeoutMs) {
  if (typeof bridge.awaitLatest === "function") return await bridge.awaitLatest(timeoutMs);
  return bridge.latest();
}
function latestInjectedState(agent) {
  for (const event of [...agent.session.events].reverse()) {
    if (event.type === "user/message" && event.data.source.kind === "plugin" && event.data.source.plugin === name) {
      const [block] = event.data.content;
      if (block?.type !== "text") return void 0;
      const newline = block.text.indexOf("\n");
      const state = newline === -1 ? "" : block.text.slice(newline + 1);
      return { state, time: event.time };
    }
  }
  return void 0;
}
function validatePositiveInteger(value, field) {
  if (value !== void 0 && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`ide-context: ${field} must be a non-negative safe integer, got ${String(value)}`);
  }
}
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
    const snapshot = await readSnapshot(bridge, DATA_READY_TIMEOUT_MS);
    if (snapshot === void 0) return decision;
    const state = renderState(snapshot);
    if (state.length === 0) return decision;
    if (previous !== void 0 && previous.state === state) return decision;
    const text = renderReading(snapshot, turn);
    return {
      kind: "enter",
      messages: [
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "plugin", plugin: name, form: "snapshot", sections: [{ name, text }] }
        }),
        ...decision.messages
      ]
    };
  }, { prepend: true });
}
export {
  Config,
  IdeBridge,
  apply,
  extractOpenedFiles,
  extractSelectionToolResult,
  filterFilesUnderRoots,
  inject,
  name,
  renderState,
  scanLatestLock,
  scanLocks,
  selectLockByWorkspace
};
