import { join } from 'node:path'
import { createClaudeSettingsTarget } from '../src/targets/claude-settings.ts'
import { createCodexConfigTarget } from '../src/targets/codex-config.ts'
import { createOpenCodeConfigTarget } from '../src/targets/opencode-config.ts'
import { runProjectionClauseSuite } from './clause-suite.ts'

// The three shipped targets satisfy the SAME clauses, exercised
// uniformly through the shared runner.

const CLAUDE_SAMPLE = `{
        "z-last": true,
    "permissions": {"deny": [], "allow": ["Bash(ls)"]},
  "model": "opus",
"a-first": false
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
    label: 'claude-settings',
    makeTarget: (homeDir) => createClaudeSettingsTarget({ filePath: join(homeDir, '.claude', 'settings.json') }),
    sampleNative: CLAUDE_SAMPLE,
    foreignSentinels: ['"z-last": true', '"allow": ["Bash(ls)"]', '"model": "opus"', '"a-first": false'],
    supportsMalformedIsolation: true,
    malformedSample: '{ "broken"',
  },
  {
    label: 'codex-config',
    makeTarget: (homeDir) => createCodexConfigTarget({ filePath: join(homeDir, '.codex', 'config.toml') }),
    sampleNative: CODEX_SAMPLE,
    foreignSentinels: ["# User's codex configuration", 'model = "gpt-5-codex"', '[mcp_servers.linear]', 'https://mcp.linear.app/sse'],
    // The delimited-block strategy manages foreign bytes at string level and
    // never parses TOML, so malformed-native detection is out of scope.
    supportsMalformedIsolation: false,
  },
  {
    label: 'opencode-config',
    makeTarget: (homeDir) => createOpenCodeConfigTarget({ filePath: join(homeDir, '.config', 'opencode', 'opencode.json') }),
    sampleNative: OPENCODE_SAMPLE,
    foreignSentinels: ['// theme picked by the user', '"theme": "vercel"', '// inline comment', '"url": "https://mcp.linear.app/sse",'],
    supportsMalformedIsolation: true,
    malformedSample: '42',
  },
])
