# Plan Durability Model

## Overview

**v6.42.0** introduced a durable plan durability model that provides crash recovery, audit logging, and corruption isolation for the swarm planning system. The core principle: the ledger is authoritative; projections are derived and can be rebuilt at any time.

## File Roles

| File | Purpose | Authority |
|------|---------|-----------|
| `.swarm/plan-ledger.jsonl` | Durable runtime record of all plan events | **Authoritative** — append-only, never delete |
| `.swarm/plan.json` | Machine-readable projection of current plan state | Derived — can be rebuilt from ledger |
| `.swarm/plan.md` | Human-readable plan view | Derived — generated from plan.json |
| `.swarm/plan-export/SWARM_PLAN.md` | Operator checkpoint artifact | Export-only — not live source of truth |
| `.swarm/plan-export/SWARM_PLAN.json` | Machine-readable checkpoint artifact | Export-only — for import/export workflows |
| `.swarm/.plan-write-marker` | Advisory write counter for PlanSyncWorker | Advisory — used to detect unauthorized writes |

> **Migration note:** As of v7.x, SWARM_PLAN files live inside `.swarm/plan-export/` instead of the project root. The `/swarm close` and `/swarm reset --confirm` commands clean up all three locations (`.swarm/plan-export/`, flat `.swarm/`, and project root) during the transition window.

## Durable task write scope (`files_touched`)

Architects author a coding task's exact project-relative write scope with the optional `files_touched` array on `save_plan`. Non-empty arrays are canonicalized with the same path normalizer used by `declare_scope` (separator normalization, dot-segment collapse, deduplication, and stable sorting). Absolute paths, traversal components, empty entries, control characters, entries over 4,096 UTF-8 bytes, and aggregate scope text over 1 MiB fail before any plan write. On revision, omission preserves that task's existing scope; an explicit `[]` clears it.

The field is lossless across the six planning surfaces:

| Surface | `files_touched` contract |
|---|---|
| `save_plan` input | Optional per task; normalized once before persistence |
| Ledger replay and snapshots | Full task data is embedded and replayed; the ledger remains authoritative |
| `.swarm/plan.json` | Machine-readable derived projection preserves the normalized array |
| `.swarm/plan.md` | Human-readable derived projection renders sorted JSON-quoted paths; never authoritative |
| Checkpoint import/export | Full JSON round-trip preserves the array; checkpoint Markdown uses the same derived renderer |
| `get_approved_plan` | Full mode returns the immutable approved task array; `summary_only` intentionally omits task details |

At coder dispatch, scope-source precedence is active `declare_scope` binding, then plan `files_touched`, then complete `FILE:` directives. Any present lower-precedence set must be a subset of the authoritative set; conflicts fail closed rather than silently widening authority.

### Ledger append concurrency

`appendLedgerEvent()` serializes its read -> validate -> rewrite sequence under
a project-scoped lock keyed to `.swarm/plan-ledger.jsonl`. The lock is acquired
before reading the latest ledger sequence and released only after the canonical
ledger file has been replaced. This preserves monotonic sequence assignment and
keeps `expectedSeq` / `expectedHash` stale-writer checks tied to the latest
committed ledger state even when two OpenCode processes or background workers
try to append at the same time.

### Ledger Event Types

```json
{"type":"plan_created","phase":1,"data":{...},"ts":"ISO8601"}
{"type":"task_added","taskId":"1.1","data":{...},"ts":"ISO8601"}
{"type":"task_removed","taskId":"1.1","phase_id":1,"from_status":"pending","source":"save_plan_tool","payload":{"reason":"...","source":"..."},"ts":"ISO8601"}
{"type":"task_updated","taskId":"1.1","status":"completed","ts":"ISO8601"}
{"type":"task_status_changed","taskId":"1.1","status":"completed","ts":"ISO8601"}
{"type":"task_reordered","taskId":"1.1","afterTaskId":"1.2","ts":"ISO8601"}
{"type":"phase_completed","phase":1,"ts":"ISO8601"}
{"type":"snapshot","data":{"plan":{...},"payload_hash":"abc123"},"ts":"ISO8601"}
{"type":"plan_rebuilt","source":"rebuildPlan","plan_id":"...","payload":{"reason":"ledger_replay_recovery | approved_snapshot_fallback | validation_failure_recovery | ...","phases_count":1,"tasks_count":3},"ts":"ISO8601"}
{"type":"plan_exported","path":".swarm/plan-export/SWARM_PLAN.json","ts":"ISO8601"}
{"type":"plan_reset","ts":"ISO8601"}
{"type":"execution_profile_set","data":{"execution_profile":{...}},"ts":"ISO8601"}
{"type":"execution_profile_locked","ts":"ISO8601"}
{"type":"task_status_changed","taskId":"1.1","from_status":"in_progress","to_status":"closed","source":"close_terminal","ts":"ISO8601"}
{"type":"phase_completed","phase":1,"source":"close_terminal","ts":"ISO8601"}
{"type":"snapshot","source":"close_terminal","data":{"plan":{...},"payload_hash":"abc123"},"ts":"ISO8601"}
```

