# `fix(workflow)`: test-engineer-exempt tasks no longer wedge at `reviewer_run` with "all required proof exists"

## Summary

- A task with the durable, receipt-backed `test_engineer_exempt` proof (a docs-only change proven by declared+observed Markdown-only attribution at coder settlement) could never complete: its dispatch-time review route receipt still demanded the complexity-routed test-engineer count (`routeReview` always routes ≥ 1), the Stage-B completeness barrier (`requireCompleteEvidence`) then permanently failed with `ROUTE_RECEIPT_INCOMPLETE`, and the durable workflow pinned at `reviewer_run`. `update_task_status` reported `Missing gates: []` / `Contradictions: [all required proof exists but workflow state is reviewer_run]`, and even the human-only `/swarm recover` could not advance the wedge (Stage A was already passed → `skipped_not_wedged`).
- Root cause: three route surfaces ignored the sanctioned exemption —
  1. route allocation (`delegation-gate.ts`) demanded the routed test-engineer count from observed complexity, with no path for the durable exemption to zero it (the anti-forgery comment rejects self-proving from observed attribution, but the durable `test_engineer_exempt` proof IS the independent declared-scope signal the comment demands);
  2. the completeness barriers at settlement (`stage-b-gates.ts` persistence + advancement, `delegation-gate.ts` foreground settlement, `update-task-status.ts` completion and recovery sync) demanded every listed slot;
  3. the recovery sync advanced `reviewer_run → tests_run` only when a test-engineer completion existed — false by definition for an exempt task.
- Fix: the durable exemption now flows through every surface. Route allocation routes zero test-engineer slots for a durably exempt task (observed attribution alone still cannot self-prove one — that anti-forgery property is unchanged). `enforceReviewRouteReceipt`/`enforcePersistedReviewRouteReceipt` accept `testEngineerExempt`, and the completeness barrier then covers only the reviewer identities (identity/role/duplicate validation stays fully authoritative). The exempt-aware `(testEngineerExempt && agent === 'reviewer')` advancement clause now actually fires, and `recoverTaskStateFromDelegations` advances an exempt `reviewer_run` task from the reviewer proof alone.

## User-facing changes

- Documentation-only (Markdown-only) swarm tasks complete normally after the reviewer approves: the route receipt requires no test engineer, the durable workflow advances `reviewer_run → tests_run`, and `update_task_status` admits the completion. No `/swarm recover` needed.
- A task wedged by a pre-fix receipt (e.g. `reviewer_run` with all proof present) unwedges through the documented path: re-dispatch the reviewer (admitted from `reviewer_run`); the fresh, exemption-aware receipt completes and the durable state advances.
- Non-exempt tasks are unaffected: the full reviewer + test_engineer pair remains required, and a fully-satisfied route is not changed by the flag.

## Migration notes

None required. Route receipts already on disk that list test-engineer slots for an exempt task are honored by the exemption-aware completeness barrier; new receipts for exempt tasks are allocated without test-engineer slots.

## Discovery context

Found in the Wirtschaftssimulation loop (session `29b8ccea-6226-4e7d-821a-4486276d1f20`, task 1.8): the task's scope was exclusively `AGENTS.md`, the durable evidence proved `test_engineer_exempt: true` with `required_gates: ["reviewer"]` (both satisfied), but the persisted route receipt for the dispatching session demanded 1 reviewer + 1 test engineer, so `routeCompleteForPersistence` was `false` and the workflow stayed at `reviewer_run` after the reviewer's APPROVED verdict. Pinned by four regression tests: `tests/unit/review/routing-enforcement-test-engineer-exempt.test.ts` (completeness semantics, including the unlisted-identity and missing-reviewer fail-closed pins), `tests/unit/hooks/review-route-exempt-allocation.test.ts` (allocation zeroing with a non-exempt control), `tests/unit/background/stage-b-doc-only.test.ts` (the production wedge shape: TE-demanding receipt + exempt evidence → durable `tests_run`), and `tests/unit/tools/update-task-status-exempt-recovery.test.ts` (recovery advancement with a non-exempt control). All four fail on the pre-fix source and pass with the fix.

Also fixed in the same pass (test stability, no runtime change): the `#3509` route suites (`tests/unit/hooks/review-route-enotdir-3509.test.ts`, `tests/unit/hooks/delegation-gate-review-route-persist-failure.test.ts`) flaked with `INVALID_TASK_STATE_TRANSITION: … coder_delegated → coder_delegated` because `ensureAgentSession(…, dir)` fires an async `rehydrateSessionFromDisk` that can land mid-fixture and overwrite the session's workflow view with a mid-seed durable state before the fixture's manual `advanceTaskState`. The fixtures now drain `swarmState.pendingRehydrations` right after session creation, before any durable seeding (12/12 consecutive green runs where the flake previously hit ~every other run).
