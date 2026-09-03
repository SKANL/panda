import { readFile } from 'node:fs/promises'
import {
  PandaError,
  PANDA_ERROR_CODES,
  REGISTRY_ENTRY_TYPES,
  UNPROJECTABLE_ENTRY_IDS,
  isRecord,
} from '@panda/contracts'
import type {
  DriftEntry,
  ProjectionClaim,
  ProjectionClaimRequest,
  ProjectionLedgerRecord,
  ProjectionMcpEntry,
  ProjectionMergeOutcome,
  ProjectionMergeRequest,
  ProjectionConfigTarget,
  RegistryEntriesByKind,
  RegistryEntry,
} from '@panda/contracts'
import type { Node, ParseError } from 'jsonc-parser'
import { parse, parseTree, printParseErrorCode } from 'jsonc-parser'
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

/**
 * What ONE vendor entry means in panda's vocabulary, or why it means nothing
 * panda can hold — a typed absence rather than a bare `undefined` (AD-5), so a
 * caller has to say what it does about an entry it cannot represent.
 */
export type ReadMcpEntry =
  | { readonly ok: true; readonly command: string; readonly args: readonly string[] }
  | { readonly ok: false; readonly detail: string }

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
  /**
   * The exact inverse of {@link renderMcpEntry}, and REQUIRED for the same
   * reason it sits here rather than in a reader module: the three vendors
   * disagree about the shape, and OpenCode's `command` IS the argv, so the
   * un-join belongs beside the join and nowhere else. Optional, it would permit
   * a target that can be projected into and never read back — precisely the
   * asymmetry M11.A exists to remove — so the type system carries the rule and
   * a fourth trait record cannot forget it.
   */
  readonly readMcpEntry: (native: NativeEntryShape) => ReadMcpEntry
  /** JSON family only: treat comments/trailing commas as malformed native input. */
  readonly strictJson?: boolean
}

/**
 * The keys THIS vendor's renderer emits, which are exactly the keys its reader
 * consumes — asked of the renderer rather than written down beside it.
 *
 * A hand-written list here was a THIRD spelling of the same fact, and a key
 * added to a renderer and forgotten in that list would be reported to the user
 * as `dropped` while panda was writing it. The sample is arbitrary: every
 * renderer emits a fixed key set, which `vendor-conformance.test.ts` pins.
 */
export function renderedKeys(traits: ProjectionTargetTraits): readonly string[] {
  return Object.keys(traits.renderMcpEntry({ id: 'sample', command: 'sample', args: ['sample'] }))
}

/**
 * The native keys the renderer does not emit, sorted so two runs report the same
 * list. `REGISTRY_PATH_FIELDS` gives an `mcp-server` a command and its arguments
 * and nothing else, so a vendor's `env` table or a `url` has no root field to
 * land in — and D10 says those are REPORTED, never silently lost.
 */
