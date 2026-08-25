import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

const TEST_DIR = '/test/project';

const defaultConfig: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 200,
	max_duration_minutes: 30,
	max_repetitions: 10,
	max_consecutive_errors: 5,
	warning_threshold: 0.75,
	idle_timeout_minutes: 60,
	qa_gates: {
		required_tools: [
			'diff',
			'syntax_check',
			'placeholder_scan',
			'lint',
			'pre_check_batch',
		],
		require_reviewer_test_engineer: true,
	},
};

function makeTaskArgs(subagentType: string, prompt = 'Fix the bug') {
	return { subagent_type: subagentType, prompt };
}

async function setupSubagentSessionWithWindow(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	sessionId: string,
	agentName = 'coder',
) {
	ensureAgentSession(sessionId, agentName);
	swarmState.activeAgent.set(sessionId, agentName);

	const input = { tool: 'Task', sessionID: sessionId, callID: 'call-init' };
	const output = { args: makeTaskArgs(agentName, 'Initial setup') };
	await hooks.toolBefore(input as any, output as any);

	return swarmState.agentSessions.get(sessionId)!;
}

describe('model fallback', () => {
	let hooks: ReturnType<typeof createGuardrailsHooks>;

	beforeEach(() => {
		resetSwarmState();
		hooks = createGuardrailsHooks(TEST_DIR, defaultConfig);
	});

	afterEach(() => {
		resetSwarmState();
	});

	test('does not grant fallback authority to transient-looking tool output', async () => {
		const sessionId = 'session-apply-fallback';
		const session = await setupSubagentSessionWithWindow(
			hooks,
			sessionId,
			'coder',
		);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'rate limit exceeded',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(0);
		expect(session.pendingAdvisoryMessages ?? []).toEqual([]);
	});

	test('does not exhaust fallback models from tool output', async () => {
		const sessionId = 'session-exhaust-no-config';
		const session = await setupSubagentSessionWithWindow(
			hooks,
			sessionId,
			'coder',
		);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'rate limit exceeded',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.modelFallbackExhausted).toBe(false);
	});

	test('resets fallback index on successful call', async () => {
		const sessionId = 'session-reset';
		const session = await setupSubagentSessionWithWindow(
			hooks,
			sessionId,
			'coder',
		);

		// Provider-boundary code owns fallback advancement; tool output cannot.
		session.model_fallback_index = 1;

		// Now a successful call should reset
		const successInput = {
			tool: 'bash',
			sessionID: sessionId,
			callID: 'call-2',
		};
		await hooks.toolAfter(
			successInput as any,
			{ title: 'bash', output: 'success', metadata: {} } as any,
		);
		expect(session.model_fallback_index).toBe(0);
	});

	test('does not fallback on non-transient errors', async () => {
		const sessionId = 'session-non-transient';
		const session = await setupSubagentSessionWithWindow(
			hooks,
			sessionId,
			'coder',
		);

		// A non-null output without transient error pattern should not trigger fallback
		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		await hooks.toolAfter(
			input as any,
			{
				title: 'bash',
				output: 'some regular error output',
				metadata: {},
			} as any,
		);

		expect(session.model_fallback_index).toBe(0);
		expect(session.modelFallbackExhausted).toBeFalsy();
	});
});
