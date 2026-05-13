# Plan Durability Model

## Overview

**v6.42.0** introduced a durable plan durability model that provides crash recovery, audit logging, and corruption isolation for the swarm planning system. The core principle: the ledger is authoritative; projections are derived and can be rebuilt at any time.

## File Roles

| File | Purpose | Authority |
|------|---------|-----------|
| `.swarm/plan-ledger.jsonl` | Durable runtime record of all plan events | **Authoritative** — append-only, never delete |
| `.swarm/plan.json` | Machine-readable projection of current plan state | Derived — can be rebuilt from ledger |
| `.swarm/plan.md` | Human-readable plan view | Derived — generated from plan.json |
| `.swarm/SWARM_PLAN.md` | Operator checkpoint artifact | Export-only — not live source of truth |
| `.swarm/SWARM_PLAN.json` | Machine-readable checkpoint artifact | Export-only — for import/export workflows |

> **Migration note:** As of v7.x, SWARM_PLAN files live inside `.swarm/` instead of the project root. The `/swarm close` command cleans up both locations during the transition window.

### Ledger Event Types

```json
{"type":"plan_created","phase":1,"data":{...},"ts":"ISO8601"}
{"type":"task_added","taskId":"1.1","data":{...},"ts":"ISO8601"}
{"type":"task_updated","taskId":"1.1","status":"completed","ts":"ISO8601"}
{"type":"task_status_changed","taskId":"1.1","status":"completed","ts":"ISO8601"}
{"type":"task_reordered","taskId":"1.1","afterTaskId":"1.2","ts":"ISO8601"}
{"type":"phase_completed","phase":1,"ts":"ISO8601"}
{"type":"snapshot","data":{"plan":{...},"payload_hash":"abc123"},"ts":"ISO8601"}
{"type":"plan_rebuilt","ts":"ISO8601"}
{"type":"plan_exported","path":".swarm/SWARM_PLAN.json","ts":"ISO8601"}
{"type":"plan_reset","ts":"ISO8601"}
{"type":"execution_profile_set","data":{"execution_profile":{...}},"ts":"ISO8601"}
{"type":"execution_profile_locked","ts":"ISO8601"}
```

## Rebuild / Import / Export

### Rebuild

`loadPlan()` detects a hash mismatch between the ledger and plan.json → replays all ledger events → writes fresh projections.

```
loadPlan()
  → computeLedgerHash() vs stored hash
  → if mismatch: replayLedger() → savePlan() → write plan.json + plan.md
```

### Import

`importCheckpoint()` reads `.swarm/SWARM_PLAN.json` (falling back to a legacy root-level `SWARM_PLAN.json` with a deprecation warning) → validates schema → calls `savePlan()` → appends `plan_rebuilt` event to ledger.

```
importCheckpoint(.swarm/SWARM_PLAN.json)
  → validateSchema()
  → savePlan(planData)
  → append {type:"plan_rebuilt"} to plan-ledger.jsonl
```

### Export

`writeCheckpoint()` is called on:
- `save_plan` command
- `phase_complete` command  
- `/swarm close` command

Writes `.swarm/SWARM_PLAN.md` and `.swarm/SWARM_PLAN.json` inside the working directory's `.swarm/` folder.

## Snapshot System

Every **50 ledger events** and on `phase_complete`, a `snapshot` event is appended to the ledger itself:

```json
{"type":"snapshot","data":{"plan":{...},"payload_hash":"abc123"},"ts":"ISO8601"}
```

Snapshot events embed the full Plan payload and its `payload_hash`. During `loadPlan()`, `replayFromLedger()` scans for the latest snapshot event and uses it as the base state, then replays only events after that snapshot. This avoids replaying the entire ledger on every load.

## Corruption Handling

If a ledger entry fails validation:

1. The bad suffix is **quarantined** to `.swarm/plan-ledger.quarantine`
2. Replay continues from the last valid event

