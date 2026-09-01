import { describe, expect, mock, test } from 'bun:test';
import {
	_test_exports,
	type DispatchLaneSpec,
	PrReviewStructuredPromptUnsupportedError,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';

const lane: DispatchLaneSpec = {
	id: 'base-correctness',
	agent: 'explorer',
	prompt: 'Review the correctness dimension and submit one structured result.',
	workflow_lane: 'base:correctness',
};

function sessionOps(promptAsync = mock(async () => ({}))): SessionOps {
	return {
		create: mock(async () => ({ data: { id: 'child-1' } })),
		prompt: mock(async () => ({})),
		promptAsync,
		delete: mock(async () => ({})),
		abort: mock(async () => ({})),
	};
}

describe('structured PR-review adapter transport (PRR-002/PRR-003)', () => {
	test('uses the issue-fixed schema-bearing adapter shape', async () => {
		const promptJsonSchema = mock(async () => ({ accepted: true }));
		const promptAsync = mock(async () => ({}));

		await _test_exports.startAsyncLanePrompt({
			session: sessionOps(promptAsync),
			directory: process.cwd(),
			sessionId: 'child-1',
			lane,
			timeoutMs: 100,
			mode: 'swarm-pr-review:base',
			structuredAdapter: { promptJsonSchema },
		});

		expect(promptJsonSchema).toHaveBeenCalledTimes(1);
		expect(promptJsonSchema.mock.calls[0]?.[0]).toMatchObject({
			sessionId: 'child-1',
			agent: 'explorer',
			parts: [{ type: 'text', text: lane.prompt }],
		});
		expect(promptJsonSchema.mock.calls[0]?.[0].schema).toBeDefined();
		expect(promptAsync).not.toHaveBeenCalled();
	});

	test('falls back only for explicit pre-execution unsupported capability', async () => {
		const promptAsync = mock(async () => ({}));

		await _test_exports.startAsyncLanePrompt({
			session: sessionOps(promptAsync),
			directory: process.cwd(),
			sessionId: 'child-1',
			lane,
			timeoutMs: 100,
			mode: 'swarm-pr-review:base',
			structuredAdapter: {
				promptJsonSchema: async () => {
					throw new PrReviewStructuredPromptUnsupportedError();
				},
			},
		});

		expect(promptAsync).toHaveBeenCalledTimes(1);
	});

	test('provider failure after adapter execution begins does not double-dispatch', async () => {
		const promptAsync = mock(async () => ({}));

		await _test_exports.startAsyncLanePrompt({
			session: sessionOps(promptAsync),
			directory: process.cwd(),
			sessionId: 'child-1',
			lane,
			timeoutMs: 100,
			mode: 'swarm-pr-review:micro',
			structuredAdapter: {
				promptJsonSchema: async () => {
					throw new Error('provider failed after execution began');
				},
			},
		});

		expect(promptAsync).not.toHaveBeenCalled();
	});

	test('bounds a structured adapter that never settles (PRR-003)', async () => {
		await withFrozenClockAsync(async () => {
			const startedAt = Date.now();
			const promptAsync = mock(async () => ({}));

			await _test_exports.startAsyncLanePrompt({
				session: sessionOps(promptAsync),
				directory: process.cwd(),
				sessionId: 'child-1',
				lane,
				timeoutMs: 10,
				mode: 'swarm-pr-review:base',
				structuredAdapter: {
					promptJsonSchema: () => new Promise(() => {}),
				},
			});

			expect(Date.now() - startedAt).toBeLessThan(1_000);
			expect(promptAsync).not.toHaveBeenCalled();
		});
	});
});
