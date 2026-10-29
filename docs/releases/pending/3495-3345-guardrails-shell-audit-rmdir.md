# Guardrails: shell-audit rows record real targets, and the rmdir /s check stops matching paths

## What

Closes #3495 and #3345 (collated; both are the guardrails shell-write surface).

When the shell write-scope gate denies a command, the `scope_violation` row in
`.swarm/session/shell-audit.jsonl` now records the actual blocked write target
in `path` and the write operator that tripped the gate in a new optional
`operator` field — instead of the literal tokens `SCOPE_VIOLATION:` or `Agent`
that message re-parsing used to capture. The denial message also names its
gate (`WRITE BLOCKED [shell-write-scope]: …`) so an operator reading a
transcript can tell the write-scope gate apart from the destructive-command
gate. Persisted `path` fields are now bounded (320 chars) so an oversized
target can no longer make the store drop the audit row silently.

The Windows recursive-delete check no longer reads a `/s` substring inside a
path operand as the `/s` switch: `rmdir a/share/b` and `del a/share/b` are
plain deletes again, while standalone and clustered switches (`/s`, `/S`,
`/s/q`, `/sq`) still block — wherever they appear, including the documented
`rd <path> /s` trailing form. Switch handling is verified against real
cmd.exe: a quoted `"/s"` is a path, not a switch, and `/sq` is rejected by
cmd itself.

`tests/unit/hooks/guardrails-shell-write.test.ts` declares explicit 120 s
per-test timeouts on its redirect/move tests, so bare local runs on loaded
hosts no longer flake against bun's 5 s default (CI always passed
`--timeout 120000`; the in-code cap equals that budget and never shrinks it).

## Why

The audit row is the operator-facing evidence of what the gate refused;
recording `SCOPE_VIOLATION:` as the path made `guardrail-log --blocks-only`
unanswerable without reading transcripts. The `/s` over-match blocked
legitimate empty-directory cleanup for any path with an `/s…` segment —
undoing most of #3456 for nested paths.
