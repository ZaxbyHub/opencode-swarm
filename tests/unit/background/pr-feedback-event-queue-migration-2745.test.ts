import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_internals,
	claimPrFeedbackMonitorEvents,
	enqueuePrFeedbackMonitorEvent,
	readPrFeedbackMonitorQueue,
} from '../../../src/background/pr-feedback-event-queue.js';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';
import { acquireLoopInternals } from '../../../tests/helpers/loop-internals-lease';
import { acquirePrFeedbackQueueLease } from '../../../tests/helpers/pr-feedback-queue-lease';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir.js';

const SESSION_ID = 'feedback-queue-migration-session';
let directory = '';
const originalIsProcessAlive = _internals.isProcessAlive;
const originalNowMs = _internals.nowMs;
let releaseLoopInternals: (() => void) | null = null;
let releaseQueue: (() => void) | null = null;

function event(
	overrides: Partial<Parameters<typeof enqueuePrFeedbackMonitorEvent>[2]> = {},
) {
	return {
		type: 'pr.ci.failed',
		repoFullName: 'owner/repo',
		prNumber: 42,
		prUrl: 'https://github.com/owner/repo/pull/42',
		message: '[pr-monitor:pr.ci.failed:owner/repo#42] advisory',
		dedupToken: '[pr-monitor:pr.ci.failed:owner/repo#42]',
		authorized: true,
		queuedAt: '2026-08-01T00:00:00.000Z',
		...overrides,
	};
}

beforeEach(async () => {
	releaseLoopInternals = await acquireLoopInternals();
	releaseQueue = await acquirePrFeedbackQueueLease();
	directory = canonicalMkdtemp('pr-feedback-queue-migration-');
	_internals.resetQueueCache();
	_internals.isProcessAlive = originalIsProcessAlive;
	_internals.nowMs = originalNowMs;
	gateInternals.resetTrackedStateCache();
});

afterEach(async () => {
	try {
		_internals.resetQueueCache();
		_internals.isProcessAlive = originalIsProcessAlive;
		_internals.nowMs = originalNowMs;
		gateInternals.resetTrackedStateCache();
		await fs.rm(directory, { recursive: true, force: true });
	} finally {
		releaseQueue?.();
		releaseQueue = null;
		releaseLoopInternals?.();
		releaseLoopInternals = null;
	}
});

test('keeps new provenance and owner fencing out of the legacy queue record (FB-025)', async () => {
	await enqueuePrFeedbackMonitorEvent(
		directory,
		SESSION_ID,
		event({ headRefOid: 'head-1' }),
	);
	await claimPrFeedbackMonitorEvents(
		directory,
		SESSION_ID,
		'workflow-a',
		event().prUrl,
		undefined,
		4321,
	);

	const queuePath = path.join(
		directory,
		'.swarm',
		_internals.queueRelativePath(SESSION_ID),
	);
	const diskEvent = JSON.parse(await fs.readFile(queuePath, 'utf8')).events[0];
	// Older binaries use a strict v1 event schema and must still be able to
	// read, clear, or append to this queue while a newer worker is installed.
	expect(diskEvent.headRefOid).toBeUndefined();
	expect(diskEvent.claimedOwnerPid).toBeUndefined();

	const metadataPath = path.join(
		directory,
		'.swarm',
		_internals.queueMetadataRelativePath(SESSION_ID),
	);
	expect(JSON.parse(await fs.readFile(metadataPath, 'utf8'))).toMatchObject({
		revision: 2,
		events: [
			{
				dedupToken: event().dedupToken,
				headRefOid: 'head-1',
				claimedOwnerPid: 4321,
			},
		],
	});

	const reloaded = await readPrFeedbackMonitorQueue(directory, SESSION_ID);
	expect(reloaded?.events[0]).toMatchObject({
		headRefOid: 'head-1',
		claimedOwnerPid: 4321,
	});
});

test('reads the pre-sidecar extended record and projects it on the next write (FB-025)', async () => {
	const queueDirectory = path.join(directory, '.swarm', 'pr-feedback-events');
	await fs.mkdir(queueDirectory, { recursive: true });
	const extendedEvent = {
		...event({ headRefOid: 'head-before-migration' }),
		claimedWorkflowInstanceId: 'old-worker',
		claimedOwnerPid: 4321,
		claimedAt: '2026-08-01T00:00:00.000Z',
	};
	await fs.writeFile(
		path.join(directory, '.swarm', _internals.queueRelativePath(SESSION_ID)),
		JSON.stringify({
			schemaVersion: 1,
			revision: 1,
			sessionID: SESSION_ID,
			events: [extendedEvent],
		}),
		'utf8',
	);

	const loaded = await readPrFeedbackMonitorQueue(directory, SESSION_ID);
	expect(loaded?.events[0]).toMatchObject({
		headRefOid: 'head-before-migration',
		claimedOwnerPid: 4321,
	});
	await enqueuePrFeedbackMonitorEvent(
		directory,
		SESSION_ID,
		event({ dedupToken: 'new-token', headRefOid: 'head-after-migration' }),
	);
	const projected = JSON.parse(
		await fs.readFile(
			path.join(directory, '.swarm', _internals.queueRelativePath(SESSION_ID)),
			'utf8',
		),
	);
	expect(projected.events).toHaveLength(2);
	expect(projected.events[0].headRefOid).toBeUndefined();
	expect(projected.events[0].claimedOwnerPid).toBeUndefined();
});

test('keeps ownerless legacy claims fail-closed after upgrade (FB-026)', async () => {
	const queueDirectory = path.join(directory, '.swarm', 'pr-feedback-events');
	await fs.mkdir(queueDirectory, { recursive: true });
	const legacyEvent = {
		...event(),
		claimedWorkflowInstanceId: 'legacy-worker',
		claimedAt: '2026-08-01T00:00:00.000Z',
	};
	await fs.writeFile(
		path.join(directory, '.swarm', _internals.queueRelativePath(SESSION_ID)),
		JSON.stringify({
			schemaVersion: 1,
			revision: 1,
			sessionID: SESSION_ID,
			events: [legacyEvent],
		}),
		'utf8',
	);

	const claimed = await claimPrFeedbackMonitorEvents(
		directory,
		SESSION_ID,
		'new-worker',
		legacyEvent.prUrl,
		undefined,
		4321,
	);
	// A legacy claim has no process identity. Reclaiming it by age would risk
	// duplicating an action from an older live worker, so operator cleanup is
	// required and the automatic path remains fail-closed.
	expect(claimed).toEqual([]);
});
