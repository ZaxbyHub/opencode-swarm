/**
 * Issue #2349 — how the new terminal-error settle interacts with the #2297
 * correlated-failure circuit.
 *
 * Settling with a populated `result.error` newly feeds
 * `classifyTerminalFailureSignature`, which groups on the WHOLE reason string
 * (not the category) and normalizes it to a bounded window. Three properties
 * must hold, and none of them is safe to establish by inspection:
 *
 *  1. CONVERGENCE — N lanes killed by one provider outage must collapse to ONE
 *     signature, or the circuit fragments and never trips.
 *  2. NO FALSE TRIP — a user-initiated mass-cancel must not look like a provider
 *     incident, because `cancelled` is itself a terminal failed status.
 *  3. BUCKET MIGRATION — the fix moves wedged lanes OUT of the coarse
 *     `terminal-zero-output:*` bucket into specific `terminal-error-output:*`
 *     ones. That splits a bucket that previously converged, so the circuit can
 *     trip LESS than before — the opposite direction from (1) and (2), and the
 *     one an "are we over-tripping?" test would never catch.
 */
import { describe, expect, test } from 'bun:test';
import { _test_exports } from '../../../src/hooks/pr-workflow-gate.js';

const TEST_TIMEOUT_MS = 15_000;
const classify = _test_exports.classifyTerminalFailureSignature;

/** Minimal terminal record shaped the way the settle path writes one. */
function settledRecord(options: {
	status: string;
	error?: string;
}): Record<string, unknown> {
	const error = options.error;
	return {
		status: options.status,
		result:
			error === undefined
				? undefined
				: {
						error,
						chars: error.length,
						truncated: false,
						digest: 'digest-placeholder',
					},
	};
}

/**
 * The reason format the settle path composes: discriminating content
 * (category, provider message) FIRST, constant `kind`/`name` tail LAST.
 */
function reason(options: {
	category: string;
	message: string;
	kind: string;
	name: string;
}): string {
	return `${options.category}: ${options.message} [kind=${options.kind} name=${options.name}]`;
}

describe('terminal-error settle vs the #2297 circuit (issue #2349)', () => {
	test(
		'property 1 — CONVERGENCE: many lanes, one quota outage, one signature',
		() => {
			// Five lanes killed by the same provider condition. Each is a distinct
			// lane with its own record; the reason text is identical because the
			// underlying condition is identical.
			const signatures = new Set(
				Array.from({ length: 5 }, () =>
					classify(
						settledRecord({
							status: 'error',
							error: reason({
								category: 'provider.quota_billing',
								message: "you've reached your usage limit for this billing cycle",
								kind: 'provider',
								name: 'APIError',
							}),
						}) as never,
					),
				),
			);

			expect(signatures.size).toBe(1);
			expect([...signatures][0]).toContain('terminal-error-output:error:');
			expect([...signatures][0]).toContain('provider.quota_billing');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'property 1b — the 160-char window cannot truncate away the discriminator',
		() => {
			// Two genuinely DIFFERENT conditions whose provider messages share a long
			// common prefix. Because the category leads, they must not collapse.
			const longShared = 'x'.repeat(140);
			const quota = classify(
				settledRecord({
					status: 'error',
					error: reason({
						category: 'provider.quota_billing',
						message: longShared,
						kind: 'provider',
						name: 'APIError',
					}),
				}) as never,
			);
			const auth = classify(
				settledRecord({
					status: 'error',
					error: reason({
						category: 'provider.authentication_configuration',
						message: longShared,
						kind: 'provider',
						name: 'ProviderAuthError',
					}),
				}) as never,
			);

			expect(quota).not.toBe(auth);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'property 2 — NO FALSE TRIP: mass-cancel is distinguishable from a provider incident',
		() => {
			const cancelled = classify(
				settledRecord({
					status: 'cancelled',
					error: reason({
						category: 'provider.cancelled',
						message: 'aborted by user',
						kind: 'aborted',
						name: 'MessageAbortedError',
					}),
				}) as never,
			);
			const quotaDead = classify(
				settledRecord({
					status: 'error',
					error: reason({
						category: 'provider.quota_billing',
						message: 'usage limit reached',
						kind: 'provider',
						name: 'APIError',
					}),
				}) as never,
			);

			// Different status AND different discriminator, so a wave of user
			// cancellations cannot be counted as the same failure as a quota outage.
			expect(cancelled).not.toBe(quotaDead);
			expect(cancelled).toContain(':cancelled:');
			expect(cancelled).toContain('kind=aborted');
			expect(quotaDead).toContain(':error:');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'property 3 — BUCKET MIGRATION: settled-with-reason leaves the coarse zero-output bucket',
		() => {
			// BEFORE the fix a wedged lane reached the circuit (if at all) only as a
			// reasonless `stale` record — the coarse bucket that lumps every cause
			// together.
			const beforeFix = classify(
				settledRecord({ status: 'stale' }) as never,
			);
			expect(beforeFix).toBe('terminal-zero-output:stale');

			// AFTER the fix the same lane carries its reason, so it lands in a
			// specific bucket. This is a deliberate SPLIT of a previously-converging
			// bucket: two lanes that died of DIFFERENT causes no longer share a
			// signature, which means the circuit can trip less readily than before.
			// Pinned explicitly so the tradeoff is a decision, not a surprise.
			const quotaDead = classify(
				settledRecord({
					status: 'error',
					error: reason({
						category: 'provider.quota_billing',
						message: 'usage limit reached',
						kind: 'provider',
						name: 'APIError',
					}),
				}) as never,
			);
			const authDead = classify(
				settledRecord({
					status: 'error',
					error: reason({
						category: 'provider.authentication_configuration',
						message: 'invalid api key',
						kind: 'provider',
						name: 'ProviderAuthError',
					}),
				}) as never,
			);

			expect(quotaDead).not.toBe(beforeFix);
			expect(quotaDead).not.toBe(authDead);
			// The convergence that matters is preserved: same cause still converges
			// (property 1), so a real single-cause outage still trips.
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'a settled record with a reason never falls into the zero-output branch',
		() => {
			// `chars: reason.length > 0` is what keeps the classifier on the
			// error-output branch; a zero-chars result would silently regress into
			// the coarse bucket and lose the diagnosis.
			const signature = classify(
				settledRecord({
					status: 'error',
					error: reason({
						category: 'provider.unavailable',
						message: 'overloaded',
						kind: 'provider',
						name: 'APIError',
					}),
				}) as never,
			);

			expect(signature).toContain('terminal-error-output:');
			expect(signature).not.toContain('terminal-zero-output:');
		},
		TEST_TIMEOUT_MS,
	);
});
