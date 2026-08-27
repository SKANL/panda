import { homedir } from 'node:os'
import { sep, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PANDA_ERROR_CODES,
  PandaError,
  REGISTRY_ENTRY_SCHEMA,
  REGISTRY_ENTRY_TYPES,
  REGISTRY_PATH_FIELDS,
  REGISTRY_SCOPES,
  REMOVABLE_ENTRY_TYPES,
  RETIRED_ENTRY_TYPES,
  RETIRED_PATH_FIELDS,
  UNPROJECTABLE_ENTRY_IDS,
  expandRegistryEntryPaths,
  isRegistryScopeValue,
  isRetiredEntryType,
  normalizeRegistryEntryPaths,
  pathFieldsFor,
  registryEntryIssues,
  validateRegistryEntry,
  validateRegistryScope,
} from '../src'
import type { RegistryEntry } from '../src'

describe('canonical registry entry envelopes', () => {
  it('accepts a valid entry of every canonical type', () => {
    for (const type of REGISTRY_ENTRY_TYPES) {
      expect(validateRegistryEntry({ type, id: 'demo' })).toEqual({ type, id: 'demo' })
    }
    expect(
      validateRegistryEntry({ type: 'mcp-server', id: 'demo', command: 'npx', args: ['-y', 'demo'] }),
    ).toEqual({ type: 'mcp-server', id: 'demo', command: 'npx', args: ['-y', 'demo'] })
  })

  it('rejects non-objects and missing required fields naming each one', () => {
    expect(registryEntryIssues(null)).toEqual([{ message: 'registry entry must be an object' }])
    expect(registryEntryIssues({})).toEqual([
      { message: "'type' must be one of: skill, mcp-server" },
      { message: "'id' must be a non-empty string" },
    ])
    expect(registryEntryIssues({ type: 'mcp-server', id: '' })).toEqual([
      { message: "'id' must be a non-empty string" },
    ])
    expect(registryEntryIssues({ type: 'skill', id: 'x', entryPath: 42 })).toEqual([
      { message: "'entryPath' must be a non-empty string when present" },
    ])
    expect(registryEntryIssues({ type: 'mcp-server', id: 'x', args: ['ok', ''] })).toEqual([
      { message: "'args' must be an array of non-empty strings when present" },
    ])
  })

  it('rejects a well-formed field that belongs to a DIFFERENT entry type', () => {
    // The rule lives at the envelope, derived from `REGISTRY_PATH_FIELDS`, so
    // the only table saying which field suits which type is the one that already
    // existed. A caller — `panda add`, an ingest provider — holding a second
    // copy of it would drift from this one, which is the whole reason it is
    // here: an `mcp-server` carrying an `entryPath` used to persist and then be
    // silently ignored by every projection target.
    //
    // Derived over the whole matrix rather than spot-checked, so a type whose
    // fields change upstream is answered for here or this goes red.
    for (const type of REGISTRY_ENTRY_TYPES) {
      for (const field of ['command', 'entryPath', 'args'] as const) {
        const value = field === 'args' ? ['x'] : 'x'
        const issues = registryEntryIssues({ type, id: 'demo', [field]: value })
        if (REGISTRY_PATH_FIELDS[type].includes(field)) {
          expect(issues, `${type}.${field}`).toEqual([])
          continue
        }
        expect(issues.map((issue) => issue.message), `${type}.${field}`).toEqual([
          expect.stringContaining(`'${field}' does not belong on a '${type}' entry`),
        ])
      }
    }
    // The reserved namespace is unaffected: a provider payload is not a field.
    expect(registryEntryIssues({ type: 'skill', id: 'p', extensions: { vendor: {} } })).toEqual([])
  })

  it('rejects ids that can never become a projected key', () => {
    // The guard lives here, at the envelope, because every registration path
    // routes through it: an unprojectable id that reaches the store makes
    // EVERY projection target fail permanently.
    for (const id of UNPROJECTABLE_ENTRY_IDS) {
      expect(registryEntryIssues({ type: 'mcp-server', id })).toEqual([
        { message: `'id' must not be '${id}': it can never be used as a projected key` },
      ])
    }
    expect(registryEntryIssues({ type: 'mcp-server', id: 'constructor-ish' })).toEqual([])
  })

  it('rejects unknown root keys naming the extensions rule', () => {
    const issues = registryEntryIssues({ type: 'mcp-server', id: 'demo', model: 'sonnet' })
    expect(issues).toEqual([
      {
        message:
          "'model' is not allowed at the entry root; provider-specific payloads belong under the reserved 'extensions' namespace",
      },
    ])
    try {
      validateRegistryEntry({ type: 'mcp-server', id: 'demo', model: 'sonnet' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PandaError)
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryInvalidEntry)
      expect((error as PandaError).message).toContain("'model'")
    }
  })

  it('rejects a malformed extensions namespace', () => {
    expect(registryEntryIssues({ type: 'mcp-server', id: 'demo', extensions: ['nope'] })).toEqual([
      { message: "'extensions' must be an object when present" },
    ])
  })

  it('exposes the envelope through Standard Schema v1', () => {
    expect(REGISTRY_ENTRY_SCHEMA['~standard'].version).toBe(1)
    expect(REGISTRY_ENTRY_SCHEMA['~standard'].validate({ type: 'skill', id: 'x' })).toEqual({
      value: { type: 'skill', id: 'x' },
    })
    const invalid = REGISTRY_ENTRY_SCHEMA['~standard'].validate({ type: 'skill', id: 'x', extra: true })
    if (!(invalid instanceof Promise)) {
      expect(invalid.issues).toHaveLength(1)
    }
  })

  it('validates the scope vocabulary with a coded error naming the field', () => {
    for (const scope of REGISTRY_SCOPES) expect(isRegistryScopeValue(scope)).toBe(true)
    expect(() => validateRegistryScope('tenant')).toThrow(/'scope'/)
    try {
      validateRegistryScope('tenant')
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryInvalidEntry)
    }
  })

  it('pins the registry codes to the canonical constants AND their verbatim literals', () => {
    // Dual assertion is deliberate drift detection, mirroring kernel-code-parity.
    expect(PANDA_ERROR_CODES.registryInvalidEntry).toBe('PANDA_REGISTRY_INVALID_ENTRY')
    expect(PANDA_ERROR_CODES.registryContention).toBe('PANDA_REGISTRY_CONTENTION')
    expect(PANDA_ERROR_CODES.registryStoreUnavailable).toBe('PANDA_REGISTRY_STORE_UNAVAILABLE')
    expect(PANDA_ERROR_CODES.registryInactive).toBe('PANDA_REGISTRY_INACTIVE')
  })
})

