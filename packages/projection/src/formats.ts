import {
  PandaError,
  PANDA_ERROR_CODES,
  PANDA_MANAGED_BLOCK_BEGIN,
  PANDA_MANAGED_BLOCK_END,
  PROJECTION_GRAMMAR_VERSION,
  PROJECTION_RESERVED_ROOT_KEY,
  classifyOwnedMarker,
  isRecord,
} from '@panda/contracts'
import type {
  DriftEntry,
  ProjectionMergeOutcome,
  ProjectionMergeRequest,
  ProjectionOwnedSubtree,
  ProjectionTarget,
} from '@panda/contracts'
import type { Node } from 'jsonc-parser'
import { parse, parseTree } from 'jsonc-parser'

// Format-trait table + generic region strategies (FR-8): everything that
// differs between target file formats is DATA on a traits record, dispatched
// through one factory. A format owns exactly one owned-region strategy —
//
//   root-key-splice (JSON family): ownership is the reserved root key
//     "panda", merged through a MANUAL OFFSET-BASED SPLICE over parseTree node
//     positions — present property → replaced exactly within its node span;
//     absent → characters are only ADDED at one insertion point next to the
//     last property (or inside an empty object). Foreign bytes outside the
//     owned span survive by construction; there is no whole-document edit and
//     no adjacent-property reformatting, unlike modify()+applyEdits which
//     extends its edit range across trailing commas. `strictJson: true`
//     additionally guards native validity with JSON.parse (Claude settings
//     reject comments/trailing commas at startup); lenient JSONC targets skip
//     that guard.
//
//   delimited-block (TOML family): JS has no toml_edit equivalent, so foreign
//     TOML is NEVER parsed. Ownership is ONE comment-delimited block managed
//     purely at string level: absent → appended at EOF after ensuring a
//     trailing newline; present → replaced wholesale between markers. Bytes
//     outside the block are untouched by construction. Malformed "TOML" is
//     undetectable without parsing and OUT OF SCOPE here (drift doctor owns
//     anomaly reporting later); marker-shape anomalies
//     (unpaired/duplicated/mismatched-version markers) classify as drift and
//     are reported without any rewrite.
//
// Both strategies render the SAME grammar-v1 owned subtree (renderOwnedSubtree)
// deterministically — indentation unit derived from the native file's first
// indented line (fallback 2 spaces) and the file's own EOL — so projecting
// twice yields byte-identical output. Every outcome reports its `ownedSpan`
// so callers can verify byte preservation mechanically.

export type FileFormat = 'jsonc' | 'toml'

export type OwnedRegionStrategyId = 'root-key-splice' | 'delimited-block'

/** The data that fully describes a projection target's file format (FR-8). */
export interface ProjectionTargetTraits {
  readonly targetId: string
  readonly fileFormat: FileFormat
  readonly ownedRegionStrategy: OwnedRegionStrategyId
  /** Absolute path used when the caller injects no filePath override. */
  readonly defaultPath: string
  /** JSON family only: treat comments/trailing commas as malformed native input. */
  readonly strictJson?: boolean
}

export interface TraitTargetOptions {
  /** Overrides the trait record's defaultPath (default paths are injectable). */
  readonly filePath?: string
}

const STRATEGY_FOR_FORMAT: Readonly<Record<FileFormat, OwnedRegionStrategyId>> = {
  jsonc: 'root-key-splice',
  toml: 'delimited-block',
}

const REGION_STRATEGIES: Readonly<
  Record<
    OwnedRegionStrategyId,
    (request: ProjectionMergeRequest, filePath: string, traits: ProjectionTargetTraits) => ProjectionMergeOutcome
  >
> = {
  'root-key-splice': (request, filePath, traits) =>
    spliceRootKeyRegion(request, filePath, { strictJson: traits.strictJson ?? false }),
  'delimited-block': (request) => mergeDelimitedBlockRegion(request),
}

