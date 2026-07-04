# Spec-drift gate: diff surfacing + obligation-preserving allowlist

## What changed

### FR-001 — Spec-drift gate now surfaces a unified diff

When the spec-drift guardrail blocks a plan operation, it now shows a
unified line diff (`-` = removed, `+` = added) comparing the **recorded**
spec snapshot against the **current** effective spec, instead of a bare
"spec is stale" message. Changed markdown sections are listed alongside the
diff so the architect can see exactly which part of the spec changed.

The recorded snapshot is persisted as `.swarm/spec-snapshot.md` at `save_plan`
time and refreshed on `/swarm acknowledge-spec-drift`. This enables the
recorded-vs-current comparison that the diff is built from.

- `src/utils/spec-hash.ts`: `computeSpecDiff()` (LCS-based line diff,
  capped at 300 lines) and `computeLcsDiff()` (minimal LCS implementation)
- `src/tools/save-plan.ts`: writes `.swarm/spec-snapshot.md` after a
  successful plan save
- `src/hooks/guardrails/index.ts`: `enforceSpecDriftGate` now calls
  `computeSpecDiff` and includes the diff + changed-sections list in the
  `SPEC_DRIFT_BLOCK` error
- `src/hooks/system-enhancer.ts`: advisory payload gains a `specDiff` field
  with the same diff content
- `src/commands/acknowledge-spec-drift.ts`: refreshes `.swarm/spec-snapshot.md`
  to the current spec before clearing the staleness marker
- `src/plan/manager.ts`: allowlist wiring (`isObligationPreserving`) is
  plumbed into the gate

### FR-002 — Obligation-preserving allowlist (fail-closed)

A new `isObligationPreserving(directory)` function in `src/utils/spec-hash.ts`
compares obligation-bearing paragraphs (paragraphs containing `MUST`,
`SHALL`, `SC-###`, or `FR-###`) between the snapshot and the current spec.

**Edits that touch only non-obligation text** — e.g. count corrections,
commentary, formatting fixes, non-obligation body text — no longer trigger the
spec-drift block.

**Any change to an obligation paragraph** (obligation text added/removed/changed,
or a new obligation paragraph introduced) still blocks with the diff.

This is conservative and fail-closed: if the snapshot is missing, unreadable,
or any error occurs during comparison, the function returns `false` and the gate
falls back to the block-with-diff path.

## Migration

No user action required. Plans created before this feature (no `specHash` in
`plan.json`) remain exempt from staleness checks. The obligation allowlist
is transparent — it only reduces false-positive blocks, never enables
behavior that was previously allowed.

## Tests

- `spec-drift-diff.test.ts`: 6 tests covering diff construction, changed-section
  attribution, and truncation
- `spec-obligation-allowlist.test.ts`: 20 tests covering the 6 obligation
  scenarios (unchanged, obligation added/removed/modified) plus boundary cases
- `spec-obligation-allowlist.adversarial.test.ts`: 18 adversarial tests
  covering empty snapshot, binary files, single-line files, deep nesting,
  and path traversal attempts
- `spec-drift-adversarial.test.ts`: 14 adversarial tests covering malformed
  snapshots and `computeSpecDiff` path containment
- `acknowledge-spec-drift.test.ts`: updated with new FR-001 snapshot-refresh
  assertions

Closes: #1628