function droppedNativeKeys(native: NativeEntryShape, rendered: readonly string[]): readonly string[] {
  return Object.keys(native)
    .filter((key) => !rendered.includes(key))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * The reading Claude Code and Codex SHARE: a `command` string beside an optional
 * `args` array of strings.
 *
 * OpenCode deliberately does NOT use it. Its `command` is the whole argv, and
 * D1 keeps that un-join in `opencode-config.ts` alone; what is shared here is
 * only the vocabulary the other two already spell identically, so the sentence a
 * user reads for a missing command cannot differ between two vendors that failed
 * the same way.
 */
export function readNativeCommand(native: NativeEntryShape): ReadMcpEntry {
  const command = native['command']
  if (typeof command !== 'string' || command === '') {
    return {
      ok: false,
      detail:
        command === undefined
          ? "it declares no 'command', so there is nothing for panda to run"
          : "'command' is not a non-empty string, so there is nothing for panda to run",
    }
  }
  const args = native['args']
  if (args !== undefined && typeof args === 'string') {
    return { ok: false, detail: "'args' is a string rather than an array, and panda will not guess how to split it" }
  }
  return { ok: true, command, args: args ?? [] }
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

/** One id present in a vendor's MCP container, as that document spells it. */
interface NativeContainerEntry {
  readonly id: string
  /** The members whose value is a string or an array of strings. */
  readonly native: NativeEntryShape
  /**
   * Member names whose value is NEITHER — a vendor's `env` table, a numeric
   * timeout, a nested `[<container>.<id>.<sub>]` table. `NativeEntryShape`
   * cannot carry them at all, so they are named here instead of vanishing
   * before the trait's reader ever sees the entry.
   */
  readonly foreignKeys: readonly string[]
}

interface NativeContainerListing {
  readonly entries: readonly NativeContainerEntry[]
  /** Ids that are present and shaped so that no entry can be read out of them. */
  readonly unreadable: readonly UnreadableNativeMcpEntry[]
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
  /**
   * Every id the vendor's container holds, with its native entry — the read
   * direction of the same location `locate` writes at, so a document this
   * strategy would refuse to merge into is refused here too rather than read
   * through a second, more forgiving door.
   */
  listEntries(body: string, traits: ProjectionTargetTraits): NativeContainerListing
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
  // Errors are COLLECTED, and trailing commas are allowed while collecting.
  // `parseTree` recovers: handed a broken document it returns a tree built from
  // a guess, and panda splices by OFFSET into whatever it returns. Without this
  // out-param a file whose only fault is an unquoted key parsed as an object and
  // panda wrote its own block INSIDE one of the user's own server definitions.
  //
  // `allowTrailingComma` is not decoration. A trailing comma is legitimate JSONC
  // that every JSONC-tolerant vendor accepts, and WITHOUT the option it reports
  // the same `PropertyNameExpected` a genuinely doubled comma does — so
  // refusing on any error would reject working files. With it, every legitimate
  // spelling (comments, trailing commas, nested and in arrays) collects zero and
  // every real fault collects at least one. `canonical()` below already parses
  // this way; this is the same answer given at both doors.
  const errors: ParseError[] = []
  const root = parseTree(body, errors, { allowTrailingComma: true })
  const first = errors[0]
  if (first !== undefined) {
    // The FIRST only. A recovering parser cascades — an unquoted key reports
    // four — and the rest are that one's shadow.
    //
    // The parser's OWN code (`InvalidSymbol`, `PropertyNameExpected`), not prose
    // panda invents for it. It is terser than a sentence and it is stable,
    // greppable, and the same word the user's editor and every other
    // jsonc-parser consumer already shows them for that fault.
    throw nativeMalformed(
      filePath,
      new Error(`${printParseErrorCode(first.error)} at ${positionOf(body, first.offset)}`),
    )
  }
  if (!root || root.type !== 'object') {
    throw nativeMalformed(filePath, new Error('document root is not an object'))
  }
  return root
}

/**
 * A byte offset as the 1-based `line:column` a user's editor shows.
 *
 * Offset 0 needs no special case and had one until it was measured: there
 * `lastIndexOf('\n', -1)` is -1, the +1 makes `lineStart` 0, and `''.split('\n')`
 * has length 1 — so the general form already answers `line 1, column 1`.
 */
function positionOf(text: string, offset: number): string {
  const bounded = Math.max(0, Math.min(offset, text.length))
  const lineStart = text.lastIndexOf('\n', bounded - 1) + 1
  return `line ${text.slice(0, lineStart).split('\n').length}, column ${bounded - lineStart + 1}`
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

/**
 * A JSON node as a {@link NativeEntryShape} value, or `undefined` when it is
 * neither a string nor an array of them.
 *
 * `undefined` is NOT "absent": it is "panda has no way to carry this", which the
 * caller turns into a reported foreign key. A number, a boolean, a nested object
 * and a mixed array all land here.
 */
function nativeValueOf(node: Node | undefined): string | readonly string[] | undefined {
  if (node === undefined) return undefined
  if (node.type === 'string') return node.value as string
  if (node.type !== 'array') return undefined
  const items = node.children ?? []
  if (!items.every((item) => item.type === 'string')) return undefined
  return items.map((item) => item.value as string)
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

  listEntries(body, traits) {
    const root = parseTree(body)
    const container = root === undefined || root.type !== 'object' ? undefined : memberValue(root, traits.mcpContainerKey)
    // An absent container is E2 — a config panda writes into that holds no
    // servers yet — and is no more an error on the way in than on the way out.
    if (container === undefined || container.type !== 'object') return { entries: [], unreadable: [] }
    const entries: NativeContainerEntry[] = []
    const unreadable: UnreadableNativeMcpEntry[] = []
    for (const property of container.children ?? []) {
      const id = property.children?.[0]?.value
      if (typeof id !== 'string') continue
      const value = property.children?.[1]
      if (value === undefined || value.type !== 'object') {
        unreadable.push({
          id,
          detail: `'${traits.mcpContainerKey}.${id}' holds a ${value?.type ?? 'nothing'} rather than an object, so panda cannot read a command out of it`,
        })
        continue
      }
      const native: Record<string, string | readonly string[]> = {}
      const foreignKeys: string[] = []
      for (const member of value.children ?? []) {
        const key = member.children?.[0]?.value
        if (typeof key !== 'string') continue
        const read = nativeValueOf(member.children?.[1])
        if (read === undefined) foreignKeys.push(key)
        else native[key] = read
      }
      entries.push({ id, native, foreignKeys })
    }
    return { entries, unreadable }
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

  /**
   * ponytail: LINE-ORIENTED, exactly like `locate` above and for the same
   * reason — this is not a TOML parser and does not become one to read. Panda
   * renders every value on one line with `JSON.stringify`, so `JSON.parse` on
   * the value text is that renderer's exact inverse, and anything it cannot
   * parse is REPORTED as unreadable rather than guessed at: a TOML literal
   * string (`command = 'uvx'`), a multi-line array, a trailing comment. Ceiling:
   * panda ingests only entries spelled the way panda writes them. Upgrade path:
   * a real TOML parser, worth it the first time a user reports a legitimate
   * server panda declined to read.
   */
  listEntries(body, traits) {
    const lines = splitLines(body)
    const byId = new Map<string, { native: Record<string, string | readonly string[]>; foreignKeys: string[] }>()
    const unreadable: UnreadableNativeMcpEntry[] = []
    const order: string[] = []

    lines.forEach((line, index) => {
      const path = tomlHeaderPath(line.text)
      if (path === undefined || path.length !== 2 || path[0] !== traits.mcpContainerKey) return
      const id = path[1]!
      // A second `[<container>.<id>]` is the document's own ambiguity, and
      // `entryConflict` is what names it; reading either copy would be picking.
      if (byId.has(id)) return
      const entry = { native: {} as Record<string, string | readonly string[]>, foreignKeys: [] as string[] }
      byId.set(id, entry)
      order.push(id)
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        const text = lines[scan]!.text
        if (startsTable(text)) break
        const trimmed = text.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        const key = tomlAssignmentPath(text)
        const equals = text.indexOf('=')
        if (key === undefined || key.length !== 1 || equals < 0) {
          unreadable.push({
            id,
            detail: `'${traits.mcpContainerKey}.${id}' holds a line panda cannot read as one 'key = value' assignment: ${trimmed}`,
          })
          byId.delete(id)
          order.splice(order.indexOf(id), 1)
          break
        }
        const raw = text.slice(equals + 1).trim()
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          unreadable.push({
            id,
            detail: `'${traits.mcpContainerKey}.${id}.${key[0]!}' is spelled '${raw}', which is not how panda renders a value; panda reports it rather than guessing what it means`,
          })
          byId.delete(id)
          order.splice(order.indexOf(id), 1)
          break
        }
        if (typeof parsed === 'string') entry.native[key[0]!] = parsed
        else if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
          entry.native[key[0]!] = parsed as readonly string[]
        } else entry.foreignKeys.push(key[0]!)
      }
    })

    // A `[<container>.<id>.<sub>]` table ends the region scan above, so its keys
    // would otherwise disappear in silence. It is one of the keys panda cannot
    // represent, and D10 says those are reported.
    for (const line of lines) {
      const path = tomlHeaderPath(line.text)
      if (path === undefined || path.length < 3 || path[0] !== traits.mcpContainerKey) continue
      byId.get(path[1]!)?.foreignKeys.push(path.slice(2).join('.'))
    }

    return {
      entries: order.map((id) => ({ id, native: byId.get(id)!.native, foreignKeys: byId.get(id)!.foreignKeys })),
      unreadable,
    }
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

// --- native -> registry entries (M11.A) --------------------------------------
//
// The read direction, and it goes through the SAME strategy the writer does —
// `validate`, `containerConflict`, `entryConflict` — so a document `parseTree`
// recovers from is refused with its `line:column` by machinery that already
// exists. A second, lenient parse for ingestion would re-open the exact defect
// M7.E closed: panda spliced its own block inside a user's server definition
// because a recovering parser had guessed a tree out of a broken document.

/** One vendor MCP entry, read back into the vocabulary the registry stores. */
export interface NativeMcpEntry {
  readonly id: string
  readonly command: string
  readonly args: readonly string[]
  /** Vendor keys the registry envelope cannot carry; reported, never lost (D10). */
  readonly dropped: readonly string[]
}

/** An id that is present and out of which panda can read no entry, and why. */
export interface UnreadableNativeMcpEntry {
  readonly id: string
  readonly detail: string
}

export interface NativeMcpRead {
  /** The document these were read from — the same path every detail names. */
  readonly filePath: string
  readonly entries: readonly NativeMcpEntry[]
  readonly unreadable: readonly UnreadableNativeMcpEntry[]
  /**
   * The file is THERE and panda could not read it, in the OS's own errno.
   *
   * Distinct from `undefined` (absent, AD-5) and from a throw (malformed, D8):
   * an `EACCES` on one vendor's config is neither "this executor is not
   * installed" nor "this document is broken", and collapsing it into either
   * makes one unreadable file either invisible or fatal to the whole run —
   * including the skills half, which has nothing to do with it.
   */
  readonly unreadableFile?: string
}

/**
 * Every MCP server one vendor's own config file declares, or `undefined` when
 * there is no such file.
 *
 * ABSENCE IS NOT FAILURE (AD-5): an executor is allowed not to be installed, so
 * a missing `~/.codex/config.toml` contributes nothing and is not an error.
 * Everything else is coded and names the path — a malformed document, a
 * container holding something panda cannot address, a file panda may not read.
 */
export async function readNativeMcpEntries(
  traits: ProjectionTargetTraits,
  options: TraitTargetOptions = {},
): Promise<NativeMcpRead | undefined> {
  const filePath = options.filePath ?? traits.defaultPath
  let nativeText: string
  try {
    nativeText = await readFile(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined
    // Reported, not thrown. D2/AD-5 let an executor be unusable, and a file
    // panda may not open is closer to absent than to malformed — but it is not
    // absent either, and silence would tell a user their servers were considered
    // when they never were.
    return { filePath, entries: [], unreadable: [], unreadableFile: code ?? String(error) }
  }
  const strategy = FORMAT_STRATEGIES[traits.fileFormat]
  const body = nativeText.startsWith(BYTE_ORDER_MARK) ? nativeText.slice(1) : nativeText
  // The merge SEEDS a whitespace-only JSON document to `{}` so entries can be
  // added to it. There is nothing in one to read, and validating it would call
  // an empty file malformed — which it is not.
  if (traits.fileFormat === 'jsonc' && body.trim() === '') {
    return { filePath, entries: [], unreadable: [] }
  }
  strategy.validate(body, filePath, traits)
  const conflict = strategy.containerConflict(body, traits)
  if (conflict !== undefined) throw nativeUnclaimable(filePath, conflict)

  const rendered = renderedKeys(traits)
  const listing = strategy.listEntries(body, traits)
  const entries: NativeMcpEntry[] = []
  const unreadable: UnreadableNativeMcpEntry[] = [...listing.unreadable]
  for (const candidate of listing.entries) {
    const ambiguous = strategy.entryConflict(body, traits, candidate.id)
    if (ambiguous !== undefined) {
      unreadable.push({ id: candidate.id, detail: ambiguous })
      continue
    }
    // A key the renderer DOES emit, holding a value no `NativeEntryShape` can
    // carry (`args: ['ok', 7]`), is a value panda cannot READ — not a key panda
    // cannot hold. Reporting it as dropped would silently lose the arguments of
    // a server panda then went on to project, and would blame the wrong thing.
    const unreadableValues = candidate.foreignKeys.filter((key) => rendered.includes(key))
    if (unreadableValues.length > 0) {
      unreadable.push({
        id: candidate.id,
        detail: `'${unreadableValues.join("', '")}' holds a value panda cannot read as a string or a list of strings, and panda will not project a server it read only half of`,
      })
      continue
    }
    const read = traits.readMcpEntry(candidate.native)
    if (!read.ok) {
      unreadable.push({ id: candidate.id, detail: read.detail })
      continue
    }
    entries.push({
      id: candidate.id,
      command: read.command,
      args: read.args,
      // Everything the renderer does not emit, whatever its value type: a user
      // reading this wants what did not travel, not which layer noticed.
      dropped: [...new Set([...droppedNativeKeys(candidate.native, rendered), ...candidate.foreignKeys])].sort(
        (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      ),
    })
  }
  return { filePath, entries, unreadable }
}

// --- correction-01 C6: panda's own prior output ------------------------------
//
// Stories 2.2 and 2.3 wrote panda's OWN vocabulary into vendor files: a reserved
// `$.panda` root key in the JSON family, and a `# BEGIN panda-managed` block in
// Codex's TOML. Not one byte of it is read by any executor, and the Codex form
// is actively harmful — foreign sub-keys inside `[tools]` and `[skills]` make
// the user's whole `config.toml` fail to load under the documented
// `--strict-config`. correction-01 C6 makes removing it part of the correction.
//
// The corrected build cannot reach that state itself, so this is a LOCATOR, not
// a drift verdict: it finds panda's own litter on a machine that ran a previous
// build, and the `discard` remediation removes exactly the region it names. One
// function, used by the report and by the act — a second locator could describe
// a region other than the one removed, which is the whole reason `panda doctor`
// is an inspection mode rather than a copy.

/** The legacy marker the TOML form opens with; also how a reader recognises it. */
const LEGACY_TOML_BEGIN = '# BEGIN panda-managed'
const LEGACY_TOML_END = '# END panda-managed'

/** The JSON-family root key a previous build reserved for itself. */
const LEGACY_JSON_KEY = 'panda'

export interface LegacyPandaBlock {
  /** Half-open range of the ORIGINAL text, byte-order mark included in the offsets. */
  readonly start: number
  readonly end: number
  readonly detail: string
}

/**
 * `block` — panda's own prior output, and exactly what removing it takes out.
 * `refusal` — something that looks like it and panda will not touch, with why.
 * Neither — the file holds none.
 */
export interface LegacyPandaScan {
  readonly block?: LegacyPandaBlock
  readonly refusal?: string
}

/**
 * The sub-keys the invalidated builds wrote under the reserved root key, from
 * correction-01's own evidence table (`$.panda.{tools,mcpServers,skills,hooks}`,
 * plus the grammar version those builds stamped).
 *
 * This list is what makes the JSON side EVIDENCE rather than a name match. A key
 * called `panda` proves nothing — it is a name a user may have chosen, and AD-6
 * is explicit that ownership is never inferred, with a bare key name weaker than
 * the path AD-6 already rules out. So panda claims the key only when its VALUE
 * is an object whose every member is vocabulary a panda build wrote. Anything
 * else is somebody's own configuration: not reported, not removed.
 */
const LEGACY_JSON_MEMBERS = new Set(['version', 'tools', 'mcpServers', 'skills', 'hooks'])

/** Whether this `panda` value is one a previous panda build wrote. */
function isLegacyPandaValue(node: Node | undefined): boolean {
  if (node === undefined || node.type !== 'object') return false
  const members = (node.children ?? []).map((property) => property.children?.[0]?.value)
  if (members.length === 0) return false
  return members.every((name) => typeof name === 'string' && LEGACY_JSON_MEMBERS.has(name))
}

function scanLegacyJson(body: string, shift: number): LegacyPandaScan {
  const root = parseTree(body)
  if (root === undefined || root.type !== 'object') {
    // Not a refusal to report loudly: a file with no object root never held the
    // reserved key, because the build that wrote it spliced into an object.
    return {}
  }
  const properties = memberProperties(root, LEGACY_JSON_KEY)
  const property = properties[0]
  if (property === undefined) return {}
  // Somebody's own `panda` key. Silence is the only correct answer: reporting it
  // would put a `problem` on the exit code for a state panda invented, and the
  // detail would assert a provenance panda cannot know.
  if (!properties.some((candidate) => isLegacyPandaValue(candidate.children?.[1]))) return {}
  if (properties.length > 1) {
    return {
      refusal: `'${LEGACY_JSON_KEY}' is declared ${properties.length} times; panda will not guess which of them it wrote. Leave one and re-run, or remove the block by hand`,
    }
  }
  const span = jsonRemovalSpan(body, { start: property.offset, end: property.offset + property.length })
  return {
    block: {
      start: span.start + shift,
      end: span.end + shift,
      detail: `the reserved '$.${LEGACY_JSON_KEY}' key a previous panda build wrote — every member of it is panda's own vocabulary and no executor reads any of it`,
    },
  }
}

/** The two TOML multi-line string fences, spelled without a literal triple quote. */
const TOML_FENCES = ['"'.repeat(3), "'".repeat(3)] as const

/**
 * The lines that are real TOML lines rather than the interior of a multi-line
 * string.
 *
 * A `# BEGIN panda-managed` inside a multi-line value is three of the USER's own
 * bytes, and matching it deleted them — measured. Panda never PARSES foreign
 * TOML and this does not start: it tracks only the two multi-line fences, which
 * is the whole of what can hide a line-initial `#`. A line inside an open fence
 * is invisible to the marker scan.
 *
 * ponytail: fence counting, not a lexer. A fence sequence inside a single-line
 * basic string would desynchronise it, and the failure direction is that panda
 * stops recognising its OWN block and reports nothing — the safe one. Upgrade
 * path: a real TOML lexer, worth it only if a legacy block is ever found in a
 * file shaped like that.
 */
function tomlCodeLines(lines: readonly TextLine[]): TextLine[] {
  const code: TextLine[] = []
  let open: string | undefined
  for (const line of lines) {
    if (open === undefined) code.push(line)
    let rest = line.text
    for (;;) {
      if (open === undefined) {
        const found = TOML_FENCES.map((fence) => ({ fence, at: rest.indexOf(fence) }))
          .filter((candidate) => candidate.at >= 0)
          .sort((a, b) => a.at - b.at)[0]
        if (found === undefined) break
        open = found.fence
        rest = rest.slice(found.at + found.fence.length)
        continue
      }
      const closes = rest.indexOf(open)
      if (closes < 0) break
      rest = rest.slice(closes + open.length)
      open = undefined
    }
  }
  return code
}

function scanLegacyToml(body: string, shift: number): LegacyPandaScan {
  const lines = tomlCodeLines(splitLines(body))
  const begins = lines.filter((line) => line.text.trimStart().startsWith(LEGACY_TOML_BEGIN))
  if (begins.length === 0) {
    // An END with no BEGIN is a hand-edited remnant panda cannot bound.
    return lines.some((line) => line.text.trimStart().startsWith(LEGACY_TOML_END))
      ? { refusal: `'${LEGACY_TOML_END}' appears with no '${LEGACY_TOML_BEGIN}' before it; panda cannot tell where the block starts. Remove what is left of it by hand` }
      : {}
  }
  if (begins.length > 1) {
    return { refusal: `'${LEGACY_TOML_BEGIN}' appears ${begins.length} times; panda will not guess which block is which. Leave one and re-run, or remove them by hand` }
  }
  const begin = begins[0]!
  const end = lines.find((line) => line.start >= begin.start && line.text.trimStart().startsWith(LEGACY_TOML_END))
  if (end === undefined) {
    return { refusal: `'${LEGACY_TOML_BEGIN}' has no matching '${LEGACY_TOML_END}'; panda cannot tell where the block ends. Remove what is left of it by hand` }
  }
  // Symmetric with how a TOML region panda owns is taken back today
  // (`TOML_STRATEGY.remove`): one blank line separated the appended block from
  // the foreign tail, and removing the block without it leaves that blank behind
  // in every file a previous build wrote one into.
  const eol = lineEndingOf(body)
  const separator = eol + eol
  const separated =
    begin.start >= separator.length &&
    body.slice(begin.start - separator.length, begin.start) === separator
  const start = separated ? begin.start - eol.length : begin.start
  return {
    block: {
      start: start + shift,
      end: end.end + shift,
      detail: `the '${LEGACY_TOML_BEGIN}' block a previous panda build wrote, whose sub-keys under '[tools]' and '[skills]' make this file fail to load under --strict-config`,
    },
  }
}

/**
 * Panda's own prior output in one vendor file, if any is there.
 *
 * READS ONLY. `panda doctor` calls it to report the state and the `discard`
 * remediation calls it to remove exactly the region it returns.
 */
export function scanLegacyPandaBlock(nativeText: string, fileFormat: FileFormat): LegacyPandaScan {
  const hasBom = nativeText.startsWith(BYTE_ORDER_MARK)
  const body = hasBom ? nativeText.slice(1) : nativeText
  const shift = hasBom ? 1 : 0
  return fileFormat === 'toml' ? scanLegacyToml(body, shift) : scanLegacyJson(body, shift)
}

// --- registry -> native entries ---------------------------------------------

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Reduces the registry to the MCP servers every target can express, in stable
 * id order. Kinds this story does not project (skills) and MCP
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
  // Every DECLARED kind this format has no native location for — derived, so a
  // word added to or removed from `REGISTRY_ENTRY_TYPES` cannot leave a stale
  // literal here. (A RETIRED kind never arrives: `groupByKind` has no bucket for
  // one, so it is dropped before any target is asked about it.)
  for (const kind of REGISTRY_ENTRY_TYPES.filter((candidate) => candidate !== 'mcp-server')) {
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
        // M11.A D4 case (ii): the CONFIG half of the SOURCE-IS-THE-DESTINATION
        // verdict `materialise.ts` already reaches for a tree.
        //
        // Deciding `foreign-collision` from EXISTENCE alone made panda report a
        // conflict against a server that already does exactly what the registry
        // asks, and M4.C's "every state has a way out" then offered two bad
        // exits: adopt bytes panda did not write, or delete the user's entry.
        //
        // THE QUESTION HERE IS ABOUT MEANING, NOT BYTES, and that is why this
        // does NOT reuse `stillPandas`. `stillPandas` asks "are these the bytes
        // panda WROTE?", where a hash is the right instrument. This asks "does
        // this FOREIGN entry already deliver what the registry says?", and a
        // hash answers that only when the user happened to spell panda's exact
        // key set — measured by driving the binary: `{"command":"npx"}`, a
        // missing `type`, and an entry carrying `env` each reported a collision
        // while running precisely the right server. So the comparison is the
        // trait's own INVERSE: read the native entry back and compare what runs.
        // Keys panda cannot represent are ignored rather than counted against
        // it, which is the same answer the reader gives when it ingests such an
        // entry and reports the key dropped — the two halves of the story now
        // agree. Being value-based it is also format-independent by
        // construction, so key order, spacing and comments stop mattering
        // without a second canonicaliser to keep in step.
        //
        // ponytail: `listEntries` walks the whole container to answer about one
        // id, so a merge is O(entries^2) in the container size. Vendor configs
        // hold a handful of servers; upgrade path is a `readEntry(body, id)` on
        // the strategy if a container ever grows big enough to measure.
        const native = strategy.listEntries(body, traits).entries.find((item) => item.id === entry.id)
        const read = native === undefined ? undefined : traits.readMcpEntry(native.native)
        if (
          read?.ok === true &&
          read.command === entry.command &&
          read.args.length === entry.args.length &&
          read.args.every((argument, index) => argument === entry.args[index])
        ) {
          // ALREADY SATISFIED: nothing written, nothing claimed, no drift.
          //
          // NOT ADOPTED, and that is the load-bearing half — the reason
          // `materialise.ts` gives for its twin holds verbatim here: panda did
          // not write these bytes, so claiming them would hand the release
          // remediation an authority to delete a server the user owns. An
          // unclaimed entry is also never in the removal path above, which
          // needs a ledger record to reach.
          //
          // Degrades correctly in both directions: change what the entry RUNS
          // and it is a foreign collision again, which is true.
          continue
        }
        drift.push(
          drifted(
            'foreign-collision',
            traits,
            entry.id,
            `'${entry.id}' already exists in '${filePath}' and does not run what the registry says it should, and panda's ledger does not claim it; panda will not resolve the collision`,
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
 * What currently occupies ONE entry's native location, expressed as the ledger
 * record that would claim it — the target's half of `adopt`.
 *
 * Every predicate below is the merge's own, called on the same text through the
 * same strategy: `entryConflict` for a location the document spells twice,
 * `locate` for the region, and `hashOwnedText(strategy.canonical(...))` for the
 * hash. That is not tidiness. An adopted record whose hash were computed any
 * other way would fail `stillPandas` on the very next run and the entry would
 * report `edited` forever — the exact state adoption exists to leave.
 *
 * Every failure is a REFUSAL rather than a throw. A malformed vendor file, an
 * unclaimable container, a duplicated key: each is a reason panda will not take
 * ownership, and the caller has to be able to print it beside the entry.
 */
function claimNative(
  request: ProjectionClaimRequest,
  filePath: string,
  traits: ProjectionTargetTraits,
): ProjectionClaim {
  const strategy = FORMAT_STRATEGIES[traits.fileFormat]
  const location = nativeLocationOf(traits, request.entryId)
  const refuse = (refusal: string): ProjectionClaim => ({ location, byteLength: 0, refusal })
  if (UNPROJECTABLE_ENTRY_IDS.has(request.entryId)) {
    return refuse(`'${request.entryId}' cannot be used as a native config key`)
  }
  const hasBom = request.nativeText.startsWith(BYTE_ORDER_MARK)
  // NOT seeded to '{}' the way the merge seeds an empty document: seeding
  // invents a document so entries can be ADDED to it, and there is nothing to
  // adopt in a file that does not exist.
  const body = hasBom ? request.nativeText.slice(1) : request.nativeText
  try {
    strategy.validate(body, filePath, traits)
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  const conflict =
    strategy.containerConflict(body, traits) ?? strategy.entryConflict(body, traits, request.entryId)
  // The refusal has to be ACTIONABLE. This is the shape where every panda verb
  // declines — `adopt` on the ambiguity, `release` because a foreign collision
  // holds no claim to drop — so the sentence has to name the thing that does
  // leave it, which is the user's own edit of their own file. Panda's ledger is
  // not involved and saying so is half the answer.
  if (conflict !== undefined) {
    return refuse(
      `${conflict}. Panda holds no claim here, so no remediation applies: resolve the ambiguity in '${filePath}' itself and re-run`,
    )
  }
  const existing = strategy.locate(body, traits, request.entryId)
  if (existing === undefined) return { location, byteLength: 0 }
  const owned = body.slice(existing.start, existing.end)
  return {
    location,
    byteLength: Buffer.byteLength(owned, 'utf8'),
    // `ownedPaths` deliberately omitted: a config claim authorises replacing one
    // REGION inside this file and can never remove the file, so there is no path
    // a later run gains delete authority over.
    record: {
      targetId: traits.targetId,
      filePath: resolveOwnedPath(filePath),
      nativeLocation: location,
      entryId: request.entryId,
      contentHash: hashOwnedText(strategy.canonical(owned)),
    },
  }
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
    claim(request: ProjectionClaimRequest): ProjectionClaim {
      return claimNative(request, filePath, traits)
    },
  }
}
