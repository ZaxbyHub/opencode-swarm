import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	claimPrFeedbackMonitorEvents,
	enqueuePrFeedbackMonitorEvent,
	readPrFeedbackMonitorQueue,
} from '../../../src/background/pr-feedback-event-queue.js';
import { _test_exports as gateInternals } from '../../../src/hooks/pr-workflow-gate.js';

const SESSION_ID = 'feedback-queue-session';
let directory = '';
const originalIsProcessAlive = _internals.isProcessAlive;
const originalNowMs = _internals.nowMs;
const originalBeforeQueueFileOpen = _internals.beforeQueueFileOpen;

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

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-feedback-queue-')),
	);
	_internals.resetQueueCache();
	_internals.isProcessAlive = originalIsProcessAlive;
	_internals.nowMs = originalNowMs;
	_internals.beforeQueueFileOpen = originalBeforeQueueFileOpen;
	gateInternals.resetTrackedStateCache();
});

afterEach(async () => {
	_internals.resetQueueCache();
	_internals.isProcessAlive = originalIsProcessAlive;
	_internals.nowMs = originalNowMs;
	_internals.beforeQueueFileOpen = originalBeforeQueueFileOpen;
	gateInternals.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('pr-feedback-event-queue', () => {
	test('enqueue persists a per-session queue record under .swarm', async () => {
		await enqueuePrFeedbackMonitorEvent(directory, SESSION_ID, event());

		const queue = await readPrFeedbackMonitorQueue(directory, SESSION_ID);
		expect(queue).toMatchObject({
			schemaVersion: 1,
			revision: 1,
			sessionID: SESSION_ID,
		});
		expect(queue?.events).toHaveLength(1);
		expect(queue?.events[0]).toMatchObject({
			type: 'pr.ci.failed',
			repoFullName: 'owner/repo',
			prNumber: 42,
			prUrl: 'https://github.com/owner/repo/pull/42',
			dedupToken: '[pr-monitor:pr.ci.failed:owner/repo#42]',
			authorized: true,
		});
		expect(queue?.events[0]?.claimedWorkflowInstanceId).toBeUndefined();

		const queuePath = path.join(
			directory,
			'.swarm',
			_internals.queueRelativePath(SESSION_ID),
		);
		expect(JSON.parse(await fs.readFile(queuePath, 'utf-8'))).toMatchObject({
			revision: 1,
		});
	});

	test('rejects an unclaimable GitHub PR subpath at enqueue (PRR-008)', async () => {
		// Previously any URL passed schema validation, even when claim-time
		// canonicalization could never match it.
		await expect(
			enqueuePrFeedbackMonitorEvent(
				directory,
				SESSION_ID,
				event({ prUrl: 'https://github.com/owner/repo/pull/42/files' }),
			),
		).rejects.toThrow(/canonical GitHub PR URL/i);
	});

	test('dedups by token and keeps the most recent payload', async () => {
		await enqueuePrFeedbackMonitorEvent(directory, SESSION_ID, event());
		await enqueuePrFeedbackMonitorEvent(
			directory,
			SESSION_ID,
			event({
				message: '[pr-monitor:pr.ci.failed:owner/repo#42] updated advisory',
				queuedAt: '2026-08-01T00:05:00.000Z',
			}),
		);

		const queue = await readPrFeedbackMonitorQueue(directory, SESSION_ID);
		expect(queue?.events).toHaveLength(1);
		expect(queue?.events[0]?.message).toContain('updated advisory');
		expect(queue?.revision).toBe(2);
	});

	test('caps the queue at 20 events with drop-oldest semantics', async () => {
		for (let i = 0; i < 25; i++) {
			await enqueuePrFeedbackMonitorEvent(
				directory,
				SESSION_ID,
				event({
					type: i % 2 === 0 ? 'pr.ci.failed' : 'pr.merge.conflict',
					prNumber: i + 1,
					prUrl: `https://github.com/owner/repo/pull/${i + 1}`,
					message: `[pr-monitor:event-${i}] advisory`,
					dedupToken: `[pr-monitor:event-${i}]`,
					queuedAt: `2026-08-01T00:${String(i).padStart(2, '0')}:00.000Z`,
				}),
			);
		}

		const queue = await readPrFeedbackMonitorQueue(directory, SESSION_ID);
		expect(queue?.events).toHaveLength(20);
		expect(queue?.events[0]?.dedupToken).toBe('[pr-monitor:event-5]');
		expect(queue?.events.at(-1)?.dedupToken).toBe('[pr-monitor:event-24]');
	});

	test('claim marks only unclaimed events for one workflow instance', async () => {
		await enqueuePrFeedbackMonitorEvent(
			directory,
			SESSION_ID,
			event({ dedupToken: '[pr-monitor:a]', message: 'a' }),
		);
		await enqueuePrFeedbackMonitorEvent(
			directory,
			SESSION_ID,
			event({
				dedupToken: '[pr-monitor:b]',
				message: 'b',
				prNumber: 43,
				prUrl: 'https://github.com/owner/repo/pull/43',
			}),
		);

		const claimed = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION_ID,
			'workflow-a',
			'https://github.com/owner/repo/pull/42',
		);
		expect(claimed).toHaveLength(1);
		expect(
			claimed.every(
				(entry) => entry.claimedWorkflowInstanceId === 'workflow-a',
			),
		).toBe(true);

		const secondClaim = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION_ID,
			'workflow-b',
			'https://github.com/owner/repo/pull/43',
		);
		expect(secondClaim).toHaveLength(1);
	});

	test('claim is idempotent for the same workflow instance', async () => {
		await enqueuePrFeedbackMonitorEvent(directory, SESSION_ID, event());

		const first = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION_ID,
			'workflow-a',
			'https://github.com/owner/repo/pull/42',
		);
		const second = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION_ID,
			'workflow-a',
			'https://github.com/owner/repo/pull/42',
		);

		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		expect(second[0]?.claimedWorkflowInstanceId).toBe('workflow-a');
	});

	test('does not let a second workflow steal an already claimed event (FB-007)', async () => {
		await enqueuePrFeedbackMonitorEvent(directory, SESSION_ID, event());

		const first = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION_ID,
			'workflow-a',
			'https://github.com/owner/repo/pull/42',
		);
		const second = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION_ID,
			'workflow-b',
			'https://github.com/OWNER/REPO/pull/42/',
		);

		expect(first).toHaveLength(1);
		expect(second).toEqual([]);
		const queue = await readPrFeedbackMonitorQueue(directory, SESSION_ID);
		expect(queue?.events[0]?.claimedWorkflowInstanceId).toBe('workflow-a');
	});

	test('claim can bind only the exact delivered dedup tokens', async () => {
		await enqueuePrFeedbackMonitorEvent(
			directory,
			SESSION_ID,
			event({ dedupToken: '[pr-monitor:a]', message: 'a' }),
		);
		await enqueuePrFeedbackMonitorEvent(
			directory,
			SESSION_ID,
			event({ dedupToken: '[pr-monitor:b]', message: 'b' }),
		);

		const claimed = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION_ID,
			'workflow-a',
			'https://github.com/owner/repo/pull/42',
			['[pr-monitor:a]'],
		);
		expect(claimed.map((entry) => entry.dedupToken)).toEqual([
			'[pr-monitor:a]',
		]);
		const queue = await readPrFeedbackMonitorQueue(directory, SESSION_ID);
		expect(queue?.events[1]?.claimedWorkflowInstanceId).toBeUndefined();
	});

	test('rejects a symlinked queue directory instead of escaping .swarm', async () => {
		const outside = path.join(directory, 'outside');
		const queueDirectory = path.join(directory, '.swarm', 'pr-feedback-events');
		await fs.mkdir(path.dirname(queueDirectory), { recursive: true });
		await fs.mkdir(outside, { recursive: true });
		await fs.symlink(
			outside,
			queueDirectory,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		await expect(
			enqueuePrFeedbackMonitorEvent(directory, SESSION_ID, event()),
		).rejects.toThrow(/must be a real directory/i);
		expect(await fs.readdir(outside)).toEqual([]);
	});

	test('rejects a queue directory swapped to a junction after validation', async () => {
		await enqueuePrFeedbackMonitorEvent(directory, SESSION_ID, event());
		const queueDirectory = path.join(directory, '.swarm', 'pr-feedback-events');
		const queueName = path.basename(_internals.queueRelativePath(SESSION_ID));
		const outside = path.join(directory, 'outside-race');
		const preserved = path.join(directory, '.swarm', 'queue-preserved');
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(
			path.join(outside, queueName),
			JSON.stringify({
				schemaVersion: 1,
				revision: 999,
				sessionID: SESSION_ID,
				events: [],
			}),
			'utf8',
		);
		_internals.beforeQueueFileOpen = async () => {
			_internals.beforeQueueFileOpen = undefined;
			await fs.rename(queueDirectory, preserved);
			await fs.symlink(
				outside,
				queueDirectory,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
		};

		await expect(
			readPrFeedbackMonitorQueue(directory, SESSION_ID),
		).rejects.toThrow(/changed|real directory|escaped/i);
	});

	test('does not create a queue directory after .swarm is swapped to a junction', async () => {
		const swarmRoot = path.join(directory, '.swarm');
		const preserved = path.join(directory, '.swarm-preserved');
		const outside = path.join(directory, 'outside-create-race');
		await fs.mkdir(swarmRoot, { recursive: true });
		await fs.mkdir(outside, { recursive: true });
		gateInternals.beforeSafeDirectoryCreate = async (_parent, nextPath) => {
			if (path.basename(nextPath) !== 'pr-feedback-events') return;
			gateInternals.beforeSafeDirectoryCreate = undefined;
			await fs.rename(swarmRoot, preserved);
			await fs.symlink(
				outside,
				swarmRoot,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
		};

		await expect(
			enqueuePrFeedbackMonitorEvent(directory, SESSION_ID, event()),
		).rejects.toThrow(/real directory|changed|escaped/i);
		expect(await fs.readdir(outside)).toEqual([]);
	});

	test('reclaims a stale lock whose owner process is gone', async () => {
		const lockPath = path.join(
			directory,
			'.swarm',
			_internals.queueLockRelativePath(SESSION_ID),
		);
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
		await fs.writeFile(
			lockPath,
			JSON.stringify({
				ownerToken: 'stale-lock',
				pid: 999999,
				createdAtMs: 1,
			}),
			'utf-8',
		);
		_internals.isProcessAlive = () => false;

		await enqueuePrFeedbackMonitorEvent(directory, SESSION_ID, event());
		const queue = await readPrFeedbackMonitorQueue(directory, SESSION_ID);
		expect(queue?.events).toHaveLength(1);
	});

	test('does not steal an old initialized lock from a live PID without fencing (PRR-007)', async () => {
		const lockPath = path.join(
			directory,
			'.swarm',
			_internals.queueLockRelativePath(SESSION_ID),
		);
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
		await fs.writeFile(
			lockPath,
			JSON.stringify({
				ownerToken: 'live-owner-lock',
				pid: 42,
				createdAtMs: 1,
			}),
			'utf-8',
		);
		_internals.nowMs = () => 5 * 60_000 + 2;
		_internals.isProcessAlive = () => true;

		await expect(
			enqueuePrFeedbackMonitorEvent(directory, SESSION_ID, event()),
		).rejects.toThrow(/being mutated by another process/i);
		expect(JSON.parse(await fs.readFile(lockPath, 'utf-8')).ownerToken).toBe(
			'live-owner-lock',
		);
	});

	test('reclaims an uninitialized stale lock file by age', async () => {
		const lockPath = path.join(
			directory,
			'.swarm',
			_internals.queueLockRelativePath(SESSION_ID),
		);
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
		await fs.writeFile(lockPath, '', 'utf-8');
		await fs.utimes(lockPath, 1, 1);
		_internals.nowMs = () => 60_000;

		await enqueuePrFeedbackMonitorEvent(directory, SESSION_ID, event());
		const queue = await readPrFeedbackMonitorQueue(directory, SESSION_ID);
		expect(queue?.events).toHaveLength(1);
	});
});
