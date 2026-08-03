import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	executeDispatchLanes,
	MAX_PROMPT_CHARS,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';

const originalInternals = { ..._internals };

afterEach(() => {
	Object.assign(_internals, originalInternals);
});

describe('blocking PR-workflow explorer prompt overflow', () => {
	test('fails closed before launch for PR-review and PR-feedback-bound lanes', async () => {
		const create = mock(async () => ({ data: { id: 'must-not-launch' } }));
		const ops: SessionOps = {
			create,
			prompt: mock(async () => ({ data: null })),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];

		// Prior bug: blocking dispatch silently retained this oversized prompt
		// without the mandatory [CANDIDATE]/[CLEAN] suffix and launched the lane.
		for (const workflowLane of [
			'intent-architecture',
			'feedback-verification',
		]) {
			const result = await executeDispatchLanes(
				{
					lanes: [
						{
							id: workflowLane,
							agent: 'swarm_explorer',
							prompt: 'x'.repeat(MAX_PROMPT_CHARS - 10),
							workflow_lane: workflowLane,
						},
					],
				},
				process.cwd(),
			);

			expect(result.success).toBe(false);
			expect(result.failure_class).toBe('invalid_args');
			expect(result.message).toContain('explorer output-format contract');
			expect(result.errors?.join('; ')).toContain(
				'mandatory explorer output contract',
			);
		}
		expect(create).not.toHaveBeenCalled();
	});

	test('preserves generic overflow compatibility without a workflow binding', async () => {
		const longPrompt = 'x'.repeat(MAX_PROMPT_CHARS - 10);
		const prompt = mock(async () => ({
			data: { parts: [{ type: 'text' as const, text: 'generic result' }] },
		}));
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'generic-session' } })),
			prompt,
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];

		const result = await executeDispatchLanes(
			{
				lanes: [{ id: 'generic', agent: 'swarm_explorer', prompt: longPrompt }],
			},
			process.cwd(),
		);

		expect(result.success).toBe(true);
		expect(prompt.mock.calls[0][0].body.parts[0].text).toBe(longPrompt);
	});
});
