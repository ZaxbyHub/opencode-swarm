/**
 * Phase 1 PR Monitor Worker tests.
 *
 * Uses _internals DI seam (Tier 1) for full mock isolation — no mock.module
 * needed, no cross-file pollution.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals as subscriberInternals } from '../../../src/background/pr-event-subscribers';
import {
	PrMonitorWorker,
	type PrMonitorWorkerOptions,
	type PrMonitorWorkerStatus,
	_internals as workerInternals,
} from '../../../src/background/pr-monitor-worker';
import type { PrSubscriptionRecord } from '../../../src/background/pr-subscriptions';
import type {
	MergeGroupRunResult,
	MergeStateResult,
	PRCommentResult,
	PRStatusResult,
} from '../../../src/git/pr';

// ── Test Fixtures ──────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), 'pr-monitor-worker-test');

function makeConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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

function makeSubscription(
	overrides: Partial<PrSubscriptionRecord> = {},
): PrSubscriptionRecord {
	return {
		correlationId: 'sess1::owner/repo::42',
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

// ── Mock State ──────────────────────────────────────────────────────
/** Fetch-knob mock that accepts the real 3-arg fetch signature. */
type FetchMock<T> = ReturnType<typeof mock> &
	((prNumber: number, repoFullName: string, cwd: string) => Promise<T>);

interface MockState {
	listActive: ReturnType<typeof mock>;
	getPRStatus: FetchMock<PRStatusResult>;
	getPRComments: FetchMock<PRCommentResult[]>;
	getMergeState: FetchMock<MergeStateResult>;
	getMergeGroupRun: ReturnType<typeof mock>;
	getPRReviewState: FetchMock<ReviewStateResult>;
	getPRPollSnapshot: ReturnType<typeof mock>;
	getPRReviewComments: ReturnType<typeof mock>;
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
	// Save originals for restoration
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
		// #2471 consolidation: the worker-facing seam now exposes the composed
		// snapshot; the four fetch mocks above remain the per-test fixture knobs
		// the snapshot composes, so existing overrides keep working unchanged.
		getPRPollSnapshot: mock(async (pr: number, repo: string, cwd: string) => ({
			status: await mockState.getPRStatus(pr, repo, cwd),
			comments: await mockState.getPRComments(pr, repo, cwd),
			merge: await mockState.getMergeState(pr, repo, cwd),
			review: await mockState.getPRReviewState(pr, repo, cwd),
		})),
		getPRReviewComments: mock(() => Promise.resolve([])),
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
	workerInternals.getMergeGroupRun =
		mockState.getMergeGroupRun as typeof workerInternals.getMergeGroupRun;
	workerInternals.getPRPollSnapshot =
		mockState.getPRPollSnapshot as typeof workerInternals.getPRPollSnapshot;
	workerInternals.getPRReviewComments =
		mockState.getPRReviewComments as typeof workerInternals.getPRReviewComments;
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
		workerInternals.getMergeGroupRun = savedInternals.getMergeGroupRun;
		workerInternals.getPRPollSnapshot = savedInternals.getPRPollSnapshot;
		workerInternals.getPRReviewComments = savedInternals.getPRReviewComments;
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

// ── Tests ──────────────────────────────────────────────────────────

describe('PrMonitorWorker', () => {
	// Top-level block — no standalone tests
});

describe('PrMonitorWorker — construction', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('constructs with required options', () => {
		const worker = createWorker();
		expect(worker.getStatus()).toBe('stopped');
		expect(worker.isRunning()).toBe(false);
	});

	test('constructs with custom onEvent callback', () => {
		const onEvent = mock(() => {});
		const worker = createWorker({ onEvent });
		expect(worker.getStatus()).toBe('stopped');
	});
});

describe('PrMonitorWorker — start/stop lifecycle', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('start transitions through starting → running', () => {
		const worker = createWorker();
		expect(worker.getStatus()).toBe('stopped');

		worker.start();
		expect(worker.getStatus()).toBe('running');
		expect(worker.isRunning()).toBe(true);
	});

	test('stop transitions to stopped and clears timer', () => {
		const worker = createWorker();
		worker.start();
		expect(worker.isRunning()).toBe(true);

		worker.stop();
		expect(worker.getStatus()).toBe('stopped');
		expect(worker.isRunning()).toBe(false);
	});

	test('stop is idempotent', () => {
		const worker = createWorker();
		worker.stop();
		worker.stop();
		expect(worker.getStatus()).toBe('stopped');
	});

	test('start is idempotent when already running', () => {
		const worker = createWorker();
		worker.start();
		worker.start();
		expect(worker.getStatus()).toBe('running');
	});

	test('dispose stops and prevents restart', () => {
		const worker = createWorker();
		worker.start();
		worker.dispose();
		expect(worker.getStatus()).toBe('stopped');

		// Attempt restart after dispose — should be no-op
		worker.start();
		expect(worker.getStatus()).toBe('stopped');
	});

	test('start fails when config.enabled is false', () => {
		const worker = createWorker({
			config: makeConfig({
				enabled: false,
			}) as PrMonitorWorkerOptions['config'],
		});
		worker.start();
		expect(worker.getStatus()).toBe('stopped');
	});

	test('start fails when directory is empty', () => {
		const worker = new PrMonitorWorker({
			directory: '',
			config: makeConfig() as PrMonitorWorkerOptions['config'],
		});
		worker.start();
		expect(worker.getStatus()).toBe('stopped');
	});
});

