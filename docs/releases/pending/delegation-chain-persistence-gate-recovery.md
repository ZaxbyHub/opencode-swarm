# Delegation Chain Persistence and Gate Recovery Hardening

## Overview

Four fixes that harden the crash-recovery path so that the reviewer and test_engineer gates survive process death without false negatives:

1. **Evidence-file fallback for delegation chains** — `recoverTaskStateFromDelegations` now falls back to reading durable evidence files when in-memory delegation chains are empty. This handles the case where a session crashes after the reviewer/test_engineer gates are recorded to disk but before the state machine advances.

2. **Recovery session seeding** — When `agentSessions` is empty after a crash (no snapshot rehydration), `recoverTaskStateFromDelegations` now creates a minimal recovery session so that evidence-backed recovery takes effect instead of silently no-oping.

3. **Enriched gate diagnostics** — `checkReviewerGate` now includes delegation chain summary, rehydrated session count, and structured evidence status in its blocked reason, making it faster to debug why a task is incorrectly blocked.

4. **fsyncSync durability guarantee** — `writeSnapshot` now calls `fsyncSync` on the temp file before the atomic rename, ensuring that power-loss or `kill -9` cannot leave a zero-length or partial canonical state file. Best-effort on tmpfs/ramdisk.

5. **Stage B completion snapshot persistence (Phase 2)** — `stageBCompletion: Map<string, Set<'reviewer' | 'test_engineer'>>` is now serialized to `Record<string, string[]>` in snapshots and deserialized back to the typed Map on rehydration. Backward compatible: old snapshots without the field deserialize to an empty Map. Conditionally omitted from serialized output when empty.

6. **Phase 3 regression verification** — SC-001 crash-recovery integration test (`update-task-status-recovery.test.ts`) proves `update_task_status` succeeds after a simulated crash when only evidence files remain. All 141 recovery-related tests pass across 5 test files (update-task-status, update-task-status-recovery, snapshot-writer, snapshot-reader, snapshot-stageBCompletion), confirming no regression to FR-006 (gate recovery).

## Breaking Changes

None.

## Bug Fixes

- `src/tools/update-task-status.ts`: `recoverTaskStateFromDelegations` — added evidence-file fallback (Pass 2) when delegation chains yield nothing; added session seeding when `agentSessions.size === 0` before advancing state
- `src/tools/update-task-status.ts`: `checkReviewerGate` — enriched diagnostic messages with delegation chain summary, rehydrated session count, and structured evidence status
- `src/session/snapshot-writer.ts`: `writeSnapshot` — added `fsyncSync` call on temp file before atomic rename (FR-004)
- `src/session/snapshot-writer.ts`: `serializeAgentSession` — added Map→Record serialization for `stageBCompletion` (conditional spread, omitted when empty)
- `src/session/snapshot-reader.ts`: `deserializeAgentSession` — added Record→Map deserialization for `stageBCompletion` typed as `Set<'reviewer' | 'test_engineer'>`

## Tests

- `tests/unit/tools/update-task-status-recovery.test.ts` — new file with 21 tests: 7 delegation-chain recovery tests, 5 session-seeding tests, 5 adversarial injection/edge-case tests, 1 path-traversal documentation test, 3 gate-state tests, and the SC-001 crash-recovery integration test proving `update_task_status` succeeds after simulated crash with only evidence files
- `tests/unit/tools/update-task-status.test.ts` — assertion updates for new diagnostic fields in gate blocked reason
- `tests/unit/session/snapshot-writer.test.ts` — new fsync tests covering: successful fsync, fsync error (best-effort), missing temp file (best-effort)
- `tests/unit/session/snapshot-stageBCompletion.test.ts` — new file, 7 tests covering: full round-trip, empty Map, missing field (backward compat), undefined field, empty task entries, mixed task entries, deserialized Set is properly typed
