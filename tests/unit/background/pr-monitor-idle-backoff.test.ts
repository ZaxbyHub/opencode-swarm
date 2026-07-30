/**
 * Idle backoff counter tests for PrMonitorWorker (FR-008).
 *
 * Verifies that the per-PR idle counter advances only when a full fetch
 * succeeds AND change-detection result is empty, and does NOT advance
 * when updateSnapshot throws (persistence failure).
 *
 * Uses _internals DI seam (Tier 1) for full mock isolation � no
 * mock.module needed, no cross-file pollution.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	PrMonitorWorker,
	shouldSkipIdlePoll,
	type PrMonitorWorkerOptions,
	_internals as workerInternals,
} from '../../../src/background/pr-monitor-worker';
import type { PrSubscriptionRecord } from '../../../src/background/pr-subscriptions';
import type {
	MergeStateResult,
	PRCommentResult,
	PRStatusResult,
} from '../../../src/git/pr';

// -- Test Fixtures --------------------------------------------------

const TEST_DIR = path.join(os.tmpdir(), 'pr-monitor-idle-backoff-test');

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		enabled: true,
		poll_interval_seconds: 60,
		max_subscriptions: 20,
		max_prs_per_cycle: 5,
		max_concurrent_pr_polls: 3,
		poll_timeout_ms: 30_000,
		failure_threshold: 5,
		cooldown_seconds: 30,
		max_cooldown_seconds: 300,
		cleanup_ttl_days: 7,
		auto_unsubscribe_on_merge: true,
		auto_unsubscribe_on_close: true,
		notify_ci_failure: true,
		notify_new_comments: true,
		notify_merge_conflict: true,
		...overrides,
	};
}

const CORRELATION_ID = 'sess1::owner/repo::42';

function makeSubscription(
	overrides: Partial<PrSubscriptionRecord> = {},
): PrSubscriptionRecord {
	return {
		correlationId: CORRELATION_ID,
		sessionID: 'sess1',
		prNumber: 42,
		repoFullName: 'owner/repo',
		prUrl: 'https://github.com/owner/repo/pull/42',
		lastCheckedAt: Date.now() - 60_000,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active',
		createdAt: Date.now() - 120_000,
		updatedAt: Date.now() - 60_000,
		errorCount: 0,
		...overrides,
	};
}

function makePRStatus(overrides: Partial<PRStatusResult> = {}): PRStatusResult {
	return {
		number: 42,
		state: 'OPEN',
		mergeable: 'MERGEABLE',
		mergeStateStatus: 'CLEAN',
		headRefOid: 'abc123',
		statusCheckRollup: [
			{ name: 'ci/build', status: 'completed', conclusion: 'success' },
		],
		...overrides,
	};
}

function makePRComments(
	overrides: Partial<PRCommentResult>[] = [],
): PRCommentResult[] {
	return [
		{
			id: 'comment-1',
			author: 'reviewer',
			body: 'Looks good',
			createdAt: '2025-01-01T00:00:00Z',
			isReviewComment: false,
		},
		...overrides,
	];
}

function makeMergeState(
	overrides: Partial<MergeStateResult> = {},
): MergeStateResult {
	return {
		mergeable: 'MERGEABLE',
		mergeStateStatus: 'CLEAN',
		headRefOid: 'abc123',
		...overrides,
	};
}

// -- Mock State ------------------------------------------------------

interface MockState {
	listActive: ReturnType<typeof mock>;
	getPRStatus: ReturnType<typeof mock>;
	getPRComments: ReturnType<typeof mock>;
	getMergeState: ReturnType<typeof mock>;
	getMergeGroupRun: ReturnType<typeof mock>;
	getPRReviewState: ReturnType<typeof mock>;
	updateSnapshot: ReturnType<typeof mock>;
	unsubscribe: ReturnType<typeof mock>;
	sweepStale: ReturnType<typeof mock>;
	getGlobalEventBus: ReturnType<typeof mock>;
	publish: ReturnType<typeof mock>;
	busInstance: {
		publish: ReturnType<typeof mock>;
	};
}

let mockState: MockState;
let savedInternals: typeof workerInternals;

function setupMocks(): void {
	savedInternals = { ...workerInternals };

	mockState = {
		listActive: mock(() => Promise.resolve([])),
		getPRStatus: mock(() => Promise.resolve(makePRStatus())),
		getPRComments: mock(() => Promise.resolve(makePRComments())),
		getMergeState: mock(() => Promise.resolve(makeMergeState())),
		getMergeGroupRun: mock(() => Promise.resolve(null)),
		getPRReviewState: mock(() =>
			Promise.resolve({ reviewDecision: '', reviewRequestCount: 0 }),
		),
		updateSnapshot: mock(() => Promise.resolve(null)),
		unsubscribe: mock(() => Promise.resolve(null)),
		sweepStale: mock(() => Promise.resolve(0)),
		getGlobalEventBus: mock(() => mockState.busInstance),
		publish: mock(() => Promise.resolve()),
		busInstance: {
			publish: mock(() => Promise.resolve()),
		},
	};

	workerInternals.listActive =
		mockState.listActive as typeof workerInternals.listActive;
	workerInternals.getPRStatus =
		mockState.getPRStatus as typeof workerInternals.getPRStatus;
	workerInternals.getPRComments =
		mockState.getPRComments as typeof workerInternals.getPRComments;
	workerInternals.getMergeState =
		mockState.getMergeState as typeof workerInternals.getMergeState;
	workerInternals.getMergeGroupRun =
		mockState.getMergeGroupRun as typeof workerInternals.getMergeGroupRun;
	workerInternals.getPRReviewState =
		mockState.getPRReviewState as typeof workerInternals.getPRReviewState;
	workerInternals.updateSnapshot =
		mockState.updateSnapshot as typeof workerInternals.updateSnapshot;
	workerInternals.unsubscribe =
		mockState.unsubscribe as typeof workerInternals.unsubscribe;
	workerInternals.sweepStale =
		mockState.sweepStale as typeof workerInternals.sweepStale;
	workerInternals.getGlobalEventBus =
		mockState.getGlobalEventBus as typeof workerInternals.getGlobalEventBus;
}

function restoreInternals(): void {
	if (savedInternals) {
		workerInternals.listActive = savedInternals.listActive;
		workerInternals.getPRStatus = savedInternals.getPRStatus;
		workerInternals.getPRComments = savedInternals.getPRComments;
		workerInternals.getMergeState = savedInternals.getMergeState;
		workerInternals.getMergeGroupRun = savedInternals.getMergeGroupRun;
		workerInternals.getPRReviewState = savedInternals.getPRReviewState;
		workerInternals.updateSnapshot = savedInternals.updateSnapshot;
		workerInternals.unsubscribe = savedInternals.unsubscribe;
		workerInternals.sweepStale = savedInternals.sweepStale;
		workerInternals.getGlobalEventBus = savedInternals.getGlobalEventBus;
	}
}

function createWorker(
	overrides: Partial<PrMonitorWorkerOptions> = {},
): PrMonitorWorker {
	return new PrMonitorWorker({
		directory: TEST_DIR,
		config: makeConfig() as PrMonitorWorkerOptions['config'],
		...overrides,
	});
}

/** Helper to read the private idlePollCountMap from a worker instance. */
function getIdleCount(worker: PrMonitorWorker, correlationId: string): number {
	return (worker as Record<string, unknown>)['idlePollCountMap'] as Map<string, number>;
}

