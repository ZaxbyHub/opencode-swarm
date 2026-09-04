/**
 * #1660/#2471 poll consolidation: one poll cycle must issue exactly ONE
 * `gh pr view --json` snapshot fetch and ONE `gh api pulls/N/comments` fetch
 * per PR (plus the conditional merge-group run fetch) — replacing the
 * pre-consolidation three pr-view spawns and two gh api spawns.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	PrMonitorWorker,
	_internals as workerInternals,
} from '../../../src/background/pr-monitor-worker';
import type { PrSubscriptionRecord } from '../../../src/background/pr-subscriptions';
import type { PRPollSnapshot } from '../../../src/git/pr';

const TEST_DIR = path.join(os.tmpdir(), 'pr-monitor-poll-consolidation-2471');

function makeConfig(): Record<string, unknown> {
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

function makeSnapshot(): PRPollSnapshot {
	return {
		status: {
			number: 42,
			state: 'OPEN',
			mergeable: 'MERGEABLE',
			mergeStateStatus: 'CLEAN',
			headRefOid: 'abc123',
			statusCheckRollup: [
				{ name: 'ci/build', status: 'completed', conclusion: 'success' },
			],
		},
		comments: [],
		merge: {
			mergeable: 'MERGEABLE',
			mergeStateStatus: 'CLEAN',
			headRefOid: 'abc123',
		},
		review: { reviewDecision: '', reviewRequestCount: 0 },
	};
}

describe('#2471 poll consolidation spawn counts', () => {
	let savedInternals: typeof workerInternals;
	let snapshotMock: ReturnType<typeof mock>;
	let reviewCommentsMock: ReturnType<typeof mock>;
	let mergeGroupRunMock: ReturnType<typeof mock>;

	beforeEach(() => {
		savedInternals = { ...workerInternals };
		snapshotMock = mock(() => Promise.resolve(makeSnapshot()));
		reviewCommentsMock = mock(() => Promise.resolve([]));
		mergeGroupRunMock = mock(() => Promise.resolve(null));

		workerInternals.getPRPollSnapshot =
			snapshotMock as typeof workerInternals.getPRPollSnapshot;
		workerInternals.getPRReviewComments =
			reviewCommentsMock as typeof workerInternals.getPRReviewComments;
		workerInternals.getMergeGroupRun =
			mergeGroupRunMock as typeof workerInternals.getMergeGroupRun;
		workerInternals.listActive = mock(() =>
			Promise.resolve([makeSubscription()]),
		);
		workerInternals.updateSnapshot = mock(() => Promise.resolve(null));
		workerInternals.unsubscribe = mock(() => Promise.resolve(null));
		workerInternals.sweepStale = mock(() => Promise.resolve(0));
		workerInternals.getGlobalEventBus = mock(() => ({
			publish: mock(() => Promise.resolve()),
		}));
	});

	afterEach(() => {
		workerInternals.getPRPollSnapshot = savedInternals.getPRPollSnapshot;
		workerInternals.getPRReviewComments = savedInternals.getPRReviewComments;
		workerInternals.getMergeGroupRun = savedInternals.getMergeGroupRun;
		workerInternals.listActive = savedInternals.listActive;
		workerInternals.updateSnapshot = savedInternals.updateSnapshot;
		workerInternals.unsubscribe = savedInternals.unsubscribe;
		workerInternals.sweepStale = savedInternals.sweepStale;
		workerInternals.getGlobalEventBus = savedInternals.getGlobalEventBus;
	});

	test('one poll issues exactly one snapshot fetch and one review-comments fetch', async () => {
		const worker = new PrMonitorWorker({
			directory: TEST_DIR,
			config: makeConfig() as never,
		});
		await worker.pollCycle();

		expect(snapshotMock).toHaveBeenCalledTimes(1);
		expect(snapshotMock).toHaveBeenCalledWith(42, 'owner/repo', TEST_DIR);
		expect(reviewCommentsMock).toHaveBeenCalledTimes(1);
		expect(reviewCommentsMock).toHaveBeenCalledWith(42, 'owner/repo', TEST_DIR);
		// getMergeGroupRun is consulted every poll; with no queue check in
		// the rollup its own null-return path means NO third gh spawn (that
		// decision lives inside getMergeGroupRun, pinned by its early return).
		expect(mergeGroupRunMock).toHaveBeenCalledTimes(1);
		expect(mergeGroupRunMock).toHaveBeenCalledWith(
			expect.anything(),
			'owner/repo',
			TEST_DIR,
		);
	});

	test('a queued PR adds exactly one conditional merge-group run fetch (3 total)', async () => {
		const queuedSnapshotMock = mock(() =>
			Promise.resolve({
				...makeSnapshot(),
				status: {
					...makeSnapshot().status,
					statusCheckRollup: [
						{
							name: 'Merge pull request',
							status: 'completed',
							conclusion: 'success',
							detailsUrl:
								'https://github.com/owner/repo/actions/runs/123456789',
						},
					],
				},
			}),
		);
		workerInternals.getPRPollSnapshot =
			queuedSnapshotMock as typeof workerInternals.getPRPollSnapshot;

		const worker = new PrMonitorWorker({
			directory: TEST_DIR,
			config: makeConfig() as never,
		});
		await worker.pollCycle();

		expect(queuedSnapshotMock).toHaveBeenCalledTimes(1);
		expect(mergeGroupRunMock).toHaveBeenCalledTimes(1);
		expect(reviewCommentsMock).toHaveBeenCalledTimes(1);
	});
});
