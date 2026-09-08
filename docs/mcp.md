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
project tree (no `.swarm/` state, no evidence, no git hygiene edits). Diff
refs are validated against flag-shaped values, so a tool argument cannot
redirect git output into a file. The
`--allow-write` flag is a forward-compatibility seam for the explicitly
authorized write surface (#2500) and adds no write tools today — the
registry's write-tool denylist fails closed either way.

The read-only guarantee extends into the recall paths. `swarm_memory_recall`
degrades to `available:false` unless the configured memory provider's store
artifact (`memory.db` / `memories.jsonl`) already exists, then recalls through
the registered tool's compute core with usage telemetry disabled — so a query
never creates the sqlite store and never appends recall-usage rows.
`knowledge_recall` skips the receipt-ledger rollup read while the
`knowledge-receipts-v2.jsonl` journal is absent or empty, so a query never
performs the ledger's one-time genesis. Against an already-initialized,
current-schema store these recalls are write-free (identical file set and
sizes), pinned by `tests/unit/mcp/readonly-recall-no-writes-2499.test.ts`.
Two transitional write paths remain by design and are outside that promise: a
stale-schema `memory.db` is migrated on open (normal upgrade behavior), and a
local-jsonl store with a truncated tail is self-healed (rewritten plus an
audit row) on read.

## Tools

(`knowledge_query` is deferred out of the Phase-1 surface — its capability
area is covered by `knowledge_recall`; it becomes available in-session.)

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
- **Redaction then bounds.** Every response — success and error text alike —
  passes through the repo's secret redaction (12 pattern families) FIRST, then
  is bounded to 65,536 serialized characters, so a large corpus can never
  produce an unbounded response and truncation can never split a secret
  pattern in half. Containment errors never disclose the host-side root path.
- **Bounded subprocess reach.** The SAST adapter forces offline-only mode, so
  the Semgrep subprocess is unreachable from the MCP surface. The `diff`
  adapter does transit git (read-only) via the registered tool; its refs are
  dash-validated so an argument cannot redirect git output into a file.

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
