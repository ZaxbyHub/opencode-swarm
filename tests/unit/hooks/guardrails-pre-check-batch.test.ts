import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	_internals,
	createGuardrailsHooks,
} from '../../../src/hooks/guardrails';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

function makeInput(
	sessionID = 'test-session',
	tool = 'read',
	callID = 'call-1',
) {
	return { tool, sessionID, callID };
}

function makeOutput(args: unknown = { filePath: '/test.ts' }) {
	return { args };
}

function makeAfterOutput(output: string = 'success') {
	return { title: 'Result', output, metadata: {} };
}

const passingPreCheckResult =
	'{"batch_status":"completed","gates_passed":true,"lint":{"ran":true,"duration_ms":1},"secretscan":{"ran":true,"duration_ms":1},"sast_scan":{"ran":true,"duration_ms":1},"quality_budget":{"ran":true,"duration_ms":1},"total_duration_ms":4}';

describe('guardrails - pre_check_batch state transition (v6.22 Task 2.1)', () => {
	beforeEach(() => {
		resetSwarmState();
		_internals.allowUncorrelatedGateReceipts = true;
	});
	afterEach(() => {
		_internals.allowUncorrelatedGateReceipts = false;
	});

	describe('toolAfter - pre_check_batch advances state to pre_check_passed', () => {
		it('pre_check_batch with gates_passed: true advances state to pre_check_passed', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			expect(session).toBeDefined();

			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			const outputJson = passingPreCheckResult;
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('pre_check_passed');
		});

		it('pre_check_batch with gates_passed: false does NOT advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			expect(session).toBeDefined();

			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			const outputJson = JSON.stringify({ gates_passed: false });
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('pre_check_batch with malformed JSON does NOT advance state (isPassed=false)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			expect(session).toBeDefined();

			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			// Simulate pre_check_batch with malformed JSON
			const malformedJson = '{ not valid json';
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(malformedJson),
			);

			// Verify state did NOT advance - should still be coder_delegated
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('pre_check_batch success but currentTaskId is null does NOT advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			// Set up session with coder_delegated state but NO currentTaskId
			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			expect(session).toBeDefined();

			// Set initial state but leave currentTaskId undefined/null
			session!.currentTaskId = null;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			// Simulate pre_check_batch with gates_passed: true but no currentTaskId
			const outputJson = passingPreCheckResult;
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			// Verify state did NOT advance - should still be coder_delegated
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('pre_check_batch but tool is different name does NOT advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			// Set up session with coder_delegated state
			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			expect(session).toBeDefined();

			// Set currentTaskId and initial state to coder_delegated
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			// Simulate a different gate tool (e.g., lint) with gates_passed: true
			// This should NOT trigger state advance since it's not pre_check_batch
			const outputJson = passingPreCheckResult;
			await hooks.toolAfter(
				makeInput(sessionId, 'lint', 'call-1'),
				makeAfterOutput(outputJson),
			);

			// Verify state did NOT advance - should still be coder_delegated
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('pre_check_batch with non-string output does NOT crash and does NOT advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			// Set up session with coder_delegated state
			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			expect(session).toBeDefined();

			// Set currentTaskId and initial state to coder_delegated
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			// Simulate pre_check_batch with non-string output (e.g., null)
			// Should not crash and should not advance state
			await hooks.toolAfter(makeInput(sessionId, 'pre_check_batch', 'call-1'), {
				title: 'Result',
				output: null as unknown as string,
				metadata: {},
			});

			// Verify state did NOT advance - should still be coder_delegated
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('pre_check_batch advances state when task already has initial idle state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			// Set up session with idle state (default)
			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			expect(session).toBeDefined();

			// Set currentTaskId - task starts at 'idle' by default
			session!.currentTaskId = taskId;
			// Don't set taskWorkflowStates - defaults to 'idle'

			// Simulate pre_check_batch tool success with gates_passed: true
			const outputJson = passingPreCheckResult;
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			// Verify state advanced to pre_check_passed (from idle)
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('pre_check_passed');
		});

		it('pre_check_batch does NOT advance state when already at pre_check_passed', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			// Set up session already at pre_check_passed
			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			expect(session).toBeDefined();

			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'pre_check_passed');

			// Simulate pre_check_batch tool success again
			const outputJson = JSON.stringify({ gates_passed: true });

			// Should not throw (caught internally) but should not change state further
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			// State should remain pre_check_passed (no regression)
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('pre_check_passed');
		});
	});

	// ============================================================
	// ADVERSARIAL SECURITY TESTS - Attack Vectors for pre_check_batch
	// ============================================================
	describe('ADVERSARIAL: pre_check_batch bypass attempts', () => {
		beforeEach(() => {
			resetSwarmState();
		});

		// Attack Vector 1: JSON with __proto__ pollution attempting to set gates_passed
		it('BLOCKED: __proto__ pollution cannot bypass gates_passed check', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			// Attempt to pollute via __proto__
			const maliciousJson = JSON.stringify({
				__proto__: { gates_passed: true },
			});
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(maliciousJson),
			);

			// State should NOT advance - __proto__ pollution doesn't work with JSON.parse
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		// Attack Vector 2: JSON with constructor pollution
		it('BLOCKED: constructor pollution cannot bypass gates_passed check', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			// Attempt to pollute via constructor
			const maliciousJson = JSON.stringify({
				constructor: { gates_passed: true },
			});
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(maliciousJson),
			);

			// State should NOT advance
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		// Attack Vector 3: gates_passed as truthy non-boolean values
		it('BLOCKED: gates_passed as number (1) does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			const outputJson = JSON.stringify({ gates_passed: 1 });
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			// 1 === true is false - strict equality prevents bypass
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('BLOCKED: gates_passed as string "true" does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			const outputJson = JSON.stringify({ gates_passed: 'true' });
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			// "true" === true is false - strict equality prevents bypass
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('BLOCKED: gates_passed as null does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			const outputJson = JSON.stringify({ gates_passed: null });
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			// null === true is false
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('BLOCKED: gates_passed as undefined does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			const outputJson = JSON.stringify({ gates_passed: undefined });
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			// undefined === true is false
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('BLOCKED: gates_passed as empty array [] does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			const outputJson = JSON.stringify({ gates_passed: [] });
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			// [] === true is false
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('BLOCKED: gates_passed as empty object {} does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			const outputJson = JSON.stringify({ gates_passed: {} });
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			// {} === true is false
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		// Attack Vector 4: Oversized JSON string (10000+ chars)
		it('BLOCKED: oversized JSON string does not crash or advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			// Create oversized but still parseable JSON (no gates_passed)
			const largePadding = 'x'.repeat(10000);
			const outputJson = JSON.stringify({
				padding: largePadding,
				gates_passed: true,
			});

			// Should handle gracefully (but won't advance because we check gates_passed === true)
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			// Oversized control output is invalid and cannot advance.
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		// Attack Vector 5: JSON array instead of object
		it('BLOCKED: JSON array instead of object does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			const outputJson = JSON.stringify([{ gates_passed: true }]);
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			// Array doesn't have gates_passed property - undefined === true is false
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		// Attack Vector 6: JSON with gates_passed: true but also malicious keys
		it('BLOCKED: nested gates_passed in malicious key does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			// gates_passed is NOT at top level - should not trigger
			const maliciousJson = JSON.stringify({
				data: { gates_passed: true },
				__proto__: { bypass: true },
			});
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(maliciousJson),
			);

			// State should NOT advance - top-level gates_passed is undefined
			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		// Attack Vector 7: Tool name case variants
		it('BLOCKED: Pre_Check_Batch (wrong case) does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			const outputJson = JSON.stringify({ gates_passed: true });
			// Case variant - should NOT match
			await hooks.toolAfter(
				makeInput(sessionId, 'Pre_Check_Batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('BLOCKED: PRE_CHECK_BATCH (uppercase) does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			const outputJson = JSON.stringify({ gates_passed: true });
			// Uppercase variant - should NOT match
			await hooks.toolAfter(
				makeInput(sessionId, 'PRE_CHECK_BATCH', 'call-1'),
				makeAfterOutput(outputJson),
			);

			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		// Attack Vector 8: Empty string output
		it('BLOCKED: empty string output does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			// Empty string - JSON.parse throws
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(''),
			);

			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		// Attack Vector 9: Whitespace-only output
		it('BLOCKED: whitespace-only output does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			// Whitespace only - JSON.parse throws
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput('   \n\t  '),
			);

			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		// Additional edge cases
		it('BLOCKED: output as non-string (number) does not crash or advance', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			// Non-string output
			await hooks.toolAfter(makeInput(sessionId, 'pre_check_batch', 'call-1'), {
				title: 'Result',
				output: 12345 as unknown as string,
				metadata: {},
			});

			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('BLOCKED: JSON with gates_passed: false (explicit failure) does not advance', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			const outputJson = JSON.stringify({ gates_passed: false });
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});

		it('BLOCKED: missing gates_passed key does not advance state', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			const sessionId = 'test-session';
			const taskId = '1.2.3';

			startAgentSession(sessionId, 'coder');
			const session = getAgentSession(sessionId);
			session!.currentTaskId = taskId;
			session!.taskWorkflowStates.set(taskId, 'coder_delegated');

			// JSON object without gates_passed key
			const outputJson = JSON.stringify({
				status: 'success',
				message: 'all good',
			});
			await hooks.toolAfter(
				makeInput(sessionId, 'pre_check_batch', 'call-1'),
				makeAfterOutput(outputJson),
			);

			const newState = session!.taskWorkflowStates.get(taskId);
			expect(newState).toBe('coder_delegated');
		});
	});
});
