/**
 * Lock-file discovery and workspace selection. Reads the Claude Code CLI's
 * `<port>.lock` files, picks the candidate that belongs to the current working
 * directory, and filters file paths to the selected workspace roots.
 * @module @deepseek-ai/dsh-ide-context/lock (internal)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LoggerService } from '@deepseek-ai/cordis'
import type { LockInfo } from './types.js'
import { isWithinRoot } from './platform.js'

/** One lock file's parsed contents plus its modification time, newest-first. */
export interface LockCandidate {
  path: string
  mtime: number
  lock: LockInfo
}

/**
 * Read and parse every `<port>.lock` under the lock directory, newest first,
 * or `undefined` when the directory is missing/unreadable or holds no readable
 * lock files. Unreadable or token-less files are skipped with a warning.
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
 * none is readable. Selected by modification time (matching the Claude Code
 * CLI's `getSortedIdeLockfiles`).
 */
export function scanLatestLock(lockDir: string, logger: LoggerService): LockInfo | undefined {
  return scanLocks(lockDir, logger)?.[0]?.lock
}

/**
 * Select one lock to follow. When a session working directory is supplied and
 * some candidate's workspace folder equals the cwd (or contains it), the newest
 * such candidate wins. With no cwd, or no match, the plain newest lock wins.
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
 * empty every path is kept. Virtual URIs are already normalized to filesystem
 * paths (or dropped) before reaching this filter.
 */
export function filterFilesUnderRoots(files: string[], roots: readonly string[]): string[] {
  if (roots.length === 0) return files
  return files.filter(file => roots.some(root => isWithinRoot(file, root)))
}

/** Drop empty entries; a root nested under another collapses to the shallowest set. */
export function uniqueRoots(roots: readonly string[]): string[] {
  const out: string[] = []
  for (const root of roots) {
    if (root.length === 0) continue
    if (out.some(existing => isWithinRoot(root, existing))) continue
    out.push(root)
  }
  return out
}
