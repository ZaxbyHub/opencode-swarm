/**
 * Issue #2349 — terminal provider errors (quota/billing) in async lanes must
 * settle the lane instead of leaving it `pending` until the 30-minute
 * presumed-stale sweep or a manual cancel.
 *
 * Root cause pinned here: `extractAssistantTranscript` read the host's
 * `info.error` only as an `=== undefined` existence test and discarded the
 * value, and the collect loop then dropped the whole zero-text transcript on
 * `if (!transcript.text) continue;` — before any readiness reasoning — so a lane
 * that died at its first background inference could never settle.
 *
 * The settle predicate is deliberately evidence-based, NOT time-based:
 * `getLaneCollectionReadiness` collapses six distinct conditions (including
 * status-budget exhaustion caused purely by lane pressure) into `'unknown'`, so
 * an elapsed-time SLO would terminalize healthy lanes. The decisive
 * anti-regression case is `does not settle a live retrying lane` below.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { recordPendingDelegation } from '../../../src/background/pending-delegations.js';
import {
	_internals,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes.js';
import { laneStatusOnDisk } from '../../helpers/pr-workflow-lane-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const TEST_TIMEOUT_MS = 15_000;
const SESSION_ID = 'sub-lane-2349';
const CORRELATION_ID = 'c-lane-2349';

let directory = '';
let restoreClock: () => void = () => {};
const originalGetSessionOps = _internals.getSessionOps;

/** An SDK-shaped assistant message: `info.error` union + optional text parts. */
function assistantMessage(options: {
	error?: unknown;
	completed?: number | undefined;
	text?: string;
}): unknown {
	return {
		info: {
			role: 'assistant',
			time:
				options.completed === undefined ? {} : { completed: options.completed },
			...(options.error === undefined ? {} : { error: options.error }),
		},
		parts:
			options.text === undefined
				? []
				: [{ type: 'text', text: options.text }],
	};
}

/**
 * Install a fake host. `statusType: null` models the six-way `'unknown'`
 * collapse (no usable status), which is what a budget-exhausted poll produces.
 */
function installHost(options: {
	statusType: string | null;
	messages: unknown[];
}): void {
	_internals.getSessionOps = () =>
		({
			status: async () => ({
				data:
					options.statusType === null
						? {}
						: { [SESSION_ID]: { type: options.statusType } },
			}),
			messages: async () => ({ data: options.messages }),
			abort: async () => ({}),
			delete: async () => ({}),
		}) as never;
}

async function recordLane(): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId: CORRELATION_ID,
		jobId: null,
		subagentSessionId: SESSION_ID,
		parentSessionId: 'collect-parent',
		callID: `call-${CORRELATION_ID}`,
		normalizedAgent: 'sme',
		swarmPrefixedAgent: 'mega_sme',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'batch-2349',
		laneId: 'lane-2349',
		mode: undefined,
		workflowLane: null,
		workspace: {
			directory,
			gitHead: 'abc123',
			dirtyHash: null,
			prHeadSha: 'abc123',
			scope: null,
		},
	});
}

async function collect(): Promise<
	Awaited<ReturnType<typeof executeCollectLaneResults>>
> {
	return executeCollectLaneResults(
		{ batch_id: 'batch-2349', wait: false },
		directory,
	);
}

beforeEach(() => {
	restoreClock = freezeClock();
	directory = canonicalMkdtemp('lane-terminal-provider-error-');
});

