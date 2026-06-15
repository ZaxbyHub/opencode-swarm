import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	_internals,
	type DispatchLaneResult,
	executeDispatchLanes,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';

const originalInternals = { ..._internals };

function makeTempDir(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-lanes-')),
	);
}

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

afterEach(() => {
	Object.assign(_internals, originalInternals);
});

describe('executeDispatchLanes', () => {
	test('starts permitted lanes concurrently and waits for all results', async () => {
		const directory = makeTempDir();
		const allStarted = deferred();
		const releases: Array<() => void> = [];
		let nextSession = 0;
		let activePrompts = 0;
		let maxActivePrompts = 0;
		let promptStarts = 0;

		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: `session-${++nextSession}` },
				error: undefined,
			})),
			prompt: mock(async (input) => {
				promptStarts++;
				activePrompts++;
				maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
				if (promptStarts === 3) allStarted.resolve();
				await new Promise<void>((resolve) => releases.push(resolve));
				activePrompts--;
				return {
					data: {
						parts: [
							{ type: 'text' as const, text: `done ${input.body.agent}` },
						],
					},
					error: undefined,
				};
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const execution = executeDispatchLanes(
			{
				max_concurrent: 3,
				timeout_ms: 10_000,
				lanes: [
					{ id: 'runtime', agent: 'explorer', prompt: 'inspect runtime' },
					{ id: 'tests', agent: 'reviewer', prompt: 'inspect tests' },
					{ id: 'docs', agent: 'critic', prompt: 'inspect docs' },
				],
			},
			directory,
		);

		await allStarted.promise;
		expect(maxActivePrompts).toBe(3);
		for (const release of releases) release();

		const result = await execution;
		expect(result.success).toBe(true);
		expect(result.lane_results.map((lane) => lane.status)).toEqual([
			'completed',
			'completed',
			'completed',
		]);
		expect(ops.create).toHaveBeenCalledTimes(3);
		expect(ops.prompt).toHaveBeenCalledTimes(3);
		expect(ops.delete).toHaveBeenCalledTimes(3);
		for (const call of (ops.prompt as ReturnType<typeof mock>).mock.calls) {
			expect(call[0].body.tools).toMatchObject({
				write: false,
				edit: false,
				patch: false,
				apply_patch: false,
				create_file: false,
				extract_code_blocks: false,
				save_plan: false,
				update_task_status: false,
			});
		}
	});

	test('honors max_concurrent while preserving a join barrier', async () => {
		const directory = makeTempDir();
		const firstTwoStarted = deferred();
		const thirdStarted = deferred();
		const releases: Array<() => void> = [];
		let nextSession = 0;
		let activePrompts = 0;
		let maxActivePrompts = 0;
		let promptStarts = 0;

		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: `session-${++nextSession}` },
				error: undefined,
			})),
			prompt: mock(async () => {
				promptStarts++;
				activePrompts++;
				maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
				if (promptStarts === 2) firstTwoStarted.resolve();
				if (promptStarts === 3) thirdStarted.resolve();
				await new Promise<void>((resolve) => releases.push(resolve));
				activePrompts--;
				return {
					data: { parts: [{ type: 'text' as const, text: 'done' }] },
					error: undefined,
				};
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const execution = executeDispatchLanes(
			{
				max_concurrent: 2,
				timeout_ms: 10_000,
				lanes: [
					{ id: 'a', agent: 'explorer', prompt: 'a' },
					{ id: 'b', agent: 'reviewer', prompt: 'b' },
					{ id: 'c', agent: 'critic', prompt: 'c' },
				],
			},
			directory,
		);

		await firstTwoStarted.promise;
		expect(maxActivePrompts).toBe(2);
		expect(promptStarts).toBe(2);
		releases.shift()?.();
		await thirdStarted.promise;
		for (const release of releases) release();

		const result = await execution;
		expect(result.success).toBe(true);
		expect(maxActivePrompts).toBe(2);
		expect(result.lane_results).toHaveLength(3);
	});

	test('rejects writable roles before creating sessions', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'unused' }, error: undefined })),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				lanes: [{ id: 'write', agent: 'coder', prompt: 'please edit files' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.lane_results).toEqual([
			expect.objectContaining({
				id: 'write',
				agent: 'coder',
				role: 'coder',
				status: 'rejected',
			}),
		]);
		expect(ops.create).not.toHaveBeenCalled();
		expect(ops.prompt).not.toHaveBeenCalled();
	});

	test('preserves prefixed dispatch identity while validating canonical role', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-1' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'prefixed ok' }] },
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;
		_internals.getGeneratedAgentNames = () => [
			'mega_architect',
			'mega_reviewer',
		];

		const result = await executeDispatchLanes(
			{
				lanes: [
					{ id: 'prefixed', agent: 'mega_reviewer', prompt: 'review only' },
				],
			},
			directory,
			{ callerAgent: 'mega_architect' },
		);

		expect(result.success).toBe(true);
		expect(result.lane_results[0]).toEqual(
			expect.objectContaining({
				id: 'prefixed',
				agent: 'mega_reviewer',
				role: 'reviewer',
				status: 'completed',
			} satisfies Partial<DispatchLaneResult>),
		);
		expect(ops.prompt).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({ agent: 'mega_reviewer' }),
			}),
		);
	});

	test('rejects suffix spoofing and cross-swarm generated agents', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-1' },
				error: undefined,
			})),
			prompt: mock(async (input) => ({
				data: {
					parts: [
						{
							type: 'text' as const,
							text: `ok ${input.body.agent}`,
						},
					],
				},
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;
		_internals.getGeneratedAgentNames = () => [
			'this_architect',
			'this_reviewer',
			'other_reviewer',
		];

		const result = await executeDispatchLanes(
			{
				lanes: [
					{ id: 'spoof', agent: 'not_an_reviewer', prompt: 'spoof' },
					{ id: 'other', agent: 'other_reviewer', prompt: 'other swarm' },
					{ id: 'valid', agent: 'this_reviewer', prompt: 'same swarm' },
				],
			},
			directory,
			{ callerAgent: 'this_architect' },
		);

		expect(result.success).toBe(false);
		expect(result.lane_results).toEqual([
			expect.objectContaining({
				id: 'spoof',
				role: 'not_an_reviewer',
				status: 'rejected',
			}),
			expect.objectContaining({
				id: 'other',
				role: 'reviewer',
				status: 'rejected',
			}),
			expect.objectContaining({
				id: 'valid',
				role: 'reviewer',
				status: 'completed',
				output: 'ok this_reviewer',
			}),
		]);
		expect(ops.create).toHaveBeenCalledTimes(1);
		expect(ops.prompt).toHaveBeenCalledTimes(1);
	});

	test('returns per-lane failures without dropping sibling results', async () => {
		const directory = makeTempDir();
		let nextSession = 0;
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: `session-${++nextSession}` },
				error: undefined,
			})),
			prompt: mock(async (input) => {
				if (input.body.agent === 'critic') {
					return { data: undefined, error: 'critic unavailable' };
				}
				return {
					data: { parts: [{ type: 'text' as const, text: 'ok' }] },
					error: undefined,
				};
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				max_concurrent: 2,
				lanes: [
					{ id: 'ok', agent: 'reviewer', prompt: 'ok' },
					{ id: 'bad', agent: 'critic', prompt: 'bad' },
				],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.lane_results).toEqual([
			expect.objectContaining({ id: 'ok', status: 'completed', output: 'ok' }),
			expect.objectContaining({
				id: 'bad',
				status: 'failed',
				error: 'session.prompt failed: critic unavailable',
			}),
		]);
		expect(ops.delete).toHaveBeenCalledTimes(2);
	});

	test('times out a hung lane and cleans up the created session', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-1' },
				error: undefined,
			})),
			prompt: mock(async () => await new Promise<never>(() => undefined)),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				timeout_ms: 10,
				lanes: [{ id: 'hung', agent: 'reviewer', prompt: 'hang' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.lane_results).toEqual([
			expect.objectContaining({
				id: 'hung',
				status: 'failed',
				error: 'Lane "hung" session.prompt timed out after 10ms',
			}),
		]);
		expect(ops.delete).toHaveBeenCalledWith({ path: { id: 'session-1' } });
	});

	test('does not let hung session cleanup block the join result', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-1' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'done' }] },
				error: undefined,
			})),
			delete: mock(async () => await new Promise<never>(() => undefined)),
		};
		_internals.getSessionOps = () => ops;

		const execution = executeDispatchLanes(
			{
				timeout_ms: 10,
				lanes: [{ id: 'cleanup', agent: 'reviewer', prompt: 'cleanup' }],
			},
			directory,
		);

		const result = await Promise.race([
			execution,
			new Promise<'blocked'>((resolve) =>
				setTimeout(() => resolve('blocked'), 200),
			),
		]);

		expect(result).not.toBe('blocked');
		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				completed: 1,
			}),
		);
		expect(ops.delete).toHaveBeenCalledWith({ path: { id: 'session-1' } });
	});

	test('cleans up a session that is created after create timeout', async () => {
		const directory = makeTempDir();
		const createGate = deferred<{ data: { id: string }; error: undefined }>();
		const deleteCalled = deferred<{ path: { id: string } }>();
		const ops: SessionOps = {
			create: mock(async () => await createGate.promise),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			delete: mock(async (args) => {
				deleteCalled.resolve(args);
				return undefined;
			}),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				timeout_ms: 10,
				lanes: [{ id: 'late-create', agent: 'reviewer', prompt: 'late' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.lane_results).toEqual([
			expect.objectContaining({
				id: 'late-create',
				status: 'failed',
				error: 'Lane "late-create" session.create timed out after 10ms',
			}),
		]);
		expect(ops.prompt).not.toHaveBeenCalled();
		expect(ops.delete).not.toHaveBeenCalled();

		createGate.resolve({ data: { id: 'late-session' }, error: undefined });
		await expect(deleteCalled.promise).resolves.toEqual({
			path: { id: 'late-session' },
		});
	});

	test('truncates oversized lane output with metadata', async () => {
		const directory = makeTempDir();
		const hugeOutput = 'x'.repeat(25_000);
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-1' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: hugeOutput }] },
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				lanes: [{ id: 'huge', agent: 'reviewer', prompt: 'large output' }],
			},
			directory,
		);

		expect(result.success).toBe(true);
		expect(result.lane_results[0].output_chars).toBe(25_000);
		expect(result.lane_results[0].output_truncated).toBe(true);
		expect(result.lane_results[0].output?.length).toBeLessThan(
			hugeOutput.length,
		);
		expect(result.lane_results[0].output).toContain(
			'chars truncated by dispatch_lanes',
		);
	});

	test('fails closed when the OpenCode session client is unavailable', async () => {
		_internals.getSessionOps = () => null;

		const result = await executeDispatchLanes(
			{
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			makeTempDir(),
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('no_client');
		expect(result.lane_results).toEqual([]);
	});
});