describe('PrMonitorWorker — single poll cycle', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('polls all active subscriptions regardless of session', async () => {
		const sub = makeSubscription({ sessionID: 'sess1' });
		const otherSub = makeSubscription({
			sessionID: 'sess2',
			correlationId: 'sess2::owner/repo::99',
			prNumber: 99,
		});

		mockState.listActive.mockResolvedValueOnce([sub, otherSub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		// Should poll ALL active subscriptions (both sessions)
		expect(mockState.getPRStatus).toHaveBeenCalledTimes(2);
		expect(mockState.getPRStatus).toHaveBeenCalledWith(
			42,
			'owner/repo',
			TEST_DIR,
		);
		expect(mockState.getPRStatus).toHaveBeenCalledWith(
			99,
			'owner/repo',
			TEST_DIR,
		);
	});

	test('skips poll when no active subscriptions', async () => {
		mockState.listActive.mockResolvedValueOnce([]);

		const worker = createWorker();
		await worker.pollCycle();

		expect(mockState.getPRStatus).not.toHaveBeenCalled();
		// Sweep still runs
		expect(mockState.sweepStale).toHaveBeenCalled();
	});

	test('respects max_prs_per_cycle limit', async () => {
		const subs = Array.from({ length: 10 }, (_, i) =>
			makeSubscription({
				prNumber: i + 1,
				correlationId: `sess1::owner/repo::${i + 1}`,
			}),
		);

		mockState.listActive.mockResolvedValueOnce(subs);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(subs[0]);

		const worker = createWorker({
			config: makeConfig({
				max_prs_per_cycle: 3,
			}) as PrMonitorWorkerOptions['config'],
		});

		await worker.pollCycle();

		// Only 3 PRs polled (max_prs_per_cycle = 3)
		expect(mockState.getPRStatus).toHaveBeenCalledTimes(3);
	});

	test('runs sweep after poll cycle', async () => {
		const sub = makeSubscription();
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		expect(mockState.sweepStale).toHaveBeenCalledWith(TEST_DIR, 7, undefined);
	});

	test('handles listActive rejection gracefully', async () => {
		mockState.listActive.mockRejectedValueOnce(new Error('lock failure'));

		const worker = createWorker();
		// Should not throw
		await worker.pollCycle();
	});
});

describe('PrMonitorWorker — CI change detection', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('publishes pr.ci.failed (batched) when a check transitions to failure', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([
				{ n: 'ci/build', c: 'success' },
				{ n: 'ci/test', c: 'success' },
			]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'failure' },
					{ name: 'ci/test', status: 'completed', conclusion: 'success' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		// FR-005a: single failure is still ONE batched event (with one entry)
		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.ci.failed',
			expect.objectContaining({
				prNumber: 42,
				repoFullName: 'owner/repo',
				failedChecks: [{ name: 'ci/build', conclusion: 'failure' }],
			}),
			'pr-monitor-worker',
		);
	});

	test('publishes pr.ci.passed when all checks transition to success', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([{ n: 'ci/build', c: 'failure' }]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'success' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.ci.passed',
			expect.objectContaining({
				prNumber: 42,
				checkCount: 1,
			}),
			'pr-monitor-worker',
		);
	});

	test('does not publish pr.ci.passed when checks were already passing', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([{ n: 'ci/build', c: 'success' }]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'success' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const publishCalls = mockState.busInstance.publish.mock.calls;
		const ciPassedCalls = publishCalls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.passed',
		);
		expect(ciPassedCalls).toHaveLength(0);
	});
});

describe('PrMonitorWorker — new comment detection', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('publishes pr.new.comment when new comments appear', async () => {
		const sub = makeSubscription({ lastCommentId: 'comment-1' });
		const newComment: PRCommentResult = {
			id: 'comment-2',
			author: 'developer',
			body: 'Updated the code',
			createdAt: '2025-01-02T00:00:00Z',
			isReviewComment: true,
		};

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue([
			...makePRComments(),
			newComment,
		]);
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.new.comment',
			expect.objectContaining({
				prNumber: 42,
				commentId: 'comment-2',
				author: 'developer',
			}),
			'pr-monitor-worker',
		);
	});

	test('publishes all new comments when lastCommentId is undefined', async () => {
		const sub = makeSubscription({ lastCommentId: undefined });
		const comments = makePRComments();

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(comments);
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.new.comment',
			expect.objectContaining({
				commentId: 'comment-1',
			}),
			'pr-monitor-worker',
		);
	});

	test('does not publish when no new comments', async () => {
		const sub = makeSubscription({ lastCommentId: 'comment-1' });

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const publishCalls = mockState.busInstance.publish.mock.calls;
		const commentCalls = publishCalls.filter(
			(c: Array<unknown>) => c[0] === 'pr.new.comment',
		);
		expect(commentCalls).toHaveLength(0);
	});
});

describe('PrMonitorWorker — merge conflict detection', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('publishes pr.merge.conflict when mergeable changes to CONFLICTING', async () => {
		const sub = makeSubscription({ mergeableState: 'MERGEABLE' });

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(
			makeMergeState({ mergeable: 'CONFLICTING' }),
		);
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.merge.conflict',
			expect.objectContaining({
				prNumber: 42,
				mergeableState: 'CONFLICTING',
			}),
			'pr-monitor-worker',
		);
	});

	test('publishes pr.merge.conflict_resolved when conflict clears', async () => {
		const sub = makeSubscription({ mergeableState: 'CONFLICTING' });

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(
			makeMergeState({ mergeable: 'MERGEABLE' }),
		);
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.merge.conflict_resolved',
			expect.objectContaining({
				prNumber: 42,
				mergeableState: 'MERGEABLE',
			}),
			'pr-monitor-worker',
		);
	});

	// Fix #3: first-poll merge conflict — guard now fires when sub.mergeableState is undefined.
	// Prior code only detected transitions FROM a known state; a PR that is CONFLICTING
	// on its very first poll (no prior snapshot) would not emit pr.merge.conflict.
	test('publishes pr.merge.conflict on first poll when mergeableState is undefined and current is CONFLICTING', async () => {
		// mergeableState is intentionally omitted — simulates a brand-new subscription
		// with no prior snapshot field
		const sub = makeSubscription({ mergeableState: undefined });

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(
			makeMergeState({ mergeable: 'CONFLICTING' }),
		);
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.merge.conflict',
			expect.objectContaining({
				prNumber: 42,
				mergeableState: 'CONFLICTING',
			}),
			'pr-monitor-worker',
		);
	});
});

