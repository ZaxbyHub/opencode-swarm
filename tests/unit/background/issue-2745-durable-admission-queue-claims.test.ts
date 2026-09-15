/**
 * Durable queue-claim identity regressions for issue #2745.
 *
 * Queue ownership is the workflow/PID pair. Claims must be released only by
 * the exact owner, and a replacement worker may reclaim only a demonstrably
 * dead claim for the selected event.
 */
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	claimPrFeedbackMonitorEvents,
	_internals as queueInternals,
	readPrFeedbackMonitorQueue,
	releasePrFeedbackMonitorEventClaim,
} from '../../../src/background/pr-feedback-event-queue.js';
import { acquirePrFeedbackQueueLease } from '../../../tests/helpers/pr-feedback-queue-lease';
import {
	enqueue,
	makeProject,
	SESSION,
} from './issue-2745-state-safety-fixtures';

const originalQueueIsProcessAlive = queueInternals.isProcessAlive;

function queueTest(name: string, work: () => Promise<void>): void {
	test(name, async () => {
		const releaseQueue = await acquirePrFeedbackQueueLease();
		try {
			await work();
		} finally {
			queueInternals.isProcessAlive = originalQueueIsProcessAlive;
			queueInternals.resetQueueCache();
			releaseQueue();
		}
	});
}

queueTest(
	'queue release requires the exact workflow and owner PID pair',
	async () => {
		const directory = makeProject();
		await enqueue(directory, { dedupToken: 'owner-pair' });
		const claimed = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION,
			'workflow-owner-pair',
			'https://github.com/example/repo/pull/42',
			['owner-pair'],
			42_424,
		);
		expect(claimed).toHaveLength(1);
		expect(claimed[0]).toMatchObject({
			claimedWorkflowInstanceId: 'workflow-owner-pair',
			claimedOwnerPid: 42_424,
		});

		expect(
			await releasePrFeedbackMonitorEventClaim(
				directory,
				SESSION,
				'owner-pair',
				'workflow-owner-pair',
				42_425,
			),
		).toBe(false);
		expect(
			(await readPrFeedbackMonitorQueue(directory, SESSION))?.events[0]
				?.claimedOwnerPid,
		).toBe(42_424);
		expect(
			await releasePrFeedbackMonitorEventClaim(
				directory,
				SESSION,
				'owner-pair',
				'workflow-owner-pair',
				42_424,
			),
		).toBe(true);
		expect(
			(await readPrFeedbackMonitorQueue(directory, SESSION))?.events[0]
				?.claimedWorkflowInstanceId,
		).toBeUndefined();
	},
);

queueTest(
	'reclaims only the selected event from a demonstrably dead queue owner',
	async () => {
		const directory = makeProject();
		await enqueue(directory, { dedupToken: 'dead-queue-claim' });
		await enqueue(directory, { dedupToken: 'unselected-queue-claim' });
		const initiallyClaimed = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION,
			'crashed-worker',
			'https://github.com/example/repo/pull/42',
			['dead-queue-claim'],
			42_424,
		);
		expect(initiallyClaimed).toHaveLength(1);

		queueInternals.isProcessAlive = mock(() => false);
		const reclaimed = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION,
			'restarted-worker',
			'https://github.com/example/repo/pull/42',
			['dead-queue-claim'],
			42_425,
		);

		expect(reclaimed).toHaveLength(1);
		expect(reclaimed[0]).toMatchObject({
			dedupToken: 'dead-queue-claim',
			claimedWorkflowInstanceId: 'restarted-worker',
			claimedOwnerPid: 42_425,
		});
		const queue = await readPrFeedbackMonitorQueue(directory, SESSION);
		expect(
			queue?.events.find(
				(entry) => entry.dedupToken === 'unselected-queue-claim',
			)?.claimedWorkflowInstanceId,
		).toBeUndefined();
	},
);

queueTest('does not reclaim a queue claim owned by a live PID', async () => {
	const directory = makeProject();
	await enqueue(directory, { dedupToken: 'live-queue-claim' });
	await claimPrFeedbackMonitorEvents(
		directory,
		SESSION,
		'live-worker',
		'https://github.com/example/repo/pull/42',
		['live-queue-claim'],
		42_424,
	);
	queueInternals.isProcessAlive = mock(() => true);

	const attempted = await claimPrFeedbackMonitorEvents(
		directory,
		SESSION,
		'other-worker',
		'https://github.com/example/repo/pull/42',
		['live-queue-claim'],
		42_425,
	);

	expect(attempted).toEqual([]);
	expect(
		(await readPrFeedbackMonitorQueue(directory, SESSION))?.events[0],
	).toMatchObject({
		claimedWorkflowInstanceId: 'live-worker',
		claimedOwnerPid: 42_424,
	});
});

queueTest('does not reclaim a legacy queue claim without a PID', async () => {
	const directory = makeProject();
	await enqueue(directory, { dedupToken: 'legacy-queue-claim' });
	const queue = await readPrFeedbackMonitorQueue(directory, SESSION);
	const firstEvent = queue?.events[0];
	expect(firstEvent).toBeDefined();
	const legacyEvent = {
		...firstEvent,
		claimedWorkflowInstanceId: 'legacy-worker',
		claimedAt: new Date(0).toISOString(),
	};
	delete legacyEvent.claimedOwnerPid;
	fs.writeFileSync(
		path.join(directory, '.swarm', queueInternals.queueRelativePath(SESSION)),
		JSON.stringify({ ...queue, events: [legacyEvent] }),
		'utf8',
	);
	queueInternals.resetQueueCache();
	queueInternals.isProcessAlive = mock(() => false);

	const attempted = await claimPrFeedbackMonitorEvents(
		directory,
		SESSION,
		'restarted-worker',
		'https://github.com/example/repo/pull/42',
		['legacy-queue-claim'],
		42_425,
	);

	expect(attempted).toEqual([]);
	expect(
		(await readPrFeedbackMonitorQueue(directory, SESSION))?.events[0],
	).toMatchObject({
		claimedWorkflowInstanceId: 'legacy-worker',
	});
	expect(
		(await readPrFeedbackMonitorQueue(directory, SESSION))?.events[0]
			?.claimedOwnerPid,
	).toBeUndefined();
});
