import { PandaError, PANDA_ERROR_CODES, UNPROJECTABLE_ENTRY_IDS, isRecord } from '@panda/contracts'
import type {
  DriftEntry,
  ProjectionLedgerRecord,
  ProjectionMcpEntry,
  ProjectionMergeOutcome,
  ProjectionMergeRequest,
  ProjectionConfigTarget,
  RegistryEntriesByKind,
  RegistryEntry,
} from '@panda/contracts'
import type { Node } from 'jsonc-parser'
import { parse, parseTree } from 'jsonc-parser'
import { hashOwnedText, resolveOwnedPath, sameOwnedPath } from './ledger.ts'

// Format-trait table + generic native-merge strategies (FR-8): everything that
// differs between targets is DATA on a traits record — the vendor's own
// container key and the vendor's own entry shape — dispatched through one
// factory. A format owns exactly one strategy:
//
//   jsonc — an offset-based SPLICE at a native KEY PATH (`<container>.<id>`)
//     over parseTree node positions. Present member → replaced exactly within
//     its node span; absent → characters are only ADDED at one insertion point
//     next to the last property (or inside an empty object). Foreign bytes
//     outside the spliced span survive by construction: there is no
//     whole-document edit and no adjacent-property reformatting, unlike
//     modify()+applyEdits, whose edit range extends across trailing commas and
//     silently reformats the neighbour. `strictJson: true` additionally guards
//     native validity with JSON.parse (Claude rejects comments and trailing
//     commas at startup); lenient JSONC targets skip that guard.
//
//   toml — one NATIVE TABLE per entry (`[<container>.<id>]`). TOML lets a table
//     be defined anywhere in a document, so there is no region to manage and no
//     top-level key to collide with: absent → appended at EOF, present →
//     replaced in place. JS has no toml_edit equivalent, so foreign TOML is
//     NEVER parsed; the locator canonicalises table headers instead.
//
// FAIL CLOSED, everywhere. "locate found nothing" is NOT "the location is
// free": a document can express panda's location in a form panda cannot claim
// (a `[mcp_servers]` table, a `mcp_servers = {...}` assignment, the same JSON
// key twice). Writing anyway means a duplicate TOML table — a hard parse error
// that stops the user's whole config from loading, in DEFAULT mode — or a JSON
// entry panda edits while every vendor reads the other one. Every such shape is
// reported as a foreign collision and nothing is written.
//
// Both strategies render deterministically — indentation unit derived from the
// native file's first indented line (fallback two spaces) and the file's own
// EOL — so projecting an unchanged registry twice is byte-identical. Every
// outcome reports its `ownedSpans` so byte preservation is checkable
// mechanically rather than by eye.
//
// What panda may write is not a judgement call: it is exactly the keys the
// trait's `renderMcpEntry` produces, and those are asserted against each
// vendor's own vendored schema source in the conformance suite.

export type FileFormat = 'jsonc' | 'toml'

/** A vendor-native entry: keys and values in the vendor's own vocabulary. */
export type NativeEntryShape = Readonly<Record<string, string | readonly string[]>>

/** The data that fully describes a projection target (FR-8). */
export interface ProjectionTargetTraits {
  readonly targetId: string
  readonly fileFormat: FileFormat
  /** Absolute path used when the caller injects no filePath override. */
  readonly defaultPath: string
  /** The vendor's OWN container for MCP servers: JSON key or TOML table prefix. */
  readonly mcpContainerKey: string
  /** The vendor's OWN entry shape. Its keys are the only keys panda writes. */
  readonly renderMcpEntry: (entry: ProjectionMcpEntry) => NativeEntryShape
  /** JSON family only: treat comments/trailing commas as malformed native input. */
  readonly strictJson?: boolean
}

export interface TraitTargetOptions {
  /** Overrides the trait record's defaultPath (default paths are injectable). */
  readonly filePath?: string
}

/** A half-open range of the native text, in the text's current coordinates. */
interface Region {
  readonly start: number
  readonly end: number
}

interface Splice extends Region {
  readonly replacement: string
  /** The entry text alone — what the ledger hashes, separators excluded. */
  readonly owned: string
}

interface DocStyle {
  readonly eol: '\n' | '\r\n'
  readonly unit: string
}