describe('PrMonitorWorker — merge and close events', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('publishes pr.merged and auto-unsubscribes', async () => {
		const sub = makeSubscription();
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus({ state: 'MERGED' }));
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.unsubscribe.mockResolvedValue(sub);

		const worker = createWorker({
			config: makeConfig({
				auto_unsubscribe_on_merge: true,
			}) as PrMonitorWorkerOptions['config'],
		});
		await worker.pollCycle();

		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.merged',
			expect.objectContaining({
				prNumber: 42,
				headRefOid: 'abc123',
			}),
			'pr-monitor-worker',
		);
		expect(mockState.unsubscribe).toHaveBeenCalledWith(
			TEST_DIR,
			'sess1::owner/repo::42',
		);
	});

	test('publishes pr.closed and auto-unsubscribes', async () => {
		const sub = makeSubscription();
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus({ state: 'CLOSED' }));
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.unsubscribe.mockResolvedValue(sub);

		const worker = createWorker({
			config: makeConfig({
				auto_unsubscribe_on_close: true,
			}) as PrMonitorWorkerOptions['config'],
		});
		await worker.pollCycle();

		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.closed',
			expect.objectContaining({
				prNumber: 42,
			}),
			'pr-monitor-worker',
		);
		expect(mockState.unsubscribe).toHaveBeenCalledWith(
			TEST_DIR,
			'sess1::owner/repo::42',
		);
	});

	test('does not auto-unsubscribe when flag is false', async () => {
		const sub = makeSubscription();
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus({ state: 'MERGED' }));
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker({
			config: makeConfig({
				auto_unsubscribe_on_merge: false,
			}) as PrMonitorWorkerOptions['config'],
		});
		await worker.pollCycle();

		expect(mockState.unsubscribe).not.toHaveBeenCalled();
		// Should update snapshot instead
		expect(mockState.updateSnapshot).toHaveBeenCalled();
	});
});

describe('PrMonitorWorker — head ref change detection', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('publishes pr.status.updated when headRefOid changes', async () => {
		const sub = makeSubscription({ headRefOid: 'old-sha' });
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({ headRefOid: 'new-sha' }),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.status.updated',
			expect.objectContaining({
				prNumber: 42,
				previousOid: 'old-sha',
				currentOid: 'new-sha',
			}),
			'pr-monitor-worker',
		);
	});

	test('does not publish when headRefOid is unchanged', async () => {
		const sub = makeSubscription({ headRefOid: 'abc123' });
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({ headRefOid: 'abc123' }),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const publishCalls = mockState.busInstance.publish.mock.calls;
		const statusCalls = publishCalls.filter(
			(c: Array<unknown>) => c[0] === 'pr.status.updated',
		);
		expect(statusCalls).toHaveLength(0);
	});
});

describe('PrMonitorWorker — circuit breaker', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('increments errorCount on poll failure', async () => {
		const sub = makeSubscription({ errorCount: 0 });
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockRejectedValue(new Error('gh auth failed'));
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker({
			config: makeConfig({
				failure_threshold: 5,
			}) as PrMonitorWorkerOptions['config'],
		});
		await worker.pollCycle();

		expect(mockState.updateSnapshot).toHaveBeenCalledWith(
			TEST_DIR,
			'sess1::owner/repo::42',
			expect.objectContaining({
				errorCount: 1,
			}),
		);
	});

	test('trips circuit breaker at failure_threshold', async () => {
		const sub = makeSubscription({ errorCount: 4 }); // One below threshold
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockRejectedValue(new Error('gh auth failed'));
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker({
			config: makeConfig({
				failure_threshold: 5,
				cooldown_seconds: 30,
				max_cooldown_seconds: 300,
			}) as PrMonitorWorkerOptions['config'],
		});
		await worker.pollCycle();

		expect(mockState.updateSnapshot).toHaveBeenCalledWith(
			TEST_DIR,
			'sess1::owner/repo::42',
			expect.objectContaining({
				errorCount: 5,
			}),
		);

		// Should emit pr.error event
		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.error',
			expect.objectContaining({
				reason: 'circuit_breaker',
				errorCount: 5,
			}),
			'pr-monitor-worker',
		);
	});

	test('resets errorCount on successful poll after errors', async () => {
		const sub = makeSubscription({ errorCount: 3 });
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		// Final updateSnapshot should reset errorCount to 0
		const lastUpdateCall = mockState.updateSnapshot.mock.calls;
		const lastCall = lastUpdateCall[lastUpdateCall.length - 1];
		expect(lastCall[2]).toHaveProperty('errorCount', 0);
	});

	test('skips suspended PRs during poll', async () => {
		const sub = makeSubscription();
		mockState.listActive.mockResolvedValueOnce([sub]);

		// First poll: cause a circuit breaker trip
		mockState.getPRStatus.mockRejectedValueOnce(new Error('fail'));
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker({
			config: makeConfig({
				failure_threshold: 1,
				cooldown_seconds: 60,
				max_cooldown_seconds: 300,
			}) as PrMonitorWorkerOptions['config'],
		});

		// First poll — trips circuit breaker
		await worker.pollCycle();

		// Reset mocks for second poll
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());

		// Second poll — should skip suspended PR
		await worker.pollCycle();

		// getPRStatus should only have been called once (first poll only)
		expect(mockState.getPRStatus).toHaveBeenCalledTimes(1);
	});
});

describe('PrMonitorWorker — concurrency limiting', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('respects max_concurrent_pr_polls', async () => {
		const subs = Array.from({ length: 6 }, (_, i) =>
			makeSubscription({
				prNumber: i + 1,
				correlationId: `sess1::owner/repo::${i + 1}`,
			}),
		);

		mockState.listActive.mockResolvedValueOnce(subs);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(subs[0]);

		// Track concurrent gh calls
		let maxConcurrent = 0;
		let currentConcurrent = 0;

		mockState.getPRStatus.mockImplementation(async () => {
			currentConcurrent++;
			maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
			// Simulate async work
			await new Promise((r) => setTimeout(r, 10));
			currentConcurrent--;
			return makePRStatus();
		});

		const worker = createWorker({
			config: makeConfig({
				max_prs_per_cycle: 6,
				max_concurrent_pr_polls: 2,
			}) as PrMonitorWorkerOptions['config'],
		});

		await worker.pollCycle();

		// Should not exceed 2 concurrent gh processes
		expect(maxConcurrent).toBeLessThanOrEqual(2);
		// All 6 PRs should have been polled
		expect(mockState.getPRStatus).toHaveBeenCalledTimes(6);
	});
});