### Task removal contract (v7.19.0+)

As of v7.19.0 (issue #853), `savePlan` is non-destructive by default. Any
task present in the prior plan but absent from the incoming plan must be
acknowledged explicitly via `options.acknowledged_removals.ids` with a
non-empty `reason`. Unacknowledged removals throw
`PlanTaskRemovalNotAcknowledgedError`.

- The architect-facing `save_plan` tool exposes three optional args:
  `removed_task_ids`, `removal_reason`, and `confirm_destructive_reset`.
  The tool layer rejects (`PLAN_TASK_REMOVAL_NOT_ACKNOWLEDGED`) before
  reaching the manager when an acknowledgement is missing or invalid.
- Recovery paths use `savePlanWithAutoAcknowledgedRemovals(dir, plan,
  source, reason)`, which diffs on-disk vs incoming and auto-populates
  `acknowledged_removals`. Callers: `loadPlan` migrate-from-md, ledger
  replay rebuild, approved-snapshot recovery, `importCheckpoint`,
  `phase-complete` rebuild.
- Source tags identify the caller on each `task_removed` event:
  `save_plan_tool`, `load_plan_migration_from_md`,
  `load_plan_rebuild_from_ledger`,
  `load_plan_recovery_from_approved_snapshot`, `import_checkpoint`,
  `phase_complete_rebuild_from_ledger`.

### Replay semantics

`task_added` is audit-only on replay (the corresponding task already lives
in the `plan_created`/`snapshot` payload). `task_removed` is **functional**
on replay: `applyEventToPlan` splices the task out of the active phase.
This is required for crash-window durability — the ledger event is
committed before the atomic `plan.json` rename, so a process death between
the two leaves `plan.json` stale. Rebuild-from-ledger therefore has to
honour the removal; otherwise the resurrected task silently violates the
exact durability invariant this audit chain exists to enforce. The event's
`plan_hash_after` matches the post-removal plan, so determinism is
preserved.

### Schema version

`LEDGER_SCHEMA_VERSION` was bumped from `1.0.0` → `1.1.0` with the
addition of `task_removed`. Older plugin readers throw on unknown event
types (the `applyEventToPlan` default branch). After upgrading, restart
any running OpenCode session so the new in-memory reader is loaded —
otherwise the first `task_removed` event written by the new plugin will
break ledger replay in the legacy process.

### Spec drift surfacing (v7.19.0+)

Three independent layers surface `.swarm/spec-staleness.json` proactively:

- **Layer A** (`src/hooks/system-enhancer.ts`,
  `buildSpecDriftAdvisory`): injects `[spec-drift]` system-prompt
  guidance after every `loadPlan` call inside
  `experimental.chat.system.transform`. Survives the single-system-
  message collapse. Discloses any `_midLoadRemovals` attached by recovery
  paths.
- **Layer B** (`src/hooks/guardrails/index.ts`, `enforceSpecDriftGate`):
  structurally blocks the `SPEC_DRIFT_BLOCKED_TOOLS` set (`save_plan`,
  `update_task_status`, `phase_complete`, `lean_turbo_run_phase`,
  `lean_turbo_acquire_locks`) while the staleness file exists. No cache
  — `/swarm acknowledge-spec-drift` is reflected immediately.

Spec reconciliation is crash-recoverable. Canonical `spec_write` (or the
separate human acknowledgement command) writes a PREPARED recovery record,
updates the ledger-backed plan hash, verifies the spec snapshot, appends one
idempotent audit event, commits the recovery record, and deletes the staleness
marker last. A retry resumes the same transition. `/swarm clarify` only enters
the dialogue mode; it does not mutate the plan hash or clear drift by itself.

## Exact-task workflow recovery

Task QA evidence carries an `exact-task-v1` workflow record with state,
generation, retry count, outcome, and transition identity. Accepted coder
mutations increment the generation and atomically invalidate prior pre-check,
reviewer, and test-engineer proof. Empty/no-mutation attempts only increment
bounded retry diagnostics. A failed or cancelled shared-root settlement that
left a safely attributed mutation still rotates the generation and enters
`rework_required`, so partial edits cannot retain stale QA proof. Durable
exact-task evidence is authoritative; session maps are bounded caches and
delegation chains cannot satisfy a completion gate.

Settled-task reopen is deliberately narrow. Architect-only
`update_task_status(force: true)` requires `expected_state`,
`expected_generation`, `target_state: "idle"`, a non-empty reason, and a caller
transition ID. Under plan-lock then task-evidence-lock ordering it writes a
PREPARED task-repair record before moving the ledger projection, clears only
that task's QA proof, appends one audited event, and commits. Retrying the same
transition lazily resumes that exact task; plugin initialization never scans
repair records.
- **Layer C** (`src/services/status-service.ts`): `/swarm status` renders
  a `**Spec drift detected**` line with stored/current hashes and the
  resolution commands.

## Rebuild / Import / Export

### Rebuild

`loadPlan()` detects a hash mismatch between the ledger and plan.json → replays all ledger events → writes fresh projections.

```
loadPlan()
  → computeLedgerHash() vs stored hash
  → if mismatch: replayLedger() → savePlan() → write plan.json + plan.md
```

### Import

`importCheckpoint()` reads `.swarm/plan-export/SWARM_PLAN.json` (with backward-compat fallback to flat `.swarm/` then project root, each with a deprecation warning) → validates schema → calls `savePlan()` → appends `plan_rebuilt` event to ledger.

```
importCheckpoint(.swarm/plan-export/SWARM_PLAN.json)
  → validateSchema()
  → savePlan(planData)
  → append {type:"plan_rebuilt"} to plan-ledger.jsonl
```

### Export

`writeCheckpoint()` is called on:
- `save_plan` command
- `phase_complete` command  
- `/swarm close` command

Writes `.swarm/plan-export/SWARM_PLAN.md` and `.swarm/plan-export/SWARM_PLAN.json` inside the working directory's `.swarm/plan-export/` subfolder.

## Snapshot System

Every **50 ledger events** and on `phase_complete`, a `snapshot` event is appended to the ledger itself:

```json
{"type":"snapshot","data":{"plan":{...},"payload_hash":"abc123"},"ts":"ISO8601"}
```

Snapshot events embed the full Plan payload and its `payload_hash`. During `loadPlan()`, `replayFromLedger()` scans for the latest snapshot event and uses it as the base state, then replays only events after that snapshot. This avoids replaying the entire ledger on every load.

## Snapshot Retry (FR-004)

Snapshot writes (triggered every 50 ledger events and on `phase_complete`) use a bounded retry helper in both `save-plan.ts` and `manager.ts`:

- **Retries**: Up to 3 attempts with exponential backoff (10ms, 20ms, 40ms)
- **Non-fatal**: Exhausted retries log a visible `console.warn` but do not block the save operation
- **Telemetry**: Emits `snapshot_failed` event with `{ error, retries, source }` after all retries are exhausted
- **Sources**: Both `save_plan` tool and `savePlan` manager layer independently retry their own snapshot calls

## Terminal Plan State Write — `/swarm close` Managed Path (Phase 2)

The `/swarm close` command uses `closePlanTerminalState()` (`src/plan/manager.ts`) to write terminal plan state through the managed ledger-first path instead of raw filesystem writes.

### Write sequence

1. **PlanSchema validation** — plan is validated before any ledger events or file writes; invalid plans rejected early with no side effects
2. **Terminal ledger events** — for each closed task: `task_status_changed` with `from_status` preserved (from the original status map); for each closed phase: `phase_completed`
3. **Terminal snapshot** — `takeSnapshotEvent` called with `source: 'close_terminal'` to embed final closed statuses in the ledger
4. **Atomic plan.json write** — temp+rename pattern (`.plan.json.close.{timestamp}`)
5. **Atomic plan.md write** — with `<!-- PLAN_HASH: ... -->` comment for sync detection
6. **Write-marker update** — `.plan-write-marker` refreshed with `source: 'plan_manager_close'` for `PlanSyncWorker` compatibility

### How it differs from `savePlan`

| Aspect | `savePlan` | `closePlanTerminalState` |
|--------|------------|------------------------|
| CAS protection | Yes (retry with backoff) | No (no concurrent writer during close) |
| Task status re-derivation | Yes (phase statuses recomputed) | No (terminal state pre-applied by caller) |
| Execution profile enforcement | Yes | No |
| Ledger events | `task_status_changed`, `task_removed` | `task_status_changed` (source: `close_terminal`), `phase_completed` |
| Snapshot | Every 50 events + phase_complete | Terminal snapshot on close |

### Crash/restart recovery

If the process crashes during `/swarm close` after ledger events are appended but before plan file writes complete, the next `loadPlan()` call detects the hash mismatch and rebuilds plan files from the ledger, recovering the terminal state.

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
| `max_concurrent_tasks` | integer 1–64 | `10` | Max simultaneous tasks when parallel is enabled |
| `council_parallel` | boolean | `true` | Allows council review phases to parallelise |
| `locked` | boolean | `false` | When true, profile is immutable (fail-closed enforcement) |
| `auto_proceed` | boolean | `false` | Advances across phase boundaries without another prompt |
| `commit_after_each_completed_task` | boolean | `false` | Requests a checkpoint after successful task completion and pre-commit gates |
| `planning_profile` | `balanced` \| `strict` | repository policy | Selects balanced defaults or strict planning ceremony |

### Invariants

- **Locked profile is immutable except for one safety ratchet**: `planning_profile` may move from `balanced` to `strict`; `strict` to `balanced` and every other locked-profile change are rejected. Locked legacy profiles without `planning_profile` resolve conservatively to effective `strict`.
- **Fail-closed enforcement**: the delegation gate enforces a locked profile — `parallelization_enabled: false` blocks Stage B parallel dispatch regardless of global plugin config.
- **Ledger authority**: profile changes are recorded as `execution_profile_set` / `execution_profile_locked` events. Replay rebuilds the profile deterministically from these events.
- **Hash coverage**: `execution_profile` is included in ledger, structure, and Markdown content hashes, so profile-only changes update the ledger chain and invalidate stale projections. An explicit `planning_profile: strict` remains distinct from an omitted legacy field (and from explicit `balanced`) in every hash and projection. Backward compatibility for a locked legacy omission is applied only by the planning-profile resolver; it never erases a real `balanced` → `strict` change from durable identity.
- **All surfaces carry the profile**: snapshot events, checkpoint export (`.swarm/plan-export/SWARM_PLAN.json`), handoff data, export data, and `get_approved_plan` output all include `execution_profile`.

### Lifecycle

```
1. Architect drafts task scopes and freezes the exact `swarm_id` plus plan title.
2. In `strict`, the architect presents the unified questionnaire and persists the selected QA profile with `set_qa_gates` against that identity before the first plan save. In `balanced`, it skips that ceremony and lets `save_plan` exact-bind the durable defaults.
   Upgraded legacy recovery: when a durable plan still points at an unbound legacy QA row, rerun `set_qa_gates` with the same exact `swarm_id`, `plan_title`, and `adopt_legacy_binding_only: true` to exact-bind the existing profile without changing gates or the lock.
3. Architect calls `save_plan` once with the same identity and the complete locked execution profile, including the resolved `planning_profile`, parallelism, auto-proceed, and checkpoint policy.
4. Ledger records `execution_profile_set` and `execution_profile_locked` events.
5. Delegation and execution protocols read the durable profile; transient `.swarm/context.md` sections are not an execution-policy authority.
6. Critic drift verifier checks for profile drift via `get_approved_plan`.
7. To change a locked profile: use `save_plan` with `reset_statuses: true` to start fresh.
```

### Round-trip surfaces

| Surface | Carries execution_profile? |
|---------|--------------------------|
| `plan.json` | ✅ Persisted in schema |
| `plan.md` | ✅ Complete human-readable projection, content-hash protected |
| Ledger replay | ✅ Via `execution_profile_set` events |
| Snapshot events | ✅ Embedded in Plan payload |
| `.swarm/plan-export/SWARM_PLAN.json` checkpoint | ✅ Via full Plan payload |
| `get_approved_plan` tool | ✅ Explicit `execution_profile` field |
| Handoff data | ✅ In `HandoffData.execution_profile` |
| Export data | ✅ In `ExportData.execution_profile` |

## Task Field: `fr_refs` (Issue #1687)

**v7.x** added an optional `fr_refs: string[]` field to `TaskSchema`, recording which spec `FR-###`/`SC-###` requirement IDs a task maps to. It exists so a delegation step can mechanically retrieve a task's originating spec requirement instead of relying on free-text prose in `description`/`acceptance`.

### Design decision: reference IDs, not a text snapshot

`fr_refs` stores requirement **IDs** only. The requirement's full text is resolved **live** against the current `.swarm/spec.md` at delegation time, not snapshotted into the task when the plan is saved. A snapshot would itself be a second, driftable copy of the spec text — exactly the class of problem `fr_refs` exists to eliminate. The existing spec-staleness machinery (`PlanSchema.specHash`/`specMtime`, `_specStale`) already detects "spec.md changed after the plan was saved," so live-resolution reuses an established pattern rather than introducing a new one.

### Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `fr_refs` | `string[]` | `undefined` (optional, **not** `.default([])`) | Spec `FR-###`/`SC-###` IDs this task maps to |

**Why `.optional()` and not `.default([])`:** unlike `depends`/`files_touched` (which default to `[]`), `fr_refs` must serialize to `undefined` — omitted entirely by `JSON.stringify` — for tasks that don't set it, not an empty array. This preserves byte-for-byte hash stability for every plan persisted before this field existed (see "Hash coverage" below).

### Hash coverage — deliberately EXCLUDED

Unlike `execution_profile` (which IS included in `computePlanHash`), `fr_refs` is **deliberately excluded** from `computePlanHash`, `computePlanStructureHash` (`src/plan/ledger.ts`), and `computePlanContentHash` (`src/plan/manager.ts`). All three hash functions build an explicit, named field list and do not reference `fr_refs`; each site carries a one-line code comment recording this exclusion so a future reader doesn't "fix" the omission. This means editing a task's `fr_refs` after critic approval does not change the plan's structural hash and does not re-trip `assertPlanCriticApprovedForExecution` — an intentional consequence of treating `fr_refs` as additive metadata, not structural plan content.

### Round-trip surfaces

| Surface | Carries `fr_refs`? |
|---------|--------------------------|
| `plan.json` | ✅ Persisted in schema |
| Ledger replay / snapshot embed | ✅ Rides the existing generic whole-`Plan`-object embed — no field-by-field wiring needed |
| `checkpoint.ts` import/export | ✅ Passes through generically via `PlanSchema.parse` |
| `get_approved_plan` tool | ✅ Passes through generically (`plan: unknown` payload) |
| `computePlanHash` / `computePlanStructureHash` / `computePlanContentHash` | ❌ Deliberately excluded (see above) |
| `migrateLegacyPlan` | Not applicable — legacy markdown plans predate this field |

## Scope Materialization at Worktree Paths (FR-102)

When Lean Turbo provisions a lane worktree, the task's declared scope is materialized at:

```
<worktreePath>/.swarm/scopes/binding-{taskId}-{bindingId}-{generationId}.json
```

This enables:
- **Restart recovery**: If a lane session is interrupted, the scope file survives on disk and can be recovered when the lane resumes or when orphan recovery cleans up.
- **Gitignore inheritance**: The worktree's `.gitignore` is set to include `.swarm/` paths from the host, preventing scope files from being committed to the lane branch.
- **Cross-lane scope verification**: The scope file is readable by tooling that needs to verify task scope containment without accessing the primary session state.

Each exact generation uses the same identity-bound v2 schema as the primary workspace:
```json
{
	"version": 2,
	"bindingId": "0f5e7c0e-41dc-4e78-9a42-53794a5db601",
	"generationId": "c2fd86ce-6a8e-4e7e-9b1d-2b5be04e4ea0",
	"revision": 1,
	"lifecycleState": "live",
	"workspaceIdentity": "/project/worktree",
	"taskId": "1.1",
	"ownerSessionId": "coder-session",
	"activation": "active",
	"files": ["src/auth.ts", "src/auth.test.ts"],
	"declaredAt": 1776024000000,
	"updatedAt": 1776024000000,
	"leaseStartedAt": 1776024000000,
	"expiresAt": 1776027600000
}
```

### Active scope leases and recovery codes

Declarations and pending dispatch records have a bounded inactivity lifetime. Claiming or deriving an active child starts a fresh bounded lease instead of inheriting the declaration's remaining deadline. After a write passes every identity, scope, containment, and authority check and the tool succeeds, the runtime refreshes that exact binding generation with a revision-checked update. A stale revision, different session/task/root, failed tool call, or already expired generation cannot renew authority.

Expiry remains fail-closed. The runtime retains bounded expiry tombstones so restart recovery can identify the expired binding generation and report its `expiredAt` time. The architect must re-read the current task, call `declare_scope` with the exact workspace-relative list and `replace_existing: true`, then dispatch a new Task call. Cleanup and replacement retire only exact generations; ambiguity never selects an enumeration-order winner.

Scope and effective-authority denials use stable recovery codes:

| Code | Meaning and reachable recovery |
|------|--------------------------------|
| `SCOPE_NOT_DECLARED` | No exact active generation authorizes this session/task. The architect declares the exact task scope and dispatches a new Task call. |
| `SCOPE_BINDING_EXPIRED` | The reported generation expired at the reported time. The architect replaces the declaration, then redispatches. |
| `SCOPE_BINDING_AMBIGUOUS` | Multiple exact live generations match. The architect reconciles/replaces them; the runtime never picks one by order. |
| `SCOPE_BINDING_PERSISTENCE_FAILED` | The durable write, verification, lock, or rollback transaction failed. Do not retry the write through another mechanism; fix the reported storage failure, then have the architect replace the declaration and redispatch. |
| `SCOPE_BINDING_CAPACITY` | The bounded live-binding admission capacity is exhausted or the candidate is no longer admissible. Finish or expire terminal tasks, then have the architect declare and dispatch again. |
| `SCOPE_BINDING_ALREADY_CLAIMED` | This exact Task dispatch already belongs to another child session. Continue with that child or have the architect create a new Task dispatch; never reuse the claimed dispatch identity. |
| `SCOPE_BINDING_STORE_OVERLOADED` | The complete durable set exceeded its bounded scan/admission budget. Finish or expire terminal tasks before retrying declaration. |
| `SCOPE_BINDING_STALE` | The generation identity or revision changed, was retired, or is no longer the exact active generation. Stop using the stale child; the architect re-reads current task state, replaces the declaration, and dispatches a new Task call. |
| `SCOPE_WORKSPACE_MISMATCH` | An otherwise plausible binding belongs to another lane/root. Use the reported active root and workspace-relative paths. |
| `SCOPE_ROOT_ESCAPE` | The target escapes the active root. Retry only the reported safe relative form; never authorize the outside absolute path. |
| `SCOPE_CONFLICT` | Explicit, plan, and/or `FILE:` sources disagree. Reconcile the named sets, update stale plan data, and replace the declaration. |
| `SCOPE_VIOLATION` | The target is outside the active exact scope. Correct the target or have the architect declare the exact intended path and redispatch. |
| `AUTHORITY_INVALID_PATH` / `AUTHORITY_ROOT_ESCAPE` | Static path validation or authority containment failed. Correct the path/root; declaration cannot override this layer. |
| `AUTHORITY_UNIVERSAL_DENY` / `AUTHORITY_PROTECTED_PATH` / `AUTHORITY_VERIFIER_CONFIG` | A hard protected policy denied the target. Assign the operation to the supported owner or change the task; scope cannot override it. |
| `AUTHORITY_ROLE_READ_ONLY` / `AUTHORITY_UNKNOWN_AGENT` / `AUTHORITY_POLICY_DENY` | The acting role cannot perform the write under immutable capability or enabled role policy. Use the responsible writable role or revise policy/task intent. |

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
| View worktree lanes | `/swarm lanes [--json]` |
| Recover orphaned worktrees | Automatic on session start (see [Recovery Runbook](troubleshooting/recovery-guide.md)) |