interface FormatStrategy {
  /** Rejects native text this strategy cannot merge into, with a coded error. */
  validate(body: string, filePath: string, traits: ProjectionTargetTraits): void
  /** Why the whole container is unclaimable in this document, if it is. */
  containerConflict(body: string, traits: ProjectionTargetTraits): string | undefined
  /** Why ONE id's location is unclaimable, if it is. */
  entryConflict(body: string, traits: ProjectionTargetTraits, id: string): string | undefined
  /** The region an entry's native location occupies, or undefined when free. */
  locate(body: string, traits: ProjectionTargetTraits, id: string): Region | undefined
  /** Formatting-independent form of an owned region; what actually gets hashed. */
  canonical(ownedText: string): string
  upsert(
    body: string,
    style: DocStyle,
    traits: ProjectionTargetTraits,
    entry: ProjectionMcpEntry,
    existing: Region | undefined,
  ): Splice
  /** Widens an entry's region to the separators panda introduced with it. */
  remove(body: string, style: DocStyle, existing: Region): Region
  /** A now-empty container panda can take back after removing its last entry. */
  reclaimContainer(body: string, traits: ProjectionTargetTraits): Region | undefined
}

// --- shared text helpers ----------------------------------------------------

const BYTE_ORDER_MARK = '\uFEFF'
const FALLBACK_INDENT_UNIT = '  '

function isSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n'
}

function lineEndingOf(bodyText: string): '\n' | '\r\n' {
  return bodyText.includes('\r\n') ? '\r\n' : '\n'
}

/** Leading whitespace of the FIRST indented content line; fallback two spaces. */
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

function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  return /^[ \t]*/.exec(text.slice(lineStart, offset))![0]
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

function nativeMalformed(filePath: string, cause: unknown): PandaError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new PandaError(
    PANDA_ERROR_CODES.projectionNativeMalformed,
    `native config file '${filePath}' is malformed: ${detail}`,
    { cause },
  )
}

function nativeUnclaimable(filePath: string, detail: string): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.projectionNativeUnclaimable,
    `native config file '${filePath}' is intact but panda cannot place entries there: ${detail}`,
  )
}

/** Sorted-key JSON: two renderings of the same entry hash the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// --- JSON family: native key-path splice ------------------------------------

function memberProperties(objectNode: Node, key: string): Node[] {
  return (objectNode.children ?? []).filter((property) => property.children?.[0]?.value === key)
}

function memberValue(objectNode: Node, key: string): Node | undefined {
  return memberProperties(objectNode, key)[0]?.children?.[1]
}

function objectRootOf(body: string, filePath: string, strictJson: boolean): Node {
  if (strictJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (error) {
      throw nativeMalformed(filePath, error)
    }
    if (!isRecord(parsed)) throw nativeMalformed(filePath, new Error('document root is not an object'))
    // Strict JSON already validated above; the tree exists by construction.
    return parseTree(body)!
  }
  const root = parseTree(body)
  if (!root || root.type !== 'object') {
    throw nativeMalformed(filePath, new Error('document root is not an object'))
  }
  return root
}

/**
 * Deterministic serializer for the VENDOR-shaped entry only — fixed key order
 * (the trait renderer's insertion order), arrays one element per line. This is
 * not a general JSON writer: it exists so the same entry always renders to the
 * same bytes.
 */
