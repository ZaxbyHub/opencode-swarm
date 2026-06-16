import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	_internals,
	_test_exports,
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
				summarize_work: false,
				doc_scan: false,
			});
		}
	});

	test('denies summarize_work and doc_scan to read-only lanes — regression: PR #1358 review (R1.1)', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-1' },
				error: undefined,
			})),
			prompt: mock(async (input) => ({
				data: { parts: [{ type: 'text' as const, text: 'denied' }] },
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				lanes: [{ id: 'scan', agent: 'explorer', prompt: 'scan docs' }],
			},
			directory,
		);

		expect(result.success).toBe(true);
		expect(ops.prompt).toHaveBeenCalledTimes(1);
		expect(ops.prompt.mock.calls[0][0].body.tools).toMatchObject({
			summarize_work: false,
			doc_scan: false,
		});
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
		expect(result.lane_results[0].output?.length).toBe(20_000);
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

	test('rejects empty lanes array — schema min(1) — regression: PR #1358 review (R1.6)', async () => {
		_internals.getSessionOps = mock(() => null);

		const result = await executeDispatchLanes({ lanes: [] }, makeTempDir());

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.errors).toBeDefined();
		expect(result.errors!.some((e) => e.includes('lanes'))).toBe(true);
		expect(result.lane_results).toEqual([]);
	});

	test('rejects lane with empty string id — schema min(1) — regression: PR #1358 review (R1.6)', async () => {
		_internals.getSessionOps = mock(() => null);

		const result = await executeDispatchLanes(
			{
				lanes: [{ id: '', agent: 'explorer', prompt: 'inspect' }],
			},
			makeTempDir(),
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.errors).toBeDefined();
		expect(result.errors!.some((e) => e.includes('id'))).toBe(true);
		expect(result.lane_results).toEqual([]);
	});

	test('rejects lane with missing agent field — schema min(1) — regression: PR #1358 review (R1.6)', async () => {
		_internals.getSessionOps = mock(() => null);

		const result = await executeDispatchLanes(
			{
				lanes: [{ id: 'lane1', prompt: 'inspect' }] as Array<{
					id: string;
					agent: string;
					prompt: string;
				}>,
			},
			makeTempDir(),
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.errors).toBeDefined();
		expect(result.errors!.some((e) => e.includes('agent'))).toBe(true);
		expect(result.lane_results).toEqual([]);
	});

	test('rejects lane with missing id field — schema min(1) — regression: PR #1358 review (R1.6)', async () => {
		_internals.getSessionOps = mock(() => null);

		const result = await executeDispatchLanes(
			{
				lanes: [{ agent: 'explorer', prompt: 'inspect' }] as Array<{
					id: string;
					agent: string;
					prompt: string;
				}>,
			},
			makeTempDir(),
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.errors).toBeDefined();
		expect(result.errors!.some((e) => e.includes('id'))).toBe(true);
		expect(result.lane_results).toEqual([]);
	});

	test('rejects lane with missing prompt field — schema min(1) — regression: PR #1358 review (R1.6)', async () => {
		_internals.getSessionOps = mock(() => null);

		const result = await executeDispatchLanes(
			{
				lanes: [{ id: 'lane1', agent: 'explorer' }] as Array<{
					id: string;
					agent: string;
					prompt: string;
				}>,
			},
			makeTempDir(),
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.errors).toBeDefined();
		expect(result.errors!.some((e) => e.includes('prompt'))).toBe(true);
		expect(result.lane_results).toEqual([]);
	});

	test('rejects lane with empty string agent — schema min(1) — regression: PR #1358 review (R1.6)', async () => {
		_internals.getSessionOps = mock(() => null);

		const result = await executeDispatchLanes(
			{
				lanes: [{ id: 'lane1', agent: '', prompt: 'inspect' }],
			},
			makeTempDir(),
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.errors).toBeDefined();
		expect(result.errors!.some((e) => e.includes('agent'))).toBe(true);
		expect(result.lane_results).toEqual([]);
	});

	test('rejects lane with empty string prompt — schema min(1) — regression: PR #1358 review (R1.6)', async () => {
		_internals.getSessionOps = mock(() => null);

		const result = await executeDispatchLanes(
			{
				lanes: [{ id: 'lane1', agent: 'explorer', prompt: '' }],
			},
			makeTempDir(),
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.errors).toBeDefined();
		expect(result.errors!.some((e) => e.includes('prompt'))).toBe(true);
		expect(result.lane_results).toEqual([]);
	});

	test('rejects max_concurrent of 0 — schema min(1) — regression: PR #1358 review (R1.6)', async () => {
		_internals.getSessionOps = mock(() => null);

		const result = await executeDispatchLanes(
			{
				max_concurrent: 0,
				lanes: [{ id: 'lane1', agent: 'explorer', prompt: 'inspect' }],
			},
			makeTempDir(),
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.errors).toBeDefined();
		expect(result.errors!.some((e) => e.includes('max_concurrent'))).toBe(true);
		expect(result.lane_results).toEqual([]);
	});

	test('rejects timeout_ms of 0 — schema min(10) — regression: PR #1358 review (R1.6)', async () => {
		_internals.getSessionOps = mock(() => null);

		const result = await executeDispatchLanes(
			{
				timeout_ms: 0,
				lanes: [{ id: 'lane1', agent: 'explorer', prompt: 'inspect' }],
			},
			makeTempDir(),
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.errors).toBeDefined();
		expect(result.errors!.some((e) => e.includes('timeout_ms'))).toBe(true);
		expect(result.lane_results).toEqual([]);
	});

	test('rejects timeout_ms of 5 — below schema min(10) — regression: PR #1358 review (R1.6)', async () => {
		_internals.getSessionOps = mock(() => null);

		const result = await executeDispatchLanes(
			{
				timeout_ms: 5,
				lanes: [{ id: 'lane1', agent: 'explorer', prompt: 'inspect' }],
			},
			makeTempDir(),
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.errors).toBeDefined();
		expect(result.errors!.some((e) => e.includes('timeout_ms'))).toBe(true);
		expect(result.lane_results).toEqual([]);
	});

	test('explicit max_concurrent above lane count is accepted but clamped to lanes.length — regression: PR #1358 review (R1.7)', async () => {
		// max_concurrent: 5 passes schema (max 8) but Math.min(5, 3, 8) = 3
		// The key distinction from "omitted" is that the explicit value is accepted
		// (schema passes) and the result.max_concurrent reflects the clamped value.
		// This verifies the clamping formula: Math.min(max_concurrent, lanes.length, MAX_LANES)
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
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				max_concurrent: 5, // passes schema (5 <= 8), clamped to 3 by lanes.length
				timeout_ms: 10_000,
				lanes: [
					{ id: 'a', agent: 'explorer', prompt: 'a' },
					{ id: 'b', agent: 'reviewer', prompt: 'b' },
					{ id: 'c', agent: 'critic', prompt: 'c' },
				],
			},
			directory,
		);

		expect(result.success).toBe(true);
		// Clamped by lanes.length: Math.min(5, 3, 8) = 3
		expect(result.max_concurrent).toBe(3);
		// All 3 lanes completed since effective concurrency (3) >= lanes.length (3)
		expect(result.completed).toBe(3);
	});

	test('omitted max_concurrent defaults to lanes.length — regression: PR #1358 review (R1.7)', async () => {
		const directory = makeTempDir();
		const allStarted = deferred();
		let activePrompts = 0;
		let maxActivePrompts = 0;
		let promptStarts = 0;

		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: `session-${Math.random()}` },
				error: undefined,
			})),
			prompt: mock(async () => {
				promptStarts++;
				activePrompts++;
				maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
				if (promptStarts === 3) allStarted.resolve();
				await new Promise<void>((resolve) => setTimeout(resolve, 50));
				activePrompts--;
				return {
					data: { parts: [{ type: 'text' as const, text: 'done' }] },
					error: undefined,
				};
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				// max_concurrent omitted → defaults to lanes.length (3)
				timeout_ms: 10_000,
				lanes: [
					{ id: 'a', agent: 'explorer', prompt: 'a' },
					{ id: 'b', agent: 'reviewer', prompt: 'b' },
					{ id: 'c', agent: 'critic', prompt: 'c' },
				],
			},
			directory,
		);

		await allStarted.promise;
		// Default is lanes.length (3), which is also within MAX_LANES (8)
		expect(result.max_concurrent).toBe(3);
		expect(maxActivePrompts).toBe(3);
	});

	test('effective max_concurrent honors the MIN-of-three formula — regression: PR #1358 review (R1.7)', async () => {
		// With 5 lanes and max_concurrent: 8, the clamping formula gives:
		// Math.min(8, 5, 8) = 5 — clamped by lanes.length (5)
		// This verifies that result.max_concurrent reflects the effective clamped value.
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
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				max_concurrent: 8, // at MAX_LANES ceiling
				timeout_ms: 10_000,
				lanes: [
					{ id: 'l1', agent: 'explorer', prompt: 'p1' },
					{ id: 'l2', agent: 'reviewer', prompt: 'p2' },
					{ id: 'l3', agent: 'critic', prompt: 'p3' },
					{ id: 'l4', agent: 'explorer', prompt: 'p4' },
					{ id: 'l5', agent: 'reviewer', prompt: 'p5' },
				],
			},
			directory,
		);

		expect(result.success).toBe(true);
		// Clamped by lanes.length: Math.min(8, 5, 8) = 5
		expect(result.max_concurrent).toBe(5);
		expect(result.completed).toBe(5);
	});

	test('rejects duplicate lane IDs before creating any sessions — regression: PR #1358 review (R1.2)', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-1' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				lanes: [
					{ id: 'dup', agent: 'explorer', prompt: 'first' },
					{ id: 'dup', agent: 'reviewer', prompt: 'second' },
				],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.message).toBe(
			'Lane IDs must be unique within one dispatch_lanes batch',
		);
		expect(result.errors).toEqual(['Duplicate lane id: dup']);
		expect(result.lane_results).toEqual([]);
		// Verify no session ops were attempted — rejection is before session creation
		expect(ops.create).not.toHaveBeenCalled();
		expect(ops.prompt).not.toHaveBeenCalled();
	});
});

describe('formatError — regression: PR #1358 review (R1.3)', () => {
	const { formatError } = _test_exports;

	test('returns Error message for Error instances', () => {
		expect(formatError(new Error('boom'))).toBe('boom');
	});

	test('returns string values unchanged', () => {
		expect(formatError('plain string')).toBe('plain string');
	});

	test('returns conservative String representation for non-Error values', () => {
		expect(formatError(42)).toBe('42');
		expect(formatError(undefined)).toBe('undefined');
		expect(formatError(null)).toBe('null');
		expect(formatError(true)).toBe('true');
	});

	test('avoids JSON.stringify and handles non-serializable objects safely', () => {
		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;

		const result = formatError(circular);
		expect(typeof result).toBe('string');
		expect(result).not.toContain('JSON');
		expect(result).toContain('[object Object]');
	});

	test('caps oversized non-Error representations', () => {
		const longText = 'x'.repeat(500);
		const result = formatError(longText);
		expect(result).toBe(`${longText.slice(0, 200)}...`);
		expect(result.length).toBe(203);
	});
});