describe('write-time path normalization (declared path fields only)', () => {
  const home = homedir()

  it('declares the per-type path-field allowlist', () => {
    expect(REGISTRY_PATH_FIELDS['skill']).toEqual(['entryPath'])
    expect(REGISTRY_PATH_FIELDS['mcp-server']).toEqual(['command', 'args'])
  })

  it('normalizes absolute-under-home values in designated fields and expands them back losslessly', () => {
    const underHome = join(home, 'bin', 'demo.exe')
    const entry: RegistryEntry = { type: 'mcp-server', id: '~demo', command: underHome }

    const normalized = normalizeRegistryEntryPaths(entry, home)
    expect(normalized.id).toBe('~demo')
    expect(normalized.command).not.toContain(home)
    expect(normalized.command!.startsWith('~/')).toBe(true)

    expect(expandRegistryEntryPaths(normalized, home)).toEqual(entry)
  })

  it('normalizes array-valued path fields recursively', () => {
    const arg = join(home, 'config', 'server.json')
    const entry: RegistryEntry = { type: 'mcp-server', id: 'demo', command: 'serve', args: ['--config', arg] }
    const normalized = normalizeRegistryEntryPaths(entry, home)
    expect(normalized.args).toEqual(['--config', `~/${join('config', 'server.json')}`])
    expect(expandRegistryEntryPaths(normalized, home)).toEqual(entry)
  })

  it('leaves ids and extension payloads verbatim even when they look like paths', () => {
    const entry: RegistryEntry = {
      type: 'skill',
      id: '~/looks-like-a-path',
      extensions: { notes: '~/notes.txt' },
    }
    expect(normalizeRegistryEntryPaths(entry, home)).toEqual(entry)
  })

  it('escapes literal leading tildes in designated fields so the round trip is lossless', () => {
    const literal = '~/relative-but-literal'
    const entry: RegistryEntry = { type: 'skill', id: 'demo', entryPath: literal }

    const normalized = normalizeRegistryEntryPaths(entry, home)
    expect(normalized.entryPath).toBe('~~' + literal.slice(1))
    expect(expandRegistryEntryPaths(normalized, home).entryPath).toBe(literal)
  })

  it('expands a bare ~ marker back to the exact home directory', () => {
    const entry: RegistryEntry = { type: 'mcp-server', id: 'demo', command: home }
    expect(expandRegistryEntryPaths(normalizeRegistryEntryPaths(entry, home), home)).toEqual(entry)
  })

  it('matches the home prefix case-insensitively on win32 only', () => {
    const swapped = home
      .split(sep)
      .map((part) => (part === part.toLowerCase() ? part.toUpperCase() : part.toLowerCase()))
      .join(sep)
    if (process.platform !== 'win32') {
      // posix comparison stays case-sensitive: swapped casing is just an opaque path.
      const opaque = join(swapped, 'bin', 'demo.exe')
      expect(normalizeRegistryEntryPaths({ type: 'mcp-server', id: 'x', command: opaque } satisfies RegistryEntry, home).command).toBe(opaque)
      return
    }
    const underSwapped = join(swapped, 'bin', 'demo.exe')
    const normalized = normalizeRegistryEntryPaths(
      { type: 'mcp-server', id: 'x', command: underSwapped } satisfies RegistryEntry,
      home,
    )
    expect(normalized.command!.startsWith('~/')).toBe(true)
    // Expanding restores the REAL home casing; only the match folded case.
    expect(expandRegistryEntryPaths(normalized, home).command).toBe(join(home, 'bin', 'demo.exe'))
  })
})

