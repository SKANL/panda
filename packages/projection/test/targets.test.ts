import { join } from 'node:path'
import { createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'
import { createCodexConfigTarget } from '../src/targets/codex-config.ts'
import { createOpenCodeConfigTarget } from '../src/targets/opencode-config.ts'
import { runProjectionClauseSuite } from './clause-suite.ts'

// The three shipped targets satisfy the SAME clauses, exercised uniformly
// through the shared runner. Each sample is a realistic file for the location
// that executor actually reads.

const CLAUDE_SAMPLE = `{
        "numStartups": 42,
    "tipsHistory": {"new-user-warmup": 3},
  "projects": {"/home/u/work": {"allowedTools": []}},
"installMethod": "native"
}
`

const CODEX_SAMPLE = `# User's codex configuration
model = "gpt-5-codex"
approval_policy = "untrusted"

[mcp_servers.linear]
url = "https://mcp.linear.app/sse"
`

const OPENCODE_SAMPLE = `{
  // theme picked by the user
  "theme": "vercel",
  "model": "anthropic/claude-opus-4.1", // inline comment
  "mcp": {
    "linear": {
      "type": "remote",
      "url": "https://mcp.linear.app/sse",
    },
  },
}
`

runProjectionClauseSuite([
  {
    label: 'claude-mcp',
    makeTarget: (homeDir) => createClaudeMcpTarget({ filePath: join(homeDir, '.claude.json') }),
    sampleNative: CLAUDE_SAMPLE,
    foreignSentinels: [
      '"numStartups": 42',
      '"new-user-warmup": 3',
      '"allowedTools": []',
      '"installMethod": "native"',
    ],
    supportsMalformedIsolation: true,
    malformedSample: '{ "broken"',
  },
  {
    label: 'codex-config',
    makeTarget: (homeDir) => createCodexConfigTarget({ filePath: join(homeDir, '.codex', 'config.toml') }),
    sampleNative: CODEX_SAMPLE,
    foreignSentinels: [
      "# User's codex configuration",
      'model = "gpt-5-codex"',
      '[mcp_servers.linear]',
      'https://mcp.linear.app/sse',
    ],
    // Foreign TOML is never parsed, so malformed-native detection is out of
    // scope for this strategy — intentional, not a gap.
    supportsMalformedIsolation: false,
  },
  {
    label: 'opencode-config',
    makeTarget: (homeDir) =>
      createOpenCodeConfigTarget({ filePath: join(homeDir, '.config', 'opencode', 'opencode.json') }),
    sampleNative: OPENCODE_SAMPLE,
    foreignSentinels: [
      '// theme picked by the user',
      '"theme": "vercel"',
      '// inline comment',
      '"url": "https://mcp.linear.app/sse",',
    ],
    supportsMalformedIsolation: true,
    malformedSample: '42',
  },
])
