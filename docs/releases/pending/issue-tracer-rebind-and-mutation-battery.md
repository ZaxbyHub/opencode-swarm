# Issue-Tracer: rebind rows and mutation-battery honesty

## What

Two evidence-honesty upgrades to the issue-tracer skill (v3.0.1), both from
the retrospective of the ragappv3 #1075/#1076 session (PR #1093):

- **Rebind rows for post-approval head drift.** New
  `trace-check.sh rebind --gate <plan-critic|implementation-review|final-critic> --reason <text> --slug <slug>`
  subcommand validates the drift and prints an explicit append-only Gates row
  (`... | 06-critic-review.md rebind(<reason>) |`) that re-binds a gate's
  existing approval to the current HEAD/tree. The validator stays read-only;
  the caller appends the row. Phase 3 accepts the explicit chain (historical
  APPROVE row matching the artifact's identity pair + a rebind-marked row at
  the current head) and emits `OK artifact-identity-<gate>-rebind-chain`;
  phases 4.5/4.6 keep the strict check, so those gates still require a fresh
  delta-review artifact (06b/09b) when they drift. A rebind is bookkeeping
  for head drift, never a substitute for a fresh critic round when the
  reviewed artifact changed. This replaces the previous state where
  post-implementation phase-3 re-sweeps produced two unexplained FAILs that
  had to be disclosed as prose.
- **Mutation-battery honesty checklist** in
  `references/evidence-artifacts.md`: one cwd change for the whole battery,
  per-probe verdicts from the pytest summary only (KILLED/SURVIVED/
  PROBE-ERROR, never counting PROBE-ERROR as KILLED), per-probe logs,
  repo-relative capture paths, and re-anchoring after any post-battery edit —
  the exact failure mode the vacuous first battery of ragappv3 PR #1093 hit
  (8/8 "KILLED" while pytest never ran).

`references/evidence-artifacts.md` gains a "Rebind rows" section documenting
the row shape and the not-a-re-approval boundary; SKILL.md's Gate Table
paragraph points at it. metadata.version 3.0.0 → 3.0.1 (installed skill
copies will show handshake `STALE` until refreshed, by design).

Tests: `tests/unit/scripts/trace-check-rebind.test.ts` (7 tests: emit shape,
no-drift refusal, no-prior-row refusal, gate/reason validation, phase-3 chain
acceptance, phase-3 strict failure without the row, phase 4.5 stays strict).