/** Set up mocks for a successful no-change poll cycle. */
function setupNoChangePoll(sub: PrSubscriptionRecord): void {
	// Subscription with headRefOid matching fetch result ? no head-ref event
	// and lastCommentId set ? no new-comment events
	const stableSub = { ...sub, headRefOid: 'abc123', lastCommentId: 'comment-1' };
	mockState.listActive.mockResolvedValueOnce([stableSub]);
	mockState.getPRStatus.mockResolvedValue(makePRStatus());
	mockState.getPRComments.mockResolvedValue(makePRComments());
	mockState.getMergeState.mockResolvedValue(makeMergeState());
	mockState.updateSnapshot.mockResolvedValue(stableSub);
}

// -- Tests ----------------------------------------------------------

describe('PrMonitorWorker � idle backoff counter (FR-008)', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('idle counter advances on successful fetch + successful updateSnapshot + empty events', async () => {
		const sub = makeSubscription({
			headRefOid: 'abc123',
			lastCommentId: 'comment-1',
		});

		setupNoChangePoll(sub);
		const worker = createWorker();
		await worker.pollCycle();

		// Counter should be 1 after one idle cycle
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(1);
	});

	test('idle counter is unchanged when updateSnapshot throws (FR-008 invariant)', async () => {
		const sub = makeSubscription({
			headRefOid: 'abc123',
			lastCommentId: 'comment-1',
		});

		// First poll: successful ? counter = 1
		setupNoChangePoll(sub);
		const worker = createWorker();
		await worker.pollCycle();
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(1);

		// Second poll: updateSnapshot throws ? counter must NOT advance
		const stableSub = { ...sub, headRefOid: 'abc123', lastCommentId: 'comment-1' };
		mockState.listActive.mockResolvedValueOnce([stableSub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());

		// applyChanges calls updateSnapshot (success), then
		// the post-success updateSnapshot throws
		mockState.updateSnapshot
			.mockResolvedValueOnce(stableSub)  // applyChanges snapshot write
			.mockRejectedValueOnce(new Error('disk full'));  // post-success persistence write

		// pollSinglePr catches the error and calls handlePollError,
		// which calls updateSnapshot again for error recording
		mockState.updateSnapshot.mockResolvedValueOnce(null); // handlePollError write

		await worker.pollCycle();

		// Counter must still be 1 � the failed persistence must not advance it
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(1);
	});

	test('idle counter resets on event, but only after persistence succeeds', async () => {
		// First: establish idle count = 1
		const sub = makeSubscription({
			headRefOid: 'abc123',
			lastCommentId: 'comment-1',
		});
		setupNoChangePoll(sub);
		const worker = createWorker();
		await worker.pollCycle();
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(1);

		// Second: new head ref ? change detected ? events emitted
		// Counter should reset to 0 after successful persistence
		const changedSub = { ...sub, headRefOid: 'abc123', lastCommentId: 'comment-1' };
		mockState.listActive.mockResolvedValueOnce([changedSub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({ headRefOid: 'def456' }),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(changedSub);

		await worker.pollCycle();

		// Counter reset to 0 after event detected and persisted
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(0);
	});

	test('idle counter does not advance when fetch fails entirely', async () => {
		const sub = makeSubscription();

		// Fetch fails ? caught by outer try/catch ? handlePollError
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockRejectedValueOnce(new Error('network error'));

		const worker = createWorker();
		await worker.pollCycle();

		// Counter should remain undefined (never set)
		expect(
			getIdleCount(worker, CORRELATION_ID).has(CORRELATION_ID),
		).toBe(false);
	});

	test('snapshot-only bookkeeping change (lastCheckRunSet grows) does NOT reset counter', async () => {
		// First: establish idle count = 2
		const sub = makeSubscription({
			headRefOid: 'abc123',
			lastCommentId: 'comment-1',
			lastCheckRunSet: JSON.stringify([{ n: 'ci/build', c: 'success' }]),
		});
		for (let i = 0; i < 2; i++) {
			setupNoChangePoll(sub);
			mockState.updateSnapshot.mockResolvedValue(sub);
		}
		const worker = createWorker();
		await worker.pollCycle();
		await worker.pollCycle();
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(2);

		// Now: add a new passing check (ci/lint success) to the rollup.
		// No new failures ? no pr.ci.failed event.
		// allPassed=true, prevHadIssues=false ? no pr.ci.passed event.
		// lastCheckRunSet changes but it is bookkeeping (excluded from meaningful whitelist).
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'success' },
					{ name: 'ci/lint', status: 'completed', conclusion: 'success' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		await worker.pollCycle();

		// Counter advances to 3 � lastCheckRunSet is bookkeeping, not meaningful
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(3);
	});

	test('snapshot-only bookkeeping change (lastCheckedAt) does NOT reset counter', async () => {
		const sub = makeSubscription({
			headRefOid: 'abc123',
			lastCommentId: 'comment-1',
		});

		// First poll: no-change ? counter = 1
		setupNoChangePoll(sub);
		const worker = createWorker();
		await worker.pollCycle();
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(1);

		// Second poll: also no meaningful change. lastCheckedAt is
		// always written in snapshotUpdates but excluded from MEANINGFUL fields.
		setupNoChangePoll(sub);
		mockState.updateSnapshot.mockResolvedValue(sub);

		await worker.pollCycle();

		// Counter advances to 2 (bookkeeping-only snapshot changes don't reset)
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(2);
	});

	test('mergeGroupRun absent-key cycle does NOT reset counter (Object.hasOwn guard)', async () => {
		// When mergeGroupRunFetchSucceeded is false, snapshotUpdates does NOT
		// include mergeGroupRun* keys. Object.hasOwn must not false-positive.
		const sub = makeSubscription({
			headRefOid: 'abc123',
			lastCommentId: 'comment-1',
		});

		// First: idle count = 1
		setupNoChangePoll(sub);
		const worker = createWorker();
		await worker.pollCycle();
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(1);

		// Second: getMergeGroupRun throws ? mergeGroupRunFetchSucceeded = false
		// ? snapshotUpdates lacks mergeGroupRun* keys
		const stableSub = { ...sub, headRefOid: 'abc123', lastCommentId: 'comment-1' };
		mockState.listActive.mockResolvedValueOnce([stableSub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.getMergeGroupRun.mockRejectedValueOnce(new Error('merge group fetch failed'));
		mockState.updateSnapshot.mockResolvedValue(stableSub);

		await worker.pollCycle();

		// Counter advances to 2 � absent mergeGroupRun keys don't reset
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(2);
	});

	test('mergeableState MERGEABLE?UNKNOWN?MERGEABLE flap does NOT reset counter', async () => {
		const sub = makeSubscription({
			headRefOid: 'abc123',
			lastCommentId: 'comment-1',
			mergeableState: 'MERGEABLE',
		});

		// First: idle count = 1 (normal no-change cycle)
		setupNoChangePoll(sub);
		const worker = createWorker();
		await worker.pollCycle();
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(1);

		// Second: mergeableState flaps to UNKNOWN (excluded from meaningful)
		const flappedSub = { ...sub, headRefOid: 'abc123', lastCommentId: 'comment-1' };
		mockState.listActive.mockResolvedValueOnce([flappedSub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(
			makeMergeState({ mergeable: 'UNKNOWN' }),
		);
		mockState.updateSnapshot.mockResolvedValue(flappedSub);

		await worker.pollCycle();

		// Counter advances to 2 � mergeableState is excluded
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(2);
	});

	test('stop() clears idlePollCountMap and resets pollCycleCount', async () => {
		const sub = makeSubscription({ headRefOid: 'abc123', lastCommentId: 'comment-1' });
		setupNoChangePoll(sub);
		const worker = createWorker();
		worker.start();
		await worker.pollCycle();
		// State was populated by the poll cycle
		expect(getIdleCount(worker, CORRELATION_ID).get(CORRELATION_ID)).toBe(1);
		expect((worker as Record<string, unknown>)['pollCycleCount']).toBe(1);
		worker.stop();
		// stop() must clear idle-backoff state
		expect(getIdleCount(worker, CORRELATION_ID).size).toBe(0);
		expect((worker as Record<string, unknown>)['pollCycleCount']).toBe(0);
	});

	test('stop() preserves circuitBreakerMap and reviewStateMap cleanup', () => {
		const worker = createWorker();
		worker.start();
		const cbMap = (worker as Record<string, unknown>)['circuitBreakerMap'] as Map<string, unknown>;
		const rsMap = (worker as Record<string, unknown>)['reviewStateMap'] as Map<string, unknown>;
		cbMap.set('k', { errorCount: 3 });
		rsMap.set('k', 'APPROVED');
		expect(cbMap.size).toBe(1);
		expect(rsMap.size).toBe(1);
		worker.stop();
		expect(cbMap.size).toBe(0);
		expect(rsMap.size).toBe(0);
	});
});

describe('shouldSkipIdlePoll — module-level pure function', () => {
	// Per General Council 3× cap: idleCount >= 6 uses skipEvery=3 uniformly.
	// Pattern: cycle % 3 !== 0 → skip; cycle % 3 === 0 → poll.
	// idleCount 0-2: never skip.
	// idleCount 3-5: skipEvery=2.
	const cases: Array<[number, number, boolean]> = [
		[0, 1, false], [3, 1, true], [3, 2, false],
		[6, 1, true], [6, 2, true], [6, 3, false], [6, 6, false],
		[10, 1, true], [10, 2, true], [10, 3, false], [10, 5, true],
		[100, 7, true], [100, 5, true], [100, 6, false],
	];
	for (const [idle, cycle, expected] of cases) {
		test(`idle=${idle} cycle=${cycle} → ${expected ? 'skip' : 'poll'}`, () => {
			expect(shouldSkipIdlePoll(idle, cycle)).toBe(expected);
		});
	}
	test('deterministic — repeated calls yield identical results', () => {
		expect(shouldSkipIdlePoll(10, 1)).toBe(shouldSkipIdlePoll(10, 1));
		expect(shouldSkipIdlePoll(10, 1)).toBe(shouldSkipIdlePoll(10, 1));
	});
});

