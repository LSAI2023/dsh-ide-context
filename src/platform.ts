/**
 * Platform abstraction for path and URI handling. Everything filesystem- or
 * URI-shaped funnels through this module so Windows support (drive letters,
 * case-insensitive comparison, `file:///C:/...` and `file:///C:\...` URIs,
 * backslash separators) becomes an isolated concern rather than scattered
 * `process.platform` branches across the codebase.
 *
 * The current implementation is POSIX-oriented; the `Platform` shape is the
 * seam to extend. Keep every call site going through the module-level helpers
 * so a future `win32` implementation only changes code here.
 * @module @deepseek-ai/dsh-ide-context/platform (internal)
 */

import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The parts of platform behavior that differ between POSIX and Windows. */
export interface Platform {
  /** Canonicalize a path for equality/containment comparison. */
  normalizePath(path: string): string
  /** The separator used to test prefix containment (`a/starts with b/`). */
  separator: string
  /** True when `path` equals `root` or lives directly under it. */
  isWithinRoot(path: string, root: string): boolean
  /** Convert a `file://` URL (or bare path) to a filesystem path; drop non-file schemes. */
  fileUriToPath(uri: string): string | undefined
  /** True when `path` is a real filesystem path rather than a virtual scheme. */
  isDiskPath(path: string): boolean
}

/** Scheme prefix regex shared by POSIX and Windows: `<scheme>:` prefixes. */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** The current platform implementation, selected once. */
let platform: Platform | undefined

/** POSIX implementation (the baseline). */
const posix: Platform = {
  normalizePath: resolve,
  separator: sep,
  isWithinRoot(path, root) {
    const p = posix.normalizePath(path)
    const r = posix.normalizePath(root)
    if (p === r) return true
    return p.startsWith(`${r}${posix.separator}`)
  },
  fileUriToPath(uri) {
    if (!SCHEME_RE.test(uri)) return uri
    if (!uri.startsWith('file://')) return undefined
    const rest = uri.slice('file://'.length)
    try {
      return fileURLToPath(uri)
    } catch {
      return decodeURIComponentFallback(rest)
    }
  },
  isDiskPath(path) {
    // A <scheme>: prefix is virtual (git:, output:, untitled:, vscode-remote:)
    // unless it is file://. Bare paths are real filesystem paths.
    return SCHEME_RE.test(path) ? path.startsWith('file://') : true
  },
}

/** Selected platform accessor. POSIX is the sole implementation today; a future
 * `win32` impl (case-insensitive compare, drive letters, `file:///C:/...` URIs)
 * plugs in here without changing any call site. */
function currentPlatform(): Platform {
  return (platform ??= posix)
}

/** Fallback URI decode for malformed percent-encoding. */
function decodeURIComponentFallback(rest: string): string {
  try {
    return decodeURIComponent(rest)
  } catch {
    return rest
  }
}

/** Normalize a path to a trailing-slash-free absolute form for comparison. */
export function normalizePathForCompare(path: string): string {
  return currentPlatform().normalizePath(path)
}

/** True when `path` equals `root` or lives under it (platform-aware). */
export function isWithinRoot(path: string, root: string): boolean {
  return currentPlatform().isWithinRoot(path, root)
}

/**
 * Convert a `file://` URL to a filesystem path; drop any non-file URL
 * (`git:`, `output:`, ...) to `undefined`.
 */
export function fileUriToPath(uri: string): string | undefined {
  return currentPlatform().fileUriToPath(uri)
}

/** True when a bare path is a real filesystem path (not a virtual scheme). */
export function isDiskPath(path: string): boolean {
  return currentPlatform().isDiskPath(path)
}