describe('PrMonitorWorker — poll timeout', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('times out a slow poll and handles error per-PR via circuit breaker', async () => {
		const sub1 = makeSubscription({
			prNumber: 99,
			correlationId: 'sess1::owner/repo::99',
		});
		const sub2 = makeSubscription({
			prNumber: 100,
			correlationId: 'sess1::owner/repo::100',
		});

		mockState.listActive.mockResolvedValueOnce([sub1, sub2]);

		// Make getPRStatus hang for the first PR (will trigger timeout)
		mockState.getPRStatus
			.mockImplementationOnce(() => new Promise<void>(() => {}))
			.mockResolvedValueOnce(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());

		const worker = createWorker({
			config: makeConfig({
				poll_timeout_ms: 50,
				max_concurrent_pr_polls: 1,
			}) as PrMonitorWorkerOptions['config'],
		});

		// pollCycle should NOT throw — timeout handled per-PR
		await worker.pollCycle();

		// getPRStatus called for both PRs (first times out, second still polls)
		expect(mockState.getPRStatus).toHaveBeenCalledTimes(2);

		// Circuit breaker accounting: errorCount updated for the timed-out PR
		expect(mockState.updateSnapshot).toHaveBeenCalledWith(
			expect.any(String),
			'sess1::owner/repo::99',
			expect.objectContaining({
				errorCount: expect.any(Number),
			}),
		);
	});

	test('late-resolving poll does not undo timeout circuit-breaker accounting', async () => {
		let resolveSlowPoll: () => void;
		const slowPromise = new Promise<void>((resolve) => {
			resolveSlowPoll = resolve;
		});

		const sub = makeSubscription({
			prNumber: 99,
			correlationId: 'sess1::owner/repo::99',
		});

		mockState.listActive.mockResolvedValueOnce([sub]);

		// getPRStatus resolves slowly (after timeout fires)
		mockState.getPRStatus.mockImplementationOnce(() => slowPromise);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());

		const worker = createWorker({
			config: makeConfig({
				poll_timeout_ms: 50,
			}) as PrMonitorWorkerOptions['config'],
		});

		const pollDone = worker.pollCycle();

		// Wait for timeout to fire and handle
		await new Promise((r) => setTimeout(r, 100));

		// Now resolve the slow poll (simulating late completion)
		resolveSlowPoll!();

		await pollDone;

		// Circuit breaker errorCount should still reflect the timeout
		expect(mockState.updateSnapshot).toHaveBeenCalledWith(
			expect.any(String),
			'sess1::owner/repo::99',
			expect.objectContaining({
				errorCount: expect.any(Number),
			}),
		);

		// No event should have been published for the late-resolving poll
		expect(mockState.busInstance.publish).not.toHaveBeenCalled();
	});
});

describe('PrMonitorWorker — event publishing', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('publishes events via global event bus', async () => {
		const sub = makeSubscription({ headRefOid: undefined });
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		expect(mockState.getGlobalEventBus).toHaveBeenCalled();
		expect(mockState.busInstance.publish).toHaveBeenCalled();
	});

	test('invokes onEvent callback when provided', async () => {
		const onEvent = mock(() => {});
		const sub = makeSubscription({ headRefOid: undefined });
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker({ onEvent });
		await worker.pollCycle();

		// onEvent should have been called for each event published
		expect(onEvent).toHaveBeenCalled();
	});

	test('handles onEvent callback errors gracefully', async () => {
		const onEvent = mock(() => {
			throw new Error('callback exploded');
		});
		const sub = makeSubscription({ headRefOid: undefined });
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker({ onEvent });
		// Should not throw despite callback error
		await worker.pollCycle();
	});

	test('handles event bus publish errors gracefully', async () => {
		mockState.busInstance.publish.mockRejectedValue(new Error('bus down'));
		const sub = makeSubscription({ headRefOid: undefined });
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		// Should not throw despite bus error
		await worker.pollCycle();
	});
});

describe('PrMonitorWorker — sweep behavior', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('does not sweep when cleanup_ttl_days is 0', async () => {
		mockState.listActive.mockResolvedValueOnce([]);

		const worker = createWorker({
			config: makeConfig({
				cleanup_ttl_days: 0,
			}) as PrMonitorWorkerOptions['config'],
		});
		await worker.pollCycle();

		expect(mockState.sweepStale).not.toHaveBeenCalled();
	});

	test('sweep errors do not crash the poll cycle', async () => {
		mockState.listActive.mockResolvedValueOnce([]);
		mockState.sweepStale.mockRejectedValue(new Error('sweep failed'));

		const worker = createWorker();
		await worker.pollCycle();
		// Should not throw
	});
});

