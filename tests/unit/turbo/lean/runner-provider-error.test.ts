/**
 * The Lean Turbo lane runner reads the provider error OpenCode records on the
 * assistant message (`info.error`): `session.prompt` answers HTTP 200 with the
 * failure there and no text, so a provider refusal must fail the lane (and tear
 * its session down) instead of completing it.
 */
import { describe, expect, mock, test } from 'bun:test';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import type { LeanTurboLane } from '../../../../src/turbo/lean/state';
import { isTransientProviderError } from '../../../../src/utils/provider-error-classification';

const LANE: LeanTurboLane = {
	laneId: 'lane-1',
	taskIds: ['1.1'],
	files: ['src/a.ts'],
	status: 'pending',
};

function makeRunner(promptData: unknown) {
	const runner = new LeanTurboRunner({
		directory: '/tmp/runner-provider-error',
		sessionID: 'sess-parent',
	});
	const ops = {
		create: mock(async () => ({ data: { id: 'lane-sess' }, error: null })),
		prompt: mock(async () => ({ data: promptData, error: null })),
		delete: mock(async () => {}),
	};
	runner._sessionOps = ops as unknown as typeof runner._sessionOps;
	return { runner, ops };
}

describe('LeanTurboRunner.dispatchLane provider error on the assistant message', () => {
	test('a 403 recorded as info.error with no text fails the lane and tears it down', async () => {
		const { runner, ops } = makeRunner({
			info: {
				error: {
					name: 'APIError',
					data: { statusCode: 403, message: 'free tier' },
				},
			},
			parts: [],
		});

		const result = await runner.dispatchLane(LANE, 'coder');

		expect(result.ok).toBe(false);
		expect(result.sessionId).toBeUndefined();
		expect(result.error).toContain('APIError (HTTP 403)');
		expect(result.error).toContain('free tier');
		// teardownEphemeralSession is fire-and-forget; let it settle.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ops.delete).toHaveBeenCalledTimes(1);
	});

	test('a 429 fails the lane with a message the fallback chain treats as transient', async () => {
		const { runner } = makeRunner({
			info: {
				error: {
					name: 'APIError',
					data: { statusCode: 429, message: 'slow down' },
				},
			},
			parts: [],
		});

		const result = await runner.dispatchLane(LANE, 'coder');

		expect(result.ok).toBe(false);
		// The runner classifies the formatted message (`classify` in the
		// model-fallback dispatch): a rate limit fails over, a 403 does not.
		expect(isTransientProviderError(result.error ?? '')).toBe(true);
	});

	test('a 403 fails the lane with a message the fallback chain treats as permanent', async () => {
		const { runner } = makeRunner({
			info: {
				error: {
					name: 'APIError',
					data: { statusCode: 403, message: 'forbidden' },
				},
			},
			parts: [],
		});

		const result = await runner.dispatchLane(LANE, 'coder');

		expect(result.ok).toBe(false);
		expect(isTransientProviderError(result.error ?? '')).toBe(false);
	});

	test('a truncated reply (MessageOutputLengthError) keeps the lane behavior it had before', async () => {
		const { runner, ops } = makeRunner({
			info: { error: { name: 'MessageOutputLengthError', data: {} } },
			parts: [{ type: 'text', text: 'partial' }],
		});

		const result = await runner.dispatchLane(LANE, 'coder');

		expect(result).toEqual({ ok: true, sessionId: 'lane-sess' });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ops.delete).not.toHaveBeenCalled();
	});

	test('a message without info.error still completes the lane', async () => {
		const { runner, ops } = makeRunner({
			info: {},
			parts: [{ type: 'text', text: 'Done' }],
		});

		const result = await runner.dispatchLane(LANE, 'coder');

		expect(result).toEqual({ ok: true, sessionId: 'lane-sess' });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ops.delete).not.toHaveBeenCalled();
	});
});
