import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import {
	findByBatchId,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import type { ParallelDispatcher } from '../../../src/parallel/dispatcher/parallel-dispatcher';
import {
	_internals,
	_test_exports,
	executeDispatchLanes,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalInternals = { ..._internals };
const tempDirs: string[] = [];

function tempProject(): string {
	const directory = canonicalMkdtemp('dispatch-create-retry-concurrency-');
	tempDirs.push(directory);
	return directory;
}

function asyncOps(create: SessionOps['create']): SessionOps {
	return {
		create,
		prompt: mock(async () => ({ data: { parts: [] } })),
		promptAsync: mock(async () => ({})),
		messages: mock(async () => ({ data: [] })),
		abort: mock(async () => undefined),
		delete: mock(async () => undefined),
	};
}

afterEach(() => {
	Object.assign(_internals, originalInternals);
	for (const directory of tempDirs.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('async create retry ownership and concurrency', () => {
	test('releases and synchronously reacquires capacity between create attempts', async () => {
		const events: string[] = [];
		let slot = 0;
		const dispatcher: ParallelDispatcher = {
			config: {
				enabled: true,
				maxConcurrentTasks: 1,
				evidenceLockTimeoutMs: 0,
			},
			dispatch: () => {
				events.push('dispatch');
				const slotId = `slot-${++slot}`;
				return {
					action: 'dispatch',
					reason: 'slot',
					slot: { slotId, taskId: 'lane', runId: `run-${slot}`, startedAt: 0 },
				};
			},
			handles: () => [],
			releaseSlot: () => events.push('release'),
			shutdown: () => events.push('shutdown'),
		};
		_internals.createParallelDispatcher = () => dispatcher;
		let attempt = 0;
		const ops: SessionOps = {
			create: mock(async () => {
				events.push('create');
				return ++attempt === 1
					? { error: { status: 503 } }
					: { data: { id: 'ok' } };
			}),
			prompt: mock(async () => {
				events.push('prompt');
				return { data: { parts: [] } };
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanes(
			{ lanes: [{ id: 'lane', agent: 'explorer', prompt: 'inspect' }] },
			tempProject(),
		);

		expect(events.slice(0, 6)).toEqual([
			'dispatch',
			'create',
			'release',
			'dispatch',
			'create',
			'prompt',
		]);
	});

	test('fails a conflicting create id without disrupting its durable owner', async () => {
		const directory = tempProject();
		await recordPendingDelegation(directory, {
			correlationId: 'shared-session',
			jobId: null,
			subagentSessionId: 'shared-session',
			parentSessionId: 'original-parent',
			callID: 'original-call',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'original-batch',
			laneId: 'original-lane',
			generation: 1,
		});
		const ops = asyncOps(
			mock(async () => ({ data: { id: 'shared-session' } })),
		);
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanesAsync(
			{
				batch_id: 'conflicting-batch',
				lanes: [
					{ id: 'new-lane', agent: 'reviewer', prompt: 'inspect conflict' },
				],
			},
			directory,
		);

		expect(result.lane_results[0]).toMatchObject({
			status: 'failed',
			error:
				'Async lane session.create returned a correlation id owned by a different background delegation',
		});
		expect(ops.promptAsync).not.toHaveBeenCalled();
		expect(ops.abort).not.toHaveBeenCalled();
		expect(ops.delete).not.toHaveBeenCalled();
		expect(findByCorrelationId(directory, 'shared-session')).toMatchObject({
			parentSessionId: 'original-parent',
			batchId: 'original-batch',
			laneId: 'original-lane',
		});
		expect(findByBatchId(directory, 'conflicting-batch')).toEqual([]);
	});

	test('fails an exact duplicate create id without cleaning up the authoritative row', async () => {
		const directory = tempProject();
		const batchId = 'duplicate-batch';
		const lane = {
			id: 'duplicate-lane',
			agent: 'reviewer',
			prompt: 'inspect exact duplicate',
		};
		const create = mock(async () => {
			await recordPendingDelegation(directory, {
				correlationId: 'duplicate-session',
				jobId: null,
				subagentSessionId: 'duplicate-session',
				parentSessionId: `dispatch_lanes_async:${batchId}`,
				callID: batchId,
				normalizedAgent: 'reviewer',
				swarmPrefixedAgent: 'reviewer',
				planTaskId: null,
				evidenceTaskId: null,
				batchId,
				laneId: lane.id,
				mode: 'advisory',
				promptHash: _test_exports.promptHash(lane, directory, batchId),
				workspace: {
					directory,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
				},
				generation: 1,
			});
			return { data: { id: 'duplicate-session' } };
		});
		const ops = asyncOps(create);
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanesAsync(
			{ batch_id: batchId, lanes: [lane] },
			directory,
		);

		expect(result.lane_results[0]).toMatchObject({
			status: 'failed',
			error:
				'Async lane session.create returned an already-recorded correlation id',
		});
		expect(ops.promptAsync).not.toHaveBeenCalled();
		expect(ops.abort).not.toHaveBeenCalled();
		expect(ops.delete).not.toHaveBeenCalled();
		expect(findByCorrelationId(directory, 'duplicate-session')).toMatchObject({
			batchId,
			laneId: lane.id,
			status: 'pending',
		});
	});

	test('conserves two real dispatcher slots across concurrent retry generations', async () => {
		const directory = tempProject();
		let dispatcher: ParallelDispatcher | undefined;
		_internals.createParallelDispatcher = (config) => {
			dispatcher = originalInternals.createParallelDispatcher(config);
			return dispatcher;
		};
		const attempts = new Map<string, number>();
		let activeCreates = 0;
		let maxActiveCreates = 0;
		let pairWaiters: Array<() => void> = [];
		const create = mock(async (input: Parameters<SessionOps['create']>[0]) => {
			const title = input.body.title;
			const attempt = (attempts.get(title) ?? 0) + 1;
			attempts.set(title, attempt);
			activeCreates++;
			maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
			await new Promise<void>((resolve) => {
				pairWaiters.push(resolve);
				if (pairWaiters.length === 2) {
					const pair = pairWaiters;
					pairWaiters = [];
					for (const release of pair) release();
				}
			});
			activeCreates--;
			return attempt === 1
				? { error: { status: 503 } }
				: { data: { id: `${title}-generation-${attempt}` } };
		});
		const ops = asyncOps(create);
		_internals.getSessionOps = () => ops;
		const lanes = Array.from({ length: 4 }, (_, index) => ({
			id: `lane-${index + 1}`,
			agent: 'reviewer',
			prompt: `inspect lane ${index + 1}`,
		}));

		const result = await executeDispatchLanesAsync(
			{ batch_id: 'conservation-batch', max_concurrent: 2, lanes },
			directory,
		);

		expect(result.success).toBe(true);
		expect(result.lane_results).toHaveLength(4);
		expect(
			result.lane_results.every((laneResult) => laneResult.generation === 2),
		).toBe(true);
		expect(create).toHaveBeenCalledTimes(8);
		expect(maxActiveCreates).toBe(2);
		expect(activeCreates).toBe(0);
		expect(dispatcher?.handles()).toEqual([]);
	});
});
