import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	test,
} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLaneOutput } from '../../../src/background/lane-output-store';
import {
	findByBatchId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	_internals,
	_test_exports,
	type DispatchLaneResult,
	executeCollectLaneResults,
	executeDispatchLanes,
	executeDispatchLanesAsync,
	MAX_PROMPT_CHARS,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';

const originalInternals = { ..._internals };

// Workaround for Bun #32056: on Windows, a pending promise that leaves the
// event loop idle prevents bun's per-test --timeout from firing. A 1s
// keepalive interval ensures the event loop wakes regularly, allowing the
// timeout mechanism to work correctly. Without this, the test file hangs
// indefinitely on Windows CI runners.
let _keepalive: ReturnType<typeof setInterval> | undefined;
beforeAll(() => {
	_keepalive = setInterval(() => {}, 1000);
});
afterAll(() => {
	if (_keepalive) clearInterval(_keepalive);
});

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

	test('returns bounded preview and durable ref for oversized lane output', async () => {
		const directory = makeTempDir();
		const hugeOutput = `head-${'x'.repeat(24_980)}-tail`;
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
		expect(result.lane_results[0].output_chars).toBe(24_990);
		expect(result.lane_results[0].output_truncated).toBe(true);
		expect(result.lane_results[0].output_ref).toMatch(
			/^L1:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/,
		);
		expect(result.lane_results[0].output_digest).toMatch(/^[a-f0-9]{64}$/);
		expect(result.lane_results[0].output?.length).toBeLessThan(
			hugeOutput.length,
		);
		expect(result.lane_results[0].output?.length).toBe(20_000);
		expect(result.lane_results[0].output).toContain(
			'retrieve_lane_output ref=',
		);
		expect(result.lane_results[0].output).toContain('-tail');
		const loaded = readLaneOutput(
			directory,
			result.lane_results[0].output_ref!,
		);
		expect(loaded?.artifact.text).toBe(hugeOutput);
		expect(loaded?.artifact.source).toBe('dispatch_lanes');
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

describe('executeDispatchLanesAsync and executeCollectLaneResults', () => {
	test('launches read-only lanes with promptAsync and records pending batch rows', async () => {
		const directory = makeTempDir();
		let nextSession = 0;
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: `session-${++nextSession}` },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;
		_internals.now = () => 1_700_000_000_000;

		const result = await executeDispatchLanesAsync(
			{
				batch_id: 'batch-async-1',
				mode: 'deep-dive',
				pr_head_sha: 'abc123',
				scope: 'src',
				lanes: [
					{ id: 'runtime', agent: 'explorer', prompt: 'inspect runtime' },
					{ id: 'tests', agent: 'reviewer', prompt: 'inspect tests' },
				],
			},
			directory,
		);

		expect(result.success).toBe(true);
		expect(result.batch_id).toBe('batch-async-1');
		expect(result.pending).toBe(2);
		expect(result.lane_results.map((lane) => lane.status)).toEqual([
			'pending',
			'pending',
		]);
		expect(ops.promptAsync).toHaveBeenCalledTimes(2);
		const records = findByBatchId(directory, 'batch-async-1');
		expect(records).toHaveLength(2);
		expect(records[0].status).toBe('running');
		expect(records[0].workspace?.prHeadSha).toBe('abc123');
		expect(records[0].generation).toBe(1);
		expect(records[0].workspace?.scope).toBe('src');
		expect(records[0].promptHash).toMatch(/^[a-f0-9]{64}$/);
		// promptHash is computed after applyExplorerFormatSuffix, so for
		// explorer-role lanes the hash covers the prompt + format suffix.
		const sentPromptText = (ops.promptAsync as ReturnType<typeof mock>).mock
			.calls[0][0].body.parts[0].text;
		expect(records[0].promptHash).toBe(
			_test_exports.promptHash(
				{ id: 'runtime', agent: 'explorer', prompt: sentPromptText },
				directory,
				'batch-async-1',
			),
		);
		expect(records[0].promptHash).not.toBe(
			_test_exports.promptHash(
				{ id: 'runtime', agent: 'explorer', prompt: 'changed prompt' },
				directory,
				'batch-async-1',
			),
		);
	});

	test('collects completed async lane output from child session messages', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-collect' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			messages: mock(async () => ({
				data: [
					{ info: { role: 'user' }, parts: [{ type: 'text', text: 'prompt' }] },
					{
						info: { role: 'assistant' },
						parts: [{ type: 'text', text: 'lane output' }],
					},
				],
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-collect-1',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);
		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-collect-1', wait: false },
			directory,
		);

		expect(result.success).toBe(true);
		expect(result.completed).toBe(1);
		expect(result.pending).toBe(0);
		expect(result.lane_results[0].output).toBe('lane output');
		expect(result.lane_results[0].output_ref).toMatch(
			/^L1:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/,
		);
		expect(
			readLaneOutput(directory, result.lane_results[0].output_ref!)?.artifact
				.text,
		).toBe('lane output');
	});

	test('collects all assistant transcript messages and marks message-limit incompleteness', async () => {
		const directory = makeTempDir();
		const messages = Array.from({ length: 50 }, (_, index) => ({
			info: { role: 'assistant' },
			parts: [{ type: 'text', text: `part-${index}` }],
		}));
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-transcript' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			messages: mock(async () => ({
				data: messages,
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-transcript',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);
		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-transcript', wait: false },
			directory,
		);

		expect(result.success).toBe(true);
		expect(result.lane_results[0].message_count).toBe(50);
		expect(result.lane_results[0].transcript_incomplete).toBe(true);
		const artifact = readLaneOutput(
			directory,
			result.lane_results[0].output_ref!,
		)?.artifact;
		expect(artifact?.text).toContain('part-0\n\npart-1');
		expect(artifact?.text).toContain('part-49');
		expect(artifact?.transcriptIncomplete).toBe(true);
	});

	test('collects only the current parent session when context is available', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-current' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			messages: mock(async (args) => ({
				data: [
					{
						info: { role: 'assistant' },
						parts: [{ type: 'text', text: `output ${args.path.id}` }],
					},
				],
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'shared-batch',
				lanes: [{ id: 'current', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
			{ sessionID: 'parent-current' },
		);
		await recordPendingDelegation(directory, {
			correlationId: 'session-other',
			jobId: null,
			subagentSessionId: 'session-other',
			parentSessionId: 'parent-other',
			callID: 'shared-batch',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'shared-batch',
			laneId: 'other',
			mode: 'advisory',
			promptHash: 'hash-other',
			generation: 1,
		});

		const result = await executeCollectLaneResults(
			{ batch_id: 'shared-batch', wait: false },
			directory,
			{ sessionID: 'parent-current' },
		);

		expect(result.success).toBe(true);
		expect(result.total).toBe(1);
		expect(result.lane_results.map((lane) => lane.id)).toEqual(['current']);
		expect(ops.messages).toHaveBeenCalledTimes(1);
		expect(ops.messages).toHaveBeenCalledWith({
			path: { id: 'session-current' },
			query: { directory, limit: 50 },
		});
		expect(findByBatchId(directory, 'shared-batch')).toHaveLength(2);
		expect(
			findByBatchId(directory, 'shared-batch', {
				parentSessionId: 'parent-current',
			}),
		).toHaveLength(1);
	});

	test('backs off collect polling while respecting timeout budget', async () => {
		const directory = makeTempDir();
		let now = 0;
		const sleeps: number[] = [];
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-wait' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			messages: mock(async () => ({ data: null, error: undefined })),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;
		_internals.now = () => now;
		_internals.sleep = mock(async (ms: number) => {
			sleeps.push(ms);
			now += ms;
		});

		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-backoff',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);
		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-backoff', wait: true, timeout_ms: 1600 },
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.pending).toBe(1);
		expect(sleeps).toEqual([500, 1000, 100]);
		expect(_test_exports.nextCollectPollInterval(500)).toBe(1000);
		expect(_test_exports.nextCollectPollInterval(10_000)).toBe(10_000);
	});

	test('fails closed when promptAsync is unavailable', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'session-1' } })),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanesAsync(
			{
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('no_client');
		expect(ops.create).not.toHaveBeenCalled();
	});

	test('records promptAsync failures as terminal async lane rows', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-fail' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ error: 'provider offline' })),
			abort: mock(async () => undefined),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanesAsync(
			{
				batch_id: 'batch-prompt-fails',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.lane_results[0]).toEqual(
			expect.objectContaining({
				id: 'runtime',
				status: 'failed',
				error: 'session.promptAsync failed: provider offline',
			}),
		);
		const records = findByBatchId(directory, 'batch-prompt-fails');
		expect(records).toHaveLength(1);
		expect(records[0]).toEqual(
			expect.objectContaining({
				status: 'error',
				result: expect.objectContaining({
					error: 'session.promptAsync failed: provider offline',
				}),
			}),
		);
		expect(ops.abort).toHaveBeenCalledWith({ path: { id: 'session-fail' } });
		expect(ops.delete).toHaveBeenCalledWith({ path: { id: 'session-fail' } });
	});

	test('cleans up async sessions created after create timeout', async () => {
		const directory = makeTempDir();
		const createGate = deferred<{ data: { id: string }; error: undefined }>();
		const deleteCalled = deferred<{ path: { id: string } }>();
		const ops: SessionOps = {
			create: mock(async () => await createGate.promise),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async (args) => {
				deleteCalled.resolve(args);
				return undefined;
			}),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanesAsync(
			{
				timeout_ms: 10,
				lanes: [{ id: 'late-create', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.lane_results[0]).toEqual(
			expect.objectContaining({
				id: 'late-create',
				status: 'failed',
				error: 'Lane "late-create" session.create timed out after 10ms',
			}),
		);
		expect(ops.promptAsync).not.toHaveBeenCalled();

		createGate.resolve({
			data: { id: 'late-async-session' },
			error: undefined,
		});
		await expect(deleteCalled.promise).resolves.toEqual({
			path: { id: 'late-async-session' },
		});
	});

	test('aborts and deletes async sessions when promptAsync times out', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-timeout' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => await new Promise<never>(() => undefined)),
			abort: mock(async () => undefined),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanesAsync(
			{
				timeout_ms: 10,
				batch_id: 'batch-timeout',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.lane_results[0]).toEqual(
			expect.objectContaining({
				id: 'runtime',
				status: 'failed',
				error: 'Lane "runtime" session.promptAsync timed out after 10ms',
			}),
		);
		expect(ops.abort).toHaveBeenCalledWith({ path: { id: 'session-timeout' } });
		expect(ops.delete).toHaveBeenCalledWith({
			path: { id: 'session-timeout' },
		});
		const records = findByBatchId(directory, 'batch-timeout');
		expect(records[0]).toEqual(
			expect.objectContaining({
				status: 'error',
				result: expect.objectContaining({
					error: 'Lane "runtime" session.promptAsync timed out after 10ms',
				}),
			}),
		);
	});

	test('rejects reused async batch ids before creating sessions', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-reuse' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-reused',
				lanes: [{ id: 'first', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);
		const result = await executeDispatchLanesAsync(
			{
				batch_id: 'batch-reused',
				lanes: [{ id: 'second', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.message).toBe(
			'Async lane batch already exists: batch-reused',
		);
		expect(ops.create).toHaveBeenCalledTimes(1);
	});

	test('marks cancelled lanes as unsuccessful collection gaps', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-cancel' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			messages: mock(async () => ({ data: null, error: undefined })),
			abort: mock(async () => undefined),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-cancel',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);
		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-cancel', cancel_pending: true },
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.cancelled).toBe(1);
		expect(result.all_settled).toBe(true);
	});

	test('sweeps stale async rows during collection and reports failure', async () => {
		const directory = makeTempDir();
		let now = 1_700_000_000_000;
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-stale' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			messages: mock(async () => ({ data: null, error: undefined })),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;
		_internals.now = () => now;
		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			await executeDispatchLanesAsync(
				{
					batch_id: 'batch-stale',
					lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
				},
				directory,
			);
			now += 31 * 60_000;

			const result = await executeCollectLaneResults(
				{ batch_id: 'batch-stale' },
				directory,
			);

			expect(result.success).toBe(false);
			expect(result.stale).toBe(1);
			expect(result.pending).toBe(0);
			expect(ops.messages).not.toHaveBeenCalled();
		} finally {
			Date.now = realDateNow;
		}
	});

	test('collects only assistant text parts into a chronological transcript', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-multipart' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			messages: mock(async () => ({
				data: [
					{
						info: { role: 'assistant' },
						parts: [{ type: 'text', text: 'older output' }],
					},
					{
						info: { role: 'assistant' },
						parts: [{ type: 'image', text: 'ignore image text' }],
					},
					{
						info: { role: 'user' },
						parts: [{ type: 'text', text: 'ignore user' }],
					},
					{
						info: { role: 'assistant' },
						parts: [
							{ type: 'tool', text: 'ignore tool text' },
							{ type: 'text', text: 'newer output' },
						],
					},
				],
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-multipart',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);
		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-multipart' },
			directory,
		);

		expect(result.success).toBe(true);
		expect(result.lane_results[0].output).toBe('older output\n\nnewer output');
		expect(
			_test_exports.extractAssistantTranscript([
				{
					info: { role: 'assistant' },
					parts: [{ type: 'text', text: 'first' }],
				},
				{ info: { role: 'assistant' }, parts: [{ type: 'text', text: '   ' }] },
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'user' }] },
			]).text,
		).toBe('first');
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

