import type { ParseError } from 'jsonc-parser'
import { parseTree, printParseErrorCode } from 'jsonc-parser'

/**
 * ONE rule, in one place, for every document this package parses (Spec M17.A):
 * **no error panda raises about a document quotes that document's content.**
 *
 * The hazard is not hypothetical and not confined to vendor files. V8's
 * `JSON.parse` puts a window of the SOURCE TEXT in its message for the shapes it
 * cannot give a position for — a stray comma before an array element and a `NaN`
 * literal — and the documents panda parses are where MCP server arguments live,
 * which is where an API token lives. Measured through the shipped binary at
 * `4232e9c`: a credential planted next to the fault reached stdout from
 * `~/.claude.json` AND from `.panda/registry.json`.
 *
 * The message cannot be TRIMMED to its location, because the shapes that quote
 * the document are exactly the ones carrying no position. So it is dropped
 * whole, the `cause` goes with it — a cause is reachable from any printed stack,
 * so keeping it would move the leak rather than close it — and panda derives its
 * own location from `jsonc-parser`'s offsets.
 *
 * ponytail: `@skanl/panda-registry` carries its own copy of this, because AD-2 forbids
 * the edge that would let it import this one and `@skanl/panda-contracts` must stay
 * dependency-free for the third-party promise. Ceiling: two copies to keep in
 * step. Upgrade path: a shared dependency-free leaf package, worth it the first
 * time a third package needs it.
 */

/** What panda says when it cannot derive a location — never the parser's text. */
export const FAULT_UNLOCATED = 'the fault could not be located'

/**
 * A byte offset as the 1-based `line:column` a user's editor shows.
 *
 * Offset 0 needs no special case and had one until it was measured: there
 * `lastIndexOf('\n', -1)` is -1, the +1 makes `lineStart` 0, and `''.split('\n')`
 * has length 1 — so the general form already answers `line 1, column 1`.
 */
export function positionOf(text: string, offset: number): string {
  const bounded = Math.max(0, Math.min(offset, text.length))
  const lineStart = text.lastIndexOf('\n', bounded - 1) + 1
  return `line ${text.slice(0, lineStart).split('\n').length}, column ${bounded - lineStart + 1}`
}

/**
 * The parser's own CODE plus panda's `line:column`, from a collected offset.
 *
 * The code (`InvalidSymbol`, `PropertyNameExpected`) is the parser's, not prose
 * panda invents: it is terser than a sentence, and it is the same word the
 * user's editor and every other jsonc-parser consumer already shows them. It
 * names the FAULT; it never carries a byte of the document.
 */
export function faultDetail(body: string, error: ParseError | undefined): string {
  return error === undefined
    ? FAULT_UNLOCATED
    : `${printParseErrorCode(error.error)} at ${positionOf(body, error.offset)}`
}

/**
 * Re-locates a fault `JSON.parse` refused, using `jsonc-parser`'s OFFSETS — not
 * a second parser, and not a regex over V8's message.
 *
 * The options are strict-JSON semantics exactly: trailing commas are errors (the
 * default) and so are comments, so nearly every document V8 rejects collects an
 * offset here. Where none is collected, the caller still refuses; it just cannot
 * say where.
 *
 * `parseTree` RECURSES, and it was measured throwing `RangeError` on a document
 * nested past ~5000 levels that V8 also rejects — so the throw is reachable from
 * here. It is caught rather than propagated, because losing the location is the
 * documented outcome and losing the CODED error is not.
 */
export function strictFaultLocation(body: string): string {
  const errors: ParseError[] = []
  try {
    parseTree(body, errors, { disallowComments: true })
  } catch {
    return FAULT_UNLOCATED
  }
  // The FIRST only. A recovering parser cascades — an unquoted key reports four
  // — and the rest are that one's shadow.
  return faultDetail(body, errors[0])
}
