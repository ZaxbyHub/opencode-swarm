import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema.js';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails/index.js';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state.js';

const config: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 200,
	max_duration_minutes: 30,
	max_repetitions: 10,
	max_consecutive_errors: 5,
	warning_threshold: 0.75,
	idle_timeout_minutes: 60,
};

async function setup(sessionID: string) {
	const hooks = createGuardrailsHooks('/test/project', config);
	const session = ensureAgentSession(sessionID, 'coder');
	swarmState.activeAgent.set(sessionID, 'coder');
	await hooks.toolBefore(
		{ tool: 'Task', sessionID, callID: 'init' } as never,
		{ args: { subagent_type: 'coder', prompt: 'setup' } } as never,
	);
	return { hooks, session };
}

describe('guardrails provider-source boundary (#2103)', () => {
	beforeEach(resetSwarmState);
	afterEach(resetSwarmState);

	for (const quoted of [
		'rate limit 429',
		'503 temporarily unavailable',
		'quota exceeded',
		'context length exceeded',
		'content filter',
	]) {
		test(`tool output cannot advance model fallback: ${quoted}`, async () => {
			const { hooks, session } = await setup(`session-${quoted.slice(0, 4)}`);
			await hooks.toolAfter(
				{ tool: 'bash', sessionID: session.id, callID: 'call' } as never,
				{
					output: quoted,
					error: 'command failed',
					metadata: { exit: 2 },
				} as never,
			);
			expect(session.model_fallback_index).toBe(0);
			expect(session.pendingAdvisoryMessages?.join('\n') ?? '').not.toContain(
				'MODEL FALLBACK',
			);
		});
	}

	test('a later successful exact tool action resets its local error state', async () => {
		const { hooks, session } = await setup('session-success');
		await hooks.toolAfter(
			{ tool: 'bash', sessionID: session.id, callID: 'failure' } as never,
			{ output: 'failed', error: 'failed', metadata: { exit: 2 } } as never,
		);
		await hooks.toolAfter(
			{ tool: 'bash', sessionID: session.id, callID: 'success' } as never,
			{ output: 'ok', metadata: { exit: 0 } } as never,
		);
		const window = Object.values(session.windows)[0];
		expect(window?.consecutiveErrors).toBe(0);
	});
});
