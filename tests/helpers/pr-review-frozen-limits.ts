/**
 * Issue #2585 (Roadmap H8, AC12) — frozen numeric ceilings for the
 * controlled-failure PR-review fixtures (R12 abort recovery, R14 evidence-read
 * repair).
 *
 * Every controlled-failure fixture imports these ceilings and asserts its
 * MEASURED totals (attempts, host launches, wall-clock ms) against them, so
 * "bounded" is a number the run can be checked against rather than a claim.
 * The values are deliberately generous (~10x the expected per-run totals) so
 * the wall-clock legs stay non-flaky on the slowest CI runner; the fixtures
 * prove boundedness, not tightness.
 *
 * `.agents/issue-traces/2585-default-path-pr-review-completion/repro/frozen-limits.json`
 * carries the same values as the committed manifest under identical key names;
 * `tests/unit/pr-review/frozen-limits-manifest-2585.test.ts` (C18) asserts the
 * two never drift. Plain exported constants only: no clock reads, no I/O.
 */

/** Max abort/recovery tool invocations one R12 run may need before settling. */
export const MAX_ABORT_RECOVERY_ATTEMPTS = 50;
/** Max child sessions the host may launch across one R12 run. */
export const MAX_ABORT_RECOVERY_HOST_LAUNCHES = 50;
/** Max wall-clock budget (ms) for one R12 run, measured end to end. */
export const MAX_ABORT_RECOVERY_WALL_CLOCK_MS = 120_000;

/** Max completion/repair attempts one R14 run may need before a terminal outcome. */
export const MAX_EVIDENCE_REPAIR_ATTEMPTS = 50;
/** Max child sessions the host may launch across one R14 run. */
export const MAX_EVIDENCE_REPAIR_HOST_LAUNCHES = 50;
/** Max wall-clock budget (ms) for one R14 run, measured end to end. */
export const MAX_EVIDENCE_REPAIR_WALL_CLOCK_MS = 120_000;

/**
 * The frozen limits as one plain record, keyed exactly like the committed
 * manifest. The C18 drift guard deep-equals this against the JSON file.
 */
export const PR_REVIEW_FROZEN_LIMITS = {
	MAX_ABORT_RECOVERY_ATTEMPTS,
	MAX_ABORT_RECOVERY_HOST_LAUNCHES,
	MAX_ABORT_RECOVERY_WALL_CLOCK_MS,
	MAX_EVIDENCE_REPAIR_ATTEMPTS,
	MAX_EVIDENCE_REPAIR_HOST_LAUNCHES,
	MAX_EVIDENCE_REPAIR_WALL_CLOCK_MS,
} as const;

export type PrReviewFrozenLimitKey = keyof typeof PR_REVIEW_FROZEN_LIMITS;