```
.swarm/plan-ledger.jsonl      ← continues with clean events
.swarm/plan-ledger.quarantine ← bad entries isolated (never replayed)
```

## Migration from v6.41.x

**No action required.**

On first `savePlan()` call in v6.42.0+, the ledger is created automatically:

- If no `.swarm/plan-ledger.jsonl` exists → initialize with `plan_created` event
- Existing `.swarm/plan.json` is used as the baseline state
- Hash is computed and stored for subsequent consistency checks

No data is lost, no manual migration steps needed.

## Council Verdict Recovery

Council verdicts (`APPROVE`, `REJECT`, `CONCERNS`) are persisted in
`.swarm/evidence/{taskId}.json` under `gates.council`. On session restart,
`applyRehydrationCache()` reconstructs `session.taskCouncilApproved` from
these entries, allowing tasks that passed the council before a crash to
retain their verdict without re-running the council gate. The task's
workflow state is derived from the highest non-council gate present — the
council verdict alone does not fast-path the task to `completed`, because
gate evidence is recorded at delegation time and does not prove Stage A
(pre-check) passed. The task advances through the normal state machine
once pre-check succeeds.

## Execution Profile

**v6.77.0** added the `execution_profile` field to the Plan schema. It is architect-controlled and plan-scoped.

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `parallelization_enabled` | boolean | `false` | Enables parallel task dispatch for this plan |
| `max_concurrent_tasks` | integer 1–64 | `1` | Max simultaneous tasks when parallel is enabled |
| `council_parallel` | boolean | `false` | Allows council review phases to parallelise |
| `locked` | boolean | `false` | When true, profile is immutable (fail-closed enforcement) |

### Invariants

- **Locked profile is immutable**: any `save_plan` call that includes `execution_profile` while the current plan has a locked profile will be rejected.
- **Fail-closed enforcement**: the delegation gate enforces a locked profile — `parallelization_enabled: false` blocks Stage B parallel dispatch regardless of global plugin config.
- **Ledger authority**: profile changes are recorded as `execution_profile_set` / `execution_profile_locked` events. Replay rebuilds the profile deterministically from these events.
- **Hash coverage**: `execution_profile` is included in `computePlanHash`, so profile changes are always reflected in the ledger's `plan_hash_after` chain.
- **All surfaces carry the profile**: snapshot events, checkpoint export (`.swarm/SWARM_PLAN.json`), handoff data, export data, and `get_approved_plan` output all include `execution_profile`.

### Lifecycle

```
1. Architect calls save_plan with execution_profile to set concurrency intent.
2. Architect calls save_plan again with locked: true to lock it (or sets locked in step 1).
3. Ledger records execution_profile_set and execution_profile_locked events.
4. Delegation gate enforces the locked profile on every Stage B dispatch.
5. Critic drift verifier checks for profile drift via get_approved_plan.
6. To change a locked profile: use save_plan with reset_statuses: true to start fresh.
```

### Round-trip surfaces

| Surface | Carries execution_profile? |
|---------|--------------------------|
| `plan.json` | ✅ Persisted in schema |
| Ledger replay | ✅ Via `execution_profile_set` events |
| Snapshot events | ✅ Embedded in Plan payload |
| `.swarm/SWARM_PLAN.json` checkpoint | ✅ Via full Plan payload |
| `get_approved_plan` tool | ✅ Explicit `execution_profile` field |
| Handoff data | ✅ In `HandoffData.execution_profile` |
| Export data | ✅ In `ExportData.execution_profile` |

## Quick Reference

| Operation | Command / Trigger |
|-----------|-------------------|
| Save plan | Automatic on plan changes |
| Export checkpoint | `/swarm close`, `save_plan`, `phase_complete` |
| Import checkpoint | `importCheckpoint()` function |
| Rebuild from ledger | Automatic on hash mismatch |
| View ledger | `cat .swarm/plan-ledger.jsonl` |
| Set execution profile | `save_plan` with `execution_profile` field |
| Lock execution profile | `save_plan` with `execution_profile.locked: true` |
