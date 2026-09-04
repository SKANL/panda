import type { ParseError } from 'jsonc-parser'
import { parseTree, printParseErrorCode } from 'jsonc-parser'

/**
 * ONE rule, for every document this package parses (Spec M17.A):
 * **no error panda raises about a document quotes that document's content.**
 *
 * `.panda/registry.json` is THE document that holds `mcp-server` args, which is
 * where an API token lives, and V8's `JSON.parse` puts a window of the SOURCE
 * TEXT in its message for the shapes it cannot give a position for — a stray
 * comma before an array element, a `NaN` literal. Measured through the shipped
 * binary: with a credential adjacent to the fault, `panda list`, `panda doctor`
 * and `panda init` all printed it, and `panda import` printed it out of a
 * bundle. The spec's first pass recorded this document as clean because the
 * probe put the credential far from the fault — outside the fixed window, which
 * measures the window rather than the code.
 *
 * The message cannot be TRIMMED to its location, because the shapes that quote
 * the document are exactly the ones carrying no position. So it is dropped
 * whole, the `cause` goes with it — a cause is reachable from any printed stack
 * — and panda derives its own location from `jsonc-parser`'s offsets.
 *
 * ponytail: `@panda/projection` carries the same three functions, because AD-2
 * forbids an edge between these packages in either direction and
 * `@panda/contracts` must stay dependency-free for the third-party promise.
 * Ceiling: two copies to keep in step, pinned by one gate that drives both.
 * Upgrade path: a shared dependency-free leaf package, worth it the first time a
 * third package needs it.
 */

/** What panda says when it cannot derive a location — never the parser's text. */
export const FAULT_UNLOCATED = 'the fault could not be located'

/**
 * A byte offset as the 1-based `line:column` a user's editor shows. Offset 0
 * needs no special case: `lastIndexOf('\n', -1)` is -1, the +1 makes `lineStart`
 * 0, and `''.split('\n')` has length 1.
 */
function positionOf(text: string, offset: number): string {
  const bounded = Math.max(0, Math.min(offset, text.length))
  const lineStart = text.lastIndexOf('\n', bounded - 1) + 1
  return `line ${text.slice(0, lineStart).split('\n').length}, column ${bounded - lineStart + 1}`
}

/**
 * Re-locates a fault `JSON.parse` refused, from `jsonc-parser`'s OFFSETS — not a
 * regex over V8's message, which is the string the credential travelled in.
 *
 * `disallowComments` makes this strict-JSON semantics exactly (trailing commas
 * are already errors by default), so nearly every document V8 rejects collects
 * an offset. `parseTree` RECURSES and throws `RangeError` past ~5000 nesting
 * levels on documents V8 also rejects, so the throw is reachable: it is caught,
 * because losing the location is the documented outcome and losing the CODED
 * error is not.
 */
export function strictFaultLocation(body: string): string {
  const errors: ParseError[] = []
  try {
    parseTree(body, errors, { disallowComments: true })
  } catch {
    return FAULT_UNLOCATED
  }
  // The FIRST only. A recovering parser cascades and the rest are its shadow.
  // The parser's own CODE (`InvalidSymbol`, `PropertyNameExpected`) names the
  // fault without carrying a byte of the document.
  const first = errors[0]
  return first === undefined
    ? FAULT_UNLOCATED
    : `${printParseErrorCode(first.error)} at ${positionOf(body, first.offset)}`
}
