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

import type { Context, LoggerService } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The active IDE bridge; provided by this plugin unless a test replaces it. */
    ideContext?: IdeBridge
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ide-context'

/** The agent registry that owns pre-step processing. */
export const inject = ['agents']

/** Per-turn IDE-context scheduling and bridge tuning. Invalid values fail plugin load. */
export interface Config {
  /** Minimum milliseconds between durable injections in one session. Omit or set to 0 to inject on every eligible change. */
  refreshIntervalMs?: number
  /** Milliseconds between polling the IDE for the opened-file list and (where exposed) the current selection. Default 5000. */
  pollIntervalMs?: number
  /** Directory holding the IDE `<port>.lock` files. Defaults to `~/.claude/ide`. */
  lockDir?: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  refreshIntervalMs: z.number(),
  pollIntervalMs: z.number(),
  lockDir: z.string(),
})

/** Lock-file directory default, shared with the Claude Code CLI. */
const DEFAULT_LOCK_DIR = join(homedir(), '.claude', 'ide')
/** How often the lock directory is rescanned for a newer/rotated lock file. */
const LOCK_SCAN_INTERVAL_MS = 2_000
/** Upper bound on the reconnect backoff. */
const MAX_RECONNECT_DELAY_MS = 30_000
/** MCP protocol version negotiated with the IDE bridge. */
const PROTOCOL_VERSION = '2024-11-05'
/** MCP subprotocol required by the Ktor/extension WebSocket servers. */
const WS_SUBPROTOCOL = 'mcp'
/** How long an eligible step waits for the first IDE poll before injecting nothing. */
const DATA_READY_TIMEOUT_MS = 1_500

/** A zero-based IDE position (IntelliJ LogicalPosition / VS Code Position). */
export interface IdePosition {
  line: number
  character: number
}

/** The IDE's reported current selection. */
export interface IdeSelection {
  filePath: string
  start: IdePosition
  end: IdePosition
  text: string
}

/** Latest known IDE state, rendered for injection on change. */
export interface IdeSnapshot {
  /** IDE name from the lock file (`IntelliJ IDEA`, `Visual Studio Code`, ...). */
  ideName: string | undefined
  /** Workspace folders from the lock file. */
  workspaceFolders: string[]
  /** Open editor file paths, polled from the IDE. */
  openedFiles: string[]
  /** Current selection, when the IDE reports one. */
  selection?: IdeSelection
}

/** Parsed contents of one `<port>.lock` file. */
interface LockInfo {
  port: number
  ideName: string | undefined
  pid: number | undefined
  workspaceFolders: string[]
  authToken: string
}

/** Prefix marking the volatile turn/step preamble line of a rendered reading. */
const READING_PREFIX = 'ide context (turn '

// ---------------------------------------------------------------------------
// Zero-dependency RFC 6455 WebSocket client (masked text frames, no extensions)
// ---------------------------------------------------------------------------

/** Minimal WebSocket client speaking single text frames, used for the IDE bridge. */
class RawWs {
  private socket?: import('node:net').Socket
  private buffer = Buffer.alloc(0)
  private closed = false

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  onopen: (() => void) | undefined
  onmessage: ((text: string) => void) | undefined
  onclose: ((code: number, reason: string) => void) | undefined
  onerror: ((error: Error) => void) | undefined