afterEach(async () => {
	restoreClock();
	_internals.getSessionOps = originalGetSessionOps;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('terminal provider errors settle async lanes (issue #2349)', () => {
	test(
		'AC1: a quota-dead lane settles to error in ONE pass with the reason recorded',
		async () => {
			await recordLane();
			installHost({
				statusType: 'idle',
				messages: [
					assistantMessage({
						completed: 1_000,
						error: {
							name: 'APIError',
							data: {
								message: "You've reached your usage limit for this billing cycle",
								statusCode: 429,
								isRetryable: false,
							},
						},
					}),
				],
			});

			const result = await collect();

			// Settled without waiting for a collection budget or manual cancel.
			expect(laneStatusOnDisk(directory, CORRELATION_ID)).toBe('error');
			expect(result.pending).toBe(0);
			expect(result.failed).toBe(1);

			// The REASON is recorded, not merely the status flip.
			const lane = result.lane_results[0];
			expect(lane?.status).toBe('failed');
			expect(lane?.error).toContain('provider.quota_billing');
			expect(lane?.error).toContain('usage limit');
			// Discriminating content leads, so the 160-char correlated-failure
			// signature window cannot truncate it away.
			expect(lane?.error?.indexOf('provider.quota_billing')).toBe(0);
			expect(lane?.error).toContain('kind=provider');
			expect(lane?.error).toContain('host_retryable=false');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'DECISIVE anti-regression: a live RETRYING lane with an error and no output does NOT settle',
		async () => {
			await recordLane();
			// The host models an in-flight retry as an ApiError carried on a
			// still-running message. `statusType: null` reproduces the readiness
			// collapse a budget-exhausted poll produces, so the ONLY thing standing
			// between this lane and a wrong terminal settle is the absence of
			// `time.completed`. A time-based SLO would kill this lane.
			installHost({
				statusType: null,
				messages: [
					assistantMessage({
						completed: undefined,
						error: {
							name: 'APIError',
							data: { message: 'overloaded', statusCode: 529, isRetryable: true },
						},
					}),
				],
			});

			const result = await collect();

			expect(laneStatusOnDisk(directory, CORRELATION_ID)).toBe('pending');
			expect(result.pending).toBe(1);
			expect(result.failed).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'a healthy lane with no error and no output keeps polling (sanity)',
		async () => {
			await recordLane();
			installHost({ statusType: 'busy', messages: [] });

			const result = await collect();

			expect(laneStatusOnDisk(directory, CORRELATION_ID)).toBe('pending');
			expect(result.pending).toBe(1);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'an abort settles as cancelled, never as a provider error',
		async () => {
			await recordLane();
			installHost({
				statusType: 'idle',
				messages: [
					assistantMessage({
						completed: 2_000,
						error: {
							name: 'MessageAbortedError',
							data: { message: 'aborted by user' },
						},
					}),
				],
			});

			const result = await collect();

			expect(laneStatusOnDisk(directory, CORRELATION_ID)).toBe('cancelled');
			// AC4: cancelled fails closed too — it cannot count as covered.
			expect(result.success).toBe(false);
			expect(result.cancelled).toBe(1);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'SDK discriminator beats the text classifier: an APIError saying "aborted" still settles error',
		async () => {
			await recordLane();
			installHost({
				statusType: 'idle',
				messages: [
					assistantMessage({
						completed: 3_000,
						error: {
							name: 'APIError',
							data: { message: 'request aborted by upstream', statusCode: 502 },
						},
					}),
				],
			});

			const result = await collect();

			// `kind` (host truth) governs the status even though the text
			// classifier reads the message as a cancellation.
			expect(laneStatusOnDisk(directory, CORRELATION_ID)).toBe('error');
			expect(result.lane_results[0]?.error).toContain('kind=provider');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'output_length is REACHABLE — the guard uses windowTruncated, not transcriptIncomplete',
		async () => {
			await recordLane();
			// Narrow-but-real state: the turn died on output length having produced
			// only non-text parts, so there is no text to salvage. Guarding on
			// `transcriptIncomplete` (which folds in finish==='length') would make
			// this branch unreachable — i.e. ship unwired code.
			installHost({
				statusType: 'idle',
				messages: [
					{
						info: {
							role: 'assistant',
							time: { completed: 4_000 },
							finish: 'length',
							error: { name: 'MessageOutputLengthError', data: {} },
						},
						parts: [{ type: 'tool', text: 'ignored-by-extractText' }],
					},
				],
			});

			const result = await collect();

			expect(laneStatusOnDisk(directory, CORRELATION_ID)).toBe('error');
			expect(result.lane_results[0]?.error).toContain('kind=output_length');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'a truncated fetch window never settles a lane as error-with-no-output',
		async () => {
			await recordLane();
			// 50 messages = ASYNC_MESSAGE_FETCH_LIMIT, so earlier text-bearing
			// messages may exist outside the window. Real output must not be
			// discarded just because the visible tail errored.
			const messages: unknown[] = [];
			for (let index = 0; index < 49; index += 1) {
				messages.push({ info: { role: 'user' }, parts: [] });
			}
			messages.push(
				assistantMessage({
					completed: 5_000,
					error: { name: 'APIError', data: { message: 'quota exceeded' } },
				}),
			);

			installHost({ statusType: 'idle', messages });

			const result = await collect();

			expect(laneStatusOnDisk(directory, CORRELATION_ID)).toBe('pending');
			expect(result.pending).toBe(1);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'a lane that produced real output takes the existing route, error notwithstanding',
		async () => {
			await recordLane();
			installHost({
				statusType: 'idle',
				messages: [
					assistantMessage({
						completed: 6_000,
						text: 'partial findings worth keeping',
						error: { name: 'APIError', data: { message: 'quota exceeded' } },
					}),
				],
			});

			const result = await collect();

			// Output is preserved rather than replaced by an error settle.
			expect(result.lane_results[0]?.output).toContain('partial findings');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'malformed error shapes degrade to unknown and never throw',
		async () => {
			await recordLane();
			installHost({
				statusType: 'idle',
				messages: [
					assistantMessage({ completed: 7_000, error: { nope: true } }),
				],
			});

			const result = await collect();

			expect(laneStatusOnDisk(directory, CORRELATION_ID)).toBe('error');
			expect(result.lane_results[0]?.error).toContain('kind=unknown');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'settling is idempotent — a second pass does not rewrite a terminal record',
		async () => {
			await recordLane();
			installHost({
				statusType: 'idle',
				messages: [
					assistantMessage({
						completed: 8_000,
						error: { name: 'ProviderAuthError', data: { message: 'invalid api key' } },
					}),
				],
			});

			const first = await collect();
			const firstError = first.lane_results[0]?.error;
			const second = await collect();

			expect(laneStatusOnDisk(directory, CORRELATION_ID)).toBe('error');
			expect(second.lane_results[0]?.error).toBe(firstError);
		},
		TEST_TIMEOUT_MS,
	);
});
