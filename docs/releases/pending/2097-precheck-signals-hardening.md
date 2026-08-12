# Pre-check signals are structured, portable, bounded, and race-safe

`pre_check_batch` now decodes its structured result exactly instead of searching
nested diagnostic text for failure words. Valid pass, fail, skip, invalid, and
legacy results have deterministic behavior, and late results are correlated to
the task that started them so one task cannot overwrite another task's gate
state.

All lint and Git subprocesses used by the batch now share one Bun/Node-compatible
bounded runner with ignored stdin, bounded output, confirmed process-tree
termination, and cleanup on every path. Windows Biome and ESLint resolution uses
native binaries or safely resolved npm, pnpm, and Yarn package entries without
directly spawning command shims or enabling a broad shell.

Legacy SAST changed-line triage now unions committed, staged, unstaged, and
untracked work, including quoted, renamed, deleted, space-containing, Unicode,
CRLF, and Windows-style paths. Git uncertainty remains fail-closed while a known
empty diff keeps untouched findings pre-existing.

Secretscan now correlates the immediately pre-open path identity with the opened
descriptor and a post-open path check, rejects unverifiable replacements
conservatively, keeps reads bounded, and closes the descriptor on every path.

The engineering-invariant mock allowlist check also normalizes CRLF input, so
Windows checkouts no longer reject allowlisted test mocks that the CI ratchet
already accepts.

The packed-artifact evaluation smoke probe now gives bounded Windows worktree
setup enough time to reach its executor and reports the cancelled run details
when it cannot, instead of failing with an opaque status-only error.

No migration is required and there are no breaking changes. Semgrep remains an
optional enhancement: when it is unavailable, SAST continues with the built-in
Tier A scanner; failures after Semgrep availability is confirmed fail closed.