/**
 * The ONE factory every target flows through: adding a target means writing a
 * trait record — no engine or strategy code changes. Format and strategy must
 * be a permitted pair; a mismatch is a coded configuration error, not silent
 * misbehavior.
 */
export function createProjectionTargetFromTraits(
  traits: ProjectionTargetTraits,
  options: TraitTargetOptions = {},
): ProjectionTarget {
  if (STRATEGY_FOR_FORMAT[traits.fileFormat] !== traits.ownedRegionStrategy) {
    throw new PandaError(
      PANDA_ERROR_CODES.projectionTraitsInvalid,
      `projection target '${traits.targetId}' declares incompatible traits: fileFormat '${traits.fileFormat}' requires ownedRegionStrategy '${STRATEGY_FOR_FORMAT[traits.fileFormat]}' but got '${traits.ownedRegionStrategy}'`,
    )
  }
  const filePath = options.filePath ?? traits.defaultPath
  return {
    targetId: traits.targetId,
    filePath,
    merge(request: ProjectionMergeRequest): ProjectionMergeOutcome {
      return REGION_STRATEGIES[traits.ownedRegionStrategy](request, filePath, traits)
    },
  }
}

function sortedEntryIds(entries: ProjectionMergeRequest['entries']['profile']): string[] {
  return [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((entry) => entry.id)
}

// --- JSON family: reserved root-key splice ---------------------------------

const BYTE_ORDER_MARK = '\uFEFF'

const FALLBACK_INDENT_UNIT = '  '

function jsonMalformed(filePath: string, cause: unknown): PandaError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new PandaError(
    PANDA_ERROR_CODES.projectionNativeMalformed,
    `native settings file '${filePath}' is malformed: ${detail}`,
    { cause },
  )
}

function lineEndingOf(bodyText: string): '\n' | '\r\n' {
  return bodyText.includes('\r\n') ? '\r\n' : '\n'
}

/** Leading whitespace of the FIRST indented content line; fallback 2 spaces. */
function indentationUnitOf(bodyText: string): string {
  for (const line of bodyText.split('\n')) {
    const indented = /^[ \t]+(?=\S)/.exec(line)
    if (indented) return indented[0]
  }
  return FALLBACK_INDENT_UNIT
}

function leadingWhitespaceBefore(text: string, offset: number): string {
  let start = offset
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start -= 1
  return text.slice(start, offset)
}

function indentLevelOf(whitespace: string, unit: string): number {
  let level = 0
  let rest = whitespace
  while (rest.startsWith(unit)) {
    rest = rest.slice(unit.length)
    level += 1
  }
  return level
}

function countRootProperties(root: Node, key: string): number {
  return (root.children ?? []).filter((property) => property.children?.[0]?.value === key).length
}

/** The reserved root PROPERTY node (key + value), not just its value. */
function findReservedRootProperty(root: Node, key: string): Node | undefined {
  return (root.children ?? []).find((property) => property.children?.[0]?.value === key)
}

interface NativeDocument {
  readonly root: Node
  readonly properties: Record<string, unknown>
}

function readNativeDocument(
  bodyText: string,
  filePath: string,
  strictJson: boolean,
): NativeDocument | undefined {
  if (bodyText.trim() === '') return undefined
  if (strictJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(bodyText)
    } catch (error) {
      throw jsonMalformed(filePath, error)
    }
    if (!isRecord(parsed)) {
      throw jsonMalformed(filePath, new Error('document root is not an object'))
    }
    // Strict JSON already validated above; the tree exists by construction.
    return { root: parseTree(bodyText)!, properties: parsed }
  }
  // Lenient targets still require an object ROOT: a spliced non-object
  // document has nowhere to claim its reserved key.
  const rootNode = parseTree(bodyText)
  if (!rootNode || rootNode.type !== 'object') {
    throw jsonMalformed(filePath, new Error('document root is not an object'))
  }
  const parsed = parse(bodyText)
  if (!isRecord(parsed)) {
    throw jsonMalformed(filePath, new Error('document root is not an object'))
  }
  return { root: rootNode, properties: parsed }
}

