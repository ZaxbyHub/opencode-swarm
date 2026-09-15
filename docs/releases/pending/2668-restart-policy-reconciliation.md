# Restart policy reconciliation

## What changed

- Restart hydration now has an explicit authority boundary: the plan ledger,
  durable execution profile, persisted QA-gate profile, ratchet-tighter
  session QA-gate overrides stored in `.swarm/swarm.db`, evidence, recovery
  WALs, and lease records are durable inputs. The session `/swarm auto-proceed`
  override, active ownership, live lease authority, child handles, timers, and
  retry/circuit state remain process-local and are not revived as execution
  authority.
- The post-resolution restart coordinator uses authoritative `loadPlan()` before
  projection/cache inspection. Missing or stale `plan.json`/`plan.md` files are
  regenerated from `.swarm/plan-ledger.jsonl`; invalid ledger suffixes remain
  quarantined instead of being silently discarded. An initializer that loses
  its exact hydration authority reports `superseded`, never reusable success,
  so a current-generation retry still performs recovery. Authority includes a
  process-monotonic epoch, preventing FIFO eviction or reset from reviving an
  old callback when a numeric per-project generation is reused.
- Session recency, workflow-cache entries, and hydrated aggregate ownership
  pair their numeric state with that process-local authority epoch, so an older
  session/cache/aggregate owner cannot survive a hydration merely because its
  numeric stamp or generation is larger after a generation is reused (ABA).
- Corrupt-ledger replay carries the same authority fence through every recovery
  replay call site (including schema-invalid/missing projections, `savePlan`,
  and `rebuildPlan`) and its integrity/quarantine path. Spec-staleness output
  and save/rebuild marker publications use the same post-await fence, so an
  obsolete restart cannot publish misleading recovery artifacts after
  supersession.
- Interrupted, cancelled, stale, ambiguous, corrupt, live-wedge, and
  old-generation results remain owner-visible. Recovery releases or repairs
  local state only when the durable evidence proves that transition; uncertain
  provider or worktree effects stay uncertain.
- The recovery runbook documents the operator restart/inspect/recover sequence;
  the registered host journey covers policy/identity and task inspection, with
  settlement categories exercised directly by its deterministic classifier
  cases.

## Operator guidance

After a restart, inspect `/swarm status`, `/swarm diagnose`,
`get_approved_plan`, and `get_qa_gate_profile`. Use `/swarm recover
--coordination` only after a failed or timed-out coordination attempt has
settled, and use `/swarm recover <task_id>` for receipt-backed stale or
live-wedge repair. Do not hand-edit derived plan projections or force a live
foreign owner. See [`docs/troubleshooting/recovery-runbook.md`](../../troubleshooting/recovery-runbook.md).

No new plan identity or ledger migration is required. Repeated replay and
accepted recovery are idempotent.
