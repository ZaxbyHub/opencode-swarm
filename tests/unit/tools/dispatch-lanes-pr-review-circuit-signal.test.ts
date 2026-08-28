/**
 * Issue #2382 — the typed circuit-signal classifier and record adoption.
 *
 * The resilience circuit counts ONLY durable, typed `provider_terminal`
 * evidence: a lane settled `error` whose record carries
 * `terminalErrorClass.kind === 'provider'` (the SDK discriminator captured at
 * settle time). Everything else is an `ignored` kind that can never open,
 * reopen, or close the circuit, or no signal at all.
 *
 * Properties pinned here (successors of the #2349 signature properties):
 *  1. CONVERGENCE — N lanes killed by one provider outage classify to the SAME
 *     provider class, or the circuit fragments and never trips.
 *  2. NO FALSE TRIP — mass-cancel (`aborted`/`cancelled`), presumed-stale
 *     sweeps, parser-rejected empty completions, and pre-upgrade records
 *     without structured classification must never classify provider-terminal.
 *  3. ADOPTION — legacy unversioned circuit records migrate once to a
 *     nonblocking v2 CLOSED record with an evidence waterline; malformed
 *     records fail open with a bounded hash-only diagnostic.
 */
import { describe, expect, test } from 'bun:test';
import {
	adoptPrReviewCircuit,
	type PrReviewCircuitSignal,
} from '../../../src/hooks/pr-review-resilience-circuit.js';
import { _test_exports } from '../../../src/hooks/pr-workflow-gate.js';

const classify = _test_exports.classifyPrReviewCircuitSignal;

/** Minimal terminal record shaped the way the settle path writes one. */
function record(options: {
	status: string;
	terminalErrorClass?: {
		kind: 'provider' | 'aborted' | 'output_length' | 'unknown';
		category: string;
		statusCode?: number;
		hostRetryable?: boolean;
	};
	error?: string;
	withTerminalResult?: boolean;
	batchId?: string;
	laneId?: string;
}): Record<string, unknown> {
	const result = {
		...(options.terminalErrorClass
			? { terminalErrorClass: options.terminalErrorClass }
			: {}),
		...(options.error === undefined ? {} : { error: options.error }),
		chars: options.error?.length ?? 80,
		text: 'lane output',
		truncated: false,
		digest: 'digest-placeholder',
	};
	return {
		status: options.status,
		batchId: options.batchId,
		laneId: options.laneId,
		result: options.withTerminalResult === false ? result : undefined,
		...(options.withTerminalResult === false
			? {}
			: {
					terminalResult: {
						eventId: 'event-1',
						status: options.status,
						recordedAt: 1_720_000_000_000,
						result,
					},
				}),
	};
}

function providerRecord(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return record({
		status: 'error',
		terminalErrorClass: {
			kind: 'provider',
			category: 'provider.rate_limit',
			statusCode: 503,
			hostRetryable: true,
		},
		batchId: 'batch-1',
		laneId: 'lane-1',
		...overrides,
	});
}

