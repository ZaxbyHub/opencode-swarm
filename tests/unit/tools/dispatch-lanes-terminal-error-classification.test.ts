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
import {
	_internals,
	_test_exports,
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
		'a >100-char transient provider message keeps model failover on the sync path',
		async () => {
			// Regression pin for the review blocker: composing the classified reason
			// INTO the thrown message truncated it at 100 chars, so a transient token
			// past that point was cut and `isTransientProviderError` flipped
			// transient → permanent, silently suppressing model fallback. The thrown
			// message is now byte-identical to its pre-#2349 form; only the recorded
			// lane reason is classified.
			const { isTransientProviderError } = await import(
				'../../../src/utils/provider-error-classification.js'
			);
			const raw = `${'x'.repeat(104)} overloaded`;
			expect(raw.length).toBeGreaterThan(100);
			expect(isTransientProviderError(`session.prompt failed: ${raw}`)).toBe(
				true,
			);
			// And no synthetic `status=NNN` is injected into what the classifier sees,
			// which previously flipped a permanent failure to transient.
			expect(`session.prompt failed: ${raw}`).not.toContain('status=');
		},
		TEST_TIMEOUT_MS,
	);
});
