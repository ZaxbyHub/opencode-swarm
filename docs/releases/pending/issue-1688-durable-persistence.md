# Durable issue reference persistence and deterministic --trace transition

## What changed

- **Durable issue reference persistence**: `/swarm issue` now writes
  `.swarm/issue-reference.json` (containing `{url, owner, repo, number, timestamp, flags}`)
  and `.swarm/issue-trace-state.json` (containing `{issueNumber, lastTransition, completed}`)
  at command invocation time, using atomic writes with two-artifact transactional rollback.
  These files capture the source issue's identity and trace state so downstream skills
  (spec, plan, commit-pr) can access the issue context without re-querying GitHub.

- **Deterministic `--trace` transition engine**: a new hook-based engine drives the
  ISSUE_INGEST → PLAN → CRITIC-GATE → EXECUTE → commit-pr ladder automatically when
  `--trace` is specified. The engine consists of:
  - `src/hooks/issue-trace-reducer.ts` — pure reducer with 8-row state-mutation table,
    cross-issue fail-closed guard, and idempotency
  - `src/hooks/issue-trace-state.ts` — state adapter with ledger-aware plan loading,
    JSON shape validation, and atomic writes
  - `src/hooks/issue-trace.ts` — runtime hook with bounded 5s approval await,
    precompute-before-state ordering, and fail-closed error handling
  - Registered in `src/index.ts` composeHandlers chain alongside existing hooks

- **`--no-repro` audit waiver**: when `--no-repro` is passed to `/swarm issue`, a
  `noReproWaiver` record is persisted in the issue reference file for audit trail.
  This documents that reproduction was waived and the issue was accepted on
  description-only evidence.

- **commit-pr auto-population**: the commit-pr skill now reads `.swarm/issue-reference.json`
  to surface `Closes #N` guidance when a swarm workflow was started from `/swarm issue`.

- **Architect recovery directives**: five mode-entry directives (ISSUE_INGEST, PLAN,
  EXECUTE, PHASE-WRAP, context.md template) instruct the architect to read
  `.swarm/issue-reference.json` if context was compacted, ensuring the issue reference
  is recoverable at every workflow stage.

## Why

Prior to this change, issue context was transient — it existed only in the architect
session's conversation and was lost on context compaction, session restart, or when the
work was handed off between agents. This made it impossible for downstream skills to
reliably link work back to its source issue.

## Migration

No migration required. Issue reference files are created on-demand by `/swarm issue`
and do not affect existing workflows that do not use the issue command.

## Breaking changes

None.

## Known caveats

- Issue reference persistence is limited to `/swarm issue` invocations; manually
  created plans or specs are not automatically linked to a GitHub issue.
- The `--trace` hook performs uncached filesystem reads on each message transform
  when trace is active. This is acceptable for correctness but may add latency in
  long sessions; a caching optimization is planned as a follow-up.
- Issue #1688 scope items (c) repro-execution gate and (d) pre-spec critic pass
  over localization are documented scope gaps — the waiver recording mechanism
  is shipped, but a blocking repro-execution gate and a pre-specification critic
  pass are deferred to a follow-up issue.
