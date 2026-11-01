/**
 * Leaf module (issue #3260): the ONE source for the unlink/teardown retry
 * schedule and the clean-stage deadline.
 *
 * Deliberately import-free so `tests/helpers/safe-test-dir.ts` can consume the
 * schedule without pulling the close-command module graph (repo-graph storage,
 * guardrails) into every test consumer. `src/commands/close/constants.ts`
 * re-exports both constants, so existing importers (and the frozen acceptance
 * checks) keep resolving unchanged.
 */

/**
 * Per-artifact retry delay schedule for unlinking archived active-state files.
 *
 * Sums to 15,175 ms — sized (PR #3254, issue #3248) to the instrumented
 * windows-latest Bun-sqlite handle-release tail (~11 s, bimodal: ~5 ms or
 * ~11 s) plus margin. The test-teardown helper `safeRmRecursive` consumes the
 * SAME schedule so the two budgets can never diverge again (that divergence —
 * a ~9.9 s teardown window against this ~15.2 s production schedule — is the
 * #3260-A defect).
 */
export const ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS = [
	25, 50, 100, 200, 400, 600, 800, 1000, 1000, 1000, 1000, 1000, 1000, 1000,
	1000, 1000, 1000, 1000, 1000, 1000,
] as const;

/**
 * Clean-stage admission deadline (issue #3260-B): once this much time has
 * elapsed inside `runCleanStage`, no FURTHER active-state artifact is admitted
 * to the per-artifact unlink retry (each admission can add up to one full
 * schedule above). This is an admission budget, not a wall-clock cap on the
 * whole stage: worst case is this deadline plus one in-flight artifact
 * schedule plus pre-unlink database-closure work. Skipped artifacts are left
 * in place (their archive copies exist) with one bounded warning.
 *
 * Overridable for operators/tests via SWARM_CLEAN_STAGE_DEADLINE_MS (invalid
 * or non-positive values fall back to this default).
 */
export const CLEAN_STAGE_DEADLINE_MS = 60_000;
