# Correct default execution-gate semantics and corrupt-evidence handling (#2470)

Closes #2470 (source scope: #1655, #2007, #2199).

## What changed

### quality_budget computes true base-vs-head deltas (#1655)

`complexity_delta` and `public_api_delta` were absolute totals of the changed
files' current content, gated against delta-sized thresholds
(`max_complexity_delta: 5`, `max_public_api_delta: 10`) — so a refactor that
halved a file's complexity failed the gate identically to one that doubled it.
Metrics now resolve the git merge-base (same candidate branches as
`pre_check_batch`) and read each changed file's base content via bounded
`git show`, computing `delta = head − base`:

- A complexity-reducing edit of a high-complexity file now passes (verified:
  20→8 decision points reports `complexity_delta = -12` and no violation).
- A genuine increase past the threshold still fails (`+18` > 5 → error).
- New files count their full head complexity; deleted files subtract their
  base; with no resolvable base (not a repo / no candidate branch) the metric
  falls back to the previous head-only behavior.
- Base reads are capped at 200 files per run (beyond the cap, files fall back
  to head-only — conservative direction) via a new bounded, timeout-guarded
  git helper (`src/quality/git-base.ts`); a read truncated at the 2 MB stdout
  cap is logged instead of silently counting as "no base content", and the
  base queries honor the caller's abort signal.
- The primary production caller (`pre_check_batch`) passes absolute paths;
  metrics relativize absolute paths inside the project root before glob
  matching, so the gate no longer silently analyzes nothing on that path
  (pre-existing gap surfaced by review, probe-verified).
- `qualityMetricAvailability` in gate-audit output is now derived from whether
  a merge base actually resolves for the audited project — a no-base run
  reports `unavailable` and the metrics log a warning instead of failing
  silently — and `quality_budget` evidence carries `base_resolved` so
  consumers see the same degraded mode.

**Config migration note:** threshold semantics changed from
"absolute total vs N" to "true delta vs N". Existing low thresholds are now
far less likely to false-fail refactors; no config keys or defaults changed.
`benchmark` / `gate-audit` reporting updated accordingly: the
`qualityMetricAvailability` field now reports `available` (previously
`unavailable`), and the Gate Audit lines no longer cite #1655 as a known
unavailability. Two disclosure notes: `benchmark` still averages
`complexity_delta`/`public_api_delta` across all persisted evidence with no
version discriminator, so pre-#2470 evidence (absolute totals) blends with
post-#2470 true deltas — the direction is conservative for CI-gate
regression math; and the promotion decision artifact continues to hardcode
`unavailableQualityMetrics: ['complexity_delta', 'public_api_delta']`
(`src/evaluation/statistics.ts`) because renaming those values would change
promotion `decisionId` hashes — deliberate backward-compat debt; the metrics
remain excluded from promotion regression math.

### lean_turbo_critic: the default-true phase_critic gate is now satisfiable (#2007)

The `turbo.lean.phase_critic` gate (default `true`) read its APPROVED verdict
from `runState.lastCriticVerdict` (no setter anywhere) or
`.swarm/evidence/{phase}/lean-turbo-critic.json` (sole writer
`dispatchPhaseCritic`, which had no production caller) — every default-config
Lean Turbo phase dead-ended at `phase_complete`. This release registers the
new **`lean_turbo_critic` tool** (mirroring `lean_turbo_review` on every
registration surface — metadata, manifest, plugin tool object, barrel,
`TURBO_TOOL_NAMES`/architect tool map, and the preflight recovery
mapping), wired to `dispatchPhaseCritic`:
the architect can now run the read-only critic at the phase boundary, and the
default-config phase-readiness check passes end to end (covered by a
default-config E2E test that fails without the wiring).

Review follow-ups also fixed a latent lean-turbo defect: the phase-readiness
integrated-diff check read `.swarm/evidence/{phase}/lean-turbo-phase.json`
(flat) while the writer produces
`.swarm/evidence/{phase}/lean-turbo/lean-turbo-phase.json` (nested), so the
gate was unsatisfiable in production for config-driven lean projects (the
schema default `integrated_diff_required: true`). The reader now matches the
writer, and the E2E test exercises the schema-default gate flags end to end.
Preflight recovery for `lean_turbo_readiness` advertises the
`lean_turbo_critic` follow-up only when the blocked reason is
critic-specific, and the critic evidence temp file gained a random suffix now
that the critic tool is a real production caller.

Additionally, `/swarm doctor` now reports a **gate-satisfiability error** if
any enabled evidence-requiring Lean Turbo gate (phase_critic, phase_reviewer,
integrated_diff_required) loses its registered producer tool — so this
class of unwired gate cannot silently recur.

### Task evidence: corrupt vs missing distinguished; fail-closed at the two bypass sites (#2199)

`readTaskEvidence` collapsed "no evidence file" and "evidence file is
corrupt/unparseable" into the same `null`, which degraded two coder-dispatch
guard checks to treat corrupt evidence as `idle` (fail-open) — reachable via
version skew when an older build reads evidence containing a newer
`workflow.state`. The new discriminated reader `readTaskEvidenceState`
distinguishes `ok | missing | unparseable`:

- `readTaskEvidence` keeps its exact fail-open contract (wrapper).
- The two guard sites in `delegation-gate` (coder preflight and the
  same-task re-delegation block) now **fail closed** on unparseable evidence
  with a `TASK_EVIDENCE_UNREADABLE` diagnostic naming the file and error
  kind, directing repair via `repair_gate_evidence`.
- Corrupt evidence for an *unrelated* task does **not** block dispatch of
  other tasks (isolation preserved); missing evidence keeps the intended
  fail-open behavior everywhere.
- Two scope edges are documented rather than widened: transient OS file locks
  (EBUSY/EPERM, e.g. antivirus) on an existing evidence file now fail closed
  like any other unreadable file — matching #2199's corrupt-means-fail-closed
  intent — and `pr_feedback`-scoped dispatches resolve no coder task id, so
  the same-task re-delegation throw is unreachable there by design
  (isolation over blocking).
- A grammar-invalid task id (no valid evidence filename can exist) reports
  `missing` rather than `corrupt`, so operators are not pointed at
  `repair_gate_evidence` for a format problem it cannot fix.