  /** Open the WebSocket connection (RFC 6455 handshake). */
  connect(): void {
    const u = new URL(this.url)
    const key = crypto.randomBytes(16).toString('base64')
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname || '/',
      headers: {
        Host: `${u.hostname}:${u.port}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
        ...this.headers,
      },
    })
    req.on('upgrade', (_res, socket) => {
      this.socket = socket
      socket.on('data', (chunk: Buffer) => { this.consume(chunk) })
      socket.on('close', () => {
        if (!this.closed) {
          this.closed = true
          this.onclose?.(1006, 'socket closed')
        }
      })
      socket.on('error', (error: Error) => this.onerror?.(error))
      this.onopen?.()
    })
    req.on('response', (res) => {
      this.onerror?.(new Error(`handshake rejected: HTTP ${res.statusCode}`))
      res.resume()
    })
    req.on('error', (error: Error) => this.onerror?.(error))
    req.end()
  }

  /** Send one masked text frame. */
  send(text: string): void {
    const payload = Buffer.from(text, 'utf8')
    const mask = crypto.randomBytes(4)
    for (let i = 0; i < payload.length; i++) {
      const byte = payload[i] ?? 0
      const key = mask[i % 4] ?? 0
      payload[i] = byte ^ key
    }
    let header: Buffer
    if (payload.length < 126) {
      header = Buffer.from([0x80 | 0x1, 0x80 | payload.length])
    } else if (payload.length < 65_536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | 0x1
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | 0x1
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    this.socket?.write(Buffer.concat([header, mask, payload]))
  }

  /** Close the connection (client-initiated). */
  close(): void {
    this.closed = true
    this.socket?.end()
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0] ?? 0
      const secondByte = this.buffer[1] ?? 0
      const opcode = firstByte & 0x0f
      let length = secondByte & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (this.buffer.length < offset + length) return
      const payload = this.buffer.subarray(offset, offset + length)
      this.buffer = this.buffer.subarray(offset + length)
      if (opcode === 0x1) {
        this.onmessage?.(payload.toString('utf8'))
      } else if (opcode === 0x9) {
        // ping -> pong (payload echoed back, no mask on server frames)
        const pong = Buffer.concat([Buffer.from([0x8a]), Buffer.from([payload.length]), payload])
        this.socket?.write(pong)
      } else if (opcode === 0x8) {
        this.closed = true
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        const reason = payload.length > 2 ? payload.subarray(2).toString() : ''
        this.onclose?.(code, reason)
      }
      // 0x0/0x2 fragments and 0xa pongs ignored: the MCP bridge uses single text frames.
    }
  }
}

// ---------------------------------------------------------------------------
// Lock-file discovery
// ---------------------------------------------------------------------------

/** One lock file's parsed contents plus its modification time, newest-first. */
interface LockCandidate {
  path: string
  mtime: number
  lock: LockInfo
}

/**
 * Read and parse every `<port>.lock` under the lock directory, newest first,
 * or `undefined` when the directory is missing/unreadable or holds no
 * readable lock files. Unreadable or token-less files are skipped with a
 * warning (matching the newest-only reader's prior behavior).
 * Exported for tests and for the {@link scanLatestLock} wrapper.
 */
export function scanLocks(lockDir: string, logger: LoggerService): LockCandidate[] | undefined {
  let entries: string[]
  try {
    entries = readdirSync(lockDir)
  } catch (error: unknown) {
    logger.warn(`ide-context: cannot read lock directory ${lockDir}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const candidates: LockCandidate[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.lock')) continue
    const path = join(lockDir, entry)
    let mtime: number
    try {
      mtime = statSync(path).mtimeMs
    } catch {
      continue
    }
    const fileName = path.split(/[\\/]/).pop()
    if (fileName === undefined) continue
    const port = Number(fileName.replace('.lock', ''))
    if (!Number.isInteger(port) || port <= 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error: unknown) {
      logger.warn(`ide-context: unreadable lock file ${path}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const root = parsed as Record<string, unknown>
    if (typeof root.authToken !== 'string' || root.authToken.length === 0) continue
    const folders = Array.isArray(root.workspaceFolders)
      ? (root.workspaceFolders as unknown[]).filter((item): item is string => typeof item === 'string')
      : []
    candidates.push({
      path,
      mtime,
      lock: {
        port,
        ideName: typeof root.ideName === 'string' ? root.ideName : undefined,
        pid: typeof root.pid === 'number' ? root.pid : undefined,
        workspaceFolders: folders,
        authToken: root.authToken,
      },
    })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates
}

/**
 * Read the newest `<port>.lock` under the lock directory, or `undefined` when
 * the directory is missing/unreadable or holds no lock files. The newest file
 * is selected by modification time, matching the Claude Code CLI's own
 * selection rule (`getSortedIdeLockfiles` in `src/utils/ide.ts`).
 * Exported for tests and for embedders that want to inspect lock files
 * without starting a bridge.
 */
export function scanLatestLock(lockDir: string, logger: LoggerService): LockInfo | undefined {
  return scanLocks(lockDir, logger)?.[0]?.lock
}

/** Normalize a path to a trailing-slash-free absolute form for comparison. */
function normalizePathForCompare(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** True when `path` equals `root` or lives under it (platform-aware). */
function isWithinRoot(path: string, root: string): boolean {
  const p = normalizePathForCompare(path)
  const r = normalizePathForCompare(root)
  if (p === r) return true
  return p.startsWith(`${r}${sep}`)
}

/** Drop empty entries; a root that is itself nested under another is redundant, so collapse to the shallowest set. */
function uniqueRoots(roots: readonly string[]): string[] {
  const out: string[] = []
  for (const root of roots) {
    if (root.length === 0) continue
    if (out.some(existing => isWithinRoot(root, existing))) continue
    out.push(root)
  }
  return out
}

/**
 * Select one lock to follow. When a session working directory is supplied and
 * some candidate's workspace folder equals the cwd (or contains it), the
 * newest such candidate wins — so an IntelliJ and a VS Code both running pick
 * the one whose project is the current session. With no cwd, or no match, the
 * plain newest lock wins.
 * Exported for tests.
 */
export function selectLockByWorkspace(
  candidates: LockCandidate[],
  cwd: string | undefined,
): LockCandidate | undefined {
  if (cwd !== undefined) {
    let best: LockCandidate | undefined
    for (const candidate of candidates) {
      if (!candidate.lock.workspaceFolders.some(folder => isWithinRoot(cwd, folder))) continue
      if (best === undefined || candidate.mtime > best.mtime) best = candidate
    }
    if (best !== undefined) return best
  }
  return candidates[0]
}

/**
 * Keep only the file paths that belong under one of `roots`. When `roots` is
 * empty every path is kept. Virtual (non-`file://`) URIs are dropped by the
 * `itemFilePath` normalization before they reach this filter. Exported for
 * tests.
 */
export function filterFilesUnderRoots(files: string[], roots: readonly string[]): string[] {
  if (roots.length === 0) return files
  return files.filter(file => roots.some(root => isWithinRoot(file, root)))
}

// ---------------------------------------------------------------------------
// IDE bridge: one MCP-over-WebSocket session maintaining the latest snapshot
// ---------------------------------------------------------------------------

/** Candidate tool names for the opened-file list, probed against tools/list. */
const OPENED_FILES_TOOLS = ['get_all_opened_file_paths', 'getOpenEditors'] as const
/** Candidate tool names for the current selection, probed against tools/list. */
const SELECTION_TOOLS = ['getCurrentSelection', 'getLatestSelection'] as const

/**
 * Background bridge to the IDE's MCP-over-WebSocket server. Owns the
 * connection lifecycle (lock scan, handshake, reconnects with backoff, ping
 * replies) and the current {@link IdeSnapshot}. All failures degrade to a
 * warning and leave the snapshot untouched; nothing here can fail a turn.
 *
 * Registered on the context as `ctx.ideContext`; tests may replace it with a
 * stub exposing {@link IdeBridge.latest} only.
 */
export class IdeBridge {
  private snapshot: IdeSnapshot = {
    ideName: undefined,
    workspaceFolders: [],
    openedFiles: [],
  }
  /** Roots every opened file / selection must live under; empty means no filter. */
  private workspaceRoots: string[] = []
  private ws: RawWs | undefined
  private knownTools: string[] = []
  private lockPath: string | undefined
  /** Session working directory the bridge currently follows; `undefined` until first follow call. */
  private cwd: string | undefined
  /** Workspace folders of the lock currently selected (used to detect same-port content changes). */
  private selectedFolders: string[] = []
  private nextRequestId = 1
  private readonly pending = new Map<string, (value: unknown) => void>()
  private lockTimer: NodeJS.Timeout | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private reconnectDelayMs = 500
  private disposed = false
  /** Waiters blocking `awaitLatest` until substantive data (files/selection) arrives. */
  private readonly readyWaiters = new Set<() => void>()

  constructor(
    private readonly lockDir: string,
    private readonly pollIntervalMs: number,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Latest IDE snapshot, or `undefined` before any substantive data arrived.
   * `ideName` alone is connection metadata, not context: it is written as soon
   * as a lock is adopted, before the first async poll of opened files and the
   * selection returns. Treating it as "data" would emit a half-empty rendering
   * (just `ide: <name>`) on a fresh session's first step.
   */
  latest(): IdeSnapshot | undefined {
    const { snapshot } = this
    if (snapshot.openedFiles.length === 0 && snapshot.selection === undefined) {
      return undefined
    }
    return snapshot
  }

  /**
   * Resolve to the latest snapshot, blocking up to `timeoutMs` for the first
   * substantive data to arrive. On a fresh connection the async handshake and
   * first poll have not returned yet when an eligible step fires; without this
   * wait that first step would inject nothing. Returns `undefined` when no data
   * arrives within the timeout.
   */
  async awaitLatest(timeoutMs: number): Promise<IdeSnapshot | undefined> {
    const immediate = this.latest()
    if (immediate !== undefined) return immediate
    if (this.disposed) return undefined
    return await new Promise<IdeSnapshot | undefined>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        this.readyWaiters.delete(onData)
        clearTimeout(timer)
        resolve(this.latest())
      }
      const onData = (): void => { done() }
      const timer = setTimeout(done, timeoutMs)
      this.readyWaiters.add(onData)
    })
  }

  /** Wake any {@link awaitLatest} waiters once files/selection have arrived. */
  private notifyData(): void {
    const { snapshot } = this
    if (snapshot.openedFiles.length === 0 && snapshot.selection === undefined) return
    for (const waiter of this.readyWaiters) waiter()
    this.readyWaiters.clear()
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
  followWorkspace(cwd: string | undefined): void {
    if (this.disposed) return
    this.cwd = cwd
    this.reselect()
  }

  /**
   * Re-scan locks and adopt the lock selected for {@link cwd}, or `undefined`.
   * Rebuilds workspace filters and reconnects whenever the selected lock's
   * identity (port or workspace folders) changed since the last adoption.
   */
  private reselect(): void {
    if (this.disposed) return
    const candidates = scanLocks(this.lockDir, this.logger) ?? []
    const selected = selectLockByWorkspace(candidates, this.cwd)
    const lock = selected?.lock
    const folders = lock?.workspaceFolders ?? []
    if (lock !== undefined && this.sameSelection(lock.port, folders)) return
    this.adoptLock(selected)
  }

  /** True when `port` + `folders` describe the lock already adopted. */
  private sameSelection(port: number, folders: string[]): boolean {
    const path = `${port}.lock`
    if (path !== this.lockPath) return false
    if (folders.length !== this.selectedFolders.length) return false
    for (let i = 0; i < folders.length; i++) {
      if (folders[i] !== this.selectedFolders[i]) return false
    }
    return true
  }

  /** Adopt a selected lock (or `undefined`): reset filters and reconnect. */
  private adoptLock(selected: LockCandidate | undefined): void {
    const lock = selected?.lock
    const folders = lock?.workspaceFolders ?? []
    this.lockPath = selected === undefined ? undefined : `${lock?.port}.lock`
    this.selectedFolders = folders
    this.knownTools = []
    this.workspaceRoots = uniqueRoots([...folders, ...(this.cwd !== undefined ? [this.cwd] : [])])
    this.snapshot = {
      ideName: lock?.ideName,
      workspaceFolders: folders,
      openedFiles: [],
    }
    if (lock !== undefined) this.connect(lock)
  }

  /** Start lock scanning and polling. */
  start(): void {
    this.rescan()
    this.lockTimer = setInterval(() => { this.rescan() }, LOCK_SCAN_INTERVAL_MS)
    this.pollTimer = setInterval(() => { this.poll() }, this.pollIntervalMs)
  }

  /** Tear down the bridge: close the socket and all timers. */
  dispose(): void {
    this.disposed = true
    if (this.lockTimer !== undefined) clearInterval(this.lockTimer)
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.ws?.close()
    this.ws = undefined
  }

  /** Re-evaluate the selected lock file; switch connections when it changed. */
  private rescan(): void {
    this.reselect()
  }

  /** Open (or re-open) the WebSocket + MCP session to one lock file. */
  private connect(lock: LockInfo): void {
    this.ws?.close()
    const url = `ws://127.0.0.1:${lock.port}`
    this.logger.debug(`ide-context: connecting to ${url} (${lock.ideName ?? 'IDE'})`)
    const ws = new RawWs(url, {
      'X-Claude-Code-Ide-Authorization': lock.authToken,
    })
    this.ws = ws
    ws.onopen = () => {
      this.reconnectDelayMs = 500
      this.logger.debug('ide-context: websocket connected')
      void this.rpc('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: '@deepseek-ai/dsh-ide-context', version: '0.1.0' },
      }).then((result) => {
        if (result !== undefined && typeof result === 'object'
          && (result as { error?: unknown }).error === undefined) {
          this.ws?.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
          void this.rpc('tools/list', {}).then((toolsResult) => { this.handleToolsList(toolsResult) })
        }
      })
    }
    ws.onmessage = (raw) => { this.handleMessage(raw) }
    ws.onclose = (code, reason) => {
      this.logger.warn(`ide-context: connection closed (${code} ${reason}); will retry`)
      this.scheduleReconnect()
    }
    ws.onerror = (error) => {
      this.logger.warn(`ide-context: connection error: ${error.message}`)
      this.scheduleReconnect()
    }
    ws.connect()
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)
    setTimeout(() => {
      if (this.disposed) return
      const candidates = scanLocks(this.lockDir, this.logger) ?? []
      const selected = selectLockByWorkspace(candidates, this.cwd)
      if (selected !== undefined) this.adoptLock(selected)
    }, delay)
  }

  /** Fire a JSON-RPC request; responses resolve via {@link handleMessage}. */
  private rpc(method: string, params: unknown): Promise<unknown> {
    const id = String(this.nextRequestId++)
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  /** Dispatch one inbound JSON-RPC message. */
  private handleMessage(raw: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const method = typeof message.method === 'string' ? message.method : undefined
    // Server -> client requests (e.g. "ping") must be answered.
    if (message.id !== undefined && method !== undefined
      && message.result === undefined && message.error === undefined) {
      this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
      return
    }
    // Responses to our requests.
    if (typeof message.id === 'string' && this.pending.has(message.id)) {
      const resolve = this.pending.get(message.id)
      if (resolve !== undefined) {
        this.pending.delete(message.id)
        resolve(message.error ?? message.result)
      }
      return
    }
    // Notifications.
    if (method === 'selection_changed') {
      this.applySelectionChanged(message.params)
    }
  }

  /** Update the snapshot from a `selection_changed` notification. */
  private applySelectionChanged(params: unknown): void {
    const p = params as { filePath?: unknown; selection?: unknown; text?: unknown } | undefined
    if (p === undefined) return
    const filePath = typeof p.filePath === 'string' ? p.filePath : undefined
    const selection = p.selection as { start?: unknown; end?: unknown } | null | undefined
    const text = typeof p.text === 'string' ? p.text : ''
    if (filePath === undefined) return
    // Drop pushes for files outside the current project.
    if (!this.isInWorkspace(filePath)) return
    if (selection === null || selection === undefined) {
      this.snapshot.selection = { filePath, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, text }
      this.notifyData()
      return
    }
    const start = selection.start as { line?: unknown; character?: unknown } | undefined
    const end = selection.end as { line?: unknown; character?: unknown } | undefined
    if (start === undefined || end === undefined) return
    this.snapshot.selection = {
      filePath,
      start: { line: Number(start.line) || 0, character: Number(start.character) || 0 },
      end: { line: Number(end.line) || 0, character: Number(end.character) || 0 },
      text,
    }
    this.notifyData()
  }

  /** Periodically refresh opened files and (where exposed) the selection. */
  private poll(): void {
    if (this.ws === undefined || this.disposed) return
    void this.refreshOpenedFiles()
    void this.refreshSelection()
  }

  private async refreshOpenedFiles(): Promise<void> {
    const tool = OPENED_FILES_TOOLS.find(candidate => this.knownTools.includes(candidate))
    if (tool === undefined) return
    const result = await this.rpc('tools/call', { name: tool, arguments: {} })
    const files = extractOpenedFiles(result)
    if (files !== undefined) {
      this.snapshot.openedFiles = filterFilesUnderRoots(files, this.workspaceRoots)
      this.notifyData()
    }
  }

  private async refreshSelection(): Promise<void> {
    const tool = SELECTION_TOOLS.find(candidate => this.knownTools.includes(candidate))
    if (tool === undefined) return
    const result = await this.rpc('tools/call', { name: tool, arguments: {} })
    const selection = extractSelectionToolResult(result)
    if (selection === undefined) return
    // A selection in a file outside the current project is not this project's context.
    if (!this.isInWorkspace(selection.filePath)) return
    this.snapshot.selection = selection
    this.notifyData()
  }

  /** True when `path` belongs under one of the current workspace roots (no roots = accept). */
  private isInWorkspace(path: string): boolean {
    return this.workspaceRoots.length === 0 || this.workspaceRoots.some(root => isWithinRoot(path, root))
  }

  /** Record the tool list once `tools/list` is answered. */
  private setKnownTools(tools: string[]): void {
    this.knownTools = tools
    this.logger.debug(`ide-context: IDE tools: ${tools.join(', ')}`)
    void this.refreshOpenedFiles()
    void this.refreshSelection()
  }

  /** Wire the `tools/list` response into {@link setKnownTools}. */
  handleToolsList(result: unknown): void {
    const tools = (result as { tools?: Array<{ name?: unknown }> } | undefined)?.tools
    if (!Array.isArray(tools)) return
    this.setKnownTools(tools.map(tool => (typeof tool.name === 'string' ? tool.name : '')))
  }
}

/** Parse opened-file paths out of a tool result (both IDE dialects). Exported for tests. */
export function extractOpenedFiles(result: unknown): string[] | undefined {
  const content = extractToolText(result)
  if (content === undefined) return undefined
  const trimmed = content.trim()
  // VS Code `getOpenEditors` returns JSON: a `{ tabs: [...] }` object or an
  // array of paths; each tab carries a `fileName`, `uri`, or `path`. A
  // successful object/array parse is authoritative — an empty `tabs` list
  // means zero files — so it must not fall through to the newline heuristic.
  const parsed = parseJson(trimmed)
  if (parsed !== null && typeof parsed === 'object') {
    return extractFilePaths(parsed)
  }
  // IntelliJ `get_all_opened_file_paths` returns a newline-separated list.
  const files = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('[') && !line.startsWith('{'))
  return files.length > 0 ? files : undefined
}

/** Parse `text` as JSON, or `undefined` when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Pull file paths out of a `getOpenEditors` JSON value (array or `{ tabs: [...] }`). */
function extractFilePaths(parsed: unknown): string[] {
  const items = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { tabs?: unknown }).tabs)
      ? (parsed as { tabs: unknown[] }).tabs
      : undefined
  if (items === undefined) return []
  return items
    .map(item => itemFilePath(item))
    .filter((file): file is string => typeof file === 'string' && file.length > 0)
}

/** Normalize one opened-editor entry to a filesystem path, or `undefined`. */
function itemFilePath(item: unknown): string | undefined {
  if (typeof item === 'string') return fileUriToPath(item)
  if (item === null || typeof item !== 'object') return undefined
  const record = item as { fileName?: unknown; path?: unknown; uri?: unknown }
  if (typeof record.fileName === 'string' && isDiskPath(record.fileName)) return record.fileName
  if (typeof record.path === 'string' && isDiskPath(record.path)) return record.path
  if (typeof record.uri === 'string') return fileUriToPath(record.uri)
  return undefined
}

/** True when a bare path is a real filesystem path (not a virtual scheme). */
function isDiskPath(path: string): boolean {
  // Reject VS Code virtual documents (git:, output:, untitled:, vscode-remote:, ...)
  // and any other <scheme>: prefix; only filesystem paths or file:// URLs count.
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) ? path.startsWith('file://') : true
}