describe('PrMonitorWorker — comment ordering regression', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('handles mixed issue/review comments returned out of chronological order', async () => {
		// Simulate getPRComments returning issue comment then review comment
		// where the review comment is older — ordering is NOT globally chronological
		const sub = makeSubscription({ lastCommentId: 'comment-1' });

		// Issue comment (newer) returned first, then older review comment
		const outOfOrderComments: PRCommentResult[] = [
			{
				id: 'comment-3',
				author: 'developer',
				body: 'Latest issue comment',
				createdAt: '2025-01-03T00:00:00Z',
				isReviewComment: false,
			},
			{
				id: 'comment-1',
				author: 'bot',
				body: 'Old review comment',
				createdAt: '2025-01-01T00:00:00Z',
				isReviewComment: true,
			},
			{
				id: 'comment-2',
				author: 'reviewer',
				body: 'Middle review comment',
				createdAt: '2025-01-02T00:00:00Z',
				isReviewComment: true,
			},
		];

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(outOfOrderComments);
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		// Should only emit comment-2 and comment-3 (after lastCommentId='comment-1'),
		// NOT re-emit comment-1 even though it appears in the array
		const publishCalls = mockState.busInstance.publish.mock.calls;
		const commentEvents = publishCalls.filter(
			(c: Array<unknown>) => c[0] === 'pr.new.comment',
		);
		expect(commentEvents).toHaveLength(2);

		// Events should be in chronological order (sorted by createdAt)
		expect(commentEvents[0][1]).toHaveProperty('commentId', 'comment-2');
		expect(commentEvents[1][1]).toHaveProperty('commentId', 'comment-3');

		// lastCommentId should be updated to the newest comment (comment-3)
		// detectChanges calls updateSnapshot FIRST (index 0), before
		// pollSinglePr calls it again with {errorCount, lastCheckedAt}
		const lastUpdate = mockState.updateSnapshot.mock.calls[0];
		expect(lastUpdate[2]).toHaveProperty('lastCommentId', 'comment-3');
	});

	test('old comments before lastCommentId are not re-emitted', async () => {
		const sub = makeSubscription({ lastCommentId: 'comment-3' });

		// Comments include both old and new; the old ones should be skipped
		const comments: PRCommentResult[] = [
			{
				id: 'comment-1',
				author: 'a',
				body: 'Old',
				createdAt: '2025-01-01T00:00:00Z',
				isReviewComment: false,
			},
			{
				id: 'comment-2',
				author: 'b',
				body: 'Also old',
				createdAt: '2025-01-02T00:00:00Z',
				isReviewComment: true,
			},
			{
				id: 'comment-3',
				author: 'c',
				body: 'Last seen',
				createdAt: '2025-01-03T00:00:00Z',
				isReviewComment: false,
			},
			{
				id: 'comment-4',
				author: 'd',
				body: 'New',
				createdAt: '2025-01-04T00:00:00Z',
				isReviewComment: true,
			},
		];

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(comments);
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		// Only comment-4 should be emitted
		const publishCalls = mockState.busInstance.publish.mock.calls;
		const commentEvents = publishCalls.filter(
			(c: Array<unknown>) => c[0] === 'pr.new.comment',
		);
		expect(commentEvents).toHaveLength(1);
		expect(commentEvents[0][1]).toHaveProperty('commentId', 'comment-4');

		// lastCommentId should update to the newest (comment-4)
		// detectChanges calls updateSnapshot FIRST (index 0), before
		// pollSinglePr calls it again with {errorCount, lastCheckedAt}
		const lastUpdate = mockState.updateSnapshot.mock.calls[0];
		expect(lastUpdate[2]).toHaveProperty('lastCommentId', 'comment-4');
	});

	test('emits all comments in chronological order on first poll (no lastCommentId)', async () => {
		const sub = makeSubscription({ lastCommentId: undefined });

		// Comments returned in reverse chronological order
		const reverseOrderComments: PRCommentResult[] = [
			{
				id: 'comment-3',
				author: 'c',
				body: 'Newest',
				createdAt: '2025-01-03T00:00:00Z',
				isReviewComment: false,
			},
			{
				id: 'comment-1',
				author: 'a',
				body: 'Oldest',
				createdAt: '2025-01-01T00:00:00Z',
				isReviewComment: false,
			},
			{
				id: 'comment-2',
				author: 'b',
				body: 'Middle',
				createdAt: '2025-01-02T00:00:00Z',
				isReviewComment: true,
			},
		];

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(reverseOrderComments);
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		// All 3 comments emitted
		const publishCalls = mockState.busInstance.publish.mock.calls;
		const commentEvents = publishCalls.filter(
			(c: Array<unknown>) => c[0] === 'pr.new.comment',
		);
		expect(commentEvents).toHaveLength(3);

		// Events emitted in chronological order
		expect(commentEvents[0][1]).toHaveProperty('commentId', 'comment-1');
		expect(commentEvents[1][1]).toHaveProperty('commentId', 'comment-2');
		expect(commentEvents[2][1]).toHaveProperty('commentId', 'comment-3');

		// lastCommentId updated to newest
		// detectChanges calls updateSnapshot FIRST (index 0), before
		// pollSinglePr calls it again with {errorCount, lastCheckedAt}
		const lastUpdate = mockState.updateSnapshot.mock.calls[0];
		expect(lastUpdate[2]).toHaveProperty('lastCommentId', 'comment-3');
	});
});

describe('PrMonitorWorker — review state change detection', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('publishes pr.review.changes_requested when review state changes to CHANGES_REQUESTED', async () => {
		const sub = makeSubscription();

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.getPRReviewState.mockResolvedValue({
			reviewDecision: 'CHANGES_REQUESTED',
			reviewRequestCount: 1,
		});
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.review.changes_requested',
			expect.objectContaining({
				prNumber: 42,
				repoFullName: 'owner/repo',
				reviewDecision: 'CHANGES_REQUESTED',
			}),
			'pr-monitor-worker',
		);
	});

	test('publishes pr.review.approved when review state changes to APPROVED', async () => {
		const sub = makeSubscription();

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.getPRReviewState.mockResolvedValue({
			reviewDecision: 'APPROVED',
			reviewRequestCount: 0,
		});
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.review.approved',
			expect.objectContaining({
				prNumber: 42,
				repoFullName: 'owner/repo',
				reviewDecision: 'APPROVED',
			}),
			'pr-monitor-worker',
		);
	});

	test('does not re-emit review event when review state is unchanged', async () => {
		const sub = makeSubscription();

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.getPRReviewState.mockResolvedValue({
			reviewDecision: 'CHANGES_REQUESTED',
			reviewRequestCount: 0,
		});
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();

		// First poll — emits event
		await worker.pollCycle();
		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.review.changes_requested',
			expect.anything(),
			'pr-monitor-worker',
		);

		// Reset for second poll
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRReviewState.mockResolvedValue({
			reviewDecision: 'CHANGES_REQUESTED',
			reviewRequestCount: 0,
		});
		mockState.busInstance.publish.mockClear();

		// Second poll — same state, should NOT re-emit
		await worker.pollCycle();

		const reviewCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) =>
				c[0] === 'pr.review.changes_requested' || c[0] === 'pr.review.approved',
		);
		expect(reviewCalls).toHaveLength(0);
	});

	test('detects transition from CHANGES_REQUESTED to APPROVED', async () => {
		const sub = makeSubscription();

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.getPRReviewState.mockResolvedValue({
			reviewDecision: 'CHANGES_REQUESTED',
			reviewRequestCount: 0,
		});
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();

		// First poll: CHANGES_REQUESTED
		await worker.pollCycle();
		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.review.changes_requested',
			expect.anything(),
			'pr-monitor-worker',
		);

		// Reset for second poll
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRReviewState.mockResolvedValue({
			reviewDecision: 'APPROVED',
			reviewRequestCount: 0,
		});
		mockState.busInstance.publish.mockClear();

		// Second poll: APPROVED
		await worker.pollCycle();
		expect(mockState.busInstance.publish).toHaveBeenCalledWith(
			'pr.review.approved',
			expect.objectContaining({
				reviewDecision: 'APPROVED',
			}),
			'pr-monitor-worker',
		);
	});

	test('does not emit review event when reviewDecision is empty (first poll)', async () => {
		const sub = makeSubscription();

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		// Default mock returns empty string — no event should fire
		mockState.getPRReviewState.mockResolvedValue({
			reviewDecision: '',
			reviewRequestCount: 0,
		});
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const reviewCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) =>
				c[0] === 'pr.review.changes_requested' || c[0] === 'pr.review.approved',
		);
		expect(reviewCalls).toHaveLength(0);
	});
});

