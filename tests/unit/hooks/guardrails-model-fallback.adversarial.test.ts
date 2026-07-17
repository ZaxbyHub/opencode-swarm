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

function expectNoNonTransientStop(
	session: ReturnType<typeof ensureAgentSession>,
) {
	expect(session.pendingAdvisoryMessages?.join('\n')).not.toContain(
		'NON-TRANSIENT STOP',
	);
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

describe('guardrails model fallback adversarial tests', () => {
	let hooks: ReturnType<typeof createGuardrailsHooks>;

	beforeEach(() => {
		resetSwarmState();
		hooks = createGuardrailsHooks(TEST_DIR, defaultConfig);
	});

	afterEach(() => {
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// Attack 1: Extremely long string (100K chars) containing "rate limit" at the end
	// Tests for ReDoS or catastrophic backtracking in TRANSIENT_MODEL_ERROR_PATTERN
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: output.error with 100K char string containing "rate limit" at end should not cause ReDoS', async () => {
		const sessionId = 'session-long-string';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		// Create a 100K char string with "rate limit" at the very end
		const padding = 'a'.repeat(100_000 - 10); // 100K total minus "rate limit"
		const longError = padding + 'rate limit';

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: longError,
			metadata: {},
		};

		// Should complete without hanging or taking excessive time
		const startTime = Date.now();
		await hooks.toolAfter(input as any, output as any);
		const elapsed = Date.now() - startTime;

		// Should match and trigger advisory
		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);
		// Should complete in reasonable time (< 1 second for simple regex)
		expect(elapsed).toBeLessThan(1000);
	}, 5000); // 5 second timeout for safety

	// Attack 2: ReDoS pattern with nested quantifiers (a+)+b
	// Tests catastrophic backtracking in TRANSIENT_MODEL_ERROR_PATTERN
	test('ADVERSARIAL: output.error with ReDoS pattern (a+)+b should not cause catastrophic backtracking', async () => {
		const sessionId = 'session-redos';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		// Classic ReDoS pattern: (a+)+b - causes exponential backtracking on some regex engines
		// The pattern does NOT match "rate limit" so it tests whether the regex hangs
		const redosError = 'aaaa'.repeat(100) + 'b'; // Long string that could cause backtracking with bad pattern

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: redosError,
			metadata: {},
		};

		// Should complete without hanging
		const startTime = Date.now();
		await hooks.toolAfter(input as any, output as any);
		const elapsed = Date.now() - startTime;

		expect(session.model_fallback_index).toBe(0);
		expectNoNonTransientStop(session);
		// Should complete very quickly
		expect(elapsed).toBeLessThan(500);
	}, 5000);

	// Attack 3: Type confusion - output.error is an object instead of string
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: output.error is an object (type confusion) should not crash or match', async () => {
		const sessionId = 'session-error-object';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: { message: 'rate limit exceeded', code: 429 },
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		// Should not crash; structured provider errors are normalized so
		// transient details in error.message still trigger model fallback.
		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);
	});

	// Attack 4: output.error is a number (e.g., 429)
	test('ADVERSARIAL: output.error is a number (429) should not crash or match', async () => {
		const sessionId = 'session-error-number';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 429 as any,
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		// Structured numeric 429 is normalized and handled as transient.
		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.[0]).toContain('MODEL FALLBACK');
	});

	// -------------------------------------------------------------------------
	// Attack 5: output.error is an array
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: output.error is an array should not crash or match', async () => {
		const sessionId = 'session-error-array';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: ['rate limit', 'timeout', 'server error'] as any,
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		// Array is not a string
		expect(session.model_fallback_index).toBe(0);
		expectNoNonTransientStop(session);
	});

	// -------------------------------------------------------------------------
	// Attack 6: output.error contains "server error" but also "password" - ensure no credential leak
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: error with "server error" and "password" should not leak password in advisory', async () => {
		const sessionId = 'session-credential-leak';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'server error: authentication failed, password is SuperSecret123!',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		// Should match and trigger advisory
		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);

		const advisory = session.pendingAdvisoryMessages![0];
		// Advisory should NOT contain the password or any sensitive details
		expect(advisory).not.toContain('SuperSecret123');
		expect(advisory).not.toContain('password');
		expect(advisory).not.toContain('authentication');
		// Advisory should be generic
		expect(advisory).toContain('MODEL FALLBACK');
		expect(advisory).toContain('attempt 1');
	});

	// -------------------------------------------------------------------------
	// Attack 7: model_fallback_index set to MAX_SAFE_INTEGER - increment should not overflow
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: model_fallback_index at MAX_SAFE_INTEGER should not overflow to Infinity', async () => {
		const sessionId = 'session-overflow';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		// Set to MAX_SAFE_INTEGER
		session.model_fallback_index = Number.MAX_SAFE_INTEGER;

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'rate limit exceeded',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		// Should increment to MAX_SAFE_INTEGER + 1, NOT overflow to Infinity
		expect(session.model_fallback_index).toBe(Number.MAX_SAFE_INTEGER + 1);
		expect(Number.isFinite(session.model_fallback_index)).toBe(true);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Attack 8: Rapid consecutive errors - ensure only one advisory per chain
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: rapid consecutive transient errors should only fire one advisory (modelFallbackExhausted)', async () => {
		const sessionId = 'session-rapid-consecutive';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		// First error
		const input1 = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output1 = {
			title: 'bash',
			output: null,
			error: 'rate limit',
			metadata: {},
		};
		await hooks.toolAfter(input1 as any, output1 as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);
		expect(session.modelFallbackExhausted).toBe(true);

		// Rapid second error
		const input2 = { tool: 'bash', sessionID: sessionId, callID: 'call-2' };
		const output2 = {
			title: 'bash',
			output: null,
			error: 'timeout',
			metadata: {},
		};
		await hooks.toolAfter(input2 as any, output2 as any);

		// Should NOT increment or add advisory
		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);

		// Rapid third error
		const input3 = { tool: 'bash', sessionID: sessionId, callID: 'call-3' };
		const output3 = {
			title: 'bash',
			output: null,
			error: 'overloaded',
			metadata: {},
		};
		await hooks.toolAfter(input3 as any, output3 as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);

		// Fourth error
		const input4 = { tool: 'bash', sessionID: sessionId, callID: 'call-4' };
		const output4 = { title: 'bash', output: null, error: '503', metadata: {} };
		await hooks.toolAfter(input4 as any, output4 as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Attack 9: Error → success → error cycle - verify advisory re-fires after success reset
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: error-success-error cycle should re-fire advisory after reset', async () => {
		const sessionId = 'session-error-success-error';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		// First error
		const input1 = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output1 = {
			title: 'bash',
			output: null,
			error: 'rate limit',
			metadata: {},
		};
		await hooks.toolAfter(input1 as any, output1 as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.modelFallbackExhausted).toBe(true);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);

		// Success resets the exhaustion flag
		const input2 = { tool: 'bash', sessionID: sessionId, callID: 'call-2' };
		const output2 = { title: 'bash', output: 'success!', metadata: {} };
		await hooks.toolAfter(input2 as any, output2 as any);

		expect(session.model_fallback_index).toBe(0);
		expect(session.modelFallbackExhausted).toBe(false);

		// Second error should fire a NEW advisory (advisory count increases)
		const input3 = { tool: 'bash', sessionID: sessionId, callID: 'call-3' };
		const output3 = {
			title: 'bash',
			output: null,
			error: 'timeout',
			metadata: {},
		};
		await hooks.toolAfter(input3 as any, output3 as any);

		expect(session.model_fallback_index).toBe(1);
		expect(session.modelFallbackExhausted).toBe(true);
		// Should have 2 advisories now (one from first error, one from second)
		expect(session.pendingAdvisoryMessages?.length).toBe(2);
	});

	// -------------------------------------------------------------------------
	// Attack 10: output.output is null but output.error is a string matching pattern - should fire
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: output.output is null but output.error matches pattern - should fire', async () => {
		const sessionId = 'session-null-output-with-error';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null, // null output
			error: 'rate limit exceeded', // but error field has the message
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		// Should detect hasError = true (output.output === null)
		// And errorContent from output.error should match
		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Attack 11: Unicode error messages (non-ASCII characters)
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: Unicode error messages with "rate limit" should match', async () => {
		const sessionId = 'session-unicode';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: 'rate limit exceeded ⏳ 服务器过载 🔥',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		// Regex with 'i' flag should match "rate limit" case-insensitively even with Unicode around it
		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Attack 12: Empty string error message - should NOT match
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: empty string error should not match transient pattern', async () => {
		const sessionId = 'session-empty-error';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: '',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(0);
		expectNoNonTransientStop(session);
	});

	// -------------------------------------------------------------------------
	// Attack 13: Whitespace-only error message - should NOT match
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: whitespace-only error should not match transient pattern', async () => {
		const sessionId = 'session-whitespace-error';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: '   \t\n  ',
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(0);
		expectNoNonTransientStop(session);
	});

	// -------------------------------------------------------------------------
	// Attack 14: Boolean error (true/false) - type confusion
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: output.error is boolean should not crash or match', async () => {
		const sessionId = 'session-error-boolean';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: true as any,
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(0);
		expectNoNonTransientStop(session);
	});

	// -------------------------------------------------------------------------
	// Attack 15: Very large number error - tests type coercion handling
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: output.error is Infinity should not crash', async () => {
		const sessionId = 'session-error-infinity';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: Infinity as any,
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(0);
		expectNoNonTransientStop(session);
	});

	// -------------------------------------------------------------------------
	// Attack 16: Error message that matches pattern but is extremely long (1MB)
	// Tests memory/performance bounds
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: 1MB error string with "rate limit" should complete reasonably', async () => {
		const sessionId = 'session-massive-error';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		// 1MB string with "rate limit" at the end
		const padding = 'x'.repeat(1_000_000 - 10);
		const massiveError = padding + 'rate limit';

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: massiveError,
			metadata: {},
		};

		const startTime = Date.now();
		await hooks.toolAfter(input as any, output as any);
		const elapsed = Date.now() - startTime;

		// Should complete
		expect(session.model_fallback_index).toBe(1);
		expect(session.pendingAdvisoryMessages?.length).toBe(1);
		// Should complete in reasonable time (< 5 seconds even for 1MB)
		expect(elapsed).toBeLessThan(5000);
	}, 10000);

	// -------------------------------------------------------------------------
	// Attack 17: Error contains Unicode RTL override characters attempting to bypass filter
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: error with RTL override Unicode bypass attempt should be handled safely', async () => {
		const sessionId = 'session-rtl-bypass';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		// RTL override character could theoretically be used to make "rate limit" appear differently
		// But since we use regex.test() on the raw string, it should still match the underlying text
		const rtlBypass = 'rate\u202Elimit'; // \u202E is RTL override

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: rtlBypass,
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		// The string "rate\u202Elimit" still contains "rate" and "limit" in the raw form
		// So it should match
		expect(session.model_fallback_index).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Attack 18: NaN error value - should not crash
	// -------------------------------------------------------------------------
	test('ADVERSARIAL: output.error is NaN should not crash', async () => {
		const sessionId = 'session-error-nan';
		const session = await setupSubagentSessionWithWindow(hooks, sessionId);

		const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
		const output = {
			title: 'bash',
			output: null,
			error: NaN as any,
			metadata: {},
		};

		await hooks.toolAfter(input as any, output as any);

		expect(session.model_fallback_index).toBe(0);
		expectNoNonTransientStop(session);
	});
});
