/**
 * Issue #2745 snapshot synchronization regressions.
 *
 * The monitor emits before persisting its snapshot. These tests pin the
 * bounded delayed reread and exact workflow-owner release so a transient
 * store race remains retryable instead of stranding a claim.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import {
	claimPrFeedbackMonitorEvents,
	readPrFeedbackMonitorQueue,
	releasePrFeedbackMonitorEventClaim,
} from '../../../src/background/pr-feedback-event-queue.js';
import {
	claimAndProcessPrFeedbackEvent,
	_internals as loopInternals,
} from '../../../src/background/pr-feedback-loop.js';
import {
	listActive,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions.js';
import {
	acquireLoopInternals,
	CORRELATION,
	enqueue,
	HEAD,
	makeProject,
	prime,
	restoreProductionLoopInternals,
	SESSION,
	URL,
} from './issue-2745-state-safety-fixtures';

let releaseLoopInternals!: () => void;

beforeEach(async () => {
	releaseLoopInternals = await acquireLoopInternals();
});

test('a failed first snapshot read retries once and proceeds on matching delayed read', async () => {
	const dir = makeProject();
	await prime(dir);
	loopInternals.evaluateCurrentHead = mock(
		async () => HEAD,
	) as unknown as typeof loopInternals.evaluateCurrentHead;
	loopInternals.dispatchOversight = mock(async () => ({
		dispatched: true,
		decision: 'allow',
	})) as unknown as typeof loopInternals.dispatchOversight;
	const performer = mock(async () => ({ performed: true }));
	loopInternals.performAuthorizedAction =
		performer as unknown as typeof loopInternals.performAuthorizedAction;
	let reads = 0;
	loopInternals.listActive = mock(async (directory: string) => {
		reads += 1;
		if (reads === 1) throw new Error('snapshot write is still in flight');
		return listActive(directory);
	}) as unknown as typeof loopInternals.listActive;
	await enqueue(dir);

	const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

	expect(reads).toBe(2);
	expect(result.authorization?.authorized).toBe(true);
	expect(result.action?.performed).toBe(true);
	expect(performer).toHaveBeenCalledTimes(1);
	// A successful path keeps the durable claim; the worker's later settlement
	// owns queue cleanup. The reread must not falsely release or retry it.
	expect(
		(await readPrFeedbackMonitorQueue(dir, SESSION))?.events[0]
			?.claimedWorkflowInstanceId,
	).toBeDefined();
});

test('persistent snapshot mismatch releases only the current claim for retry', async () => {
	const dir = makeProject();
	await prime(dir);
	await updateSnapshot(dir, CORRELATION, { headRefOid: 'different-head' });
	loopInternals.evaluateCurrentHead = mock(
		async () => HEAD,
	) as unknown as typeof loopInternals.evaluateCurrentHead;
	loopInternals.dispatchOversight = mock(async () => ({
		dispatched: true,
		decision: 'allow',
	})) as unknown as typeof loopInternals.dispatchOversight;
	const performer = mock(async () => ({ performed: true }));
	loopInternals.performAuthorizedAction =
		performer as unknown as typeof loopInternals.performAuthorizedAction;
	await enqueue(dir);

	const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

	expect(result.authorization?.reason).toMatch(
		/snapshot synchronization|retryable/,
	);
	expect(result.terminal).toBeNull();
	expect(performer).not.toHaveBeenCalled();
	expect(
		(await readPrFeedbackMonitorQueue(dir, SESSION))?.events[0]
			?.claimedWorkflowInstanceId,
	).toBeUndefined();
});

test('a failed second snapshot read releases the claim and leaves the event retryable', async () => {
	const dir = makeProject();
	await prime(dir);
	loopInternals.evaluateCurrentHead = mock(
		async () => HEAD,
	) as unknown as typeof loopInternals.evaluateCurrentHead;
	loopInternals.dispatchOversight = mock(async () => ({
		dispatched: true,
		decision: 'allow',
	})) as unknown as typeof loopInternals.dispatchOversight;
	const performer = mock(async () => ({ performed: true }));
	loopInternals.performAuthorizedAction =
		performer as unknown as typeof loopInternals.performAuthorizedAction;
	let reads = 0;
	loopInternals.listActive = mock(async () => {
		reads += 1;
		if (reads === 2) throw new Error('snapshot store unavailable');
		return [];
	}) as unknown as typeof loopInternals.listActive;
	await enqueue(dir);

	const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

	expect(reads).toBe(2);
	expect(result.authorization?.reason).toMatch(
		/snapshot synchronization|retryable/,
	);
	expect(result.terminal).toBeNull();
	expect(performer).not.toHaveBeenCalled();
	expect(
		(await readPrFeedbackMonitorQueue(dir, SESSION))?.events[0]
			?.claimedWorkflowInstanceId,
	).toBeUndefined();
});

test('claim release rejects a different workflow owner', async () => {
	const dir = makeProject();
	await enqueue(dir, { dedupToken: 'owned-token' });
	const claimed = await claimPrFeedbackMonitorEvents(
		dir,
		SESSION,
		'workflow-a',
		URL,
		['owned-token'],
	);
	expect(claimed).toHaveLength(1);

	expect(
		await releasePrFeedbackMonitorEventClaim(
			dir,
			SESSION,
			'owned-token',
			'workflow-b',
		),
	).toBe(false);
	expect(
		(await readPrFeedbackMonitorQueue(dir, SESSION))?.events[0]
			?.claimedWorkflowInstanceId,
	).toBe('workflow-a');
	expect(
		await releasePrFeedbackMonitorEventClaim(
			dir,
			SESSION,
			'owned-token',
			'workflow-a',
		),
	).toBe(true);
});

afterEach(() => {
	try {
		restoreProductionLoopInternals();
	} finally {
		releaseLoopInternals();
	}
});
