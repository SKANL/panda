VENDORED VERBATIM from Claude Code's own published documentation. Claude Code
is closed source, so its documentation IS the authority for this schema — this
is the one target whose declared keys could not be read off a source file, and
the conformance suite says so rather than pretending otherwise.

source: https://code.claude.com/docs/en/mcp
retrieved: 2026-08-25 (no commit: the docs are not a versioned artifact)

The conformance suite extracts declared entry keys MECHANICALLY from the fenced
JSON blocks below — every key appearing inside an `mcpServers.<name>` object.
A key panda writes that is not in a block here fails the suite, which forces a
trip back to the source rather than an edit to a table.

--- verbatim: user scope and project scope ---

> User-scoped servers are stored in `~/.claude.json` and provide cross-project
> accessibility, making them available across all projects on your machine
> while remaining private to your user account.

> Project-scoped servers enable team collaboration by storing configurations in
> a `.mcp.json` file at your project's root directory.

> When configuring MCP servers via JSON in `.mcp.json`, `~/.claude.json`, or
> `claude mcp add-json`, the `type` field accepts `streamable-http` as an alias
> for `http`.

> Claude Code reads an entry with no `type` as a stdio server, so a `url` entry
> without a `type` fails.

--- verbatim: an `mcpServers` block, the wrapper key and entry shape Claude Code reads ---

```json
{
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server"]
    }
  }
}
```

--- verbatim: the resulting `.mcp.json` file follows a standardized format ---

```json
{
  "mcpServers": {
    "shared-server": {
      "type": "http",
      "url": "https://example.com/mcp"
    }
  }
}
```

--- verbatim: `oauth` and `headers` on an entry ---

```json
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "authServerMetadataUrl": "https://auth.example.com/.well-known/openid-configuration"
      }
    }
  }
}
```

```json
{
  "mcpServers": {
    "api-server": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  }
}
```

--- verbatim: expansion locations, which name the stdio entry's own fields ---

> Environment variables can be expanded in:
>
> * `command`: the server executable path
> * `args`: command-line arguments
> * `env`: environment variables passed to the server
> * `url`: for HTTP server types
> * `headers`: for HTTP server authentication

--- verbatim: per-server timeout ---

> Set a per-server tool execution timeout by adding a `timeout` field in
> milliseconds to that server's `.mcp.json` entry, for example
> `"timeout": 600000` for ten minutes.
