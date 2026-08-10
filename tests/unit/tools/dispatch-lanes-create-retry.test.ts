import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import {
	findByBatchId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
	executeDispatchLanes,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalInternals = { ..._internals };
const tempDirs: string[] = [];

function tempProject(): string {
	const directory = canonicalMkdtemp('dispatch-create-retry-');
	tempDirs.push(directory);
	return directory;
}

function blockingOps(
	create: SessionOps['create'],
	prompt: SessionOps['prompt'] = mock(async () => ({
		data: { parts: [{ type: 'text', text: 'done' }] },
	})),
): SessionOps {
	return {
		create,
		prompt,
		delete: mock(async () => undefined),
	};
}

function asyncOps(
	create: SessionOps['create'],
	promptAsync: NonNullable<SessionOps['promptAsync']> = mock(async () => ({})),
): SessionOps {
	return {
		create,
		prompt: mock(async () => ({ data: { parts: [] } })),
		promptAsync,
		messages: mock(async () => ({
			data: [
				{
					info: { role: 'assistant' },
					parts: [{ type: 'text', text: 'done' }],
				},
			],
		})),
		delete: mock(async () => undefined),
	};
}

afterEach(() => {
	Object.assign(_internals, originalInternals);
	for (const directory of tempDirs.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('bounded pre-prompt session.create retry', () => {
	test('blocking dispatch retries a returned transient failure and exposes generation 2', async () => {
		let attempt = 0;
		const create = mock(async () =>
			++attempt === 1
				? { error: { response: { status: 503 } } }
				: { data: { id: 'session-2' } },
		);
		const ops = blockingOps(create);
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{ lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }] },
			tempProject(),
		);

		expect(create).toHaveBeenCalledTimes(2);
		expect(ops.prompt).toHaveBeenCalledTimes(1);
		expect(result.lane_results[0]).toMatchObject({
			status: 'completed',
			session_id: 'session-2',
			generation: 2,
		});
	});

	test('async dispatch retries a thrown transient failure and preserves generation through collection', async () => {
		let attempt = 0;
		const create = mock(async () => {
			if (++attempt === 1) throw new Error('ECONNRESET');
			return { data: { id: 'async-session-2' } };
		});
		const ops = asyncOps(create);
		_internals.getSessionOps = () => ops;
		const directory = tempProject();

		const launched = await executeDispatchLanesAsync(
			{
				batch_id: 'retry-batch',
				lanes: [{ id: 'tests', agent: 'reviewer', prompt: 'inspect' }],
			},
			directory,
		);
		expect(launched.lane_results[0]).toMatchObject({
			status: 'pending',
			generation: 2,
		});
		expect(findByBatchId(directory, 'retry-batch')[0]?.generation).toBe(2);

		const collected = await executeCollectLaneResults(
			{ batch_id: 'retry-batch' },
			directory,
		);
		expect(collected.lane_results[0]?.generation).toBe(2);
		expect(create).toHaveBeenCalledTimes(2);
		expect(ops.promptAsync).toHaveBeenCalledTimes(1);
	});

	test('async dispatch retries a returned transient failure before prompt admission', async () => {
		let attempt = 0;
		const create = mock(async () =>
			++attempt === 1
				? { error: { cause: { code: 'EAI_AGAIN' } } }
				: { data: { id: 'async-returned-2' } },
		);
		const ops = asyncOps(create);
		_internals.getSessionOps = () => ops;
		const launched = await executeDispatchLanesAsync(
			{
				batch_id: 'async-returned',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			tempProject(),
		);
		expect(create).toHaveBeenCalledTimes(2);
		expect(launched.lane_results[0]).toMatchObject({
			status: 'pending',
			session_id: 'async-returned-2',
			generation: 2,
		});
	});

	test('stops after exactly two transient create failures', async () => {
		const create = mock(async () => ({ error: { statusCode: 503 } }));
		const ops = blockingOps(create);
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{ lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }] },
			tempProject(),
		);

		expect(create).toHaveBeenCalledTimes(2);
		expect(ops.prompt).not.toHaveBeenCalled();
		expect(result.lane_results[0]).toMatchObject({
			status: 'failed',
			generation: 2,
		});
	});

	test('reports async create exhaustion immediately as generation 2', async () => {
		const create = mock(async () => ({ error: { status: 503 } }));
		const ops = asyncOps(create);
		_internals.getSessionOps = () => ops;
		const result = await executeDispatchLanesAsync(
			{
				batch_id: 'async-exhausted',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			tempProject(),
		);
		expect(create).toHaveBeenCalledTimes(2);
		expect(ops.promptAsync).not.toHaveBeenCalled();
		expect(result.lane_results[0]).toMatchObject({
			status: 'failed',
			generation: 2,
		});
	});

	const permanentCases: Array<[string, unknown]> = [
		['authentication', { status: 401, message: 'authentication failed' }],
		['configuration', { message: 'invalid configuration' }],
		['invalid agent', { error: { code: 'INVALID_AGENT' } }],
		['invalid model', { cause: { message: 'model not found' } }],
		['quota', { status: 429, message: 'insufficient quota' }],
		['explicit opt-out', { status: 503, isRetryable: false }],
	];
	for (const [label, failure] of permanentCases) {
		test(`does not retry permanent ${label} create failures`, async () => {
			const create = mock(async () => ({ error: failure }));
			const ops = blockingOps(create);
			_internals.getSessionOps = () => ops;
			const result = await executeDispatchLanes(
				{ lanes: [{ id: 'lane', agent: 'explorer', prompt: 'inspect' }] },
				tempProject(),
			);
			expect(create).toHaveBeenCalledTimes(1);
			expect(ops.prompt).not.toHaveBeenCalled();
			expect(result.lane_results[0]?.generation).toBe(1);
		});
	}

	test('treats a malformed create response as permanent', async () => {
		const create = mock(async () => ({}));
		const ops = blockingOps(create);
		_internals.getSessionOps = () => ops;
		const result = await executeDispatchLanes(
			{ lanes: [{ id: 'lane', agent: 'explorer', prompt: 'inspect' }] },
			tempProject(),
		);
		expect(create).toHaveBeenCalledTimes(1);
		expect(result.lane_results[0]).toMatchObject({
			generation: 1,
			error: 'session.create failed: malformed response without a session id',
		});
	});

	test('walks nested cyclic failures within fixed bounds and lets permanent signals win', () => {
		const transient: Record<string, unknown> = { message: 'outer failure' };
		transient.cause = { response: { status: 503 }, cause: transient };
		expect(_test_exports.isRetryableSessionCreateFailure(transient)).toBe(true);

		const mixed: Record<string, unknown> = { status: 503 };
		mixed.cause = { message: 'invalid model configuration', cause: mixed };
		expect(_test_exports.isRetryableSessionCreateFailure(mixed)).toBe(false);

		const oversized = Array.from({ length: 80 }, (_, index) =>
			index === 0 ? { status: 503 } : { detail: index },
		);
		expect(_test_exports.isRetryableSessionCreateFailure(oversized)).toBe(
			false,
		);
		expect(
			_test_exports.isRetryableSessionCreateFailure({ retryAfterMs: 503 }),
		).toBe(false);
		expect(
			_test_exports.isRetryableSessionCreateFailure({
				requestId: 'job-503',
				metadata: { message: 'service unavailable' },
			}),
		).toBe(false);
		expect(
			_test_exports.isRetryableSessionCreateFailure({
				status: '401',
				message: 'service unavailable',
			}),
		).toBe(false);
		expect(
			_test_exports.isRetryableSessionCreateFailure({
				code: '400',
				message: 'server error',
			}),
		).toBe(false);
		expect(
			_test_exports.isRetryableSessionCreateFailure({ status: '503' }),
		).toBe(true);
		expect(_test_exports.isRetryableSessionCreateFailure('ECONNRESET')).toBe(
			true,
		);
		expect(
			_test_exports.isRetryableSessionCreateFailure(
				'invalid model configuration',
			),
		).toBe(false);
		const lengthTrap = new Proxy([], {
			get(target, property, receiver) {
				if (property === 'length') throw new Error('length trap');
				return Reflect.get(target, property, receiver);
			},
		});
		expect(() =>
			_test_exports.isRetryableSessionCreateFailure(lengthTrap),
		).not.toThrow();
		const revokedArray = Proxy.revocable([], {});
		revokedArray.revoke();
		let revokedResult: boolean | undefined;
		expect(() => {
			revokedResult = _test_exports.isRetryableSessionCreateFailure(
				revokedArray.proxy,
			);
		}).not.toThrow();
		expect(revokedResult).toBe(false);
	});

	test('retries a local create timeout and deletes the late first session without prompting it', async () => {
		let resolveFirst!: (value: { data: { id: string } }) => void;
		const first = new Promise<{ data: { id: string } }>((resolve) => {
			resolveFirst = resolve;
		});
		let attempt = 0;
		const create = mock(() =>
			++attempt === 1
				? first
				: Promise.resolve({ data: { id: 'on-time-session' } }),
		);
		const ops = blockingOps(create);
		let resolveDeleted!: (args: { path: { id: string } }) => void;
		const deleted = new Promise<{ path: { id: string } }>((resolve) => {
			resolveDeleted = resolve;
		});
		ops.delete = mock(async (args) => {
			if (args.path.id === 'late-first-session') resolveDeleted(args);
		});
		_internals.getSessionOps = () => ops;
		const result = await executeDispatchLanes(
			{
				timeout_ms: 10,
				lanes: [{ id: 'timeout', agent: 'explorer', prompt: 'inspect' }],
			},
			tempProject(),
		);
		expect(result.lane_results[0]).toMatchObject({
			status: 'completed',
			generation: 2,
		});
		expect(ops.prompt).toHaveBeenCalledTimes(1);
		expect(ops.prompt.mock.calls[0]?.[0].path.id).toBe('on-time-session');

		resolveFirst({ data: { id: 'late-first-session' } });
		await expect(deleted).resolves.toEqual({
			path: { id: 'late-first-session' },
		});
	});

	test('never retries a blocking prompt after create generation 2 succeeds', async () => {
		let attempt = 0;
		const create = mock(async () =>
			++attempt === 1
				? { error: { status: 503 } }
				: { data: { id: 'session-2' } },
		);
		const prompt = mock(async () => ({ error: { status: 503 } }));
		const ops = blockingOps(create, prompt);
		_internals.getSessionOps = () => ops;
		const result = await executeDispatchLanes(
			{ lanes: [{ id: 'lane', agent: 'explorer', prompt: 'inspect' }] },
			tempProject(),
		);
		expect(create).toHaveBeenCalledTimes(2);
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(result.lane_results[0]).toMatchObject({
			status: 'failed',
			generation: 2,
		});
	});

	const asyncPromptFailures: Array<
		[string, () => Promise<{ error?: unknown }>]
	> = [
		[
			'returned transient-looking error',
			async () => ({ error: { status: 503 } }),
		],
		[
			'thrown transport error',
			async () => {
				throw new Error('ECONNRESET');
			},
		],
		[
			'acceptance timeout',
			async () => await new Promise<never>(() => undefined),
		],
	];
	for (const [
		caseIndex,
		[label, implementation],
	] of asyncPromptFailures.entries()) {
		test(`keeps promptAsync single-shot after a ${label}`, async () => {
			const directory = tempProject();
			const create = mock(async () => ({ data: { id: `prompt-${label}` } }));
			const promptAsync = mock(implementation);
			const ops = asyncOps(create, promptAsync);
			let resolveCleanup!: () => void;
			const cleanupStarted = new Promise<void>((resolve) => {
				resolveCleanup = resolve;
			});
			ops.abort = mock(async () => {
				resolveCleanup();
			});
			_internals.getSessionOps = () => ops;
			const batchId = `single-shot-${caseIndex}`;
			const result = await executeDispatchLanesAsync(
				{
					batch_id: batchId,
					launch_timeout_ms: 10,
					lanes: [{ id: 'lane', agent: 'explorer', prompt: 'inspect' }],
				},
				directory,
			);
			expect(result.lane_results[0]?.generation).toBe(1);
			await cleanupStarted;
			expect(promptAsync).toHaveBeenCalledTimes(1);
			expect(create).toHaveBeenCalledTimes(1);
			expect(findByBatchId(directory, batchId)[0]?.status).toBe('error');
		});
	}

	test('defaults legacy collected rows without generation to 1', async () => {
		const directory = tempProject();
		await recordPendingDelegation(directory, {
			correlationId: 'legacy-session',
			jobId: null,
			subagentSessionId: 'legacy-session',
			parentSessionId: 'parent',
			callID: 'legacy-batch',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'legacy-batch',
			laneId: 'legacy',
		});
		_internals.getSessionOps = () =>
			asyncOps(mock(async () => ({ data: { id: 'unused' } })));
		const result = await executeCollectLaneResults(
			{ batch_id: 'legacy-batch' },
			directory,
		);
		expect(result.lane_results[0]?.generation).toBe(1);
	});
});
