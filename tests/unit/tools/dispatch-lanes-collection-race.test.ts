import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readLaneOutput } from '../../../src/background/lane-output-store';
import { findByBatchId } from '../../../src/background/pending-delegations';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const originalInternals = { ..._internals };
const testDirCleanups: Array<() => void> = [];

function makeTempDir(): string {
	const { dir, cleanup } = createSafeTestDir('dispatch-lanes-collection-race-');
	testDirCleanups.push(cleanup);
	return dir;
}

afterEach(() => {
	Object.assign(_internals, originalInternals);
	while (testDirCleanups.length > 0) testDirCleanups.pop()?.();
});

describe('dispatch lane collection readiness and races', () => {
	test('same-pass collection wins over a stale snapshot and preserves the durable output ref', async () => {
		const directory = makeTempDir();
		let now = 2_000_000_000_000;
		const ops: SessionOps = {
			create: mock(async () => ({
				data: { id: 'session-race' },
				error: undefined,
			})),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'unused' }] },
				error: undefined,
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			status: mock(async () => ({
				data: { 'session-race': { type: 'idle' } },
				error: undefined,
			})),
			messages: mock(async () => ({
				data: [
					{
						info: { role: 'assistant' },
						parts: [{ type: 'text', text: 'terminal lane output' }],
					},
				],
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;
		_internals.now = () => now;

		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-stale-race',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);
		now += _test_exports.DEFAULT_ASYNC_STALE_TIMEOUT_MS + 1;

		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-stale-race', wait: false },
			directory,
		);

		expect(result.success).toBe(true);
		expect(result.completed).toBe(1);
		expect(result.stale).toBe(0);
		expect(result.pending).toBe(0);
		expect(result.lane_results[0]).toEqual(
			expect.objectContaining({
				id: 'runtime',
				status: 'completed',
				output: 'terminal lane output',
				output_ref: expect.stringMatching(
					/^L1:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/,
				),
			}),
		);
		expect(
			readLaneOutput(directory, result.lane_results[0].output_ref!)?.artifact
				.text,
		).toBe('terminal lane output');
		expect(findByBatchId(directory, 'batch-stale-race')[0].status).toBe(
			'completed',
		);
	});

	test('collects ready lanes while leaving still-running lanes pending', async () => {
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
			status: mock(async () => ({
				data: {
					'session-1': { type: 'idle' },
					'session-2': { type: 'busy' },
				},
				error: undefined,
			})),
			messages: mock(async (args) => ({
				data: [
					{
						info: { role: 'assistant' },
						parts: [{ type: 'text', text: `final output for ${args.path.id}` }],
					},
				],
				error: undefined,
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-mixed-readiness',
				lanes: [
					{ id: 'ready', agent: 'explorer', prompt: 'inspect ready lane' },
					{ id: 'running', agent: 'reviewer', prompt: 'inspect running lane' },
				],
			},
			directory,
		);
		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-mixed-readiness', wait: false },
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.completed).toBe(1);
		expect(result.pending).toBe(1);
		expect(result.all_settled).toBe(false);
		const ready = result.lane_results.find((lane) => lane.id === 'ready');
		const running = result.lane_results.find((lane) => lane.id === 'running');
		expect(ready).toEqual(
			expect.objectContaining({
				id: 'ready',
				status: 'completed',
				output: 'final output for session-1',
			}),
		);
		expect(running).toEqual(
			expect.objectContaining({ id: 'running', status: 'pending' }),
		);
		expect(running?.output).toBeUndefined();
		expect(ops.status).toHaveBeenCalledTimes(2);
		expect(ops.messages).toHaveBeenCalledTimes(1);
		expect(ops.messages).toHaveBeenCalledWith({
			path: { id: 'session-1' },
			query: { directory, limit: 50 },
		});
	});

	test('requires a whitelisted terminal finish reason', () => {
		const transcriptForFinish = (finish?: string) =>
			_test_exports.extractAssistantTranscript([
				{
					info: {
						role: 'assistant',
						time: { completed: 1 },
						...(finish !== undefined ? { finish } : {}),
					},
					parts: [{ type: 'text', text: 'assistant output' }],
				},
			]);

		expect(transcriptForFinish('stop').terminalAssistantProof).toBe(true);
		expect(transcriptForFinish('length').terminalAssistantProof).toBe(true);
		expect(transcriptForFinish('content-filter').terminalAssistantProof).toBe(
			true,
		);
		expect(transcriptForFinish('tool-calls').terminalAssistantProof).toBe(
			false,
		);
		expect(transcriptForFinish('unknown').terminalAssistantProof).toBe(false);
		expect(transcriptForFinish('tool').terminalAssistantProof).toBe(false);
		expect(transcriptForFinish('error').terminalAssistantProof).toBe(false);
		expect(transcriptForFinish('').terminalAssistantProof).toBe(false);
	});
});