/**
 * Convert a `file://` URL to a filesystem path; drop any non-file URL
 * (`git:`, `output:`, ...) to `undefined`.
 */
function fileUriToPath(uri: string): string | undefined {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) return uri
  if (!uri.startsWith('file://')) return undefined
  const rest = uri.slice('file://'.length)
  try {
    return decodeURIComponent(rest)
  } catch {
    return rest
  }
}

/**
 * Extract the first `text` block from an MCP tool result, or the stringified
 * `text` field when the server returns a plain object instead of content
 * blocks (both shapes occur across IDE versions).
 */
function extractToolText(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined
  const content = (result as { content?: unknown }).content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string') {
        return (block as { text: string }).text
      }
    }
    return undefined
  }
  const text = (result as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

/** Parse a selection out of a `getCurrentSelection`/`getLatestSelection` result. Exported for tests. */
export function extractSelectionToolResult(result: unknown): IdeSelection | undefined {
  const text = extractToolText(result)
  if (text === undefined) return undefined
  let data: { filePath?: unknown; selection?: unknown; text?: unknown }
  try {
    data = JSON.parse(text) as { filePath?: unknown; selection?: unknown; text?: unknown }
  } catch {
    return undefined
  }
  const filePath = typeof data.filePath === 'string' ? data.filePath : undefined
  if (filePath === undefined) return undefined
  const selection = data.selection as { start?: unknown; end?: unknown } | null | undefined
  const selectedText = typeof data.text === 'string' ? data.text : ''
  if (selection === null || selection === undefined) {
    return { filePath, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, text: selectedText }
  }
  const start = selection.start as { line?: unknown; character?: unknown } | undefined
  const end = selection.end as { line?: unknown; character?: unknown } | undefined
  if (start === undefined || end === undefined) return undefined
  return {
    filePath,
    start: { line: Number(start.line) || 0, character: Number(start.character) || 0 },
    end: { line: Number(end.line) || 0, character: Number(end.character) || 0 },
    text: selectedText,
  }
}

// ---------------------------------------------------------------------------
// Rendering + change-suppressed injection (mirrors dsh-tmux-context)
// ---------------------------------------------------------------------------

/** Render the stable state block: the part compared for change suppression. */
export function renderState(snapshot: IdeSnapshot): string {
  const lines: string[] = []
  if (snapshot.ideName !== undefined) lines.push(`ide: ${snapshot.ideName}`)
  if (snapshot.openedFiles.length > 0) {
    lines.push(`opened files (${snapshot.openedFiles.length}):`)
    for (const file of snapshot.openedFiles) lines.push(`- ${file}`)
  }
  const selection = snapshot.selection
  if (selection !== undefined && (selection.start.line !== 0 || selection.start.character !== 0
    || selection.end.line !== 0 || selection.end.character !== 0 || selection.text.length > 0)) {
    // Claude Code's editor-selection structure: 1-based inclusive line range,
    // then the selected text, then a fixed "may or may not be related" tail.
    const startLine = selection.start.line + 1
    const endLine = selection.end.line + 1
    const linesLabel = startLine === endLine ? `line ${startLine}` : `lines ${startLine} to ${endLine}`
    lines.push(`The user selected ${linesLabel} from ${selection.filePath}:`)
    if (selection.text.length > 0) lines.push(selection.text)
    lines.push('')
    lines.push('This may or may not be related to the current task.')
  }
  return lines.join('\n')
}

/** Render the full durable reading, including the volatile turn preamble. */
function renderReading(snapshot: IdeSnapshot, turn: number): string {
  return `${READING_PREFIX}${turn}):\n${renderState(snapshot)}`
}

/**
 * Read the latest snapshot, waiting briefly for the first poll when the bridge
 * supports it. Tests inject a minimal `{ latest, followWorkspace }` stub without
 * `awaitLatest`, so fall back to the synchronous read in that case.
 */
async function readSnapshot(bridge: IdeBridge, timeoutMs: number): Promise<IdeSnapshot | undefined> {
  if (typeof bridge.awaitLatest === 'function') return await bridge.awaitLatest(timeoutMs)
  return bridge.latest()
}

/**
 * The stable state block of this plugin's latest durable injection, or
 * `undefined` when the session has none. Scans raw durable events so the
 * schedule survives compaction and resumed processes without process-local
 * cache state.
 */
function latestInjectedState(agent: Agent): { state: string; time: number } | undefined {
  for (const event of [...agent.session.events].reverse()) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === name) {
      const [block] = event.data.content
      if (block?.type !== 'text') return undefined
      const newline = block.text.indexOf('\n')
      const state = newline === -1 ? '' : block.text.slice(newline + 1)
      return { state, time: event.time }
    }
  }
  return undefined
}