describe('PrMonitorWorker — prUrl in all event payloads', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	function extractPayloads(mockCalls: Array<Array<unknown>>) {
		return mockCalls.map((call) => call[1] as Record<string, unknown>);
	}

	test('pr.ci.failed payload includes prUrl', async () => {
		const sub = makeSubscription({
			prUrl: 'https://github.com/owner/repo/pull/42',
			lastCheckRunSet: JSON.stringify([{ n: 'ci/build', c: 'success' }]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'failure' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const payloads = extractPayloads(mockState.busInstance.publish.mock.calls);
		const ciFailed = payloads.find(
			(p) =>
				(mockState.busInstance.publish.mock.calls.find((c) => c[1] === p) ??
					[])[0] === 'pr.ci.failed',
		);
		expect(ciFailed).toBeDefined();
		expect(ciFailed).toHaveProperty(
			'prUrl',
			'https://github.com/owner/repo/pull/42',
		);
	});

	test('pr.merge.conflict payload includes prUrl', async () => {
		const sub = makeSubscription({
			prUrl: 'https://github.com/owner/repo/pull/42',
			mergeableState: 'MERGEABLE',
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(
			makeMergeState({ mergeable: 'CONFLICTING' }),
		);
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const conflictCall = mockState.busInstance.publish.mock.calls.find(
			(c) => c[0] === 'pr.merge.conflict',
		);
		expect(conflictCall).toBeDefined();
		expect(conflictCall![1]).toHaveProperty(
			'prUrl',
			'https://github.com/owner/repo/pull/42',
		);
	});

	test('pr.new.comment payload includes prUrl', async () => {
		const sub = makeSubscription({
			prUrl: 'https://github.com/owner/repo/pull/42',
			lastCommentId: 'comment-1',
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getPRComments.mockResolvedValue([
			...makePRComments(),
			{
				id: 'comment-2',
				author: 'dev',
				body: 'New comment',
				createdAt: '2025-01-02T00:00:00Z',
				isReviewComment: false,
			},
		]);
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const commentCall = mockState.busInstance.publish.mock.calls.find(
			(c) => c[0] === 'pr.new.comment',
		);
		expect(commentCall).toBeDefined();
		expect(commentCall![1]).toHaveProperty(
			'prUrl',
			'https://github.com/owner/repo/pull/42',
		);
	});

	test('pr.merged payload includes prUrl', async () => {
		const sub = makeSubscription({
			prUrl: 'https://github.com/owner/repo/pull/42',
		});
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus({ state: 'MERGED' }));
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.unsubscribe.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const mergedCall = mockState.busInstance.publish.mock.calls.find(
			(c) => c[0] === 'pr.merged',
		);
		expect(mergedCall).toBeDefined();
		expect(mergedCall![1]).toHaveProperty(
			'prUrl',
			'https://github.com/owner/repo/pull/42',
		);
	});

	test('pr.closed payload includes prUrl', async () => {
		const sub = makeSubscription({
			prUrl: 'https://github.com/owner/repo/pull/42',
		});
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus({ state: 'CLOSED' }));
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.unsubscribe.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const closedCall = mockState.busInstance.publish.mock.calls.find(
			(c) => c[0] === 'pr.closed',
		);
		expect(closedCall).toBeDefined();
		expect(closedCall![1]).toHaveProperty(
			'prUrl',
			'https://github.com/owner/repo/pull/42',
		);
	});

	test('pr.error payload includes prUrl when circuit breaker trips', async () => {
		const sub = makeSubscription({
			prUrl: 'https://github.com/owner/repo/pull/42',
			errorCount: 4,
		});
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockRejectedValue(new Error('gh auth failed'));
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker({
			config: makeConfig({
				failure_threshold: 5,
				cooldown_seconds: 30,
				max_cooldown_seconds: 300,
			}) as PrMonitorWorkerOptions['config'],
		});
		await worker.pollCycle();

		const errorCall = mockState.busInstance.publish.mock.calls.find(
			(c) => c[0] === 'pr.error',
		);
		expect(errorCall).toBeDefined();
		expect(errorCall![1]).toHaveProperty(
			'prUrl',
			'https://github.com/owner/repo/pull/42',
		);
	});
});

describe('PrMonitorWorker — merge group run fetching', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('SC-014: fetches and stores merge group run info on poll', async () => {
		const sub = makeSubscription();
		const mergeGroupRun: MergeGroupRunResult = {
			status: 'completed',
			conclusion: 'failure',
			htmlUrl: 'https://github.com/owner/repo/actions/runs/999',
		};

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'success' },
					{
						name: 'Merge pull request',
						status: 'completed',
						conclusion: 'failure',
						detailsUrl: 'https://github.com/owner/repo/actions/runs/999',
					},
				],
			}),
		);
		mockState.getMergeGroupRun.mockResolvedValueOnce(mergeGroupRun);
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		// Verify getMergeGroupRun was called with the statusCheckRollup
		expect(mockState.getMergeGroupRun).toHaveBeenCalledTimes(1);
		expect(mockState.getMergeGroupRun).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ name: 'Merge pull request' }),
			]),
			'owner/repo',
			TEST_DIR,
		);

		// Verify updateSnapshot was called with merge group run fields
		expect(mockState.updateSnapshot).toHaveBeenCalled();
		const updateCall = mockState.updateSnapshot.mock.calls.find(
			(c) => c[0] === TEST_DIR && c[1] === sub.correlationId,
		);
		expect(updateCall).toBeDefined();
		expect(updateCall![2]).toMatchObject({
			mergeGroupRunStatus: 'completed',
			mergeGroupRunConclusion: 'failure',
			mergeGroupRunHtmlUrl: 'https://github.com/owner/repo/actions/runs/999',
		});
	});

	test('does not crash when getMergeGroupRun throws', async () => {
		const sub = makeSubscription();
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getMergeGroupRun.mockRejectedValueOnce(
			new Error('gh run view failed'),
		);
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		// Should not throw
		await worker.pollCycle();

		// Snapshot should still be updated (without merge group run info)
		expect(mockState.updateSnapshot).toHaveBeenCalled();
	});

	test('preserves prior mergeGroupRun snapshot fields when getMergeGroupRun throws (transient failure)', async () => {
		// Seed subscription with known merge group run state
		const sub = makeSubscription({
			mergeGroupRunStatus: 'failure',
			mergeGroupRunConclusion: 'failure',
			mergeGroupRunHtmlUrl: 'https://github.com/owner/repo/actions/runs/999',
		});
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(makePRStatus());
		mockState.getMergeGroupRun.mockRejectedValueOnce(
			new Error('gh run view failed'),
		);
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		// Verify pollCycle did not throw
		expect(mockState.updateSnapshot).toHaveBeenCalled();

		// There are two updateSnapshot calls:
		// 1. applyChanges -> snapshotUpdates (from computeChanges)
		// 2. Success path -> { errorCount: 0, lastCheckedAt }
		// We need to check call #1 has no mergeGroupRun* fields
		const snapshotUpdateCalls = mockState.updateSnapshot.mock.calls.filter(
			(c) =>
				c[0] === TEST_DIR &&
				c[1] === sub.correlationId &&
				c[2] && // non-null updates
				!('errorCount' in c[2] && Object.keys(c[2]).length === 2), // not the success {errorCount, lastCheckedAt} call
		);

		expect(snapshotUpdateCalls).toHaveLength(1);

		// mergeGroupRun* fields must NOT be present in snapshotUpdates on transient failure
		// so the prior snapshot state is preserved by the merge in updateSnapshot
		expect(snapshotUpdateCalls[0][2]).not.toHaveProperty('mergeGroupRunStatus');
		expect(snapshotUpdateCalls[0][2]).not.toHaveProperty(
			'mergeGroupRunConclusion',
		);
		expect(snapshotUpdateCalls[0][2]).not.toHaveProperty(
			'mergeGroupRunHtmlUrl',
		);
	});

	test('stores null merge group run fields when no merge group check exists', async () => {
		const sub = makeSubscription();
		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'success' },
				],
			}),
		);
		mockState.getMergeGroupRun.mockResolvedValueOnce(null);
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		// Verify updateSnapshot was called with undefined merge group fields
		const updateCall = mockState.updateSnapshot.mock.calls.find(
			(c) => c[0] === TEST_DIR && c[1] === sub.correlationId,
		);
		expect(updateCall).toBeDefined();
		expect(updateCall![2]).toMatchObject({
			mergeGroupRunStatus: undefined,
			mergeGroupRunConclusion: undefined,
			mergeGroupRunHtmlUrl: undefined,
		});
	});
});

