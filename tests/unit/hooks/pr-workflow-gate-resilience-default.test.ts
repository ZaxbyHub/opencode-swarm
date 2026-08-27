import { describe, expect, test } from 'bun:test';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate';

/**
 * Issue #2381: pins the staged-resilience DEFAULT on the GATE resolution path.
 *
 * `snapshotPrReviewResiliencePolicy` previously hardcoded `enabled: true`. That
 * is reachable — `effectivePrReviewResiliencePolicy` falls back to it whenever a
 * gate state carries no recorded policy and no policy is supplied — so leaving
 * it at `true` after the schema default flipped to `false` would have
 * force-enabled staged admission for such callers and then hard-BLOCKed tier
 * M/L base dispatch, while the architect prompt now (correctly) tells the
 * controller not to emit stage metadata by default.
 *
 * The dispatch-side default-flip test drives `loadPluginConfig` through
 * `dispatch-lanes`, a different resolution path that never reaches this
 * function — so without this file the gate line is provably uncovered: reverting
 * it to `?? true` changed nothing across the whole resilience test corpus.
 */

const EMPTY_GATE_STATE = {} as Parameters<
	typeof gateInternals.effectivePrReviewResiliencePolicy
>[0];

describe('PR-review staged resilience default on the gate path (#2381)', () => {
	test('a gate state with no recorded policy and no requested policy defaults to DISABLED', () => {
		const policy = gateInternals.effectivePrReviewResiliencePolicy(
			EMPTY_GATE_STATE,
			undefined,
		);

		expect(policy.enabled).toBe(false);
		// The gate must not drift from the schema constant — that divergence is the
		// exact defect this pins.
		expect(policy.enabled).toBe(DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.enabled);
	});

	test('an explicitly enabled requested policy is still honored', () => {
		const policy = gateInternals.effectivePrReviewResiliencePolicy(
			EMPTY_GATE_STATE,
			{ ...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG, enabled: true },
		);

		expect(policy.enabled).toBe(true);
		// The flip must be a change of DEFAULT, never an unconditional disable.
		expect(policy.maxRetryAttemptsAfterInitial).toBe(2);
	});

	test('a policy already recorded on the gate state wins over the default', () => {
		// Upgrade-window behavior: a session that recorded `enabled: true` before
		// the flip keeps its snapshotted policy. Live-disable for an already
		// admitted session is issue #2382's scope, so this pins current intent
		// rather than asserting the eventual behavior.
		const state = {
			prReviewResilience: {
				policy: {
					enabled: true,
					canaryProbeMs: 300_000,
					statusProbeTimeoutMs: 2_000,
					correlatedFailureThreshold: 2,
					maxRetryAttemptsAfterInitial: 2,
				},
			},
		} as Parameters<typeof gateInternals.effectivePrReviewResiliencePolicy>[0];

		expect(
			gateInternals.effectivePrReviewResiliencePolicy(state, undefined).enabled,
		).toBe(true);
	});

	test('snapshotPrReviewResiliencePolicy tracks the schema default directly', () => {
		const snapshot = gateInternals.snapshotPrReviewResiliencePolicy(undefined);

		expect(snapshot).toEqual({
			enabled: DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.enabled,
			canaryProbeMs: DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.canary_probe_ms,
			statusProbeTimeoutMs:
				DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.status_probe_timeout_ms,
			correlatedFailureThreshold:
				DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.correlated_failure_threshold,
			maxRetryAttemptsAfterInitial:
				DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.max_retry_attempts_after_initial,
		});
	});
});
