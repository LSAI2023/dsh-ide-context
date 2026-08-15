/**
 * MCP tool-result parsing, both IDE dialects. Owns the shape-shifting between
 * the two return payloads (JSON `getOpenEditors` tabs vs. newline lists, and
 * `getCurrentSelection`/`getLatestSelection` vs. `selection_changed` pushes)
 * so the bridge and renderers stay dialect-agnostic.
 * @module @deepseek-ai/dsh-ide-context/protocol (internal)
 */

import type { IdeSelection } from './types.js'
import { fileUriToPath, isDiskPath } from './platform.js'

/** Parse opened-file paths out of a tool result (both IDE dialects). */
export function extractOpenedFiles(result: unknown): string[] | undefined {
  const content = extractToolText(result)
  if (content === undefined) return undefined
  const trimmed = content.trim()
  // VS Code `getOpenEditors` returns JSON: a `{ tabs: [...] }` object or an
  // array of paths. A successful parse is authoritative — an empty `tabs` list
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

/** Parse a selection out of a `getCurrentSelection`/`getLatestSelection` result. */
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

/**
 * Extract the first `text` block from an MCP tool result, or the stringified
 * `text` field when the server returns a plain object instead of content blocks
 * (both shapes occur across IDE versions).
 */
export function extractToolText(result: unknown): string | undefined {
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
