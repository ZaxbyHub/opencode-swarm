# Root-fix the async, timeout, and quota-batch flake family (issue #2478)

## What changed

Four CI/test-stability flake families are root-fixed instead of quarantine-hidden. The change is tests-and-ledger only — no production code was touched.

### dispatch-lanes timeout assertions (issues #2362 / #2368 / #2386)

The two hung-lane timeout tests pinned the literal elapsed milliseconds embedded in the timeout error message. The `session.prompt` and `session.promptAsync` messages embed the **deadline-derived remaining budget** (`deadlineAtMs - now()`, computed by `dispatchWithModelFallback` before the timeout fires), so under multi-file single-process load — or coverage instrumentation — the digits read `9` instead of the configured `10` and the assertion failed; those two pins now assert the message prefix (`expect.stringContaining('… timed out after')`), pinning the timeout path rather than the elapsed value. The two `session.create` timeout messages embed the configured `timeout_ms` (deterministic), so their exact-string assertions are retained unchanged. The `waitForBatchRecordStatus` helper's fixed 50×1ms polling loop (~50ms wall budget, routinely exceeded under load) was replaced with the repo's attempt-counting convention (10ms × 200 attempts ≥ 2s). The file's existing per-test `afterEach` restore remains the `_internals` seam-hygiene mechanism for multi-file single-process runs (an additionally planned `afterAll` belt-and-braces duplicate was dropped to keep the grandfathered 2430-line file inside the FR-006 growth ratchet — the afterEach restore is complete: production `_internals` exports every key the tests mutate).

### evaluation-runner and gate-utils timeout/temp races (issues #2330 / #2416 / #2449)

- `runner-failures.test.ts`: the per-task-deadline test's `performance.now() < 500ms` pin (deadline under test: 20ms) flipped on shared-runner stalls; it now uses a 5s semantic bound that still fails well before the run-level fallback if the deadline mechanism breaks. The real-subprocess scorer cases keep asserting output classification but with generous subprocess budgets (8s scorer / 10s task) so a cold child boot under load cannot masquerade as a timeout. All temp-dir cleanups use `safeRmRecursive` (EBUSY/EPERM-retrying, tmpdir-containment-guarded).
- `gate-utils.test.ts`: the non-Windows probe timeout (200ms) raced child cold-start — the exact class Windows already carried a 2s budget for; the probe now uses 2s on every platform, and the elapsed bound is derived from the actual contract (`timeout + 1s kill grace + 2s stall slack`) instead of platform-specific magic numbers. Cleanup uses `safeRmRecursive`.

### skill_improver "merge-group batch suppression" (issue #2396) — real root cause found

The #2396 theory (quota state polluted by batch order) is **disproven**: quota state was already per-directory and file-backed. The actual failure was a merge-combination regression — PR #2377's approval-gate enforcement met the integration test's stale `require_user_approval: true` config (no session-bound approval provided), so `runSkillImprover` fast-exited with `ran: false` in both failing queue runs on 2026-08-27. It was reproduced deterministically at the exact failing queue merge commit and had already been repaired on main by `75d47bd3c` (minutes after the failures); the interim quarantine kept hiding the green test from every merge-group run since. This change:

- removes the quarantine entry, restoring merge-group validation of the file. The un-quarantine is validated by the merge-group run that consumes it: the file is deterministically green on main (the historical failure was a since-fixed regression), so if it regressed the queue blocks the merge rather than hiding the failure;
- injects a per-call `now` (one fixed UTC day, 2026-09-02, with distinct second offsets per call) on every `runSkillImprover` invocation so the sequential quota calls can never straddle a UTC-midnight rollover — the one genuine live-clock hazard left in the file. (A global `freezeClock` spy was tried first and rejected: freezing `toISOString` collapses every run's proposal filename onto one timestamp, making consecutive successful runs overwrite each other's proposals; per-call injection protects the quota day while keeping proposal slugs distinct.); and
- adds a **batch-order independence test**: exhausting project root A's daily quota never suppresses a run in independent root B, pinning the per-directory quota-isolation invariant through the registered `runSkillImprover` path.

### Supersedes PR #2455

PR #2455 proposed quarantining `dispatch-lanes.test.ts`; it was closed unmerged and the general ledger stayed empty. This root fix supersedes that approach — no quarantine is needed.

## Known limitation (documented)

The integration job runs only on `merge_group` events, so ordinary PR CI never executes integration tests against merge combinations — the blind spot that let the #2377 regression reach the queue undetected. Redesigning the trigger is a CI-cost decision outside this issue; recorded here for the test-stability workstream.
