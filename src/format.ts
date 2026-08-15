/**
 * Snapshot rendering: turns an {@link IdeSnapshot} into the durable text that
 * both enters the model prompt and is echoed verbatim by the harness Web UI's
 * snapshot disclosure. Isolated behind a strategy so a future compact
 * `path#L45-49` locator format is an additive change here, not a rewrite of the
 * injection layer.
 * @module @deepseek-ai/dsh-ide-context/format (internal)
 */

import { READING_PREFIX } from './constants.js'
import type { IdeSelection, IdeSnapshot } from './types.js'

/**
 * One pluggable selection-line strategy. The baseline renders Claude Code's
 * editor-selection prose; a locator strategy can render `path#L45-49` instead.
 */
export interface SelectionRenderStrategy {
  /** Render the "The user selected …" block for a selection (or `undefined` to omit it). */
  render(selection: IdeSelection): string | undefined
}

/** Baseline strategy: Claude Code's 1-based inclusive selection prose. */
export const claudeSelectionStrategy: SelectionRenderStrategy = {
  render(selection) {
    if (selection.start.line === 0 && selection.start.character === 0
      && selection.end.line === 0 && selection.end.character === 0 && selection.text.length === 0) {
      return undefined
    }
    const startLine = selection.start.line + 1
    const endLine = selection.end.line + 1
    const linesLabel = startLine === endLine ? `line ${startLine}` : `lines ${startLine} to ${endLine}`
    const lines: string[] = [`The user selected ${linesLabel} from ${selection.filePath}:`]
    if (selection.text.length > 0) lines.push(selection.text)
    lines.push('')
    lines.push('This may or may not be related to the current task.')
    return lines.join('\n')
  },
}

/** Render the stable state block: the part compared for change suppression. */
export function renderState(snapshot: IdeSnapshot, strategy: SelectionRenderStrategy = claudeSelectionStrategy): string {
  const lines: string[] = []
  if (snapshot.ideName !== undefined) lines.push(`ide: ${snapshot.ideName}`)
  if (snapshot.openedFiles.length > 0) {
    lines.push(`opened files (${snapshot.openedFiles.length}):`)
    for (const file of snapshot.openedFiles) lines.push(`- ${file}`)
  }
  const selection = snapshot.selection
  if (selection !== undefined) {
    const rendered = strategy.render(selection)
    if (rendered !== undefined) lines.push(rendered)
  }
  return lines.join('\n')
}

/** Render the full durable reading, including the volatile turn preamble. */
export function renderReading(snapshot: IdeSnapshot, turn: number, strategy?: SelectionRenderStrategy): string {
  return `${READING_PREFIX}${turn}):\n${renderState(snapshot, strategy)}`
}
