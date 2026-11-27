/**
 * #3947 — terminal PR event latch.
 *
 * pr.merged / pr.closed are emitted at most once per PR while the PR stays
 * terminal, but the latch dedupes the EVENT only: the sweep key and the
 * auto-unsubscribe keep retrying every cycle (so a refused or failed cleanup
 * is not stranded). Uses the _internals DI seam; no mock.module.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	PrMonitorWorker,
	type PrMonitorWorkerOptions,
	_internals as workerInternals,
} from '../../../src/background/pr-monitor-worker';
import type { PrSubscriptionRecord } from '../../../src/background/pr-subscriptions';

const TEST_DIR = path.join(os.tmpdir(), 'pr-monitor-worker-terminal-latch');

function makeConfig(
	overrides: Record<string, unknown> = {},
): PrMonitorWorkerOptions['config'] {
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
	} as PrMonitorWorkerOptions['config'];
}

function makeSubscription(): PrSubscriptionRecord {
	return {
		correlationId: 'sess1::owner/repo::42',
		sessionID: 'sess1',
		prNumber: 42,
		repoFullName: 'owner/repo',
		prUrl: 'https://github.com/owner/repo/pull/42',
		lastCheckedAt: 1_700_000_000_000,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active',
		createdAt: 1_699_999_940_000,
		updatedAt: 1_700_000_000_000,
		errorCount: 0,
	};
}

function snapshotFor(state: 'OPEN' | 'MERGED' | 'CLOSED') {
	return {
		status: {
			number: 42,
			state,
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

let publish: ReturnType<typeof mock>;
let snapshot: ReturnType<typeof mock>;
let unsubscribe: ReturnType<typeof mock>;
let saved: typeof workerInternals;

function setupMocks(sub: PrSubscriptionRecord): void {
	saved = { ...workerInternals };
	publish = mock(() => Promise.resolve());
	snapshot = mock(async () => snapshotFor('MERGED'));
	unsubscribe = mock(() => Promise.resolve(sub));
	workerInternals.listActive = mock(() =>
		Promise.resolve([sub]),
	) as typeof workerInternals.listActive;
	workerInternals.getMergeGroupRun = mock(() =>
		Promise.resolve(null),
	) as typeof workerInternals.getMergeGroupRun;
	workerInternals.getPRPollSnapshot =
		snapshot as typeof workerInternals.getPRPollSnapshot;
	workerInternals.getPRReviewComments = mock(() =>
		Promise.resolve([]),
	) as typeof workerInternals.getPRReviewComments;
	workerInternals.updateSnapshot = mock(() =>
		Promise.resolve(sub),
	) as typeof workerInternals.updateSnapshot;
	workerInternals.unsubscribe =
		unsubscribe as typeof workerInternals.unsubscribe;
	workerInternals.sweepStale = mock(() =>
		Promise.resolve(0),
	) as typeof workerInternals.sweepStale;
	workerInternals.getGlobalEventBus = mock(() => ({
		publish,
	})) as typeof workerInternals.getGlobalEventBus;
}

function restoreInternals(): void {
	if (!saved) return;
	workerInternals.listActive = saved.listActive;
	workerInternals.getMergeGroupRun = saved.getMergeGroupRun;
	workerInternals.getPRPollSnapshot = saved.getPRPollSnapshot;
	workerInternals.getPRReviewComments = saved.getPRReviewComments;
	workerInternals.updateSnapshot = saved.updateSnapshot;
	workerInternals.unsubscribe = saved.unsubscribe;
	workerInternals.sweepStale = saved.sweepStale;
	workerInternals.getGlobalEventBus = saved.getGlobalEventBus;
}

function createWorker(config: Record<string, unknown>): PrMonitorWorker {
	return new PrMonitorWorker({
		directory: TEST_DIR,
		config: makeConfig(config),
	});
}

function count(type: string): number {
	return publish.mock.calls.filter((c) => c[0] === type).length;
}

describe('PrMonitorWorker — terminal event latch (#3947)', () => {
	beforeEach(() => setupMocks(makeSubscription()));
	afterEach(() => restoreInternals());

	test('publishes pr.merged at most once across repeated poll cycles', async () => {
		snapshot.mockImplementation(async () => snapshotFor('MERGED'));
		const worker = createWorker({ auto_unsubscribe_on_merge: false });
		await worker.pollCycle();
		await worker.pollCycle();
		expect(count('pr.merged')).toBe(1);
	});

	test('publishes pr.closed at most once across repeated poll cycles', async () => {
		snapshot.mockImplementation(async () => snapshotFor('CLOSED'));
		const worker = createWorker({ auto_unsubscribe_on_close: false });
		await worker.pollCycle();
		await worker.pollCycle();
		expect(count('pr.closed')).toBe(1);
	});

	test('retries auto-unsubscribe without re-emitting pr.merged after unsubscribe fails', async () => {
		snapshot.mockImplementation(async () => snapshotFor('MERGED'));
		unsubscribe
			.mockRejectedValueOnce(new Error('store refused write'))
			.mockResolvedValue(null);
		const worker = createWorker({ auto_unsubscribe_on_merge: true });
		await worker.pollCycle();
		await worker.pollCycle();
		// Cleanup is retried on the next cycle; the latch dedupes the event only.
		expect(unsubscribe).toHaveBeenCalledTimes(2);
		expect(count('pr.merged')).toBe(1);
	});

	test('clears the latch on auto-unsubscribe so a re-subscribed PR emits afresh', async () => {
		snapshot.mockImplementation(async () => snapshotFor('MERGED'));
		const worker = createWorker({ auto_unsubscribe_on_merge: true });
		await worker.pollCycle();
		await worker.pollCycle();
		expect(count('pr.merged')).toBe(2);
		expect(unsubscribe).toHaveBeenCalledTimes(2);
	});

	test('re-emits pr.closed after a reopen-then-close sequence', async () => {
		snapshot
			.mockImplementationOnce(async () => snapshotFor('CLOSED'))
			.mockImplementationOnce(async () => snapshotFor('OPEN'))
			.mockImplementationOnce(async () => snapshotFor('CLOSED'));
		const worker = createWorker({ auto_unsubscribe_on_close: false });
		await worker.pollCycle();
		await worker.pollCycle();
		await worker.pollCycle();
		expect(count('pr.closed')).toBe(2);
	});

	test('stop() clears the latch', async () => {
		snapshot.mockImplementation(async () => snapshotFor('MERGED'));
		const worker = createWorker({ auto_unsubscribe_on_merge: false });
		await worker.pollCycle();
		// stop() is a no-op unless the worker was started.
		worker.start();
		worker.stop();
		await worker.pollCycle();
		expect(count('pr.merged')).toBe(2);
	});
});
