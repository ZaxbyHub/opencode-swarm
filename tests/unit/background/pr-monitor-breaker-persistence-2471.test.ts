/**
 * #2409/#2471: the PR-monitor circuit breaker must trip and SURVIVE a
 * deterministic error-snapshot write failure; capacity refusals must
 * short-circuit to the worker-level skip state (probe-based recovery,
 * one cycle-level disclosure, structured health surface) instead of
 * per-PR breaker accounting.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	getPrMonitorWorkerHealth,
	PrMonitorWorker,
	_internals as workerInternals,
} from '../../../src/background/pr-monitor-worker';
import type { PrSubscriptionRecord } from '../../../src/background/pr-subscriptions';
import {
	isPrSubscriptionCapacityError,
	PrSubscriptionCapacityError,
} from '../../../src/background/pr-subscriptions';
import type { PRPollSnapshot } from '../../../src/git/pr';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const DIGEST = { note: 'fixtures' } as const;

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
		failure_threshold: 3,
		cooldown_seconds: 30,
		max_cooldown_seconds: 300,
		cleanup_ttl_days: 7,
		auto_unsubscribe_on_merge: true,
		auto_unsubscribe_on_close: true,
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

function makeSnapshot(): PRPollSnapshot {
	return {
		status: {
			number: 42,
			state: 'OPEN',
			mergeable: 'MERGEABLE',
			mergeStateStatus: 'CLEAN',
			headRefOid: 'abc123',
			statusCheckRollup: [],
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

describe('#2409/#2471 breaker independence and capacity skip', () => {
	let directory: string;
	let savedInternals: typeof workerInternals;
	let listActiveMock: ReturnType<typeof mock>;
	let snapshotMock: ReturnType<typeof mock>;
	let reviewCommentsMock: ReturnType<typeof mock>;
	let mergeGroupRunMock: ReturnType<typeof mock>;
	let updateSnapshotMock: ReturnType<typeof mock>;
	let sweepStaleMock: ReturnType<typeof mock>;
	let busPublishMock: ReturnType<typeof mock>;

	beforeEach(() => {
		directory = canonicalMkdtemp('pr-monitor-breaker-2471-');
		savedInternals = { ...workerInternals };
		listActiveMock = mock(() => Promise.resolve([makeSubscription()]));
		snapshotMock = mock(() => Promise.resolve(makeSnapshot()));
		reviewCommentsMock = mock(() => Promise.resolve([]));
		mergeGroupRunMock = mock(() => Promise.resolve(null));
		updateSnapshotMock = mock(() => Promise.resolve(null));
		sweepStaleMock = mock(() => Promise.resolve(0));
		busPublishMock = mock(() => Promise.resolve());

		workerInternals.listActive =
			listActiveMock as typeof workerInternals.listActive;
		workerInternals.getPRPollSnapshot =
			snapshotMock as typeof workerInternals.getPRPollSnapshot;
		workerInternals.getPRReviewComments =
			reviewCommentsMock as typeof workerInternals.getPRReviewComments;
		workerInternals.getMergeGroupRun =
			mergeGroupRunMock as typeof workerInternals.getMergeGroupRun;
		workerInternals.updateSnapshot =
			updateSnapshotMock as typeof workerInternals.updateSnapshot;
		workerInternals.sweepStale =
			sweepStaleMock as typeof workerInternals.sweepStale;
		workerInternals.unsubscribe = mock(() => Promise.resolve(null)) as never;
		workerInternals.getGlobalEventBus = mock(() => ({
			publish: busPublishMock,
		})) as typeof workerInternals.getGlobalEventBus;
	});

	afterEach(() => {
		workerInternals.listActive = savedInternals.listActive;
		workerInternals.getPRPollSnapshot = savedInternals.getPRPollSnapshot;
		workerInternals.getPRReviewComments = savedInternals.getPRReviewComments;
		workerInternals.getMergeGroupRun = savedInternals.getMergeGroupRun;
		workerInternals.updateSnapshot = savedInternals.updateSnapshot;
		workerInternals.sweepStale = savedInternals.sweepStale;
		workerInternals.unsubscribe = savedInternals.unsubscribe;
		workerInternals.getGlobalEventBus = savedInternals.getGlobalEventBus;
	});

	function createWorker(
		overrides: Record<string, unknown> = {},
	): PrMonitorWorker {
		return new PrMonitorWorker({
			directory,
			config: makeConfig(overrides) as never,
		});
	}

	test('breaker trips and survives a deterministic snapshot-write failure at threshold', async () => {
		// Fetches fail (non-capacity) AND every error-snapshot write throws.
		snapshotMock.mockImplementation(() =>
			Promise.reject(new Error('gh exploded')),
		);
		updateSnapshotMock.mockImplementation(() =>
			Promise.reject(new Error('write lock')),
		);
		const worker = createWorker({ failure_threshold: 3 });

		await worker.pollCycle();
		await worker.pollCycle();
		await worker.pollCycle();

		const health = worker.getHealth();
		// Four-part required assertion (#2471):
		expect(health.suspendedPrCount).toBe(1); // breaker entry suspended
		const cb = (
			worker as unknown as {
				circuitBreakerMap: Map<string, { errorCount: number }>;
			}
		).circuitBreakerMap.get('sess1::owner/repo::42');
		expect(cb?.errorCount).toBe(3); // errorCount reached threshold
		expect(health.suspendedPrCount).toBeGreaterThan(0); // suspendedUntil in future
		expect(health.storeWriteRefusal).toBeNull(); // NOT a capacity failure
		// pr.error emitted exactly once at the threshold crossing.
		const circuitEvents = busPublishMock.mock.calls.filter(
			(args: unknown[]) => args[0] === 'pr.error',
		);
		expect(circuitEvents).toHaveLength(1);
		expect((circuitEvents[0]?.[1] as { reason: string }).reason).toBe(
			'circuit_breaker',
		);
		void DIGEST;
	});

	test('capacity refusal skips breaker accounting and enters the skip state', async () => {
		snapshotMock.mockImplementation(() =>
			Promise.reject(
				new PrSubscriptionCapacityError(
					'PR subscription store over checkpoint capacity: 600 records > 512.',
				),
			),
		);
		const worker = createWorker({ failure_threshold: 2 });

		await worker.pollCycle();
		await worker.pollCycle();

		const cbMap = (
			worker as unknown as { circuitBreakerMap: Map<string, unknown> }
		).circuitBreakerMap;
		expect(cbMap.size).toBe(0); // no breaker entry for a policy failure
		const health = worker.getHealth();
		expect(health.storeWriteRefusal).not.toBeNull();
		expect(health.storeWriteRefusal?.lastReason).toContain(
			'over checkpoint capacity',
		);
	});

	test('while refused, only the one-PR probe is polled; recovery resumes without restart', async () => {
		const subs = [
			makeSubscription(),
			makeSubscription({
				correlationId: 'sess1::owner/repo::43',
				prNumber: 43,
			}),
			makeSubscription({
				correlationId: 'sess1::owner/repo::44',
				prNumber: 44,
			}),
		];
		listActiveMock.mockImplementation(() => Promise.resolve(subs));

		const capacity = new PrSubscriptionCapacityError(
			'PR subscription store over checkpoint capacity: 600 records > 512.',
		);
		let writeFails = true;
		snapshotMock.mockImplementation(() => {
			if (writeFails) throw capacity;
			return Promise.resolve(makeSnapshot());
		});
		updateSnapshotMock.mockImplementation(() => {
			if (writeFails) throw capacity;
			return Promise.resolve(null);
		});

		const worker = createWorker();
		// Cycle 1: all polls hit the refusal; state entered.
		await worker.pollCycle();
		expect(worker.getHealth().storeWriteRefusal).not.toBeNull();

		// Cycle 2 (refused): exactly ONE probe poll happens (1 snapshot fetch
		// for the probe PR), not one per subscription.
		snapshotMock.mockClear();
		await worker.pollCycle();
		expect(snapshotMock).toHaveBeenCalledTimes(1);

		// Cycle 3: operator repaired the store — the probe write succeeds,
		// the refusal clears, and the next cycle polls all PRs again.
		writeFails = false;
		await worker.pollCycle();
		expect(worker.getHealth().storeWriteRefusal).toBeNull();
		snapshotMock.mockClear();
		await worker.pollCycle();
		expect(snapshotMock).toHaveBeenCalledTimes(3);
	});

	test('stop/start keeps the refusal state so recovery still probes', async () => {
		const capacity = new PrSubscriptionCapacityError(
			'PR subscription store over checkpoint capacity: 1 bytes > 0.',
		);
		snapshotMock.mockImplementation(() => {
			throw capacity;
		});
		updateSnapshotMock.mockImplementation(() => {
			throw capacity;
		});
		const worker = createWorker();
		await worker.pollCycle();
		expect(worker.getHealth().storeWriteRefusal).not.toBeNull();

		worker.stop();
		worker.start(); // interval never fires in test; state must persist
		expect(worker.getHealth().storeWriteRefusal).not.toBeNull();

		// After restart the probe path still runs (manual pollCycle).
		snapshotMock.mockClear();
		await worker.pollCycle();
		expect(snapshotMock).toHaveBeenCalledTimes(1);
	});

	test('registry exposes health per directory and null for unknown directories', () => {
		const worker = createWorker();
		expect(getPrMonitorWorkerHealth(directory)?.status).toBe('stopped');
		expect(
			getPrMonitorWorkerHealth(path.join(os.tmpdir(), 'never')),
		).toBeNull();
		worker.dispose();
		expect(getPrMonitorWorkerHealth(directory)).toBeNull();
	});

	test('isPrSubscriptionCapacityError discriminates by class, not text', () => {
		const capacity = new PrSubscriptionCapacityError(
			'PR subscription store over checkpoint capacity: 600 records > 512.',
		);
		const lookalike = new Error(
			'PR subscription store over checkpoint capacity: 600 records > 512.',
		);
		expect(isPrSubscriptionCapacityError(capacity)).toBe(true);
		expect(isPrSubscriptionCapacityError(lookalike)).toBe(false);
		expect(isPrSubscriptionCapacityError(null)).toBe(false);
	});
});