function serializeJsonValue(value: unknown, level: number, unit: string, eol: string): string {
  const at = (depth: number): string => unit.repeat(depth)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const inner = value
      .map((item) => `${at(level + 1)}${serializeJsonValue(item, level + 1, unit, eol)}`)
      .join(`,${eol}`)
    return `[${eol}${inner}${eol}${at(level)}]`
  }
  if (!isRecord(value)) {
    // Unreachable for a NativeEntryShape; a trait renderer returning anything
    // else must fail coded instead of emitting invalid JSON.
    throw new PandaError(
      PANDA_ERROR_CODES.projectionTraitsInvalid,
      `native entry shape contains a value that cannot be serialized: ${JSON.stringify(value)}`,
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

/** The member text WITHOUT its leading indent, matching what parseTree spans. */
function renderJsonMember(id: string, shape: NativeEntryShape, level: number, style: DocStyle): string {
  return `${JSON.stringify(id)}: ${serializeJsonValue(shape, level, style.unit, style.eol)}`
}

/**
 * Panda's entry lines up with the container's EXISTING members; only an empty
 * container falls back to one unit in from its own line. Rendering root members
 * at column 0 inside a two-space document is how the previous build produced
 * output no formatter would leave alone.
 */
function memberLevelOf(body: string, objectNode: Node, unit: string): number {
  const first = objectNode.children?.[0]
  if (first !== undefined) return indentLevelOf(leadingWhitespaceBefore(body, first.offset), unit)
  if (objectNode.parent === undefined) return 0
  return indentLevelOf(lineIndentAt(body, objectNode.offset), unit) + 1
}

/**
 * Insertion is purely ADDITIVE: characters are added at exactly one point and
 * no existing byte is rewritten. With a trailing comma after the last property
 * we insert right after it; otherwise we contribute the separator comma
 * ourselves. An empty object owns its interior wholesale.
 */
function insertIntoObject(
  body: string,
  objectNode: Node,
  memberText: string,
  style: DocStyle,
  level: number,
): Region & { replacement: string } {
  const indent = style.unit.repeat(level)
  const properties = objectNode.children ?? []
  if (properties.length === 0) {
    // An empty object owns its interior wholesale, and closes on the
    // container's own line so nothing reformats it on the next save.
    const at = objectNode.offset + 1
    const closingIndent = style.unit.repeat(Math.max(0, level - 1))
    return {
      start: at,
      end: at,
      replacement: `${style.eol}${indent}${memberText}${style.eol}${closingIndent}`,
    }
  }
  const last = properties[properties.length - 1]!
  const lastEnd = last.offset + last.length
  for (let index = lastEnd; index < body.length; index += 1) {
    const character = body[index]
    if (character === ',') {
      return { start: index + 1, end: index + 1, replacement: `${style.eol}${indent}${memberText}` }
    }
    if (!isSpace(character)) break
  }
  return { start: lastEnd, end: lastEnd, replacement: `,${style.eol}${indent}${memberText}` }
}

/**
 * Symmetric with insertion: takes back the separator comma and the whitespace
 * panda's own line introduced, so removal cannot leave a dangling comma that
 * strict JSON would reject.
 */
function jsonRemovalSpan(body: string, existing: Region): Region {
  let end = existing.end
  let scan = end
  while (isSpace(body[scan])) scan += 1
  const hasTrailingComma = body[scan] === ','
  if (hasTrailingComma) end = scan + 1
  let start = existing.start
  while (start > 0 && isSpace(body[start - 1])) start -= 1
  if (!hasTrailingComma && body[start - 1] === ',') start -= 1
  if (body[start - 1] === '{') {
    // We were the object's only member. Inserting into an empty object adds
    // whitespace on BOTH sides, so emptying one has to take both back —
    // otherwise every rename leaves another blank line behind.
    let closing = end
    while (isSpace(body[closing])) closing += 1
    if (body[closing] === '}') end = closing
  }
  return { start, end }
}

const JSONC_STRATEGY: FormatStrategy = {
  validate(body, filePath, traits) {
    const root = objectRootOf(body, filePath, traits.strictJson ?? false)
    if (memberProperties(root, traits.mcpContainerKey).length > 1) {
      throw nativeMalformed(
        filePath,
        new Error(`document declares more than one '${traits.mcpContainerKey}' key`),
      )
    }
    const container = memberValue(root, traits.mcpContainerKey)
    if (container !== undefined && container.type !== 'object') {
      // The vendor's own key holding something panda cannot place entries in.
      // The FILE is fine — telling the user it is malformed would be a lie.
      throw nativeUnclaimable(
        filePath,
        `'${traits.mcpContainerKey}' holds a ${container.type}, not an object of servers`,
      )
    }
  },

  containerConflict() {
    // JSON has no ambiguous container spelling: validate() already rejected the
    // two shapes that exist (duplicate key, non-object value).
    return undefined
  },

  entryConflict(body, traits, id) {
    const root = parseTree(body)
    const container = root === undefined ? undefined : memberValue(root, traits.mcpContainerKey)
    if (container === undefined || container.type !== 'object') return undefined
    if (memberProperties(container, id).length > 1) {
      return `'${traits.mcpContainerKey}.${id}' is declared more than once; panda would edit the first while every vendor reads the last`
    }
    return undefined
  },

  locate(body, traits, id) {
    const root = parseTree(body)
    if (!root || root.type !== 'object') return undefined
    const container = memberValue(root, traits.mcpContainerKey)
    if (container === undefined || container.type !== 'object') return undefined
    const member = memberProperties(container, id)[0]
    return member === undefined ? undefined : { start: member.offset, end: member.offset + member.length }
  },

  canonical(ownedText) {
    // The owned text is one object MEMBER; wrapping it makes a document jsonc
    // can parse. A member that no longer parses has been edited beyond
    // recognition, and its raw text is the honest canonical form.
    const parsed: unknown = parse(`{${ownedText}}`, [], { allowTrailingComma: true })
    return isRecord(parsed) ? stableJson(parsed) : ownedText.trim()
  },

  upsert(body, style, traits, entry, existing) {
    // validate() ran first, so the root is an object and the container is
    // either absent or an object.
    const root = parseTree(body)!
    if (existing !== undefined) {
      const level = indentLevelOf(leadingWhitespaceBefore(body, existing.start), style.unit)
      const owned = renderJsonMember(entry.id, traits.renderMcpEntry(entry), level, style)
      return { start: existing.start, end: existing.end, replacement: owned, owned }
    }
    const container = memberValue(root, traits.mcpContainerKey)
    if (container !== undefined) {
      const level = memberLevelOf(body, container, style.unit)
      const owned = renderJsonMember(entry.id, traits.renderMcpEntry(entry), level, style)
      return { ...insertIntoObject(body, container, owned, style, level), owned }
    }
    // The vendor's container does not exist yet: panda creates it holding this
    // one entry, indented like the document's own root members so nothing
    // reformats it on the next save.
    const containerLevel = memberLevelOf(body, root, style.unit)
    const owned = renderJsonMember(entry.id, traits.renderMcpEntry(entry), containerLevel + 1, style)
    const containerMember = `${JSON.stringify(traits.mcpContainerKey)}: {${style.eol}${style.unit.repeat(containerLevel + 1)}${owned}${style.eol}${style.unit.repeat(containerLevel)}}`
    return { ...insertIntoObject(body, root, containerMember, style, containerLevel), owned }
  },

  remove(body, _style, existing) {
    return jsonRemovalSpan(body, existing)
  },

  reclaimContainer(body, traits) {
    const root = parseTree(body)
    if (!root || root.type !== 'object') return undefined
    const property = memberProperties(root, traits.mcpContainerKey)[0]
    const container = property?.children?.[1]
    if (property === undefined || container === undefined || container.type !== 'object') return undefined
    if ((container.children ?? []).length > 0) return undefined
    // ponytail: panda cannot tell a container it created from an empty one the
    // user left behind — but for all three vendors an empty container and an
    // absent one are the same configuration, so reclaiming it is semantically
    // free and stops renames from accreting dead scaffolding.
    return jsonRemovalSpan(body, { start: property.offset, end: property.offset + property.length })
  },
}

// --- TOML family: one native table per entry --------------------------------

function tomlBareKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

function tomlValue(value: string | readonly string[]): string {
  if (typeof value === 'string') return JSON.stringify(value)
  return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
}

/**
 * Splits a TOML key path into its decoded segments, tolerating the spellings
 * that mean the same key: bare, basic-quoted, literal-quoted, and whitespace
 * around the dots. This is key canonicalisation, NOT a TOML parser — anything
 * it cannot decode returns undefined and is treated as unrecognised.
 */
function splitTomlKeyPath(raw: string): string[] | undefined {
  const segments: string[] = []
  let rest = raw.trim()
  if (rest === '') return undefined
  for (;;) {
    const basic = /^"((?:[^"\\]|\\.)*)"/.exec(rest)
    const literal = /^'([^']*)'/.exec(rest)
    const bare = /^[A-Za-z0-9_-]+/.exec(rest)
    if (basic) {
      const decoded: unknown = JSON.parse(basic[0])
      segments.push(String(decoded))
      rest = rest.slice(basic[0].length)
    } else if (literal) {
      segments.push(literal[1]!)
      rest = rest.slice(literal[0].length)
    } else if (bare) {
      segments.push(bare[0])
      rest = rest.slice(bare[0].length)
    } else {
      return undefined
    }
    rest = rest.trimStart()
    if (rest === '') return segments
    if (!rest.startsWith('.')) return undefined
    rest = rest.slice(1).trimStart()
  }
}

