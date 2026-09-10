# MCP verification and explicitly authorized writes (`swarm mcp serve`)

Any [Model Context Protocol](https://modelcontextprotocol.io) client can query
Swarm verification state for one configured project root — without running the
OpenCode TUI (#2499, source issue #1227 phase 1). The server remains
read-only unless the operator opts in to the one reviewed write operation in
issue #2500.

```bash
opencode-swarm mcp serve --dir /path/to/project
# or from a checkout:
bunx opencode-swarm mcp serve --dir /path/to/project

# Explicitly authorize the reviewed knowledge write surface:
bunx opencode-swarm mcp serve \
  --dir /path/to/project \
  --allow-write \
  --write-tool knowledge_add
```

The server speaks MCP over **stdio** and binds to exactly ONE project root per
process. It has two independent startup gates for writes:

1. `--allow-write` explicitly enables the write capability for this server
   process.
2. `--write-tool knowledge_add` selects the exact reviewed write tool. The
   option is repeatable so future reviewed tools can be selected explicitly;
   today `knowledge_add` is the only accepted value.

Both gates are required. The default invocation is read-only. A bare
`--allow-write` still registers no write tools, and a write-tool policy without
`--allow-write` fails closed before the server connects. Unknown names,
read-only names such as `scope_validate`, duplicate names, and malformed or
empty values are rejected at startup. There is no generic MCP shell, patch,
plan, or destructive write tool.

In read-only mode the server never writes anywhere under the project tree (no
`.swarm/` state, no evidence, no git hygiene edits). An authorized
`knowledge_add` call may create only the knowledge-store state and the bounded
receipt journal described below. Diff refs are validated against flag-shaped
values, so a tool argument cannot redirect git output into a file.

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
| `scope_validate` | read-only command-versus-inline-scope advisory; classifies, resolves, and checks shell write targets without executing the command |
| `evidence_check` | completed-task evidence completeness over `.swarm/plan.md` + `.swarm/evidence/` |
| `syntax_check` | tree-sitter syntax check over changed files |
| `placeholder_scan` | TODO/FIXME/stub placeholder scan |
| `sast_scan` | static analysis security scan (offline rules only — no Semgrep subprocess is ever spawned) |
| `quality_budget` | complexity / API-surface / duplication / test-ratio budgets |
| `plan_conflict_check` | declared-scope disjointness matrix for proposed parallel tasks |
| `diff` | git diff contract analysis (degrades on non-git roots) |
| `symbols` | tree-sitter symbol extraction/search |

When both write gates are present, `knowledge_add` is added to this list. No
other write-capable in-session tool is exposed through MCP.

Tool names and descriptions come from the plugin's registered tool metadata,
so what an MCP client sees matches the in-session tools exactly.

## Tool schemas

The MCP server binds every request to the root supplied by `--dir`; callers do
not provide a second working directory. Inputs below are JSON objects. The SDK
also validates these shapes before an adapter is called.

### `scope_validate` (always read-only)

```json
{
  "command": "printf x > in-root/note.md",
  "shell": "posix",
  "scope_files": ["in-root/note.md"]
}
```

- `command`: required string containing the command to inspect. It is never
  executed by this tool.
- `shell`: required shell dialect string. Use `posix`, `powershell`, or
  `cmd` for the corresponding write detector.
- `scope_files`: required non-empty array of path strings that declares the
  caller's allowed file scope for this advisory. Each entry is resolved from
  the fixed `--dir` root and must remain inside it.

The result is a bounded structured decision. An allowed result means the
detected, statically resolvable write targets are inside `scope_files`; it is
an advisory and does not grant permission to any other tool. Parse failures,
dynamic or unresolved targets, path escapes, symlink/junction escapes, and
destructive or catastrophic command intent are denied. The command is not
spawned and no scope declaration is persisted.

### `knowledge_add` (available only under both write gates)

```json
{
  "idempotency_key": "lesson-2026-001",
  "lesson": "A durable lesson that is at least fifteen characters.",
  "category": "testing",
  "tags": ["mcp", "retries"],
  "scope": "global",
  "applies_to_agents": ["coder"],
  "applies_to_tools": ["knowledge_add"],
  "required_actions": ["replay safely"],
  "forbidden_actions": [],
  "verification_checks": ["run the focused test"]
}
```

`idempotency_key` is required, non-empty, and bounded. It identifies the
client's logical attempt but is never written to the receipt journal in raw
form. `lesson` is required and is 15–280 characters. `category` is one of
`process`, `architecture`, `tooling`, `security`, `testing`, `debugging`,
`performance`, `integration`, `todo`, or `other`. `tags`, `scope`,
`applies_to_agents`, `applies_to_tools`, `required_actions`,
`forbidden_actions`, and `verification_checks` are optional arrays/strings
with the same bounded validation as the in-session `knowledge_add` tool.
Actionability fields are subject to the existing knowledge validator; an
entry can therefore produce a structured validation, duplicate, quarantine,
or store outcome without throwing. `working_directory` is not accepted: the
server's canonical `--dir` root is authoritative.

## Write receipts, replay, and uncertainty

Authorized writes use a project-local JSONL journal at
`.swarm/mcp-write-receipts.jsonl`. The journal is created only when an
authorized write is actually called. Read-only calls, including
`scope_validate`, never create it. A bounded receipt-only lock protects
lookup and individual state transitions; it is released before the knowledge
mutation runs.

Each record stores bounded metadata: a receipt and attempt identifier, the
tool, hashed root and idempotency identities, a canonical argument digest,
policy digest, state, timestamps, and a sanitized bounded result or error.
Raw lesson text, raw idempotency keys, absolute root paths, secrets, and
unbounded client fields are never persisted. Journal lines and total journal
size are capped. A malformed, truncated, oversized, or capacity-exhausted
journal fails closed for new writes; uncertain history is not silently
discarded.

If a write reports that the receipt journal is malformed, truncated, or at
capacity, stop retrying the request. Preserve a copy of
`.swarm/mcp-write-receipts.jsonl`, manually reconcile its settled states with
the knowledge store, and repair or archive the journal only after that audit.
Do not delete it to force a retry: receipt history is the recovery boundary,
and a new idempotency key is safe only after the prior attempt's outcome is
known.

The state machine is:

```text
PREPARED -> COMMITTED
PREPARED -> FAILED_NO_EFFECT
PREPARED -> IN_DOUBT
```

- `PREPARED` is durable before the production `knowledge_add` call. A live
  prepared attempt is reported as in progress and is not executed again.
- A same-key request with the same argument digest replays the bounded,
  stored result without invoking `knowledge_add` a second time. This is true
  for a committed success as well as a committed structured failure,
  duplicate, quarantine, or validation outcome. `COMMITTED` means the
  production response was durably settled and published; it does not imply
  that a knowledge entry was created.
- Reusing a key with a different argument digest is a conflict. It is denied,
  does not mutate the knowledge store, and is recorded as a bounded handler
  outcome.
- `FAILED_NO_EFFECT` is reserved for a failure proven to occur strictly before
  the production mutation starts. If the receipt cannot be durably prepared,
  the mutation is not attempted.
- A stale prepared attempt, a failure after the production call begins, or a
  failure to publish the final receipt becomes `IN_DOUBT` (or remains
  prepared until the bounded lease expires). `IN_DOUBT` is terminal for
  client retry: the server never automatically replays uncertain work.
  A late definitive settlement from the same original attempt may record the
  truth, but another attempt cannot overwrite it.

This means a disconnected client should reconnect and inspect the receipt
outcome before deciding what to do. Never blindly retry an interrupted
request. SDK-level unknown-tool and input-schema rejection happens before an
adapter is dispatched, so it cannot mutate and intentionally has no receipt;
handler-reachable policy, conflict, and adapter denials are receipted.

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

The snippets below show a write-enabled server. Remove the final
`--allow-write`, `--write-tool`, and `knowledge_add` arguments to keep the
client read-only (the default). Keep the three arguments together when
`knowledge_add` is intentionally enabled; the two-gate policy is evaluated
when the stdio server starts.

### Claude Code

```json
{
  "mcpServers": {
    "opencode-swarm": {
      "command": "bunx",
      "args": ["opencode-swarm", "mcp", "serve", "--dir", "/path/to/project", "--allow-write", "--write-tool", "knowledge_add"]
    }
  }
}
```

(Or `claude mcp add opencode-swarm -- bunx opencode-swarm mcp serve --dir /path/to/project --allow-write --write-tool knowledge_add`.)

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "opencode-swarm": {
      "command": "bunx",
      "args": ["opencode-swarm", "mcp", "serve", "--dir", "/path/to/project", "--allow-write", "--write-tool", "knowledge_add"]
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
      "args": ["opencode-swarm", "mcp", "serve", "--dir", "/path/to/project", "--allow-write", "--write-tool", "knowledge_add"]
    }
  }
}
```

### JetBrains IDEs

In the JetBrains IDE, open **Settings | Tools | AI Assistant | Model Context
Protocol (MCP)** and add a local stdio server using the following values. If
your IDE stores server definitions in a project `.idea/mcp.json`, the same
object can be used there:

```json
{
  "mcpServers": {
    "opencode-swarm": {
      "command": "bunx",
      "args": ["opencode-swarm", "mcp", "serve", "--dir", "/path/to/project", "--allow-write", "--write-tool", "knowledge_add"]
    }
  }
}
```

Any other MCP client works the same way: spawn
`opencode-swarm mcp serve --dir <root>` (plus both explicit write gates when
needed) as a stdio child and speak
newline-delimited JSON-RPC 2.0 (`initialize` → `tools/list` → `tools/call`).
