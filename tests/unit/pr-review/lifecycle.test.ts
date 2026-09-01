import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_STALE_DELEGATION_TIMEOUT_MS,
	isPrReviewDiscoveryLaneMode,
	isPrReviewLaneMode,
	isPrReviewVerdictLaneMode,
	laneResultCreditableToGeneration,
	observerDiagnosticIsTerminalEvidence,
	PR_REVIEW_OBSERVER_DIAGNOSTIC_KINDS,
	presumedStaleLaneEligible,
	SWEEPABLE_PR_REVIEW_LANE_STATUSES,
} from '../../../src/pr-review/lifecycle.js';
import { DEFAULT_SWEEPABLE_DELEGATION_STATUSES } from '../../../src/background/pending-delegations.js';

describe('PR-review lane mode classification (issue #2385 lifecycle boundary)', () => {
	test('classifies PR-review lane modes', () => {
		expect(isPrReviewLaneMode('swarm-pr-review:base')).toBe(true);
		expect(isPrReviewLaneMode('swarm-pr-review:micro')).toBe(true);
		expect(isPrReviewLaneMode('swarm-pr-review:reviewer')).toBe(true);
		expect(isPrReviewLaneMode('swarm-pr-feedback:base')).toBe(false);
		expect(isPrReviewLaneMode(undefined)).toBe(false);
		expect(isPrReviewLaneMode('')).toBe(false);
	});

	test('discovery vs verdict lanes are disjoint', () => {
		expect(isPrReviewDiscoveryLaneMode('swarm-pr-review:base')).toBe(true);
		expect(isPrReviewDiscoveryLaneMode('swarm-pr-review:micro')).toBe(true);
		expect(isPrReviewDiscoveryLaneMode('swarm-pr-review:reviewer')).toBe(false);
		expect(isPrReviewVerdictLaneMode('swarm-pr-review:reviewer')).toBe(true);
		expect(isPrReviewVerdictLaneMode('swarm-pr-review:critic')).toBe(true);
		expect(isPrReviewVerdictLaneMode('swarm-pr-review:base')).toBe(false);
	});
});

describe('presumed-stale eligibility (single authority, recurrence class G-5)', () => {
	test('sweepable status set matches the delegation ledger sweepable set', () => {
		expect([...SWEEPABLE_PR_REVIEW_LANE_STATUSES].sort()).toEqual(
			[...DEFAULT_SWEEPABLE_DELEGATION_STATUSES].sort(),
		);
	});

	test('a lane below the horizon is never stale-eligible, even unresponsive', () => {
		expect(
			presumedStaleLaneEligible({
				status: 'running',
				ageMs: DEFAULT_STALE_DELEGATION_TIMEOUT_MS - 1,
				liveness: 'unresponsive',
			}),
		).toBe(false);
	});

	test('a sweepable-status lane past the horizon with unknown liveness is eligible', () => {
		expect(
			presumedStaleLaneEligible({
				status: 'running',
				ageMs: DEFAULT_STALE_DELEGATION_TIMEOUT_MS,
				liveness: 'unknown',
			}),
		).toBe(true);
	});

	test('an ALIVE lane is never stale-eligible regardless of age', () => {
		expect(
			presumedStaleLaneEligible({
				status: 'running',
				ageMs: DEFAULT_STALE_DELEGATION_TIMEOUT_MS * 10,
				liveness: 'alive',
			}),
		).toBe(false);
	});

	test('terminal or non-sweepable statuses are never stale-eligible', () => {
		for (const status of ['completed', 'error', 'cancelled', 'stale', 'consumed']) {
			expect(
				presumedStaleLaneEligible({
					status,
					ageMs: DEFAULT_STALE_DELEGATION_TIMEOUT_MS * 10,
					liveness: 'unknown',
				}),
			).toBe(false);
		}
	});

	test('a custom shorter horizon is honored', () => {
		expect(
			presumedStaleLaneEligible(
				{ status: 'pending', ageMs: 1_000, liveness: 'unresponsive' },
				1_000,
			),
		).toBe(true);
	});
});

describe('late-result acceptance (generation isolation)', () => {
	test('only results of the current generation are creditable', () => {
		expect(laneResultCreditableToGeneration(3, 3)).toBe(true);
		expect(laneResultCreditableToGeneration(2, 3)).toBe(false);
		expect(laneResultCreditableToGeneration(undefined, 1)).toBe(true);
		expect(laneResultCreditableToGeneration(undefined, 2)).toBe(false);
	});
});

describe('observer diagnostics (never terminal evidence)', () => {
	test('the closed vocabulary is exactly the six observer kinds', () => {
		expect(PR_REVIEW_OBSERVER_DIAGNOSTIC_KINDS).toEqual([
			'busy',
			'retry',
			'idle_unknown',
			'host_unavailable',
			'probe_error',
			'wait_expired',
		]);
	});

	test('every observer diagnostic kind is never terminal evidence', () => {
		for (const kind of PR_REVIEW_OBSERVER_DIAGNOSTIC_KINDS) {
			expect(observerDiagnosticIsTerminalEvidence(kind)).toBe(false);
		}
	});
});
