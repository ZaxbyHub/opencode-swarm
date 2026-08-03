import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPendingDelegation } from '../../../src/background/pending-delegations';
import {
	_internals,
	executeCollectLaneResults,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';

const originalInternals = { ..._internals };
const directories: string[] = [];

async function withTestDeadline<T>(promise: Promise<T>): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error('test deadline exceeded')),
					500,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function makeTempDir(): string {
	const directory = realpathSync(
		mkdtempSync(join(tmpdir(), 'collect-host-timeout-')),
	);
	directories.push(directory);
	return directory;
}

async function recordPending(
	directory: string,
	batchId: string,
): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId: `${batchId}-session`,
		jobId: null,
		subagentSessionId: `${batchId}-session`,
		parentSessionId: `${batchId}-parent`,
		callID: batchId,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId: `${batchId}-lane`,
		mode: 'advisory',
		promptHash: `${batchId}-hash`,
		generation: 1,
	});
}

function baseOps(): Pick<SessionOps, 'create' | 'prompt' | 'delete'> {
	return {
		create: mock(async () => ({ data: { id: 'unused' } })),
		prompt: mock(async () => ({ data: null })),
		delete: mock(async () => undefined),
	};
}

afterEach(async () => {
	Object.assign(_internals, originalInternals);
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe('collect_lane_results host-call deadline', () => {
	test('bounds a hung session.status call by the remaining collection budget', async () => {
		const directory = makeTempDir();
		const batchId = 'hung-status';
		await recordPending(directory, batchId);
		const status = mock(() => new Promise<never>(() => {}));
		const messages = mock(async () => ({ data: null }));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		// Prior bug: one unresolved host status promise bypassed the outer poll
		// deadline because the deadline was checked only between iterations.
		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 25,
				},
				directory,
			),
		);

		expect(result.pending).toBe(1);
		expect(result.message).toContain('Collection deadline exhausted');
		expect(result.errors?.join('; ')).toContain('session.status');
		expect(status).toHaveBeenCalledTimes(1);
		expect(messages).not.toHaveBeenCalled();
	});

	test('bounds a hung session.messages call by the remaining collection budget', async () => {
		const directory = makeTempDir();
		const batchId = 'hung-messages';
		await recordPending(directory, batchId);
		const messages = mock(() => new Promise<never>(() => {}));
		_internals.getSessionOps = () => ({ ...baseOps(), messages });

		// Prior bug: a ready lane could hang collection forever inside the
		// transcript fetch even when collect_lane_results had a finite timeout.
		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 25,
				},
				directory,
			),
		);

		expect(result.pending).toBe(1);
		expect(result.message).toContain('Collection deadline exhausted');
		expect(result.errors?.join('; ')).toContain('session.messages');
		expect(messages).toHaveBeenCalledTimes(1);
	});

	test('bounds a hung session.abort call without claiming cancellation', async () => {
		const directory = makeTempDir();
		const batchId = 'hung-abort';
		await recordPending(directory, batchId);
		const abort = mock(() => new Promise<never>(() => {}));
		_internals.getSessionOps = () => ({
			...baseOps(),
			abort,
			messages: mock(async () => ({ data: null })),
		});

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					cancel_pending: true,
					include_pending: true,
					timeout_ms: 25,
				},
				directory,
			),
		);
		expect(result.cancelled).toBe(0);
		expect(result.pending).toBe(1);
		expect(result.message).toContain('Collection deadline exhausted');
		expect(result.errors?.join('; ')).toContain('session.abort');
		expect(abort).toHaveBeenCalledTimes(1);
	});
});
