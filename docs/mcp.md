# Read-only MCP verification surface (`swarm mcp serve`)

Any [Model Context Protocol](https://modelcontextprotocol.io) client can query
Swarm verification state read-only for one configured project root — without
running the OpenCode TUI (#2499, source issue #1227 phase 1).

```bash
opencode-swarm mcp serve --dir /path/to/project
# or from a checkout:
bunx opencode-swarm mcp serve --dir /path/to/project
```

The server speaks MCP over **stdio**, binds to exactly ONE project root per
process, and is **read-only by default**: it never writes anywhere under the
project tree (no `.swarm/` state, no evidence, no git hygiene edits). The
`--allow-write` flag is a forward-compatibility seam for the explicitly
authorized write surface (#2500) and adds no write tools today — the
registry's write-tool denylist fails closed either way.

## Tools

| Tool | Capability |
| --- | --- |
| `knowledge_recall` | semantic knowledge-base recall (the same `searchKnowledge` core the in-session tool uses, without receipt-ledger writes) |
| `swarm_memory_recall` | scoped Swarm memory recall (degrades to `available: false` when memory is disabled or no store exists — a query never creates one) |
| `evidence_check` | completed-task evidence completeness over `.swarm/plan.md` + `.swarm/evidence/` |
| `syntax_check` | tree-sitter syntax check over changed files |
| `placeholder_scan` | TODO/FIXME/stub placeholder scan |
| `sast_scan` | static analysis security scan (offline rules only — no Semgrep subprocess is ever spawned) |
| `quality_budget` | complexity / API-surface / duplication / test-ratio budgets |
| `plan_conflict_check` | declared-scope disjointness matrix for proposed parallel tasks |
| `diff` | git diff contract analysis (degrades on non-git roots) |
| `symbols` | tree-sitter symbol extraction/search |

Tool names and descriptions come from the plugin's registered tool metadata,
so what an MCP client sees matches the in-session tools exactly.

## Security model

- **Single root binding.** One server process = one `--dir` project root. The
  root is validated at startup and every file-path argument is re-validated
  per call against the canonical root.
- **Containment.** Path arguments escaping the root — `..` traversal,
  absolute paths outside the root, and symlink/junction indirection — are
  rejected with a containment error; the outside-root file content never
  enters a response. The checks reuse the same `path-security` helpers the
  write tools rely on.
- **Redaction then bounds.** Every response passes through the repo's secret
  redaction (12 pattern families) FIRST, then is bounded to 65,536 serialized
  characters, so a large corpus can never produce an unbounded response and
  truncation can never split a secret pattern in half.
- **No subprocesses.** The SAST adapter forces offline-only mode; no
  `Bun.spawn`/`child_process` call is reachable from the MCP surface.

## Client setup

### Claude Code

```json
{
  "mcpServers": {
    "opencode-swarm": {
      "command": "bunx",
      "args": ["opencode-swarm", "mcp", "serve", "--dir", "/path/to/project"]
    }
  }
}
```

(Or `claude mcp add opencode-swarm -- bunx opencode-swarm mcp serve --dir /path/to/project`.)

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "opencode-swarm": {
      "command": "bunx",
      "args": ["opencode-swarm", "mcp", "serve", "--dir", "/path/to/project"]
    }
  }
}
```

### VS Code (GitHub Copilot / other MCP clients)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "opencode-swarm": {
      "type": "stdio",
      "command": "bunx",
      "args": ["opencode-swarm", "mcp", "serve", "--dir", "/path/to/project"]
    }
  }
}
```

Any other MCP client works the same way: spawn
`opencode-swarm mcp serve --dir <root>` as a stdio child and speak
newline-delimited JSON-RPC 2.0 (`initialize` → `tools/list` → `tools/call`).