describe('PrMonitorWorker — FR-005a CI failure batching (SC-015)', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	test('SC-015: three failing checks in one poll cycle produces ONE batched pr.ci.failed event', async () => {
		// Prior state: all checks passing
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([
				{ n: 'ci/build', c: 'success' },
				{ n: 'ci/test', c: 'success' },
				{ n: 'ci/lint', c: 'success' },
			]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		// Current state: all three checks now failing
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'failure' },
					{ name: 'ci/test', status: 'completed', conclusion: 'failure' },
					{ name: 'ci/lint', status: 'completed', conclusion: 'failure' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		// Exactly ONE pr.ci.failed event emitted (not three)
		const publishCalls = mockState.busInstance.publish.mock.calls;
		const ciFailedCalls = publishCalls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.failed',
		);
		expect(ciFailedCalls).toHaveLength(1);

		// The single batched event payload contains all three failed checks
		const batchedPayload = ciFailedCalls[0][1] as Record<string, unknown>;
		expect(batchedPayload).toHaveProperty('prNumber', 42);
		expect(batchedPayload).toHaveProperty('repoFullName', 'owner/repo');
		expect(batchedPayload).toHaveProperty('failedChecks');
		const failedChecks = batchedPayload.failedChecks as Array<{
			name: string;
			conclusion: string;
		}>;
		expect(failedChecks).toHaveLength(3);
		expect(failedChecks.map((c) => c.name).sort()).toEqual([
			'ci/build',
			'ci/lint',
			'ci/test',
		]);
	});

	test('SC-015: batched event uses the same dedup token format as individual events', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([
				{ n: 'ci/build', c: 'success' },
				{ n: 'ci/test', c: 'success' },
			]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'failure' },
					{ name: 'ci/test', status: 'completed', conclusion: 'failure' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const ciFailedCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.failed',
		);
		expect(ciFailedCalls).toHaveLength(1);

		// The batched event has failedChecks (not a single checkName)
		const payload = ciFailedCalls[0][1] as Record<string, unknown>;
		expect(payload).toHaveProperty('failedChecks');
		expect(payload).not.toHaveProperty('checkName'); // batched payload uses failedChecks
	});

	test('SC-015: one previously-passing check and two already-failing checks → only one new failure emitted', async () => {
		// ci/build was already failing; ci/test and ci/lint are new failures
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([
				{ n: 'ci/build', c: 'failure' },
				{ n: 'ci/test', c: 'success' },
				{ n: 'ci/lint', c: 'success' },
			]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'failure' },
					{ name: 'ci/test', status: 'completed', conclusion: 'failure' },
					{ name: 'ci/lint', status: 'completed', conclusion: 'failure' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		// Only ONE batched event (for the 2 newly-failed checks)
		const ciFailedCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.failed',
		);
		expect(ciFailedCalls).toHaveLength(1);

		const failedChecks = (ciFailedCalls[0][1] as Record<string, unknown>)
			.failedChecks as Array<{ name: string }>;
		expect(failedChecks.map((c) => c.name).sort()).toEqual([
			'ci/lint',
			'ci/test',
		]);
	});
});

describe('formatAdvisory — FR-005a batched CI failure (SC-015)', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { formatAdvisory } = subscriberInternals as any;

	test('SC-015: batched failedChecks renders all check names in advisory', () => {
		const advisory = formatAdvisory('pr.ci.failed', {
			prNumber: 42,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/42',
			failedChecks: [
				{ name: 'ci/build', conclusion: 'failure' },
				{ name: 'ci/test', conclusion: 'failure' },
				{ name: 'ci/lint', conclusion: 'failure' },
			],
		});

		expect(advisory).toContain('[pr-monitor:pr.ci.failed:owner/repo#42]');
		expect(advisory).toContain('3 CI checks failed');
		expect(advisory).toContain('ci/build');
		expect(advisory).toContain('ci/test');
		expect(advisory).toContain('ci/lint');
	});

	test('SC-015: batched advisory uses plural form for singular failure', () => {
		const advisory = formatAdvisory('pr.ci.failed', {
			prNumber: 99,
			repoFullName: 'org/repo',
			prUrl: 'https://github.com/org/repo/pull/99',
			failedChecks: [{ name: 'ci/build', conclusion: 'failure' }],
		});

		expect(advisory).toContain('1 CI check failed');
		expect(advisory).not.toContain('1 CI checks failed');
	});

	test('SC-015: legacy single-checkName payload still formats correctly', () => {
		// Backward-compat: old events with checkName (no failedChecks)
		const advisory = formatAdvisory('pr.ci.failed', {
			prNumber: 7,
			repoFullName: 'old/legacy',
			prUrl: 'https://github.com/old/legacy/pull/7',
			checkName: 'ci/build',
			checkState: 'failure',
		});

		expect(advisory).toContain('[pr-monitor:pr.ci.failed:old/legacy#7]');
		expect(advisory).toContain('ci/build');
		expect(advisory).toContain('CI check "ci/build" failed');
	});
});