// Story M4.E. `tool` was removed from the vocabulary because no executor has a
// non-MCP location for it — and removing a word must not turn a registry that
// already holds one into an unreadable store. The read path therefore RECOGNISES
// the retired word; the frozen Ask-First clause of that story says recognising
// it may not become a relaxation of validation, which is what the second half of
// this block asserts one rule at a time.
//
// Story M4.F retired `profile` through the SAME machinery and added no mechanism
// to do it, which is what a second member is for: a mechanism exercised once is
// one that happens to work. Every assertion below that names `tool` has a
// `profile` sibling, and the fieldless case is the one `tool` could not reach.
describe('a retired entry type stays readable without weakening the envelope', () => {
  const stored = { type: 'tool', id: 'rg', command: 'rg' }

  it('is no longer part of the vocabulary panda declares', () => {
    expect(REGISTRY_ENTRY_TYPES).toEqual(['skill', 'mcp-server'])
    expect(REGISTRY_ENTRY_TYPES).not.toContain('tool')
    expect(REGISTRY_ENTRY_TYPES).not.toContain('profile')
    expect(RETIRED_ENTRY_TYPES).toEqual(['tool', 'profile'])
    expect(isRetiredEntryType('tool')).toBe(true)
    expect(isRetiredEntryType('profile')).toBe(true)
    expect(isRetiredEntryType('mcp-server')).toBe(false)
    // The two lists together are what `panda remove` accepts, and the ORDER puts
    // the declared words first so a usage message reads sensibly.
    expect(REMOVABLE_ENTRY_TYPES).toEqual([...REGISTRY_ENTRY_TYPES, ...RETIRED_ENTRY_TYPES])
  })

  it('is refused by every WRITE path, so nothing can create one again', () => {
    for (const type of RETIRED_ENTRY_TYPES) {
      expect(registryEntryIssues({ type, id: 'demo' }), type).toEqual([
        { message: "'type' must be one of: skill, mcp-server" },
      ])
      try {
        validateRegistryEntry({ type, id: 'demo' })
        expect.unreachable()
      } catch (error) {
        expect((error as PandaError).code, type).toBe(PANDA_ERROR_CODES.registryInvalidEntry)
      }
    }
  })

  it('is accepted by the READ path, with the fields it carried while it was live', () => {
    expect(registryEntryIssues(stored, true)).toEqual([])
    expect(RETIRED_PATH_FIELDS['tool']).toEqual(['command'])
    expect(pathFieldsFor('tool')).toEqual(['command'])
    // A retired type that carried NOTHING is the case `tool` cannot exercise: a
    // Profile is a selection OVER entries, so it never had a leaf field, and the
    // read path has to admit the bare envelope rather than demand one.
    expect(registryEntryIssues({ type: 'profile', id: 'frontend' }, true)).toEqual([])
    expect(RETIRED_PATH_FIELDS['profile']).toEqual([])
    expect(pathFieldsFor('profile')).toEqual([])
    // The one that would throw rather than misreport: a retired entry indexed
    // against the DECLARED record yields `undefined`, and iterating it dies.
    expect(pathFieldsFor('mcp-server')).toEqual(REGISTRY_PATH_FIELDS['mcp-server'])
  })

  it('still round-trips its declared path field through home normalization', () => {
    const home = homedir()
    const entry = { type: 'tool', id: 'localfmt', command: join(home, 'bin', 'fmt.exe') } as RegistryEntry
    const normalized = normalizeRegistryEntryPaths(entry, home)
    expect(normalized.command).toBe(`~/${join('bin', 'fmt.exe')}`)
    expect(expandRegistryEntryPaths(normalized, home)).toEqual(entry)
  })

  it('admits the retired WORD and nothing else — every other rule still rejects', () => {
    // Each row is one rule of the envelope, asserted UNDER `admitRetired`. If
    // recognising `tool` had been implemented as leniency, these would pass.
    const cases: [string, unknown, string][] = [
      ['a field belonging to another type', { type: 'tool', id: 'rg', entryPath: './x' }, "'entryPath' does not belong on a 'tool' entry"],
      ['a genuinely unknown type', { type: 'gadget', id: 'rg' }, "'type' must be one of"],
      ['a missing id', { type: 'tool' }, "'id' must be a non-empty string"],
      ['an unprojectable id', { type: 'tool', id: '__proto__' }, 'it can never be used as a projected key'],
      ['a mistyped field', { type: 'tool', id: 'rg', command: 42 }, "'command' must be a non-empty string when present"],
      ['an unknown root key', { type: 'tool', id: 'rg', model: 'sonnet' }, "'model' is not allowed at the entry root"],
      ['a non-object', 'tool', 'registry entry must be an object'],
      ['a field on a fieldless retired type', { type: 'profile', id: 'frontend', command: 'x' }, "'command' does not belong on a 'profile' entry; a 'profile' entry carries no field beyond 'type' and 'id'"],
      ['a fieldless retired type with a missing id', { type: 'profile' }, "'id' must be a non-empty string"],
      ['a fieldless retired type with an unknown root key', { type: 'profile', id: 'p', model: 'sonnet' }, "'model' is not allowed at the entry root"],
    ]
    for (const [label, value, expected] of cases) {
      const issues = registryEntryIssues(value, true)
      expect(issues.length, label).toBeGreaterThan(0)
      expect(issues.map((issue) => issue.message).join('; '), label).toContain(expected)
    }
  })

  // The hazard M4.E's own review recorded, asserted rather than reasoned about:
  // `KNOWN_ROOT_KEYS` is derived from the union of the live AND retired field
  // lists, so a retired type whose field no live type still declares stays a
  // KNOWN root key. Were it hand-written, that entry would fail the
  // unknown-root-key rule, and one failing entry fails the WHOLE store — the
  // M4.C dead end inside the mechanism built to abolish it. Derived over the
  // whole table so the next retirement is covered without editing this.
  it('keeps every field a retired type carried a KNOWN root key', () => {
    for (const [type, fields] of Object.entries(RETIRED_PATH_FIELDS)) {
      for (const field of fields) {
        const value = field === 'args' ? ['x'] : 'x'
        expect(registryEntryIssues({ type, id: 'demo', [field]: value }, true), `${type}.${field}`).toEqual([])
      }
    }
  })
})
