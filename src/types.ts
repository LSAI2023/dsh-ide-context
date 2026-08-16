/**
 * Public domain types for the IDE-context plugin: the IDE snapshot model, the
 * plugin configuration, and the parsed lock-file shape. Kept dependency-free so
 * embedders can import the model without pulling in the transport layers.
 * @module @deepseek-ai/dsh-ide-context/types (internal)
 */

import z from '@deepseek-ai/schemastery'

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
export interface LockInfo {
  port: number
  ideName: string | undefined
  pid: number | undefined
  workspaceFolders: string[]
  authToken: string
  /** True when the IDE runs on Windows (enables WSL path/host handling later). */
  runningInWindows: boolean
}

/** Reject non-negative non-safe-integer intervals (shared config validation). */
export function validatePositiveInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`ide-context: ${field} must be a non-negative safe integer, got ${String(value)}`)
  }
}
