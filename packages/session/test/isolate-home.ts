import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// Machine independence for the WHOLE session suite.
//
// This package owns `resolveExecutor`, whose `homeDir` seam defaults to
// `os.homedir()`. Every call in the suite names its own temp directory today —
// which makes the suite clean by LUCK, not by construction: one future
// `resolveExecutor({})` would start reading the real machine's
// `~/.panda/config.json` and nothing here would notice.
//
// `os.homedir()` reads `USERPROFILE` on win32 and `HOME` elsewhere, so pointing
// both at an empty temp directory makes the machine scope reliably absent unless
// a test writes a document into it.
const isolatedHome = mkdtempSync(join(tmpdir(), 'panda-session-home-'))
process.env['HOME'] = isolatedHome
process.env['USERPROFILE'] = isolatedHome

// Setup files run once per test FILE, so without this the directories pile up.
afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true })
})