describe('common_prompt (shared lane context)', () => {
	test('applyCommonPrompt prepends shared context to every lane prompt', () => {
		const result = _test_exports.applyCommonPrompt(
			[
				{ id: 'a', agent: 'explorer', prompt: 'focus A' },
				{ id: 'b', agent: 'reviewer', prompt: 'focus B' },
			],
			'SHARED CONTEXT',
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.lanes[0].prompt).toBe('SHARED CONTEXT\n\nfocus A');
		expect(result.lanes[1].prompt).toBe('SHARED CONTEXT\n\nfocus B');
	});

	test('applyCommonPrompt returns a fresh, equal array when common_prompt is omitted', () => {
		const lanes = [{ id: 'a', agent: 'explorer', prompt: 'focus A' }];
		const result = _test_exports.applyCommonPrompt(lanes, undefined);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Contract: the caller always owns the returned array (a fresh copy), so
		// mutating it can never affect the originals. Same contents, new reference.
		expect(result.lanes).toEqual(lanes);
		expect(result.lanes).not.toBe(lanes);
		result.lanes.push({ id: 'z', agent: 'explorer', prompt: 'injected' });
		expect(lanes).toHaveLength(1);
	});

	test('applyCommonPrompt handles multi-line common_prompt and special characters correctly', () => {
		// The separator is '\n\n', so a multi-line common_prompt produces a blank line
		// between it and the lane prompt — standard Markdown paragraph separation.
		const common = 'Line 1\nLine 2\n\nParagraph 2 — emoji: 🔍 unicode: café';
		const result = _test_exports.applyCommonPrompt(
			[{ id: 'x', agent: 'explorer', prompt: 'focus area' }],
			common,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.lanes[0].prompt).toBe(
			'Line 1\nLine 2\n\nParagraph 2 — emoji: 🔍 unicode: café\n\nfocus area',
		);
	});

	test('empty string common_prompt is rejected by schema (min(1))', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'session' }, error: undefined })),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'done' }] },
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				common_prompt: '' as string, // type cast to bypass TS — testing runtime schema guard
				lanes: [{ id: 'x', agent: 'explorer', prompt: 'focus' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(ops.create).toHaveBeenCalledTimes(0);
	});

	test('whitespace-only common_prompt is rejected by schema (regex \\S guard)', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'session' }, error: undefined })),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'done' }] },
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		// A whitespace-only common_prompt passes .min(1) but carries no context;
		// the \S regex guard rejects it before any session is created so lanes
		// never receive a blank prefix + separator.
		const result = await executeDispatchLanes(
			{
				common_prompt: '   \n\t  ',
				lanes: [{ id: 'x', agent: 'explorer', prompt: 'focus' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(ops.create).toHaveBeenCalledTimes(0);
	});

	test('DispatchLanesAsyncArgsSchema inherits common_prompt from the base schema — regression: false-positive "missing from async schema" review claim', () => {
		// A PR review claimed common_prompt was absent from the async schema, so
		// dispatch_lanes_async would silently drop it. That is false: the async
		// schema is `DispatchLanesArgsSchema.extend({...})`, and Zod's .extend
		// preserves every base field. This locks the parity down permanently.
		const { DispatchLanesArgsSchema, DispatchLanesAsyncArgsSchema } =
			_test_exports;
		expect(DispatchLanesArgsSchema.shape.common_prompt).toBeDefined();
		expect(DispatchLanesAsyncArgsSchema.shape.common_prompt).toBeDefined();

		const parsed = DispatchLanesAsyncArgsSchema.parse({
			batch_id: 'batch-schema-1',
			common_prompt: 'shared async context',
			lanes: [{ id: 'x', agent: 'explorer', prompt: 'focus' }],
		});
		expect(parsed.common_prompt).toBe('shared async context');
	});

	test('applyCommonPrompt rejects when combined length exceeds the per-lane limit', () => {
		const common = 'a'.repeat(MAX_PROMPT_CHARS - 1);
		const result = _test_exports.applyCommonPrompt(
			[{ id: 'big', agent: 'explorer', prompt: 'bb' }],
			common,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('big');
		expect(result.errors[0]).toContain(`max ${MAX_PROMPT_CHARS}`);
	});

	test('applyCommonPrompt passes when combined length equals the per-lane limit exactly', () => {
		// common_prompt schema max = MAX_PROMPT_CHARS - separator(2) - 1 = 79997
		// combined = 79997 + 2 + 1 = 80000 = MAX_PROMPT_CHARS, NOT > MAX_PROMPT_CHARS → passes
		const common = 'a'.repeat(MAX_PROMPT_CHARS - 3); // 79997 chars
		const result = _test_exports.applyCommonPrompt(
			[{ id: 'x', agent: 'explorer', prompt: 'y' }],
			common,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.lanes[0].prompt.length).toBe(MAX_PROMPT_CHARS); // exactly at limit
	});

	test('common_prompt schema rejects values exceeding the tightened max (79997)', async () => {
		// 79998-char common_prompt is schema-invalid (max is MAX_PROMPT_CHARS - sep - 1 = 79997)
		// so the executor must fail with invalid_args before any session is created
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'session' }, error: undefined })),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'done' }] },
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				common_prompt: 'a'.repeat(MAX_PROMPT_CHARS - 2), // 79998 chars — exceeds schema max of 79997
				lanes: [{ id: 'x', agent: 'explorer', prompt: 'y' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(ops.create).toHaveBeenCalledTimes(0);
	});

	test('executeDispatchLanes sends common_prompt + per-lane prompt to each lane', async () => {
		const directory = makeTempDir();
		let nextSession = 0;
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: `session-${++nextSession}` },
				error: undefined,
			})),
			prompt: mock(async (input) => ({
				data: {
					parts: [{ type: 'text' as const, text: `done ${input.body.agent}` }],
				},
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				common_prompt: 'PR DIFF + LEDGER',
				lanes: [
					{ id: 'corr', agent: 'explorer', prompt: 'correctness focus' },
					{ id: 'sec', agent: 'reviewer', prompt: 'security focus' },
				],
			},
			directory,
		);

		expect(result.success).toBe(true);
		const texts = (ops.prompt as ReturnType<typeof mock>).mock.calls.map(
			(call) => call[0].body.parts[0].text,
		);
		const explorerText = texts.find((t) => t.includes('correctness focus'));
		expect(explorerText).toBeDefined();
		expect(explorerText).toContain('PR DIFF + LEDGER\n\ncorrectness focus');
		expect(explorerText).toContain('[CANDIDATE]');
		expect(texts).toContain('PR DIFF + LEDGER\n\nsecurity focus');
	});

	test('executeDispatchLanes rejects oversized common_prompt + prompt without dispatching', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'session' }, error: undefined })),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'done' }] },
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				common_prompt: 'a'.repeat(MAX_PROMPT_CHARS - 1),
				lanes: [{ id: 'big', agent: 'explorer', prompt: 'bbbb' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(ops.prompt).toHaveBeenCalledTimes(0);
	});

	test('executeDispatchLanesAsync sends common_prompt + lane prompt to promptAsync', async () => {
		const directory = makeTempDir();
		let nextSession = 0;
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: `session-${++nextSession}` },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanesAsync(
			{
				batch_id: 'batch-common-1',
				common_prompt: 'SHARED ASYNC CONTEXT',
				lanes: [
					{ id: 'runtime', agent: 'explorer', prompt: 'inspect runtime' },
				],
			},
			directory,
		);

		expect(result.success).toBe(true);
		expect(ops.promptAsync).toHaveBeenCalledTimes(1);
		const sentText = (ops.promptAsync as ReturnType<typeof mock>).mock
			.calls[0][0].body.parts[0].text;
		expect(sentText).toContain('SHARED ASYNC CONTEXT\n\ninspect runtime');
		expect(sentText).toContain('[CANDIDATE]');
	});

	test('executeDispatchLanesAsync rejects oversized common_prompt + prompt without dispatching', async () => {
		const directory = makeTempDir();
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'session' }, error: undefined })),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanesAsync(
			{
				batch_id: 'batch-oversized-1',
				common_prompt: 'a'.repeat(MAX_PROMPT_CHARS - 1),
				lanes: [{ id: 'big', agent: 'explorer', prompt: 'bbbb' }],
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(ops.promptAsync).toHaveBeenCalledTimes(0);
	});
});

