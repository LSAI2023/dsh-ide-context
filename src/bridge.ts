/**
 * Background bridge to the IDE's MCP-over-WebSocket server. Owns the connection
 * lifecycle (lock scan, handshake, reconnects with backoff, ping replies) and
 * the current {@link IdeSnapshot}. All failures degrade to a warning and leave
 * the snapshot untouched; nothing here can fail a turn.
 *
 * Composed from the transport ({@link RawWs}), discovery ({@link scanLocks},
 * {@link selectLockByWorkspace}), and protocol ({@link extractOpenedFiles},
 * {@link extractSelectionToolResult}) modules so each concern stays separate.
 * @module @deepseek-ai/dsh-ide-context/bridge (internal)
 */

import type { LoggerService } from '@deepseek-ai/cordis'
import {
  LOCK_SCAN_INTERVAL_MS,
  MAX_RECONNECT_DELAY_MS,
  OPENED_FILES_TOOLS,
  PROTOCOL_VERSION,
  SELECTION_TOOLS,
} from './constants.js'
import {
  filterFilesUnderRoots,
  scanLocks,
  selectLockByWorkspace,
  uniqueRoots,
  type LockCandidate,
} from './lock.js'
import { isWithinRoot } from './platform.js'
import { extractOpenedFiles, extractSelectionToolResult } from './protocol.js'
import { validatePositiveInteger, type IdeSnapshot, type LockInfo } from './types.js'
import { RawWs } from './ws.js'

/** Reject non-negative non-safe-integer intervals. */

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
  /** Workspace folders of the lock currently selected (to detect same-port content changes). */
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
  ) {
    validatePositiveInteger(pollIntervalMs, 'pollIntervalMs')
  }

  // -------------------------------------------------------------------------
  // Snapshot reads
  // -------------------------------------------------------------------------

  /**
   * Latest IDE snapshot, or `undefined` before any substantive data arrived.
   * `ideName` alone is connection metadata, not context.
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
   * substantive data to arrive. When opened files arrive before the selection
   * (push-only IDEs deliver `selection_changed` slightly later), it keeps
   * waiting within the same deadline so the first step still carries the
   * selection rather than a files-only snapshot.
   */
  async awaitLatest(timeoutMs: number): Promise<IdeSnapshot | undefined> {
    validatePositiveInteger(timeoutMs, 'timeoutMs')
    const deadline = Date.now() + timeoutMs
    const first = await this.waitForData(deadline)
    if (first === undefined) return undefined
    if (first.selection === undefined && Date.now() < deadline) {
      await this.waitForData(deadline)
    }
    return this.latest()
  }

  /** Wait until substantive data arrives or `deadline` passes; resolve to the current snapshot. */
  private waitForData(deadline: number): Promise<IdeSnapshot | undefined> {
    const immediate = this.latest()
    if (immediate !== undefined) return Promise.resolve(immediate)
    if (this.disposed) return Promise.resolve(undefined)
    return new Promise<IdeSnapshot | undefined>((resolve) => {
      let settled = false
      const remaining = Math.max(0, deadline - Date.now())
      const done = (): void => {
        if (settled) return
        settled = true
        this.readyWaiters.delete(onData)
        clearTimeout(timer)
        resolve(this.latest())
      }
      const onData = (): void => { done() }
      const timer = setTimeout(done, remaining)
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

  // -------------------------------------------------------------------------
  // Workspace selection
  // -------------------------------------------------------------------------

  /**
   * Re-select the lock by a session working directory. The selected lock is
   * identified by its port *and* workspace folders — a same-port lock whose
   * `workspaceFolders` changed (same window switched projects) still rebuilds.
   */
  followWorkspace(cwd: string | undefined): void {
    if (this.disposed) return
    this.cwd = cwd
    this.reselect()
  }

  private reselect(): void {
    if (this.disposed) return
    const candidates = scanLocks(this.lockDir, this.logger) ?? []
    const selected = selectLockByWorkspace(candidates, this.cwd)
    const lock = selected?.lock
    const folders = lock?.workspaceFolders ?? []
    if (lock !== undefined && this.sameSelection(lock.port, folders)) return
    this.adoptLock(selected)
  }

  private sameSelection(port: number, folders: string[]): boolean {
    const path = `${port}.lock`
    if (path !== this.lockPath) return false
    if (folders.length !== this.selectedFolders.length) return false
    for (let i = 0; i < folders.length; i++) {
      if (folders[i] !== this.selectedFolders[i]) return false
    }
    return true
  }

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

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    this.rescan()
    this.lockTimer = setInterval(() => { this.rescan() }, LOCK_SCAN_INTERVAL_MS)
    this.pollTimer = setInterval(() => { this.poll() }, this.pollIntervalMs)
  }

  dispose(): void {
    this.disposed = true
    if (this.lockTimer !== undefined) clearInterval(this.lockTimer)
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.ws?.close()
    this.ws = undefined
  }

  private rescan(): void {
    this.reselect()
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  private connect(lock: LockInfo): void {
    this.ws?.close()
    const url = `ws://127.0.0.1:${lock.port}`
    this.logger.debug(`ide-context: connecting to ${url} (${lock.ideName ?? 'IDE'})`)
    const ws = new RawWs(url, { 'X-Claude-Code-Ide-Authorization': lock.authToken })
    this.ws = ws
    ws.callbacks.onopen = () => {
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
    ws.callbacks.onmessage = (raw) => { this.handleMessage(raw) }
    ws.callbacks.onclose = (code, reason) => {
      this.logger.warn(`ide-context: connection closed (${code} ${reason}); will retry`)
      this.scheduleReconnect()
    }
    ws.callbacks.onerror = (error) => {
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

  // -------------------------------------------------------------------------
  // JSON-RPC
  // -------------------------------------------------------------------------

  private rpc(method: string, params: unknown): Promise<unknown> {
    const id = String(this.nextRequestId++)
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

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

  // -------------------------------------------------------------------------
  // Incoming selection
  // -------------------------------------------------------------------------

  private applySelectionChanged(params: unknown): void {
    const p = params as { filePath?: unknown; selection?: unknown; text?: unknown } | undefined
    if (p === undefined) return
    const filePath = typeof p.filePath === 'string' ? p.filePath : undefined
    const selection = p.selection as { start?: unknown; end?: unknown } | null | undefined
    const text = typeof p.text === 'string' ? p.text : ''
    if (filePath === undefined) return
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

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

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
    if (!this.isInWorkspace(selection.filePath)) return
    this.snapshot.selection = selection
    this.notifyData()
  }

  private isInWorkspace(path: string): boolean {
    return this.workspaceRoots.length === 0 || this.workspaceRoots.some(root => isWithinRoot(path, root))
  }

  private setKnownTools(tools: string[]): void {
    this.knownTools = tools
    this.logger.debug(`ide-context: IDE tools: ${tools.join(', ')}`)
    void this.refreshOpenedFiles()
    void this.refreshSelection()
  }

  handleToolsList(result: unknown): void {
    const tools = (result as { tools?: Array<{ name?: unknown }> } | undefined)?.tools
    if (!Array.isArray(tools)) return
    this.setKnownTools(tools.map(tool => (typeof tool.name === 'string' ? tool.name : '')))
  }
}