/**
 * Deterministic JSON serializer for the OWNED subtree only — fixed key order
 * (insertion order of the rendered subtree), explicit-empty sections, arrays
 * one element per line. This replaces modify()+applyEdits, whose edit range
 * could swallow and reformat ADJACENT foreign properties across trailing
 * commas.
 */
function serializeJsonValue(value: unknown, level: number, unit: string, eol: string): string {
  const at = (depth: number): string => unit.repeat(depth)
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const inner = value
      .map((item) => `${at(level + 1)}${serializeJsonValue(item, level + 1, unit, eol)}`)
      .join(`,${eol}`)
    return `[${eol}${inner}${eol}${at(level)}]`
  }
  if (!isRecord(value)) {
    // Unreachable for the rendered subtree shape; a corrupted renderer input
    // must fail coded instead of emitting invalid JSON.
    throw new PandaError(
      PANDA_ERROR_CODES.projectionTargetFailed,
      `owned subtree contains a value that cannot be serialized: ${JSON.stringify(value)}`,
    )
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  const inner = entries
    .map(
      ([key, child]) =>
        `${at(level + 1)}${JSON.stringify(key)}: ${serializeJsonValue(child, level + 1, unit, eol)}`,
    )
    .join(`,${eol}`)
  return `{${eol}${inner}${eol}${at(level)}}`
}

function renderReservedProperty(
  ownedContent: ProjectionOwnedSubtree,
  level: number,
  unit: string,
  eol: string,
): string {
  const body = serializeJsonValue({ ...ownedContent }, level, unit, eol)
  return `${unit.repeat(level)}${JSON.stringify(PROJECTION_RESERVED_ROOT_KEY)}: ${body}`
}

export function spliceRootKeyRegion(
  request: ProjectionMergeRequest,
  filePath: string,
  options: { strictJson: boolean },
): ProjectionMergeOutcome {
  // A missing or whitespace-only file starts from an empty document; a
  // leading BOM is foreign state, stripped for parsing and re-prepended to
  // the output so it survives every projection byte-intact.
  const hasBom = request.nativeText.startsWith(BYTE_ORDER_MARK)
  const bodyText = hasBom ? request.nativeText.slice(1) : request.nativeText

  const document = readNativeDocument(bodyText, filePath, options.strictJson)
  let drift: readonly DriftEntry[] = []
  if (document !== undefined && countRootProperties(document.root, PROJECTION_RESERVED_ROOT_KEY) > 1) {
    throw jsonMalformed(
      filePath,
      new Error(`document declares more than one '${PROJECTION_RESERVED_ROOT_KEY}' root key`),
    )
  }
  if (document !== undefined) {
    drift = classifyOwnedMarker(document.properties[PROJECTION_RESERVED_ROOT_KEY])
  }
  if (drift.length > 0) return { text: request.nativeText, drift }

  const unit = indentationUnitOf(bodyText)
  const eol = lineEndingOf(bodyText)

  let text: string
  let spanStart: number
  let spanEnd: number
  if (document === undefined) {
    // Whitespace-only input: the rendered subtree IS the file content now.
    text = `{${eol}${renderReservedProperty(request.ownedContent, 0, unit, eol)}${eol}}`
    spanStart = 0
    spanEnd = text.length
  } else {
    const reservedProperty = findReservedRootProperty(document.root, PROJECTION_RESERVED_ROOT_KEY)
    if (reservedProperty !== undefined) {
      // Present: replace EXACTLY the owned node's span. An immediately
      // attached trailing comma belongs to our entry and is consumed too;
      // everything else — including surrounding newlines — is foreign state.
      const leadingWs = leadingWhitespaceBefore(bodyText, reservedProperty.offset)
      const rendered = renderReservedProperty(request.ownedContent, indentLevelOf(leadingWs, unit), unit, eol)
      spanStart = reservedProperty.offset
      spanEnd = reservedProperty.offset + reservedProperty.length
      let scan = spanEnd
      while (bodyText[scan] === ' ' || bodyText[scan] === '\t') scan += 1
      if (bodyText[scan] === ',') spanEnd = scan + 1
      text = bodyText.slice(0, spanStart) + rendered + bodyText.slice(spanEnd)
    } else {
      // Absent: minimal insertion — foreign characters are never touched,
      // only ADDITIONS at one point. With a trailing comma after the last
      // property we insert right after it; otherwise we append the separator
      // comma ourselves. An empty object owns its interior wholesale.
      const properties = document.root.children ?? []
      let insertAt: number
      let inserted: string
      if (properties.length === 0) {
        insertAt = document.root.offset + 1
        inserted = `${eol}${renderReservedProperty(request.ownedContent, 0, unit, eol)}${eol}`
      } else {
        const last = properties[properties.length - 1]!
        const lastEnd = last.offset + last.length
        let commaAt = -1
        for (let i = lastEnd; i < bodyText.length; i += 1) {
          const ch = bodyText[i]
          if (ch === ',') {
            commaAt = i
            break
          }
          if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') break
        }
        if (commaAt >= 0) {
          insertAt = commaAt + 1
          inserted = `${eol}${renderReservedProperty(request.ownedContent, 0, unit, eol)}`
        } else {
          insertAt = lastEnd
          inserted = `,${eol}${renderReservedProperty(request.ownedContent, 0, unit, eol)}`
        }
      }
      text = bodyText.slice(0, insertAt) + inserted + bodyText.slice(insertAt)
      spanStart = insertAt
      spanEnd = insertAt + inserted.length
    }
  }

  return {
    text: hasBom ? BYTE_ORDER_MARK + text : text,
    drift: [],
    skippedEntryIds: sortedEntryIds(request.entries.profile),
    ownedSpan: hasBom ? [spanStart + 1, spanEnd + 1] : [spanStart, spanEnd],
  }
}

