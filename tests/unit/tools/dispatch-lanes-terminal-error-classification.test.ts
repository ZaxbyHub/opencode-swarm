/**
 * Issue #2349 — CLASSIFICATION and REASON-FORMAT properties of the terminal
 * provider-error settle. Split from
 * `dispatch-lanes-terminal-provider-error.test.ts` (which owns settle behavior)
 * when that file crossed the FR-006 500-line cap; shared fixtures live in
 * `tests/helpers/lane-terminal-error-fixtures.ts`.
 *
 * These two properties are load-bearing and were BOTH raised by the independent
 * implementation review:
 *  - the reason's field ORDER is what keeps the 160-char correlated-failure
 *    signature window from truncating away the discriminator;
 *  - the SDK discriminator must beat `isAbortLike`'s text match for the one
 *    error shape the approved plan calls empirically proven.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { createAgents } from '../../../src/agents/index.js';
import {
	_internals,
	_test_exports,
	executeDispatchLanes,
} from '../../../src/tools/dispatch-lanes.js';
import {
	assistantMessage,
	collectLaneFixture,
	installLaneHost,
	LANE_CORRELATION_ID,
	recordLaneFixture,
} from '../../helpers/lane-terminal-error-fixtures.js';
import { laneStatusOnDisk } from '../../helpers/pr-workflow-lane-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const TEST_TIMEOUT_MS = 15_000;

let directory = '';
let restoreClock: () => void = () => {};
const originalGetSessionOps = _internals.getSessionOps;

beforeEach(() => {
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('lane-terminal-error-class-');
	_test_exports.resetDeliveredLaneOutputs();
});

afterEach(async () => {
	restoreClock();
	_internals.getSessionOps = originalGetSessionOps;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('terminal-error classification and reason format (issue #2349)', () => {
	test(
		'reason FORMAT is pinned: discriminating content leads, constant tail last',
		async () => {
			await recordLaneFixture(directory);
			installLaneHost({
				statusType: 'idle',
				messages: [
					assistantMessage({
						completed: 11_000,
						error: {
							name: 'ProviderAuthError',
							data: { message: 'invalid api key', statusCode: 401 },
						},
					}),
				],
			});

			const result = await collectLaneFixture(directory);
			const reason = result.lane_results[0]?.error ?? '';

			// The ordering property the 160-char correlated-failure signature window
			// depends on: category first, constant `[kind=… name=…]` tail last.
			expect(reason).toMatch(
				/^provider\.[a-z_]+: .*\[kind=[a-z_]+ name=\w+( status=\d+)?( host_retryable=(true|false))?\]$/,
			);
			// Host-stated status now reaches the classifier instead of being patched
			// on afterwards, so 401 classifies as auth rather than `provider.unknown`
			// — which previously produced self-contradictory `provider.unknown …
			// status=401` records.
			expect(reason.startsWith('provider.authentication_configuration:')).toBe(
				true,
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'an abort with NO data.message records provider.cancelled, not provider.unknown',
		async () => {
			await recordLaneFixture(directory);
			// The shape the approved plan calls the only empirically-proven one.
			// `isAbortLike` tests /\baborted\b/, which does NOT match inside the
			// single token "MessageAbortedError", so without the SDK-discriminator
			// override this would be recorded as `provider.unknown`.
			installLaneHost({
				statusType: 'idle',
				messages: [
					assistantMessage({
						completed: 12_000,
						error: { name: 'MessageAbortedError', data: {} },
					}),
				],
			});

			const result = await collectLaneFixture(directory);

			expect(laneStatusOnDisk(directory, LANE_CORRELATION_ID)).toBe(
				'cancelled',
			);
			expect(result.lane_results[0]?.error).toContain('provider.cancelled');
			expect(result.lane_results[0]?.error).toContain('kind=aborted');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'a >100-char transient error still fails over, and the LAST attempt owns the reason',
		async () => {
			// This drives the REAL production path end to end. An earlier version of
			// this test asserted `isTransientProviderError()` against a locally-built
			// string — it pinned the library, not the fix, and would still have passed
			// if the classified reason were re-composed into the thrown message.
			//
			// It pins two things at once:
			//  1. FAILOVER SURVIVES. Attempt 1's provider message is 115 chars with
			//     its transient token ("overloaded") past char 100. Composing the
			//     classified reason into the throw truncated at 100, cutting that
			//     token and flipping transient -> permanent, which silently skipped
			//     failover. `prompt` being called TWICE proves the fallback ran.
			//  2. NO STALE REASON. Attempt 2 REJECTS rather than returning
			//     `{data: undefined}`, so it never reaches the site that sets
			//     `syncClassifiedReason`. Without the per-attempt reset, attempt 1's
			//     provider reason leaks and the lane is recorded with the wrong cause.
			const directory = canonicalMkdtemp('lane-failover-attribution-');
			createAgents({
				agents: { reviewer: { model: 'p/m1', fallback_models: ['p/m2'] } },
			} as never);

			let attempts = 0;
			_internals.getSessionOps = () =>
				({
					create: async () => ({ data: { id: 'sess-failover' } }),
					prompt: async () => {
						attempts += 1;
						if (attempts === 1) {
							return {
								data: undefined,
								error: `${'x'.repeat(104)} overloaded`,
							};
						}
						throw new Error('disk exploded');
					},
					delete: async () => ({}),
				}) as never;

			const result = await executeDispatchLanes(
				{
					max_concurrent: 1,
					lanes: [{ id: 'l', agent: 'reviewer', prompt: 'p' }],
				},
				directory,
			);

			expect(attempts).toBe(2);
			const laneError = result.lane_results[0]?.error ?? '';
			expect(laneError).toContain('disk exploded');
			expect(laneError).not.toContain('overloaded');
			await fs.rm(directory, { recursive: true, force: true });
		},
		TEST_TIMEOUT_MS,
	);
});