/** Reject non-negative non-safe-integer intervals. */
function validatePositiveInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`ide-context: ${field} must be a non-negative safe integer, got ${String(value)}`)
  }
}

/**
 * Register a prepended pre-step listener plus the background IDE bridge for
 * the lifetime of `ctx`.
 * @param ctx - plugin context; the listener and bridge are disposed with it.
 * @param config - scheduling and bridge tuning.
 */
export function apply(ctx: Context, config: Config): void {
  const refreshIntervalMs = config.refreshIntervalMs
  const pollIntervalMs = config.pollIntervalMs ?? 5_000
  const lockDir = config.lockDir ?? DEFAULT_LOCK_DIR
  validatePositiveInteger(refreshIntervalMs, 'refreshIntervalMs')
  validatePositiveInteger(pollIntervalMs, 'pollIntervalMs')

  const bridge = ctx.get('ideContext') ?? new IdeBridge(lockDir, pollIntervalMs, ctx.logger)
  if (ctx.get('ideContext') === undefined) {
    ctx.provide('ideContext', bridge)
    ctx.effect(() => {
      bridge.start()
      return () => { bridge.dispose() }
    }, `${name} bridge`)
  }

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision
    bridge.followWorkspace(agent.session.header.cwd)
    const previous = latestInjectedState(agent)
    if (refreshIntervalMs !== undefined && refreshIntervalMs > 0 && previous !== undefined) {
      const now = Date.now()
      if (now >= previous.time && now - previous.time < refreshIntervalMs) return decision
    }
    const snapshot = await readSnapshot(bridge, DATA_READY_TIMEOUT_MS)
    if (snapshot === undefined) return decision
    const state = renderState(snapshot)
    if (state.length === 0) return decision
    if (previous !== undefined && previous.state === state) return decision
    const text = renderReading(snapshot, turn)
    return {
      kind: 'enter',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        }),
        ...decision.messages,
      ],
    }
  }, { prepend: true })
}