describe('applyExplorerFormatSuffix', () => {
	afterEach(() => {
		Object.assign(_internals, originalInternals);
	});

	test('appends format suffix to explorer-role lanes', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const lanes = [
			{ id: 'L1', agent: 'swarm_explorer', prompt: 'inspect runtime' },
		];
		const result = _test_exports.applyExplorerFormatSuffix(lanes);
		expect(result[0].prompt).toContain('inspect runtime');
		expect(result[0].prompt).toContain('[CANDIDATE]');
	});

	test('skips non-explorer lanes', () => {
		_internals.getGeneratedAgentNames = () => [
			'swarm_explorer',
			'swarm_reviewer',
		];
		const lanes = [
			{ id: 'L1', agent: 'swarm_reviewer', prompt: 'review findings' },
		];
		const result = _test_exports.applyExplorerFormatSuffix(lanes);
		expect(result[0].prompt).toBe('review findings');
		expect(result[0].prompt).not.toContain('[CANDIDATE]');
	});

	test('skips lanes that already contain [CANDIDATE]', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const originalPrompt = 'inspect with [CANDIDATE] format already';
		const lanes = [
			{ id: 'L1', agent: 'swarm_explorer', prompt: originalPrompt },
		];
		const result = _test_exports.applyExplorerFormatSuffix(lanes);
		expect(result[0].prompt).toBe(originalPrompt);
	});

	test('skips when appending would exceed MAX_PROMPT_CHARS', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const longPrompt = 'x'.repeat(MAX_PROMPT_CHARS - 10);
		const lanes = [{ id: 'L1', agent: 'swarm_explorer', prompt: longPrompt }];
		const result = _test_exports.applyExplorerFormatSuffix(lanes);
		expect(result[0].prompt).toBe(longPrompt);
	});
});
