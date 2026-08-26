import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// Machine independence for the WHOLE CLI suite.
//
// `panda run` resolves its executor through `~/.panda/config.json` when the
// caller names no home directory, and `os.homedir()` reads `USERPROFILE` on
// win32 and `HOME` elsewhere. Left alone, every `panda run` test would consult
// the home directory of whoever ran the suite — a test that passes or fails for
// reasons having nothing to do with the code, which is the exact defect this
// story exists to remove. Measured: a malformed `~/.panda/config.json` fails 9
// of the 33 assertions in `test/run.test.ts` without this.
//
// Pointed at an empty temp directory instead, so the machine scope is reliably
// ABSENT unless a test writes a document there itself. Done here rather than in
// the test files because the existing assertions must keep passing unmodified,
// and because a rule that only holds in the files someone remembered to edit is
// not a rule.
//
// `test/executor-selection.test.ts` asserts the MECHANISM — that the resolved
// home is under the temp directory, and that a document written into it is
// picked up as the `global` layer. An earlier version pinned only that nothing
// was configured, which stayed green with this file deleted on any machine
// without a `~/.panda/config.json`: a machine-dependent pin against
// machine dependence.
const isolatedHome = mkdtempSync(join(tmpdir(), 'panda-cli-home-'))
process.env['HOME'] = isolatedHome
process.env['USERPROFILE'] = isolatedHome

// Setup files run once per test FILE, so without this the directories pile up in
// %TEMP% — 22 were observed from a handful of runs.
afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true })
})
