/**
 * The Lean Turbo lane runner reads the provider error OpenCode records on the
 * assistant message (`info.error`): `session.prompt` answers HTTP 200 with the
 * failure there and no text, so a provider refusal must fail the lane (and tear
 * its session down) instead of completing it.
 */
import { describe, expect, mock, test } from 'bun:test';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import type { LeanTurboLane } from '../../../../src/turbo/lean/state';

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
