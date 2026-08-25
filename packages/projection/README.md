# @panda/projection

Projects Registry entries into executors' native configuration files through
per-target `ProjectionTarget` strategies (port defined in `@panda/contracts`).

- `runProjection` — engine: renders entries once, then runs each target
  SEQUENTIALLY with per-target failure containment (a failing target never
  affects siblings, and failures surface as typed results — the call does not
  throw). Single-writer assumption: concurrent `runProjection` calls over the
  same projected file are unsupported in v1; a file modified externally between
  read and write fails that target instead of landing stale content.
- `createClaudeSettingsTarget` — Claude Code `settings.json` target: strict
  JSON, surgical splice of the reserved `"panda"` root key via jsonc-parser.

Grammar vocabulary, owned-subtree types, and drift classification live in
`@panda/contracts` (`src/projection.ts`). Unknown or legacy panda markers are
reported as drift and never overwritten.
