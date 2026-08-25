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
  expandRegistryEntryPaths,
  isRegistryScopeValue,
  normalizeRegistryEntryPaths,
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
    expect(validateRegistryEntry({ type: 'tool', id: 'demo', command: 'demo --run' })).toEqual({
      type: 'tool',
      id: 'demo',
      command: 'demo --run',
    })
    expect(
      validateRegistryEntry({ type: 'mcp-server', id: 'demo', command: 'npx', args: ['-y', 'demo'] }),
    ).toEqual({ type: 'mcp-server', id: 'demo', command: 'npx', args: ['-y', 'demo'] })
  })

  it('rejects non-objects and missing required fields naming each one', () => {
    expect(registryEntryIssues(null)).toEqual([{ message: 'registry entry must be an object' }])
    expect(registryEntryIssues({})).toEqual([
      { message: "'type' must be one of: tool, skill, mcp-server, profile" },
      { message: "'id' must be a non-empty string" },
    ])
    expect(registryEntryIssues({ type: 'tool', id: '' })).toEqual([
      { message: "'id' must be a non-empty string" },
    ])
    expect(registryEntryIssues({ type: 'skill', id: 'x', entryPath: 42 })).toEqual([
      { message: "'entryPath' must be a non-empty string when present" },
    ])
    expect(registryEntryIssues({ type: 'mcp-server', id: 'x', args: ['ok', ''] })).toEqual([
      { message: "'args' must be an array of non-empty strings when present" },
    ])
  })

  it('rejects unknown root keys naming the extensions rule', () => {
    const issues = registryEntryIssues({ type: 'tool', id: 'demo', model: 'sonnet' })
    expect(issues).toEqual([
      {
        message:
          "'model' is not allowed at the entry root; provider-specific payloads belong under the reserved 'extensions' namespace",
      },
    ])
    try {
      validateRegistryEntry({ type: 'tool', id: 'demo', model: 'sonnet' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PandaError)
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryInvalidEntry)
      expect((error as PandaError).message).toContain("'model'")
    }
  })

  it('rejects a malformed extensions namespace', () => {
    expect(registryEntryIssues({ type: 'tool', id: 'demo', extensions: ['nope'] })).toEqual([
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
    expect(REGISTRY_PATH_FIELDS['tool']).toEqual(['command'])
    expect(REGISTRY_PATH_FIELDS['skill']).toEqual(['entryPath'])
    expect(REGISTRY_PATH_FIELDS['mcp-server']).toEqual(['command', 'args'])
    expect(REGISTRY_PATH_FIELDS['profile']).toEqual([])
  })

  it('normalizes absolute-under-home values in designated fields and expands them back losslessly', () => {
    const underHome = join(home, 'bin', 'demo.exe')
    const entry: RegistryEntry = { type: 'tool', id: '~demo', command: underHome }

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
    const entry: RegistryEntry = { type: 'tool', id: 'demo', command: home }
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
      expect(normalizeRegistryEntryPaths({ type: 'tool', id: 'x', command: opaque } satisfies RegistryEntry, home).command).toBe(opaque)
      return
    }
    const underSwapped = join(swapped, 'bin', 'demo.exe')
    const normalized = normalizeRegistryEntryPaths(
      { type: 'tool', id: 'x', command: underSwapped } satisfies RegistryEntry,
      home,
    )
    expect(normalized.command!.startsWith('~/')).toBe(true)
    // Expanding restores the REAL home casing; only the match folded case.
    expect(expandRegistryEntryPaths(normalized, home).command).toBe(join(home, 'bin', 'demo.exe'))
  })
})
