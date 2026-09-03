import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectionConfigTarget } from '@panda/contracts'
import { createProjectionTargetFromTraits } from '../formats.ts'
import type { ProjectionTargetTraits, TraitTargetOptions } from '../formats.ts'

// OpenCode config target.
//
// `mcp.<id>` in opencode.json, shape `{type:'local', command: string[]}`.
// OpenCode's `command` IS the argv — there is no `args` field — so the split
// panda keeps internally is joined here and nowhere else. opencode.json is
// JSONC-tolerant (comments and trailing commas are legal), so it reuses the
// shared splice WITHOUT the strict-JSON guard.

export const OPENCODE_CONFIG_TARGET_ID = 'opencode-config'

export const OPENCODE_CONFIG_TRAITS: ProjectionTargetTraits = {
  targetId: OPENCODE_CONFIG_TARGET_ID,
  fileFormat: 'jsonc',
  defaultPath: join(homedir(), '.config', 'opencode', 'opencode.json'),
  mcpContainerKey: 'mcp',
  renderMcpEntry: (entry) => ({ type: 'local', command: [entry.command, ...entry.args] }),
  // The UN-JOIN, and it lives here because the join does: `readNativeCommand`
  // is the other two vendors' shared reading and would be the wrong answer for
  // this one. A `remote` server carries a url and no argv at all, and an argv
  // whose first element is not an executable name is a server with nothing to
  // run — both are reported and skipped rather than turned into an entry no
  // executor could start.
  readMcpEntry: (native) => {
    if (native['type'] !== undefined && native['type'] !== 'local') {
      return {
        ok: false,
        detail: `its 'type' is ${JSON.stringify(native['type'])} rather than 'local', and panda projects a command with arguments`,
      }
    }
    const argv = native['command']
    if (argv === undefined || typeof argv === 'string') {
      return {
        ok: false,
        detail:
          argv === undefined
            ? "it declares no 'command', so there is nothing for panda to run"
            : "'command' is a string, and OpenCode spells a local server's whole argv as an array",
      }
    }
    const [command, ...args] = argv
    if (command === undefined || command === '') {
      // Two different documents, one honest sentence each: `[]` has no first
      // element at all, and `['', 'x']` has one that names no executable.
      // Saying "empty array" for the second described a file the user does not
      // have, which is the kind of detail that sends someone to the wrong line.
      return {
        ok: false,
        detail:
          command === undefined
            ? "'command' is an empty array, so there is no command to run"
            : "the first element of 'command' is empty, so the argv names no executable to run",
      }
    }
    return { ok: true, command, args }
  },
}

export type OpenCodeConfigTargetOptions = TraitTargetOptions

export function createOpenCodeConfigTarget(options: OpenCodeConfigTargetOptions = {}): ProjectionConfigTarget {
  return createProjectionTargetFromTraits(OPENCODE_CONFIG_TRAITS, options)
}
