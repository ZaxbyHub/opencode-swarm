/**
 * Issue #2349 / PR #2363 review (FB-004) — the terminal-error settle predicate
 * must not delete a host session that may still be retrying.
 *
 * Split into its own file (rather than added to
 * `dispatch-lanes-terminal-provider-error.test.ts`) because that file was
 * already at the FR-006 500-line cap; uses the shared fixtures in
 * `tests/helpers/lane-terminal-error-fixtures.ts`.
 *
 * Background: the settle predicate accepts `Number.isFinite(completedAt)` as
 * sufficient turn-over evidence even when readiness could not be read (the
 * six-way `'unknown'` collapse — e.g. a starved/failed `session.status()`
 * RPC). A PR reviewer showed this is reachable and, before this fix, led to
 * `cleanupAsyncLaunchSession` deleting a host session the provider's own
 * `ApiError.data.isRetryable: true` said might still recover. The fix gates
 * the completedAt-only fallback (not the affirmative-`idle` path) on the
 * host NOT having said the error is retryable — using `hostRetryable`, which
 * was already computed by `classifyLaneTerminalError` and previously
 * discarded rather than acted on.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { _internals } from '../../../src/tools/dispatch-lanes.js';
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
	directory = canonicalMkdtemp('lane-terminal-retry-safety-');
});

afterEach(async () => {
	restoreClock();
	_internals.getSessionOps = originalGetSessionOps;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('terminal-error settle vs. host-reported retryability (issue #2349 FB-004)', () => {
	test(
		'completedAt-only settle is refused when the host says the error IS retryable',
		async () => {
			await recordLaneFixture(directory);
			// The exact destructive chain from the review: `completedAt` IS
			// stamped, but readiness could not be read (statusType: null
			// reproduces the six-way 'unknown' collapse, e.g. a starved/failed
			// session.status() RPC) — so completedAt is the ONLY evidence.
			// Before this fix, the lane settled to 'error' and then the host
			// session was deleted, even though it may still have been retrying.
			installLaneHost({
				statusType: null,
				messages: [
					assistantMessage({
						completed: 10_000,
						error: {
							name: 'APIError',
							data: {
								message: 'overloaded',
								statusCode: 529,
								isRetryable: true,
							},
						},
					}),
				],
			});

			const result = await collectLaneFixture(directory);

			expect(laneStatusOnDisk(directory, LANE_CORRELATION_ID)).toBe('pending');
			expect(result.pending).toBe(1);
			expect(result.failed).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'completedAt-only settle still fires for a genuinely non-retryable error (AC1 preserved)',
		async () => {
			await recordLaneFixture(directory);
			// Same shape as above (completedAt stamped, readiness unreadable) but
			// the host says isRetryable: false — the gate must not weaken AC1 for
			// the exact incident #2349 exists to fix (quota/billing exhaustion is
			// reported non-retryable by the host).
			installLaneHost({
				statusType: null,
				messages: [
					assistantMessage({
						completed: 10_000,
						error: {
							name: 'APIError',
							data: {
								message: 'usage limit reached',
								statusCode: 429,
								isRetryable: false,
							},
						},
					}),
				],
			});

			const result = await collectLaneFixture(directory);

			expect(laneStatusOnDisk(directory, LANE_CORRELATION_ID)).toBe('error');
			expect(result.failed).toBe(1);
		},
		TEST_TIMEOUT_MS,
	);
});