/** The decoded path of a `[a.b]` header line, tolerating spacing and comments. */
function tomlHeaderPath(line: string): string[] | undefined {
  const match = /^\s*\[([^[\]]*)\]\s*(?:#.*)?$/.exec(line)
  return match === undefined || match === null ? undefined : splitTomlKeyPath(match[1]!)
}

/** The decoded path on the left of a `key = value` line, if it is one. */
function tomlAssignmentPath(line: string): string[] | undefined {
  const match = /^\s*([^=#]+?)\s*=/.exec(line)
  return match === null ? undefined : splitTomlKeyPath(match[1]!)
}

function startsTable(lineText: string): boolean {
  return lineText.trimStart().startsWith('[')
}

function tomlHeader(traits: ProjectionTargetTraits, id: string): string {
  return `[${traits.mcpContainerKey}.${tomlBareKey(id)}]`
}

function renderTomlTable(traits: ProjectionTargetTraits, entry: ProjectionMcpEntry, style: DocStyle): string {
  const lines = [tomlHeader(traits, entry.id)]
  for (const [key, value] of Object.entries(traits.renderMcpEntry(entry))) {
    lines.push(`${key} = ${tomlValue(value)}`)
  }
  return lines.join(style.eol) + style.eol
}

interface TextLine {
  readonly start: number
  /** One past the line terminator (or the text end for a final unterminated line). */
  readonly end: number
  readonly text: string
}

function splitLines(body: string): TextLine[] {
  const lines: TextLine[] = []
  let start = 0
  while (start <= body.length) {
    const newline = body.indexOf('\n', start)
    if (newline < 0) {
      if (start < body.length) lines.push({ start, end: body.length, text: body.slice(start) })
      break
    }
    lines.push({ start, end: newline + 1, text: body.slice(start, newline) })
    start = newline + 1
  }
  return lines
}

/** Indices of the header lines that define `[<container>.<id>]`, any spelling. */
function tomlEntryHeaders(lines: readonly TextLine[], container: string, id: string): number[] {
  const found: number[] = []
  lines.forEach((line, index) => {
    const path = tomlHeaderPath(line.text)
    if (path?.length === 2 && path[0] === container && path[1] === id) found.push(index)
  })
  return found
}

const TOML_STRATEGY: FormatStrategy = {
  validate() {
    // Foreign TOML is never parsed, so malformed foreign TOML is undetectable
    // here by design. Every shape panda MUST notice is a container conflict,
    // which fails closed below instead of relying on a parse.
  },

  /**
   * The load-bearing half of "not found is not free". Every one of these
   * spellings defines servers panda cannot address; appending its own table
   * anyway would define the same table twice, which stops the user's entire
   * config.toml from loading in DEFAULT mode — the exact catastrophe
   * correction-01 exists to eliminate.
   */
  containerConflict(body, traits) {
    let inRootTable = true
    for (const line of splitLines(body)) {
      const header = tomlHeaderPath(line.text)
      if (header !== undefined) {
        inRootTable = false
        if (header.length === 1 && header[0] === traits.mcpContainerKey) {
          return `'[${traits.mcpContainerKey}]' is defined as a table, so its servers are keys panda cannot address individually`
        }
        continue
      }
      if (startsTable(line.text)) {
        // An array-of-tables header or anything else bracketed: no longer root.
        inRootTable = false
        continue
      }
      if (!inRootTable) continue
      const assignment = tomlAssignmentPath(line.text)
      if (assignment !== undefined && assignment[0] === traits.mcpContainerKey) {
        return `'${assignment.join('.')}' is assigned directly, so '${traits.mcpContainerKey}' is not a set of tables panda can add to`
      }
    }
    return undefined
  },

  entryConflict(body, traits, id) {
    const headers = tomlEntryHeaders(splitLines(body), traits.mcpContainerKey, id)
    return headers.length > 1
      ? `'${traits.mcpContainerKey}.${id}' is defined ${headers.length} times; the document does not load as it is and panda will not add to it`
      : undefined
  },

  /**
   * ponytail: line-oriented table locator, not a TOML parser. Panda renders
   * every value on one line, so no line inside a table panda wrote can start
   * with '[' — a user edit that introduces one ends the region early, the hash
   * stops matching, and the entry lands as 'edited' drift. That is the safe
   * direction: panda reports instead of rewriting.
   */
  locate(body, traits, id) {
    const lines = splitLines(body)
    const headerIndex = tomlEntryHeaders(lines, traits.mcpContainerKey, id)[0]
    if (headerIndex === undefined) return undefined
    let end = lines[headerIndex]!.end
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!
      if (startsTable(line.text)) break
      // Trailing blank lines after the table are foreign spacing, not ours.
      if (line.text.trim() !== '') end = line.end
    }
    return { start: lines[headerIndex]!.start, end }
  },

  canonical(ownedText) {
    return ownedText
      .split('\n')
      .map((line) => {
        const trimmed = line.trim()
        const header = tomlHeaderPath(trimmed)
        // Re-spell the header from its decoded path so `[ a."b" ]` and `[a.b]`
        // hash the same.
        return header === undefined ? trimmed : `[${header.map(tomlBareKey).join('.')}]`
      })
      .filter((line) => line !== '')
      .join('\n')
  },

  upsert(body, style, traits, entry, existing) {
    const owned = renderTomlTable(traits, entry, style)
    if (existing !== undefined) {
      return { start: existing.start, end: existing.end, replacement: owned, owned }
    }
    // Appended at EOF, after ensuring the foreign tail keeps its own trailing
    // newline and exactly one blank line separates panda's table from it.
    const separator = body === '' ? '' : body.endsWith(style.eol) ? style.eol : `${style.eol}${style.eol}`
    return { start: body.length, end: body.length, replacement: `${separator}${owned}`, owned }
  },

  remove(body, style, existing) {
    const separator = style.eol + style.eol
    const hasSeparator =
      existing.start >= separator.length &&
      body.slice(existing.start - separator.length, existing.start) === separator
    return { start: hasSeparator ? existing.start - style.eol.length : existing.start, end: existing.end }
  },

  reclaimContainer() {
    // TOML tables are independent definitions; removing one leaves no container.
    return undefined
  },
}

const FORMAT_STRATEGIES: Readonly<Record<FileFormat, FormatStrategy>> = {
  jsonc: JSONC_STRATEGY,
  toml: TOML_STRATEGY,
}

// --- registry -> native entries ---------------------------------------------

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Reduces the registry to the MCP servers every target can express, in stable
 * id order. Kinds this story does not project (tools, skills, profiles) and MCP
 * entries with no command are REPORTED through skippedEntryIds rather than
 * approximated into something no executor reads — Stories 2.9 and 2.10 own
 * those concepts. `present` is EVERY mcp-server id the registry holds,
 * including the ones panda cannot render: removal authority comes from absence
 * in the registry, never from unprojectability.
 */
function collectMcpEntries(entries: RegistryEntriesByKind): {
  readonly mcp: readonly ProjectionMcpEntry[]
  readonly present: ReadonlySet<string>
  readonly skippedEntryIds: readonly string[]
} {
  const skipped: string[] = []
  for (const kind of ['tool', 'skill', 'profile'] as const) {
    for (const entry of entries[kind]) skipped.push(entry.id)
  }
  const mcp: ProjectionMcpEntry[] = []
  const present = new Set<string>()
  let previousId: string | undefined
  for (const entry of [...entries['mcp-server']].sort(byId) as RegistryEntry[]) {
    // Defense in depth: the Registry already rejects duplicate type+id pairs
    // and unprojectable ids, so reaching either branch means a hand-edited or
    // corrupted store — which must fail coded, never silently collapse two
    // entries into one native location or address one through a prototype key.
    if (UNPROJECTABLE_ENTRY_IDS.has(entry.id)) {
      throw new PandaError(
        PANDA_ERROR_CODES.registryInvalidEntry,
        `registry mcp-server entry '${entry.id}' cannot be used as a native config key`,
      )
    }
    if (previousId === entry.id) {
      throw new PandaError(
        PANDA_ERROR_CODES.registryContention,
        `duplicate registry mcp-server entries '${entry.id}': two entries with the same id cannot both be projected`,
      )
    }
    previousId = entry.id
    present.add(entry.id)
    if (entry.command === undefined) {
      // Reported, and LEFT ALONE on disk. Treating "panda cannot render this"
      // as "the user deleted it" would delete a registered server from every
      // config the moment its command went missing.
      skipped.push(entry.id)
      continue
    }
    mcp.push({ id: entry.id, command: entry.command, args: [...(entry.args ?? [])] })
  }
  return { mcp, present, skippedEntryIds: skipped.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }
}

// --- the merge --------------------------------------------------------------

function drifted(
  kind: DriftEntry['kind'],
  traits: ProjectionTargetTraits,
  entryId: string,
  detail: string,
): DriftEntry {
  return { kind, entryId, location: `${traits.mcpContainerKey}.${entryId}`, detail }
}

function nativeLocationOf(traits: ProjectionTargetTraits, entryId: string): string {
  return `${traits.mcpContainerKey}.${entryId}`
}

function mergeNative(
  request: ProjectionMergeRequest,
  filePath: string,
  traits: ProjectionTargetTraits,
): ProjectionMergeOutcome {
  const strategy = FORMAT_STRATEGIES[traits.fileFormat]
  // A leading BOM is foreign state: stripped for parsing, re-prepended to the
  // output so it survives every projection byte-intact.
  const hasBom = request.nativeText.startsWith(BYTE_ORDER_MARK)
  const nativeBody = hasBom ? request.nativeText.slice(1) : request.nativeText
  // A missing or whitespace-only JSON file has no document to splice into, so
  // the projection IS the file; TOML needs no seed because a table appends to
  // anything.
  const seeded = traits.fileFormat === 'jsonc' && nativeBody.trim() === ''
  let body = seeded ? '{}' : nativeBody
  strategy.validate(body, filePath, traits)

  const style: DocStyle = { eol: lineEndingOf(nativeBody), unit: indentationUnitOf(nativeBody) }
  const { mcp, present, skippedEntryIds } = collectMcpEntries(request.entries)

  // A record is authority ONLY for its own key. A stale record from a build
  // that used a different container key, another target, or another file must
  // never authorise an overwrite or a deletion here.
  const ownedPath = resolveOwnedPath(filePath)
  const authoritative = request.records.filter(
    (record) =>
      record.targetId === traits.targetId &&
      sameOwnedPath(resolveOwnedPath(record.filePath), ownedPath) &&
      record.nativeLocation === nativeLocationOf(traits, record.entryId),
  )
  const claimed = new Map(authoritative.map((record) => [record.entryId, record]))
  const unchanged = (drift: readonly DriftEntry[]): ProjectionMergeOutcome => ({
    text: request.nativeText,
    drift,
    skippedEntryIds,
    records: authoritative,
    ownedSpans: [],
  })

  const conflict = strategy.containerConflict(body, traits)
  if (conflict !== undefined) {
    const affected = [...new Set([...mcp.map((entry) => entry.id), ...claimed.keys()])].sort()
    return unchanged(
      affected.map((entryId) =>
        drifted(
          'foreign-collision',
          traits,
          entryId,
          `${conflict}; panda will not touch '${entryId}' in '${filePath}'`,
        ),
      ),
    )
  }

  const drift: DriftEntry[] = []
  const records: ProjectionLedgerRecord[] = []
  const spans: [number, number][] = []
  let removed = 0

  const applySplice = (start: number, end: number, replacement: string): void => {
    body = body.slice(0, start) + replacement + body.slice(end)
    const delta = replacement.length - (end - start)
    // A later entry can land INSIDE a span panda already owns — the second
    // entry going into a container the first one created. Such a splice grows
    // the enclosing span instead of adding an overlapping one. Only a NON-EMPTY
    // span can enclose: a removal's zero-width span must never swallow a later
    // insertion's own span and leave the verification surface empty.
    const enclosing = spans.find((span) => span[1] > span[0] && span[0] <= start && end <= span[1])
    for (const span of spans) {
      if (span[0] >= end) {
        span[0] += delta
        span[1] += delta
      } else if (span === enclosing) {
        span[1] += delta
      }
    }
    if (enclosing === undefined && replacement.length > 0) {
      spans.push([start, start + replacement.length])
    }
  }

  const stillPandas = (record: ProjectionLedgerRecord, region: Region): boolean =>
    hashOwnedText(strategy.canonical(body.slice(region.start, region.end))) === record.contentHash

  // 1. Entries absent from the REGISTRY: remove exactly the ledger-recorded
  //    region, and only while it still hashes to what panda wrote.
  const renderable = new Set(mcp.map((entry) => entry.id))
  for (const record of [...authoritative].sort((a, b) => (a.entryId < b.entryId ? -1 : 1))) {
    if (present.has(record.entryId)) {
      // Still registered but not renderable this run: keep the claim, or the
      // next run would see its own entry as foreign and never manage it again.
      if (!renderable.has(record.entryId)) records.push(record)
      continue
    }
    const entryBlocked = strategy.entryConflict(body, traits, record.entryId)
    if (entryBlocked !== undefined) {
      drift.push(drifted('foreign-collision', traits, record.entryId, `${entryBlocked} in '${filePath}'`))
      records.push(record)
      continue
    }
    const existing = strategy.locate(body, traits, record.entryId)
    if (existing === undefined) continue
    if (!stillPandas(record, existing)) {
      drift.push(
        drifted(
          'edited',
          traits,
          record.entryId,
          `'${record.entryId}' in '${filePath}' has been edited since panda wrote it; panda will not remove it`,
        ),
      )
      records.push(record)
      continue
    }
    const removal = strategy.remove(body, style, existing)
    applySplice(removal.start, removal.end, '')
    removed += 1
  }

  // 2. Entries the registry holds. Panda writes only where it already owns the
  //    location or where the location is provably free; everything else is
  //    reported and left alone.
  for (const entry of mcp) {
    const record = claimed.get(entry.id)
    const entryBlocked = strategy.entryConflict(body, traits, entry.id)
    if (entryBlocked !== undefined) {
      drift.push(drifted('foreign-collision', traits, entry.id, `${entryBlocked} in '${filePath}'`))
      if (record !== undefined) records.push(record)
      continue
    }
    const existing = strategy.locate(body, traits, entry.id)
    if (record === undefined) {
      if (existing !== undefined) {
        drift.push(
          drifted(
            'foreign-collision',
            traits,
            entry.id,
            `'${entry.id}' already exists in '${filePath}' and panda's ledger does not claim it; panda will not resolve the collision`,
          ),
        )
        continue
      }
    } else if (existing === undefined) {
      drift.push(
        drifted(
          'removed-by-user',
          traits,
          entry.id,
          `panda wrote '${entry.id}' to '${filePath}' and it is gone; panda will not re-add it`,
        ),
      )
      // The claim is KEPT: dropping it would make the next run treat the entry
      // as never written and silently re-add what the user deleted.
      records.push(record)
      continue
    } else if (!stillPandas(record, existing)) {
      drift.push(
        drifted(
          'edited',
          traits,
          entry.id,
          `'${entry.id}' in '${filePath}' has been edited since panda wrote it; panda will not overwrite it`,
        ),
      )
      records.push(record)
      continue
    }
    const splice = strategy.upsert(body, style, traits, entry, existing)
    applySplice(splice.start, splice.end, splice.replacement)
    records.push({
      targetId: traits.targetId,
      filePath: ownedPath,
      nativeLocation: nativeLocationOf(traits, entry.id),
      entryId: entry.id,
      contentHash: hashOwnedText(strategy.canonical(splice.owned)),
    })
  }

  if (removed > 0) {
    const reclaimable = strategy.reclaimContainer(body, traits)
    if (reclaimable !== undefined) applySplice(reclaimable.start, reclaimable.end, '')
  }

  // Nothing to write means nothing to create: a run with an empty registry must
  // not conjure a config file the user never had.
  if (seeded && spans.length === 0) return unchanged(drift)

  const text = hasBom ? BYTE_ORDER_MARK + body : body
  const bomShift = hasBom ? 1 : 0
  const ownedSpans: (readonly [number, number])[] = seeded
    ? [[0, text.length]]
    : spans
        .filter((span) => span[1] > span[0])
        .sort((a, b) => a[0] - b[0])
        .map((span) => [span[0] + bomShift, span[1] + bomShift] as const)

  return { text, drift, skippedEntryIds, records, ownedSpans }
}

/**
 * The ONE factory every target flows through: adding a target means writing a
 * trait record — no engine or strategy code changes. An unknown file format is
 * a coded configuration error, not a crash at splice time.
 */
export function createProjectionTargetFromTraits(
  traits: ProjectionTargetTraits,
  options: TraitTargetOptions = {},
): ProjectionConfigTarget {
  if (FORMAT_STRATEGIES[traits.fileFormat] === undefined) {
    throw new PandaError(
      PANDA_ERROR_CODES.projectionTraitsInvalid,
      `projection target '${traits.targetId}' declares unknown fileFormat '${traits.fileFormat}'`,
    )
  }
  const filePath = options.filePath ?? traits.defaultPath
  return {
    targetId: traits.targetId,
    filePath,
    merge(request: ProjectionMergeRequest): ProjectionMergeOutcome {
      return mergeNative(request, filePath, traits)
    },
  }
}
