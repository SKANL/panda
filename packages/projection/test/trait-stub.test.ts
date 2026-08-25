import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import { createProjectionTargetFromTraits } from '../src/formats.ts'
import type { ProjectionTargetTraits } from '../src/formats.ts'
import { runProjectionClauseSuite } from './clause-suite.ts'

// FR-8 strategy isolation, PROVEN: these trait records are brand new — no
// existing target, engine, or strategy code was touched — and the factory
// turns each one into a working target that passes the SAME shared clause
// suite as the shipped targets.

const STUB_JSONC_TRAITS: ProjectionTargetTraits = {
  targetId: 'stub-jsonc-target',
  fileFormat: 'jsonc',
  defaultPath: '/unused/stub.json',
  mcpContainerKey: 'servers',
  renderMcpEntry: (entry) => ({ run: entry.command, argv: entry.args }),
}

const STUB_TOML_TRAITS: ProjectionTargetTraits = {
  targetId: 'stub-toml-target',
  fileFormat: 'toml',
  defaultPath: '/unused/stub.toml',
  mcpContainerKey: 'servers',
  renderMcpEntry: (entry) => ({ run: entry.command, argv: entry.args }),
}

const JSONC_SAMPLE = `{
      "userKey": "user-value",
  "nested": {"kept": true},
}
`

const TOML_SAMPLE = `# user table
flag = true

[foreign]
value = "kept"
`

runProjectionClauseSuite([
  {
    label: 'trait-only stub (jsonc)',
    makeTarget: (homeDir) =>
      createProjectionTargetFromTraits(STUB_JSONC_TRAITS, { filePath: join(homeDir, 'stub.json') }),
    sampleNative: JSONC_SAMPLE,
    foreignSentinels: ['"userKey": "user-value"', '"kept": true'],
    supportsMalformedIsolation: true,
    malformedSample: '42',
  },
  {
    label: 'trait-only stub (toml)',
    makeTarget: (homeDir) =>
      createProjectionTargetFromTraits(STUB_TOML_TRAITS, { filePath: join(homeDir, 'stub.toml') }),
    sampleNative: TOML_SAMPLE,
    foreignSentinels: ['# user table', 'flag = true', '[foreign]', 'value = "kept"'],
    supportsMalformedIsolation: false,
  },
])

describe('createProjectionTargetFromTraits — trait validation', () => {
  it('rejects an unknown fileFormat with a coded error instead of crashing at splice time', () => {
    try {
      createProjectionTargetFromTraits({
        ...STUB_JSONC_TRAITS,
        targetId: 'bogus',
        fileFormat: 'yaml' as ProjectionTargetTraits['fileFormat'],
      })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PandaError)
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.projectionTraitsInvalid)
      expect((error as PandaError).code).toBe('PANDA_PROJECTION_TRAITS_INVALID')
      expect((error as PandaError).message).toContain("'bogus'")
    }
  })

  it('uses the trait record’s defaultPath when no override is injected', () => {
    expect(createProjectionTargetFromTraits(STUB_TOML_TRAITS).filePath).toBe(STUB_TOML_TRAITS.defaultPath)
  })
})
