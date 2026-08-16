/**
 * Platform abstraction for path and URI handling. Everything filesystem- or
 * URI-shaped funnels through this module so Windows support (drive letters,
 * case-insensitive comparison, `file:///C:/...` and `file:///C:\...` URIs,
 * backslash separators) becomes an isolated concern rather than scattered
 * `process.platform` branches across the codebase.
 *
 * Mirrors the platform vocabulary of the Claude Code CLI (`macos | windows |
 * wsl | linux | unknown`) so lock-file discovery and workspace matching stay
 * aligned with the IDE integration it speaks to. Windows (`win32`) is
 * implemented here; WSL (Linux host + Windows IDE) path conversion is a
 * separate future concern behind the same seam.
 * @module @deepseek-ai/dsh-ide-context/platform (internal)
 */

import { readFileSync } from 'node:fs'
import { resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Platform vocabulary shared with the Claude Code CLI. */
export type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'

/** Detect the current platform once, in Claude Code's terms. */
export function detectPlatform(): Platform {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'linux') {
    // WSL (Windows Subsystem for Linux) reports itself as linux.
    try {
      const proc = readFileSync('/proc/version', 'utf8').toLowerCase()
      if (proc.includes('microsoft') || proc.includes('wsl')) return 'wsl'
    } catch {
      // Not running in a Linux environment that exposes /proc/version.
    }
    return 'linux'
  }
  return 'unknown'
}

/** The parts of path behavior that differ between POSIX and Windows. */
export interface PathBehavior {
  /** Canonicalize a path for equality/containment comparison (absolute, case-normalized). */
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

/**
 * Normalize a Windows drive-letter prefix (`c:` / `C:`) to uppercase for
 * case-insensitive comparison, matching the Claude Code CLI's behavior.
 */
function normalizeDriveLetter(path: string): string {
  return path.replace(/^[a-zA-Z]:/, match => match.toUpperCase())
}

/** POSIX (macOS/Linux) path behavior. */
const posix: PathBehavior = {
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

/** Windows (native) path behavior: case-insensitive drives + backslash separators. */
const win32Behavior: PathBehavior = {
  normalizePath(path) {
    return normalizeDriveLetter(win32.resolve(path))
  },
  separator: win32.sep,
  isWithinRoot(path, root) {
    const p = win32Behavior.normalizePath(path)
    const r = win32Behavior.normalizePath(root)
    if (p === r) return true
    return p.startsWith(`${r}${win32Behavior.separator}`)
  },
  fileUriToPath(uri) {
    if (!SCHEME_RE.test(uri)) {
      // A bare Windows path may use backslashes; normalize to forward slashes
      // for the rest of the pipeline. Drive-relative input passes through.
      return uri.includes('\\') ? uri.replace(/\\/g, '/') : uri
    }
    if (!uri.toLowerCase().startsWith('file://')) return undefined
    try {
      // fileURLToPath handles file:///C:/path and file:///C:\path variants.
      return fileURLToPath(uri)
    } catch {
      const rest = uri.slice('file://'.length)
      return decodeURIComponentFallback(rest).replace(/^\//, '')
    }
  },
  isDiskPath(path) {
    // On Windows a bare <scheme>: is virtual; a drive letter (C:) is a real path.
    if (!SCHEME_RE.test(path)) return true
    if (path.toLowerCase().startsWith('file://')) return true
    return false
  },
}

let detected: Platform | undefined

/** The current platform type (memoized). */
export function getPlatform(): Platform {
  return (detected ??= detectPlatform())
}

let behavior: PathBehavior | undefined

/** Selected path behavior for the current platform. */
function currentBehavior(): PathBehavior {
  if (behavior !== undefined) return behavior
  const platform = getPlatform()
  behavior = platform === 'windows' ? win32Behavior : posix
  return behavior
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
  return currentBehavior().normalizePath(path)
}

/** True when `path` equals `root` or lives under it (platform-aware). */
export function isWithinRoot(path: string, root: string): boolean {
  return currentBehavior().isWithinRoot(path, root)
}

/**
 * Convert a `file://` URL to a filesystem path; drop any non-file URL
 * (`git:`, `output:`, ...) to `undefined`.
 */
export function fileUriToPath(uri: string): string | undefined {
  return currentBehavior().fileUriToPath(uri)
}

/** True when a bare path is a real filesystem path (not a virtual scheme). */
export function isDiskPath(path: string): boolean {
  return currentBehavior().isDiskPath(path)
}
