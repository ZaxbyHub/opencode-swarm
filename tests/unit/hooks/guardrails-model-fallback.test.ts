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

/**
 * Sets up a subagent session with a window by calling toolBefore first.
 * Architect sessions never create windows (see state.ts getOrCreateWindow).
 */
async function setupSubagentSessionWithWindow(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	sessionId: string,
	agentName = 'coder',
) {
	ensureAgentSession(sessionId, agentName);
	swarmState.activeAgent.set(sessionId, agentName);

	// Call toolBefore to create the window (getOrCreateWindow is called in toolBefore)
	const input = { tool: 'Task', sessionID: sessionId, callID: 'call-init' };
	const output = { args: makeTaskArgs(agentName, 'Initial setup') };
	await hooks.toolBefore(input as any, output as any);

	return swarmState.agentSessions.get(sessionId)!;
}

describe('guardrails model fallback retry logic (toolAfter)', () => {
	let hooks: ReturnType<typeof createGuardrailsHooks>;

	beforeEach(() => {
		resetSwarmState();
		hooks = createGuardrailsHooks(TEST_DIR, defaultConfig);
	});

	afterEach(() => {
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// Test 1: Transient error "rate limit" → advisory injected, model_fallback_index incremented
	// -------------------------------------------------------------------------
	test('toolAfter with "rate limit" error → advisory injected, model_fallback_index incremented', async () => {
		const sessionId = 'session-rate-limit';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'rate limit exceeded, please wait',
			metadata: {},
		};

		const initialPendingEvents = swarmState.pendingEvents;
		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.modelFallbackExhausted).toBe(true);
		expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
		expect(session.pendingAdvisoryMessages?.[0]).toContain('MODEL FALLBACK');
		expect(session.pendingAdvisoryMessages?.[0]).toContain('attempt 1');
		expect(swarmState.pendingEvents).toBe(initialPendingEvents + 1);
	});

	// -------------------------------------------------------------------------
	// Test 2: Transient error "429" → advisory injected
	// -------------------------------------------------------------------------
	test('toolAfter with "429" error → advisory injected', async () => {
		const sessionId = 'session-429';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'Error 429: Too Many Requests',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// Test 3: Transient error "503" → advisory injected
	// -------------------------------------------------------------------------
	test('toolAfter with "503" error → advisory injected', async () => {
		const sessionId = 'session-503';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'HTTP 503 Service Unavailable',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// Test 4: Transient error "timeout" → advisory injected
	// -------------------------------------------------------------------------
	test('toolAfter with "timeout" error → advisory injected', async () => {
		const sessionId = 'session-timeout';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'Request timeout after 30s',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// Test 5: Transient error "overloaded" → advisory injected
	// -------------------------------------------------------------------------
	test('toolAfter with "overloaded" error → advisory injected', async () => {
		const sessionId = 'session-overloaded';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'Model is overloaded, try again later',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// Test 6: Transient error "model not found" → advisory injected
	// -------------------------------------------------------------------------
	test('toolAfter with "model not found" error → advisory injected', async () => {
		const sessionId = 'session-model-not-found';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'model not found in registry',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// Test 7: Non-transient error "file not found" → no advisory
	// -------------------------------------------------------------------------
	test('toolAfter with "file not found" error → no advisory', async () => {
		const sessionId = 'session-file-not-found';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'file not found at /path/to/file',
			metadata: {},
		};

		const initialPendingEvents = swarmState.pendingEvents;
		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(0);
		expect(session.pendingAdvisoryMessages?.length).toBe(0);
		expect(swarmState.pendingEvents).toBe(initialPendingEvents);
	});

	// -------------------------------------------------------------------------
	// Test 8: No error (output.output is a valid string) → model_fallback_index reset to 0
	// -------------------------------------------------------------------------
	test('toolAfter with valid output → model_fallback_index reset to 0', async () => {
		const sessionId = 'session-success';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		// Pre-set model_fallback_index to simulate a prior transient failure
		session.model_fallback_index = 2;
		session.modelFallbackExhausted = true;

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: 'Command succeeded with output',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(0);
		expect(session.modelFallbackExhausted).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Test 9: modelFallbackExhausted prevents double advisory on consecutive errors
	// -------------------------------------------------------------------------
	test('toolAfter with consecutive transient errors → modelFallbackExhausted prevents double advisory', async () => {
		const sessionId = 'session-consecutive';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input1 = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output1 = {
			title: 'bash',
			output: null,
			error: 'rate limit exceeded',
			metadata: {},
		};

		await hooks.toolAfter(input1 as any, output1 as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);

		// Second transient error should NOT inject another advisory
		const input2 = { tool: 'bash', sessionID: sessionId, callID: 'call-2' };
		const output2 = {
			title: 'bash',
			output: null,
			error: 'rate limit exceeded again',
			metadata: {},
		};

		await hooks.toolAfter(input2 as any, output2 as any);

		// model_fallback_index should NOT increment again
		expect(session.model_fallback_index).toBe(1);
		// Should still only have 1 advisory message (no double injection)
		expect(session.pendingAdvisoryMessages?.length).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Test 10: Advisory message content is correct (references attempt number, doesn't leak error details)
	// -------------------------------------------------------------------------
	test('toolAfter advisory message content is correct', async () => {
		const sessionId = 'session-advisory-content';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'rate limit exceeded, your API key is xyz123',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		const advisory = session.pendingAdvisoryMessages?.[0];
		expect(advisory).toBeDefined();
		// Should reference attempt number
		expect(advisory).toContain('attempt 1');
		// Should NOT leak error details (no API key, no error message)
		expect(advisory).not.toContain('xyz123');
		expect(advisory).not.toContain('rate limit exceeded');
		expect(advisory).toContain('MODEL FALLBACK');
	});

	// -------------------------------------------------------------------------
	// Test 11: swarmState.pendingEvents incremented by 1
	// -------------------------------------------------------------------------
	test('toolAfter with transient error → swarmState.pendingEvents incremented by 1', async () => {
		const sessionId = 'session-pending-events';
		await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'timeout exceeded',
			metadata: {},
		};

		expect(swarmState.pendingEvents).toBe(0);
		await hooks.toolAfter(input as any, output as any);
		expect(swarmState.pendingEvents).toBe(1);

		// Second transient error should NOT increment again (modelFallbackExhausted blocks)
		const input2 = { tool: 'bash', sessionID: sessionId, callID: 'call-2' };
		const output2 = {
			title: 'bash',
			output: null,
			error: 'timeout again',
			metadata: {},
		};

		await hooks.toolAfter(input2 as any, output2 as any);
		expect(swarmState.pendingEvents).toBe(1); // Still 1, not 2
	});

	// -------------------------------------------------------------------------
	// Test 12: Success path resets modelFallbackExhausted
	// -------------------------------------------------------------------------
	test('toolAfter with success after transient error → modelFallbackExhausted reset to false', async () => {
		const sessionId = 'session-reset-exhausted';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		// Simulate a transient failure first
		session.model_fallback_index = 1;
		session.modelFallbackExhausted = true;

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: 'success',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.modelFallbackExhausted).toBe(false);
		expect(session.model_fallback_index).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Test 13: output.error is null → no advisory (null doesn't match regex)
	// -------------------------------------------------------------------------
	test('toolAfter with output.error = null → no advisory', async () => {
		const sessionId = 'session-null-error';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: null,
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		// output.output is null, so hasError is true, but errorContent will be null
		// null doesn't match the regex, so no advisory should be injected
		expect(session.model_fallback_index).toBe(0);
		expect(session.pendingAdvisoryMessages?.length).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Test 14: output.error is undefined → no advisory
	// -------------------------------------------------------------------------
	test('toolAfter with output.error = undefined → no advisory', async () => {
		const sessionId = 'session-undefined-error';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: undefined,
			error: undefined,
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		// output.output is undefined, so hasError is true, but errorContent will be undefined
		// undefined doesn't match the regex, so no advisory should be injected
		expect(session.model_fallback_index).toBe(0);
		expect(session.pendingAdvisoryMessages?.length).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Test 15: Session doesn't exist → no crash
	// -------------------------------------------------------------------------
	test('toolAfter with non-existent session → no crash', async () => {
		const input = {
			tool: 'bash',
			sessionID: 'non-existent-session',
			callID: 'call-1',
		};
		const output = {
			title: 'bash',
			output: null,
			error: 'rate limit exceeded',
			metadata: {},
		};

		// Should not throw even though session doesn't exist
		await expect(
			hooks.toolAfter(input as any, output as any),
		).resolves.toBeUndefined();

		// pendingEvents should still be 0 (no session to track)
		expect(swarmState.pendingEvents).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Test 16: Successive successful calls after fallback don't double-reset
	// -------------------------------------------------------------------------
	test('toolAfter with multiple successes after fallback → model_fallback_index stays at 0', async () => {
		const sessionId = 'session-multi-success';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		// Simulate transient failure
		session.model_fallback_index = 2;
		session.modelFallbackExhausted = true;

		// First success
		const input1 = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output1 = { title: 'bash', output: 'success 1', metadata: {} };
		await hooks.toolAfter(input1 as any, output1 as any);
		expect(session.model_fallback_index).toBe(0);
		expect(session.modelFallbackExhausted).toBe(false);

		// Second success (should stay at 0, not go negative)
		const input2 = { tool: 'bash', sessionID: sessionId, callID: 'call-2' };
		const output2 = { title: 'bash', output: 'success 2', metadata: {} };
		await hooks.toolAfter(input2 as any, output2 as any);
		expect(session.model_fallback_index).toBe(0);
		expect(session.modelFallbackExhausted).toBe(false);

		// Third success
		const input3 = { tool: 'bash', sessionID: sessionId, callID: 'call-3' };
		const output3 = { title: 'bash', output: 'success 3', metadata: {} };
		await hooks.toolAfter(input3 as any, output3 as any);
		expect(session.model_fallback_index).toBe(0);
		expect(session.modelFallbackExhausted).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Test 17: "temporarily unavailable" triggers fallback advisory
	// -------------------------------------------------------------------------
	test('toolAfter with "temporarily unavailable" error → advisory injected', async () => {
		const sessionId = 'session-temp-unavailable';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'Service temporarily unavailable',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Test 18: "server error" triggers fallback advisory
	// -------------------------------------------------------------------------
	test('toolAfter with "server error" error → advisory injected', async () => {
		const sessionId = 'session-server-error';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'Internal server error',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Test 19: Error index increments on successive transient errors after reset
	// -------------------------------------------------------------------------
	test('toolAfter with transient error after success → index increments from 0', async () => {
		const sessionId = 'session-increment-after-reset';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		// First transient error
		const input1 = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output1 = {
			title: 'bash',
			output: null,
			error: 'rate limit',
			metadata: {},
		};
		await hooks.toolAfter(input1 as any, output1 as any);
		expect(session.model_fallback_index).toBe(1);

		// Success resets
		const input2 = { tool: 'bash', sessionID: sessionId, callID: 'call-2' };
		const output2 = { title: 'bash', output: 'success', metadata: {} };
		await hooks.toolAfter(input2 as any, output2 as any);
		expect(session.model_fallback_index).toBe(0);
		expect(session.modelFallbackExhausted).toBe(false);

		// Another transient error should increment from 0
		const input3 = { tool: 'bash', sessionID: sessionId, callID: 'call-3' };
		const output3 = {
			title: 'bash',
			output: null,
			error: 'timeout',
			metadata: {},
		};
		await hooks.toolAfter(input3 as any, output3 as any);
		expect(session.model_fallback_index).toBe(1); // Back to 1, not 2
	});

	// -------------------------------------------------------------------------
	// Test 20: output.output is empty string but not null/undefined → hasError is false
	// -------------------------------------------------------------------------
	test('toolAfter with output.output empty string → no advisory (empty string is not error)', async () => {
		const sessionId = 'session-empty-output';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: '',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		// Empty string is not null/undefined, so hasError is false
		// This means success path runs - model_fallback_index stays at 0
		expect(session.model_fallback_index).toBe(0);
		expect(session.pendingAdvisoryMessages?.length).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Test 21: Transient error with "temporarily unavailable" (different casing)
	// -------------------------------------------------------------------------
	test('toolAfter with "TEMPORARILY UNAVAILABLE" (uppercase) → advisory injected', async () => {
		const sessionId = 'session-uppercase';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'Service TEMPORARILY UNAVAILABLE',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);
	});
});

// =============================================================================
// consecutiveErrors counter behaviour for transient vs non-transient errors
// (issue #593: rate limit errors should not burn the circuit breaker budget)
// =============================================================================
describe('guardrails consecutiveErrors: transient errors skip increment', () => {
	let hooks: ReturnType<typeof createGuardrailsHooks>;

	const config: GuardrailsConfig = {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		idle_timeout_minutes: 60,
	};

	beforeEach(() => {
		resetSwarmState();
		hooks = createGuardrailsHooks(TEST_DIR, config);
	});

	afterEach(() => {
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// Transient 429 must NOT increment consecutiveErrors while fallback available
	// -------------------------------------------------------------------------
	test('transient 429 error does not increment consecutiveErrors when fallback available', async () => {
		const sessionId = 'session-cb-transient';
		ensureAgentSession(sessionId, 'coder');
		swarmState.activeAgent.set(sessionId, 'coder');
		await hooks.toolBefore(
			{ tool: 'Task', sessionID: sessionId, callID: 'call-init' } as any,
			{ args: { subagent_type: 'coder', prompt: 'fix' } } as any,
		);

		const session = swarmState.agentSessions.get(sessionId)!;
		// modelFallbackExhausted starts false — fallback is still available
		expect(session.modelFallbackExhausted).toBe(false);

		await hooks.toolAfter(
			{ tool: 'bash', sessionID: sessionId, callID: 'call-1' } as any,
			{
				title: 'bash',
				output: null,
				error: '429 Too Many Requests',
				metadata: {},
			} as any,
		);

		const window = Object.values(session.windows)[0];
		expect(window).toBeDefined();
		// consecutiveErrors must NOT have been incremented — 429 is a transient error
		expect(window!.consecutiveErrors).toBe(0);
		// fallback tracking must have advanced
		expect(session.model_fallback_index).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Non-transient errors must still increment consecutiveErrors
	// -------------------------------------------------------------------------
	test('non-transient error increments consecutiveErrors normally', async () => {
		const sessionId = 'session-cb-nontransient';
		ensureAgentSession(sessionId, 'coder');
		swarmState.activeAgent.set(sessionId, 'coder');
		await hooks.toolBefore(
			{ tool: 'Task', sessionID: sessionId, callID: 'call-init' } as any,
			{ args: { subagent_type: 'coder', prompt: 'fix' } } as any,
		);

		const session = swarmState.agentSessions.get(sessionId)!;

		await hooks.toolAfter(
			{ tool: 'bash', sessionID: sessionId, callID: 'call-1' } as any,
			{
				title: 'bash',
				output: null,
				error: 'syntax error on line 42',
				metadata: {},
			} as any,
		);

		const window = Object.values(session.windows)[0];
		expect(window).toBeDefined();
		// Non-transient error must increment consecutiveErrors
		expect(window!.consecutiveErrors).toBe(1);
		expect(session.model_fallback_index).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Transient retry budget is independent of modelFallbackExhausted.
	// -------------------------------------------------------------------------
	test('transient error does not increment consecutiveErrors when modelFallbackExhausted is true but retry budget remains', async () => {
		const sessionId = 'session-cb-exhausted';
		ensureAgentSession(sessionId, 'coder');
		swarmState.activeAgent.set(sessionId, 'coder');
		await hooks.toolBefore(
			{ tool: 'Task', sessionID: sessionId, callID: 'call-init' } as any,
			{ args: { subagent_type: 'coder', prompt: 'fix' } } as any,
		);

		const session = swarmState.agentSessions.get(sessionId)!;
		// Simulate all fallback models already exhausted
		session.modelFallbackExhausted = true;
		session.model_fallback_index = 2;

		await hooks.toolAfter(
			{ tool: 'bash', sessionID: sessionId, callID: 'call-1' } as any,
			{
				title: 'bash',
				output: null,
				error: 'rate limit exceeded',
				metadata: {},
			} as any,
		);

		const window = Object.values(session.windows)[0];
		expect(window).toBeDefined();
		// Transient retries are independent of fallback exhaustion.
		expect(window!.consecutiveErrors).toBe(0);
		expect(window!.transientRetryCount).toBe(1);
		// model_fallback_index must not advance further
		expect(session.model_fallback_index).toBe(2);
	});

	// -------------------------------------------------------------------------
	// Five consecutive transient 429s must NOT trip the circuit breaker
	// -------------------------------------------------------------------------
	test('five consecutive 429 errors do not trip circuit breaker while fallback available', async () => {
		const sessionId = 'session-cb-five-429';
		ensureAgentSession(sessionId, 'coder');
		swarmState.activeAgent.set(sessionId, 'coder');
		await hooks.toolBefore(
			{ tool: 'Task', sessionID: sessionId, callID: 'call-init' } as any,
			{ args: { subagent_type: 'coder', prompt: 'fix' } } as any,
		);

		const session = swarmState.agentSessions.get(sessionId)!;
		// Keep modelFallbackExhausted false for all attempts
		session.modelFallbackExhausted = false;

		for (let i = 1; i <= 5; i++) {
			// Reset exhausted flag each iteration to simulate repeated rate limits
			// before fallback kicks in (edge case: fallback config absent, exhausted immediately)
			session.modelFallbackExhausted = false;
			session.model_fallback_index = 0;

			await hooks.toolAfter(
				{ tool: 'bash', sessionID: sessionId, callID: `call-${i}` } as any,
				{
					title: 'bash',
					output: null,
					error: '429 rate limit',
					metadata: {},
				} as any,
			);
		}

		const window = Object.values(session.windows)[0];
		expect(window).toBeDefined();
		// Circuit breaker must NOT have fired — consecutiveErrors stays 0
		expect(window!.consecutiveErrors).toBe(0);
		expect(window!.hardLimitHit).toBe(false);
	});
});
