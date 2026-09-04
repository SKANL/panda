type SqliteModule = typeof import('node:sqlite')

let pending: Promise<SqliteModule> | undefined

/**
 * Loads `node:sqlite` LAZILY and with its experimental warning confined.
 *
 * Two facts, both measured on Node 24.14.1 (the version CI runs):
 *
 * 1. The warning fires when the MODULE LOADS, not when a database is opened. A
 *    static `import { DatabaseSync } from 'node:sqlite'` therefore prints
 *    `ExperimentalWarning: SQLite is an experimental feature and might change at
 *    any time` on stderr the moment anything imports this package — including a
 *    consumer that never touches a store. stderr is a contract surface for
 *    `panda run`, so that is panda's output, not SQLite's.
 * 2. `process.emitWarning` is where it comes out, and the emission lands during
 *    the awaited import (Node schedules it on `process.nextTick`, which drains
 *    before this function's continuation). So a patch installed around the
 *    import and removed after it catches exactly that warning and nothing else.
 *
 * Both halves are applied because they answer different questions: the lazy
 * import means nothing loads until a consumer actually opens a store, and the
 * confinement means opening one is silent too. The filter is narrow — the type
 * AND the text — so any other warning, experimental or not, still reaches the
 * user. `packages/memory-sqlite/test/load-sqlite.test.ts` drives that with a
 * control warning that must survive.
 *
 * ponytail: the patch is a global mutation, held for the duration of ONE
 * memoised import. Ceiling: a warning emitted by unrelated code inside that
 * window is still handed to the original emitter, but a concurrent patcher that
 * replaces `process.emitWarning` in the same window would have its replacement
 * restored away — which is why the restore checks that the function it is
 * replacing is still ours. Upgrade path: delete this file's body down to a plain
 * `import('node:sqlite')` the release `node:sqlite` stops being experimental in.
 */
export function loadSqlite(): Promise<SqliteModule> {
  pending ??= importWithWarningConfined()
  return pending
}

async function importWithWarningConfined(): Promise<SqliteModule> {
  const original = process.emitWarning
  const patched = (warning: string | Error, ...rest: unknown[]): void => {
    const first = rest[0]
    const type = typeof first === 'string' ? first : (first as { type?: unknown } | undefined)?.type
    const text = typeof warning === 'string' ? warning : warning.message
    if (type === 'ExperimentalWarning' && text.includes('SQLite')) return
    ;(original as unknown as (...args: unknown[]) => void).call(process, warning, ...rest)
  }
  process.emitWarning = patched as unknown as typeof process.emitWarning
  try {
    return await import('node:sqlite')
  } finally {
    if ((process.emitWarning as unknown) === (patched as unknown)) process.emitWarning = original
  }
}
