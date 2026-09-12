# Explicitly authorized MCP knowledge writes

## What changed

- Added an opt-in MCP write surface for `knowledge_add`, guarded by both
  `--allow-write` and the repeatable `--write-tool knowledge_add` startup
  policy. The default MCP server remains read-only.
- Added the read-only `scope_validate` advisory for checking shell write
  intent against an inline file scope without executing the command.
- Added bounded, redacted JSONL receipts with idempotent replay, same-key
  conflict detection, and explicit `PREPARED`, `COMMITTED`,
  `FAILED_NO_EFFECT`, and `IN_DOUBT` outcomes.
- Documented setup for Claude Code, Cursor, VS Code, and JetBrains clients.

## Why

Issue #2500 completes the guarded Phase-2 MCP surface requested by issue
#1227 while keeping external stdio clients separate from OpenCode's in-session
scope identity. A durable receipt is required to make disconnects and retries
truthful without replaying an uncertain mutation.

## Migration steps

None for existing clients. Existing invocations stay read-only. To enable the
reviewed write operation, add both `--allow-write` and
`--write-tool knowledge_add` to the server command and provide a bounded
`idempotency_key` on each `knowledge_add` request.

## Breaking changes

None. No generic shell, patch, plan, or destructive MCP write tool is exposed.

## Known caveats

- An interrupted or stale operation can settle as `IN_DOUBT`; the server never
  automatically retries uncertain work. Reconnect and inspect the receipt
  outcome before deciding whether to take action.
- SDK-level unknown-tool and schema validation failures happen before adapter
  dispatch and therefore do not create receipts.
- Receipts are bounded and redacted: raw lesson text, idempotency keys,
  absolute roots, secrets, and unbounded client fields are not retained.
