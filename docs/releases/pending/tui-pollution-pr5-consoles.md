# TUI pollution sweep — console wrapper final migration (PR5 of epic #1752)

## What

Migrates the last two raw `console.error` calls in `src/index.ts` (the
`chat.message` plugin hook diagnostics on entry and exit) to `log()`, completing
the epic #1752 migration. After this PR the codebase has zero raw
`console.warn`/`console.error`/`console.log` in `src/` (biome `noConsole`
enforcement).

The two sites are guarded by `if (process.env.DEBUG_SWARM)` and were
intentionally excluded from the PR1–PR4 sweeps — they fire only on explicit
debug activation and were considered low-risk for TUI pollution. The same
`log()` helper used by PR1–PR4 is applied here for consistency.

Also enables Biome `suspicious/noConsole` rule globally in `biome.json` as the
enforcement mechanism for the epic's "zero raw console in src/" invariant.

## Migration

- `console.error(\`[DIAG] chat.message agent=... session=...\`)`
  → `log(\`[DIAG] chat.message agent=... session=...\`)`
- `console.error(\`[DIAG] chat.message DONE agent=...\`)`
  → `log(\`[DIAG] chat.message DONE agent=...\`)`

Both are `OPENCODE_SWARM_DEBUG=1`-gated (same as PR1–PR4).

## Files

- `src/index.ts` — 2 `chat.message` hook diagnostic calls

## Why

Epic #1752 systematically eliminated raw console writes from every agent-facing
code path. The `chat.message` hook diagnostics in `src/index.ts` were the last
two holdouts. Closing them completes the invariant: no console noise during
normal operation (`OPENCODE_SWARM_DEBUG` unset). Operators with
`OPENCODE_SWARM_DEBUG=1` see the same diagnostic messages; `/swarm diagnose`
surfaces actionable advisories through the buffered `advisoryWarn` channel.

## Behavior changes

- Zero console noise during normal operation (no `OPENCODE_SWARM_DEBUG`).
- Same debug diagnostics available via `OPENCODE_SWARM_DEBUG=1`.
- `/swarm diagnose` shows buffered `advisoryWarn` messages as before.

## Epic context

- Closes #1752 (final PR of epic #1752)
- PR1 #1758, PR2 #1789, PR3 #1829, PR4 #1834 already merged

## Test impact

Small set of test files updated to spy on the `log()` helper instead of
`console.error` for the two `chat.message` diagnostic sites.