describe('PrMonitorWorker — FR-005a CI failure batching adversarial (SC-015)', () => {
	beforeEach(() => {
		setupMocks();
	});

	afterEach(() => {
		restoreInternals();
	});

	// ── Adversarial: PR with 0 failures (all pass) ──────────────────────
	test('SC-015 adversarial: all checks still passing → no pr.ci.failed event', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([
				{ n: 'ci/build', c: 'success' },
				{ n: 'ci/test', c: 'success' },
			]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'success' },
					{ name: 'ci/test', status: 'completed', conclusion: 'success' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const ciFailedCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.failed',
		);
		expect(ciFailedCalls).toHaveLength(0);
	});

	test('SC-015 adversarial: all checks still passing → no pr.ci.passed (already passing)', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([{ n: 'ci/build', c: 'success' }]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'success' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const ciPassedCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.passed',
		);
		expect(ciPassedCalls).toHaveLength(0);
	});

	test('SC-015 adversarial: all checks already failing → no pr.ci.failed event', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([
				{ n: 'ci/build', c: 'failure' },
				{ n: 'ci/test', c: 'failure' },
			]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'failure' },
					{ name: 'ci/test', status: 'completed', conclusion: 'failure' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const ciFailedCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.failed',
		);
		expect(ciFailedCalls).toHaveLength(0);
	});

	test('SC-015 adversarial: one new failure among already-passing checks → one batched event with one entry', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([
				{ n: 'ci/build', c: 'success' },
				{ n: 'ci/test', c: 'success' },
			]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'failure' },
					{ name: 'ci/test', status: 'completed', conclusion: 'success' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const ciFailedCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.failed',
		);
		expect(ciFailedCalls).toHaveLength(1);
		const failedChecks = (ciFailedCalls[0][1] as Record<string, unknown>)
			.failedChecks as Array<{ name: string }>;
		expect(failedChecks).toHaveLength(1);
		expect(failedChecks[0].name).toBe('ci/build');
	});

	test('SC-015 adversarial: one new failure + two already-failing → only the new one in batched event', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([
				{ n: 'ci/build', c: 'failure' },
				{ n: 'ci/test', c: 'failure' },
				{ n: 'ci/lint', c: 'success' },
			]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'failure' },
					{ name: 'ci/test', status: 'completed', conclusion: 'failure' },
					{ name: 'ci/lint', status: 'completed', conclusion: 'failure' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const ciFailedCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.failed',
		);
		expect(ciFailedCalls).toHaveLength(1);
		const failedChecks = (ciFailedCalls[0][1] as Record<string, unknown>)
			.failedChecks as Array<{ name: string }>;
		expect(failedChecks.map((c) => c.name).sort()).toEqual(['ci/lint']);
		expect(failedChecks.map((c) => c.name)).not.toContain('ci/build');
		expect(failedChecks.map((c) => c.name)).not.toContain('ci/test');
	});

	test('SC-015 adversarial: all checks recover from failure → pr.ci.passed emitted', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([
				{ n: 'ci/build', c: 'failure' },
				{ n: 'ci/test', c: 'failure' },
			]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'success' },
					{ name: 'ci/test', status: 'completed', conclusion: 'success' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const ciPassedCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.passed',
		);
		expect(ciPassedCalls).toHaveLength(1);
		const payload = ciPassedCalls[0][1] as Record<string, unknown>;
		expect(payload).toHaveProperty('checkCount', 2);
	});

	test('SC-015 adversarial: conclusion is FAILURE (uppercase) still triggers batching', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([
				{ n: 'ci/build', c: 'success' },
				{ n: 'ci/test', c: 'success' },
			]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'FAILURE' },
					{ name: 'ci/test', status: 'completed', conclusion: 'failure' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const ciFailedCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.failed',
		);
		expect(ciFailedCalls).toHaveLength(1);
		const failedChecks = (ciFailedCalls[0][1] as Record<string, unknown>)
			.failedChecks as Array<{ name: string; conclusion: string }>;
		expect(failedChecks.map((c) => c.name).sort()).toEqual([
			'ci/build',
			'ci/test',
		]);
	});

	test('SC-015 adversarial: new check not in prior set but now failing → emitted', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([{ n: 'ci/build', c: 'success' }]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'success' },
					{ name: 'ci/lint', status: 'completed', conclusion: 'failure' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const ciFailedCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.failed',
		);
		expect(ciFailedCalls).toHaveLength(1);
		const failedChecks = (ciFailedCalls[0][1] as Record<string, unknown>)
			.failedChecks as Array<{ name: string }>;
		expect(failedChecks.map((c) => c.name)).toEqual(['ci/lint']);
	});

	test('SC-015 adversarial: check missing from current rollup is not emitted as failure', async () => {
		const sub = makeSubscription({
			lastCheckRunSet: JSON.stringify([
				{ n: 'ci/build', c: 'success' },
				{ n: 'ci/lint', c: 'success' },
			]),
		});

		mockState.listActive.mockResolvedValueOnce([sub]);
		mockState.getPRStatus.mockResolvedValue(
			makePRStatus({
				statusCheckRollup: [
					{ name: 'ci/build', status: 'completed', conclusion: 'success' },
				],
			}),
		);
		mockState.getPRComments.mockResolvedValue(makePRComments());
		mockState.getMergeState.mockResolvedValue(makeMergeState());
		mockState.updateSnapshot.mockResolvedValue(sub);

		const worker = createWorker();
		await worker.pollCycle();

		const ciFailedCalls = mockState.busInstance.publish.mock.calls.filter(
			(c: Array<unknown>) => c[0] === 'pr.ci.failed',
		);
		expect(ciFailedCalls).toHaveLength(0);
	});
});
