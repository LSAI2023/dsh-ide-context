/**
 * Shared constants for the IDE-context plugin. Kept in one module so the
 * protocol, transport, discovery, and rendering layers reference a single
 * source of truth rather than re-declaring magic values.
 * @module @deepseek-ai/dsh-ide-context/constants (internal)
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ide-context'

/** The agent registry that owns pre-step processing. */
export const inject = ['agents']

/** Lock-file directory default, shared with the Claude Code CLI. */
export const DEFAULT_LOCK_DIR = join(homedir(), '.claude', 'ide')

/** How often the lock directory is rescanned for a newer/rotated lock file. */
export const LOCK_SCAN_INTERVAL_MS = 2_000

/** Upper bound on the reconnect backoff. */
export const MAX_RECONNECT_DELAY_MS = 30_000

/** MCP protocol version negotiated with the IDE bridge. */
export const PROTOCOL_VERSION = '2024-11-05'

/** MCP subprotocol required by the Ktor/extension WebSocket servers. */
export const WS_SUBPROTOCOL = 'mcp'

/** How long an eligible step waits for the first IDE poll before injecting nothing. */
export const DATA_READY_TIMEOUT_MS = 1_500

/** Prefix marking the volatile turn/step preamble line of a rendered reading. */
export const READING_PREFIX = 'ide context (turn '

/** Candidate tool names for the opened-file list, probed against tools/list. */
export const OPENED_FILES_TOOLS = ['get_all_opened_file_paths', 'getOpenEditors'] as const

/** Candidate tool names for the current selection, probed against tools/list. */
export const SELECTION_TOOLS = ['getCurrentSelection', 'getLatestSelection'] as const
