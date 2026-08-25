import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  PandaError,
  PANDA_ERROR_CODES,
  PROJECTION_RESERVED_ROOT_KEY,
  classifyOwnedMarker,
  isRecord,
} from '@panda/contracts'
import type {
  DriftEntry,
  ProjectionMergeOutcome,
  ProjectionMergeRequest,
  ProjectionTarget,
} from '@panda/contracts'
import { applyEdits, modify, parseTree } from 'jsonc-parser'

// Claude Code settings.json target. Claude settings are STRICT JSON —
// comments and trailing commas are startup errors — so native validity is
// guarded with JSON.parse before anything else; a violation fails THIS target
// with PANDA_PROJECTION_NATIVE_MALFORMED naming the file and cause.
//
// Ownership is the reserved root key "panda", spliced with exactly one
// jsonc-parser modify+applyEdits edit region: foreign bytes outside that span
// are preserved by construction, and because the owned subtree serializes
// deterministically, projecting twice yields byte-identical output. Foreign
// quirks that live OUTSIDE strict JSON's grammar — a leading BOM, CRLF line
// endings — are detected and carried through untouched. A document with MORE
// THAN ONE "panda" root key cannot be classified or edited safely and fails
// this target as malformed.
//
// A panda marker that does not match grammar v1 classifies as drift (via
// @panda/contracts) and is reported WITHOUT any rewrite. Profile entries have
// no Claude settings surface in grammar v1 and are reported through
// skippedEntryIds instead of being dropped silently.

export const CLAUDE_SETTINGS_TARGET_ID = 'claude-settings'

export interface ClaudeSettingsTargetOptions {
  /** Defaults to `<home>/.claude/settings.json`. */
  readonly filePath?: string
}

const BYTE_ORDER_MARK = '\uFEFF'

const FORMATTING = { tabSize: 2, insertSpaces: true } as const

function malformed(filePath: string, cause: unknown): PandaError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new PandaError(
    PANDA_ERROR_CODES.projectionNativeMalformed,
    `native settings file '${filePath}' is malformed: ${detail}`,
    { cause },
  )
}

function parseNative(bodyText: string, filePath: string): Record<string, unknown> | undefined {
  if (bodyText.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch (error) {
    throw malformed(filePath, error)
  }
  if (!isRecord(parsed)) {
    throw malformed(filePath, new Error('document root is not an object'))
  }
  return parsed
}

function countPandaProperties(bodyText: string): number {
  const root = parseTree(bodyText)
  if (!root || root.type !== 'object') return 0
  return (root.children ?? []).filter(
    (property) => property.children?.[0]?.value === PROJECTION_RESERVED_ROOT_KEY,
  ).length
}

function lineEndingOf(bodyText: string): '\n' | '\r\n' {
  return bodyText.includes('\r\n') ? '\r\n' : '\n'
}

export function createClaudeSettingsTarget(
  options: ClaudeSettingsTargetOptions = {},
): ProjectionTarget {
  const filePath = options.filePath ?? join(homedir(), '.claude', 'settings.json')
  return {
    targetId: CLAUDE_SETTINGS_TARGET_ID,
    filePath,
    merge(request: ProjectionMergeRequest): ProjectionMergeOutcome {
      // A missing or whitespace-only file starts from an empty document; a
      // leading BOM is foreign state, stripped for parsing and re-prepended to
      // the output so it survives every projection byte-intact.
      const hasBom = request.nativeText.startsWith(BYTE_ORDER_MARK)
      const bodyText = hasBom ? request.nativeText.slice(1) : request.nativeText

      const document = parseNative(bodyText, filePath)
      let drift: readonly DriftEntry[] = []
      if (document !== undefined) {
        if (countPandaProperties(bodyText) > 1) {
          throw malformed(
            filePath,
            new Error(`document declares more than one '${PROJECTION_RESERVED_ROOT_KEY}' root key`),
          )
        }
        drift = classifyOwnedMarker(document[PROJECTION_RESERVED_ROOT_KEY])
      }
      if (drift.length > 0) return { text: request.nativeText, drift }

      const seedText = document === undefined ? '{}' : bodyText
      const edits = modify(seedText, [PROJECTION_RESERVED_ROOT_KEY], request.ownedContent, {
        formattingOptions: { ...FORMATTING, eol: lineEndingOf(bodyText) },
      })
      const merged = applyEdits(seedText, edits)
      return {
        text: hasBom ? BYTE_ORDER_MARK + merged : merged,
        drift: [],
        skippedEntryIds: [...request.entries.profile]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((entry) => entry.id),
      }
    },
  }
}
