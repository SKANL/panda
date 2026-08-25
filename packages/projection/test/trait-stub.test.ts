import { join } from 'node:path'
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
  ownedRegionStrategy: 'root-key-splice',
  defaultPath: '/unused/stub.json',
}

const STUB_TOML_TRAITS: ProjectionTargetTraits = {
  targetId: 'stub-toml-target',
  fileFormat: 'toml',
  ownedRegionStrategy: 'delimited-block',
  defaultPath: '/unused/stub.toml',
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
    makeTarget: (homeDir) => createProjectionTargetFromTraits(STUB_JSONC_TRAITS, { filePath: join(homeDir, 'stub.json') }),
    sampleNative: JSONC_SAMPLE,
    foreignSentinels: ['"userKey": "user-value"', '"kept": true'],
    supportsMalformedIsolation: true,
    malformedSample: '42',
  },
  {
    label: 'trait-only stub (toml)',
    makeTarget: (homeDir) => createProjectionTargetFromTraits(STUB_TOML_TRAITS, { filePath: join(homeDir, 'stub.toml') }),
    sampleNative: TOML_SAMPLE,
    foreignSentinels: ['# user table', 'flag = true', '[foreign]', 'value = "kept"'],
    supportsMalformedIsolation: false,
  },
])