// --- TOML family: delimited comment block at EOF ---------------------------

interface ManagedMarker {
  readonly kind: 'begin' | 'end'
  /** Declared grammar version; undefined when the marker carries none. */
  readonly version: number | undefined
  /** Offset of the marker line's first byte. */
  readonly start: number
  /** Offset one past the marker line's terminating newline (or text end). */
  readonly end: number
}

const BEGIN_MARKER_RE = /^#\s*BEGIN\s+panda-managed(?:\s+v(\d+))?\s*$/
const END_MARKER_RE = /^#\s*END\s+panda-managed(?:\s+v(\d+))?\s*$/

function scanManagedMarkers(nativeText: string): ManagedMarker[] {
  const markers: ManagedMarker[] = []
  let offset = 0
  for (const rawLine of nativeText.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const beginMatch = BEGIN_MARKER_RE.exec(line)
    const endMatch = END_MARKER_RE.exec(line)
    if (beginMatch || endMatch) {
      const match = beginMatch ?? endMatch!
      markers.push({
        kind: beginMatch ? 'begin' : 'end',
        version: match[1] === undefined ? undefined : Number(match[1]),
        start: offset,
        end: offset + rawLine.length + 1,
      })
    }
    offset += rawLine.length + 1
  }
  return markers
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

function tomlFieldValue(value: string | readonly string[]): string {
  if (typeof value === 'string') return JSON.stringify(value)
  return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
}

/**
 * Renders the owned subtree as TOML lines inside the managed block. Only OUR
 * subtree shape is serialized — this is not a general TOML writer, and no
 * foreign TOML is ever parsed. Key order is fixed (grammar sections, ids
 * lexicographic) so the rendering of a given registry state never varies.
 */
function renderManagedBlockLines(ownedContent: ProjectionOwnedSubtree): string[] {
  const lines = [`version = ${ownedContent.version}`]
  for (const section of ['tools', 'mcpServers', 'skills'] as const) {
    const leaves = Object.entries(ownedContent[section]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    for (const [id, leaf] of leaves) {
      lines.push('', `[${section}.${tomlKey(id)}]`)
      for (const [field, value] of Object.entries(leaf)) {
        lines.push(`${field} = ${tomlFieldValue(value as string | readonly string[])}`)
      }
    }
  }
  return lines
}

function renderManagedBlock(ownedContent: ProjectionOwnedSubtree, eol: string): string {
  return [PANDA_MANAGED_BLOCK_BEGIN, ...renderManagedBlockLines(ownedContent), PANDA_MANAGED_BLOCK_END].join(eol)
}

function blockDrift(kind: DriftEntry['kind'], detail: string): DriftEntry[] {
  return [{ kind, location: '$.panda-managed-block', detail }]
}

function driftForMarkers(markers: readonly ManagedMarker[]): DriftEntry[] | undefined {
  const begins = markers.filter((marker) => marker.kind === 'begin')
  const ends = markers.filter((marker) => marker.kind === 'end')
  if (markers.length === 0) return undefined
  if (begins.length !== 1 || ends.length !== 1) {
    return blockDrift(
      'unknown-shape',
      `expected exactly one paired '${PANDA_MANAGED_BLOCK_BEGIN}'/'${PANDA_MANAGED_BLOCK_END}' pair but found ${begins.length} begin and ${ends.length} end markers`,
    )
  }
  const begin = begins[0]!
  const end = ends[0]!
  if (begin.start >= end.start) {
    return blockDrift('unknown-shape', 'managed block end marker appears before its begin marker')
  }
  if (begin.version === undefined || end.version === undefined) {
    return blockDrift('legacy-marker', 'managed block markers do not declare a grammar version')
  }
  if (begin.version !== end.version) {
    return blockDrift('unknown-shape', `managed block markers declare mismatched versions v${begin.version} and v${end.version}`)
  }
  if (begin.version !== PROJECTION_GRAMMAR_VERSION) {
    return blockDrift(
      'legacy-marker',
      `managed block declares grammar version ${begin.version} but this build projects version ${PROJECTION_GRAMMAR_VERSION}`,
    )
  }
  return undefined
}

export function mergeDelimitedBlockRegion(request: ProjectionMergeRequest): ProjectionMergeOutcome {
  // Block lines always adopt the file's own EOL so a projection never mixes
  // line-ending styles inside (or around) the managed block.
  const eol = request.nativeText.includes('\r\n') ? '\r\n' : '\n'
  const markers = scanManagedMarkers(request.nativeText)
  const drift = driftForMarkers(markers)
  if (drift !== undefined) return { text: request.nativeText, drift }

  const block = renderManagedBlock(request.ownedContent, eol)
  if (markers.length === 0) {
    // Absent block: append at EOF after ensuring the foreign tail keeps its
    // own trailing newline.
    const prefix =
      request.nativeText === '' || request.nativeText.endsWith('\n')
        ? request.nativeText
        : request.nativeText + eol
    const spanStart = prefix.length
    return {
      text: `${prefix}${block}${eol}`,
      drift: [],
      skippedEntryIds: sortedEntryIds(request.entries.profile),
      ownedSpan: [spanStart, spanStart + block.length],
    }
  }
  // Present block: replace it wholesale between markers — bytes before the
  // BEGIN marker and after the END marker's newline are untouched by
  // construction, and the re-emitted block carries the same trailing EOL the
  // replaced END line had, keeping projections byte-identical across runs.
  const spanStart = markers[0]!.start
  const text =
    request.nativeText.slice(0, spanStart) + `${block}${eol}` + request.nativeText.slice(markers[1]!.end)
  return {
    text,
    drift: [],
    skippedEntryIds: sortedEntryIds(request.entries.profile),
    ownedSpan: [spanStart, spanStart + block.length],
  }
}