describe('typed circuit-signal classification (issue #2382)', () => {
	test('CONVERGENCE: lanes killed by one provider outage classify to one provider class', () => {
		for (const laneId of ['lane-1', 'lane-2', 'lane-3']) {
			const signal = classify(providerRecord({ laneId }));
			expect(signal?.kind).toBe('provider_terminal');
			expect(
				(
					signal as Extract<
						PrReviewCircuitSignal,
						{ kind: 'provider_terminal' }
					>
				).providerClass,
			).toBe('provider.rate_limit');
		}
	});

	test('distinct provider classes do not collapse into one signal class', () => {
		const rateLimit = classify(
			providerRecord({
				terminalErrorClass: {
					kind: 'provider',
					category: 'provider.rate_limit',
				},
			}),
		);
		const auth = classify(
			providerRecord({
				terminalErrorClass: { kind: 'provider', category: 'provider.auth' },
			}),
		);
		expect(
			(
				rateLimit as Extract<
					PrReviewCircuitSignal,
					{ kind: 'provider_terminal' }
				>
			).providerClass,
		).not.toBe(
			(auth as Extract<PrReviewCircuitSignal, { kind: 'provider_terminal' }>)
				.providerClass,
		);
	});

	test('NO FALSE TRIP: cancellation, stale, parser, and unclassified errors are ignored kinds', () => {
		// Aborted child: settles cancelled, carries kind aborted.
		expect(
			classify(
				record({
					status: 'cancelled',
					terminalErrorClass: {
						kind: 'aborted',
						category: 'provider.cancelled',
					},
					batchId: 'b',
					laneId: 'l',
				}),
			),
		).toEqual({ kind: 'ignored', reason: 'cancellation' });
		// A provider-classed record that settled as anything other than `error`
		// is not a terminal provider failure.
		expect(
			classify(
				record({
					status: 'cancelled',
					terminalErrorClass: { kind: 'provider', category: 'provider.auth' },
					batchId: 'b',
					laneId: 'l',
				}),
			),
		).toEqual({ kind: 'ignored', reason: 'cancellation' });
		// Presumed-stale sweep records carry no result at all.
		expect(classify({ status: 'stale' })).toEqual({
			kind: 'ignored',
			reason: 'stale_observation',
		});
		// Explicit cancellation.
		expect(classify({ status: 'cancelled' })).toEqual({
			kind: 'ignored',
			reason: 'cancellation',
		});
		// Parser-rejected empty completion.
		expect(
			classify({
				status: 'completed',
				result: { text: '', chars: 0, truncated: false, digest: 'd' },
			}),
		).toEqual({ kind: 'ignored', reason: 'parser' });
		// Pre-upgrade / launch-failure / contract errors: error status without a
		// structured class is NEVER trusted as provider evidence.
		expect(classify({ status: 'error' })).toEqual({
			kind: 'ignored',
			reason: 'unknown',
		});
		expect(
			classify(
				record({
					status: 'error',
					error: 'provider.rate_limit: quota [kind=provider name=APIError]',
					batchId: 'b',
					laneId: 'l',
				}),
			),
		).toEqual({ kind: 'ignored', reason: 'unknown' });
		// output_length is a validation-shaped outcome, not provider death.
		expect(
			classify(
				record({
					status: 'error',
					terminalErrorClass: {
						kind: 'output_length',
						category: 'provider.output_length',
					},
					batchId: 'b',
					laneId: 'l',
				}),
			),
		).toEqual({ kind: 'ignored', reason: 'validation' });
		// Non-terminal records and healthy completions produce no signal.
		expect(classify({ status: 'running' })).toBeNull();
		expect(classify({ status: 'pending' })).toBeNull();
		expect(
			classify({
				status: 'completed',
				result: { text: 'findings', chars: 8, truncated: false, digest: 'd' },
			}),
		).toBeNull();
	});
});

describe('circuit record adoption (issue #2382)', () => {
	test('a legacy unversioned circuit migrates once to nonblocking v2 CLOSED with a waterline', () => {
		const nowMs = 1_756_000_000_000;
		const adoption = adoptPrReviewCircuit(
			{
				signature: 'terminal-error-output:error:http 503',
				count: 2,
				contributors: [
					{ batchId: 'b1', laneId: 'l1' },
					{ batchId: 'b2', laneId: 'l2' },
				],
				openedAt: '2026-08-23T00:00:00.000Z',
			},
			nowMs,
		);
		expect(adoption.kind).toBe('migrated');
		if (adoption.kind !== 'migrated') return;
		expect(adoption.record).toEqual({
			version: 2,
			state: 'CLOSED',
			generation: 1,
			contributors: [],
			evidenceWaterline: new Date(nowMs).toISOString(),
		});
		expect(adoption.diagnostic.code).toBe('migrated_legacy_circuit');
		expect(adoption.diagnostic.legacySignatureCount).toBe(2);
	});

	test('an absent record adopts as absent; a v2 record passes through unchanged', () => {
		expect(adoptPrReviewCircuit(undefined, 0).kind).toBe('absent');
		expect(adoptPrReviewCircuit(null, 0).kind).toBe('absent');
		const v2 = {
			version: 2,
			state: 'OPEN',
			generation: 3,
			providerClass: 'provider.auth',
			contributors: [
				{ batchId: 'b', laneId: 'l', terminalAt: '2026-08-23T00:00:00.000Z' },
			],
			openedAt: '2026-08-23T00:00:00.000Z',
			openUntil: '2026-08-23T00:01:00.000Z',
		};
		const adoption = adoptPrReviewCircuit(v2, 0);
		expect(adoption.kind).toBe('v2');
		if (adoption.kind === 'v2') {
			expect(adoption.record).toEqual(v2);
		}
	});

	test('a malformed record fails open with a bounded hash-only diagnostic', () => {
		const adoption = adoptPrReviewCircuit(
			{ version: 2, state: 'EXPLODED', generation: -4 },
			0,
		);
		expect(adoption.kind).toBe('malformed');
		if (adoption.kind !== 'malformed') return;
		expect(adoption.diagnostic.code).toBe('malformed_circuit_dropped');
		expect(adoption.diagnostic.bodyHash8).toMatch(/^[0-9a-f]{8}$/);
		expect(adoption.diagnostic.byteLength).toBeGreaterThan(0);
	});
});
