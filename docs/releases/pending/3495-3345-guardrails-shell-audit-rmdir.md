# Guardrails: shell-audit rows record real targets, and the rmdir /s check follows cmd.exe's actual grammar

## What

Closes #3495 and #3345 (collated; both are the guardrails shell-write surface).
Includes the feedback-round fixes from the PR #3499 review.

When the shell write-scope gate denies a command, the `scope_violation` row in
`.swarm/session/shell-audit.jsonl` now records the actual blocked write target
in `path` and the write operator that tripped the gate in a new optional
`operator` field, for the five structured denial sites (declared-scope,
file-authority, universal-deny, inline-eval, dynamic-path). Denials that carry
no target (no active agent, scope not declared) keep the previous
message-derived row. The denial message for the scope gate also names its gate
(`WRITE BLOCKED [shell-write-scope]: …`) so an operator can tell it apart from
the destructive-command gate in a transcript. Persisted `path` fields are
bounded at 320 chars and the new `operator` field at 32 (embedded paths
redacted), so no persisted audit field is unbounded — previously an
oversized value could make the bounded store reject the whole line.

The Windows recursive-delete check now models cmd.exe's actual grammar
(verified against real cmd.exe): cmd scans each UNQUOTED argument for the
first `/` — everything after it is switch text, the text before it is the
path. So the recursion switch is recognized standalone (`rmdir /s x`),
clustered (`/s/q`, `/sq`), trailing (`rd x /s`), attached to the operand
(`rd zzz/s` = `rd zzz /s`), caret-escaped (`rmdir ^/^s zzz`), single-quoted
(`rmdir 'zzz/s'` — cmd does not honor single quotes), or glued to a quoted
operand (`del /s"file.txt"`); a switch with no operand fails closed. A `/s`
substring inside an operand whose post-slash text is NOT a valid switch name
(`rmdir a/share/b` — cmd itself rejects it with "Parameter format not
correct") is a plain nested path, so the #3456 nested-path cleanup works
again. The `/swarm guardrail-explain` mirror uses the same grammar, and the
write detector defers an `rmdir` to the destructive guard only when the
guard will actually evaluate it — a quoted `"/s"` is a path, so the
remaining operands reach the scope gate instead of being skipped by both
layers.

`tests/unit/hooks/guardrails-shell-write.test.ts` declares explicit 120 s
per-test timeouts on its redirect/move/sed-i family tests, so bare local runs
on loaded hosts no longer flake against bun's 5 s default. The in-code cap
equals CI's per-file `--timeout 120000` budget (an in-code per-test cap
overrides the CLI value, so CI is never shrunk by it).

## Why

The audit row is the operator-facing evidence of what the gate refused;
recording `SCOPE_VIOLATION:` as the path made `guardrail-log --blocks-only`
unanswerable without reading transcripts. The `/s` over-match blocked
legitimate nested-path cleanup — and the first cut of the token fix still
missed cmd.exe's attached-switch grammar (`rd zzz/s` is a real recursive
delete), which this round closes.
