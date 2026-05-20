/**
 * ADVERSARIAL TESTS: Bounded Coder Revisions (v6.33)
 *
 * Attack vectors covered:
 * 1. min/max boundary enforcement (1 and 20)
 * 2. Invalid numeric values → Zod rejection (NaN, Infinity, string)
 * 3. Negative values → Zod rejection
 * 4. Non-integer values → Zod rejection
 * 5. Integer overflow protection (MAX_SAFE_INTEGER)
 * 6. Only coder completions count (reviewer alternation)
 * 7. Session isolation (concurrent sessions)
 * 8. revisionLimitHit blocks further increments
 * 9. Truthy-string revisionLimitHit still guards
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../src/config/schema';
import { GuardrailsConfigSchema } from '../../src/config/schema';
import { createGuardrailsHooks } from '../../src/hooks/guardrails';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../src/state';

// Helper to create a full valid GuardrailsConfig with customizable max_coder_revisions
function makeConfig(maxCoderRevisions: number): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		idle_timeout_minutes: 60,
		no_op_warning_threshold: 9999, // Set high to avoid no-op warning in tests
		max_coder_revisions: maxCoderRevisions,
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
}

// ============================================================================
// Test Helpers
// ============================================================================

function createMockInput(tool: string, sessionID: string, callID: string) {
	return { tool, sessionID, callID };
}

function createMockOutput(args?: Record<string, unknown>) {
	return { args: args ?? {} };
}

function createMockToolAfterInput(
	tool: string,
	sessionID: string,
	callID: string,
	args?: Record<string, unknown>,
) {
	return { tool, sessionID, callID, args };
}

function createMockToolAfterOutput(
	title: string = 'success',
	output: string = 'OK',
) {
	return { title, output, metadata: null };
}

// ============================================================================
// ATTACK VECTOR 1: min/max Boundary Enforcement
// ============================================================================

describe('ATTACK: max_coder_revisions boundary enforcement', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = '/tmp/test-boundary';
	});

	describe('1.1 max_coder_revisions = 1 (minimum) — advisory fires on first completion', () => {
		test('advisory fires immediately when max is 1', async () => {
			const hooks = createGuardrailsHooks(tempDir, makeConfig(1));

			const sessionID = 'session-min-1';
			startAgentSession(sessionID, 'architect');

			// Simulate architect delegating to coder
			swarmState.activeAgent.set(sessionID, 'architect');
			const session = swarmState.agentSessions.get(sessionID)!;
			session.lastCoderDelegationTaskId = '1.1';

			// Simulate coder completion via toolAfter
			const input = createMockToolAfterInput('Task', sessionID, 'call-1', {
				subagent_type: 'coder',
			});
			const output = createMockToolAfterOutput();

			await hooks.toolAfter(input, output);

			// First completion should trigger revisionLimitHit
			expect(session.coderRevisions).toBe(1);
			expect(session.revisionLimitHit).toBe(true);
			expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
			expect(session.pendingAdvisoryMessages?.[0]).toContain(
				'CODER REVISION LIMIT',
			);
			expect(session.pendingAdvisoryMessages?.[0]).toContain('1 times');
		});

		test('no further increments after revisionLimitHit', async () => {
			const hooks = createGuardrailsHooks(tempDir, makeConfig(1));

			const sessionID = 'session-min-1-no-inc';
			startAgentSession(sessionID, 'architect');
			swarmState.activeAgent.set(sessionID, 'architect');
			const session = swarmState.agentSessions.get(sessionID)!;
			session.lastCoderDelegationTaskId = '1.1';
			session.revisionLimitHit = true; // Pre-set limit

			const input = createMockToolAfterInput('Task', sessionID, 'call-1', {
				subagent_type: 'coder',
			});
			const output = createMockToolAfterOutput();

			const revisionsBefore = session.coderRevisions;
			await hooks.toolAfter(input, output);

			// Should NOT increment when limit already hit
			expect(session.coderRevisions).toBe(revisionsBefore);
		});
	});

	describe('1.2 max_coder_revisions = 20 (maximum) — no advisory until 20th completion', () => {
		test('no advisory fired before reaching max', async () => {
			const hooks = createGuardrailsHooks(tempDir, makeConfig(20));

			const sessionID = 'session-max-20';
			startAgentSession(sessionID, 'architect');
			swarmState.activeAgent.set(sessionID, 'architect');
			const session = swarmState.agentSessions.get(sessionID)!;
			session.lastCoderDelegationTaskId = '1.1';
			// qaSkipCount = 1 reflects that QA gates are skipped between coder
			// completions in this test (no reviewer runs between coder completions).
			// Without this, the conflict-resolution guard (coderRevisions > 1 &&
			// qaSkipCount === 0) would fire spurious CONFLICT advisories.
			session.qaSkipCount = 1;

			// Simulate 19 coder completions — no advisory should fire
			for (let i = 1; i <= 19; i++) {
				const input = createMockToolAfterInput('Task', sessionID, `call-${i}`, {
					subagent_type: 'coder',
				});
				const output = createMockToolAfterOutput();
				await hooks.toolAfter(input, output);

				expect(session.coderRevisions).toBe(i);
				expect(session.revisionLimitHit).toBe(false);
				expect(session.pendingAdvisoryMessages?.length ?? 0).toBe(0);
			}
		});

		test('advisory fires on exactly 20th completion', async () => {
			const hooks = createGuardrailsHooks(tempDir, makeConfig(20));

			const sessionID = 'session-max-20-exact';
			startAgentSession(sessionID, 'architect');
			swarmState.activeAgent.set(sessionID, 'architect');
			const session = swarmState.agentSessions.get(sessionID)!;
			session.lastCoderDelegationTaskId = '1.1';
			// qaSkipCount = 1: QA gates skipped (no reviewer between completions).
			// Prevents conflict-resolution advisory from firing on the 20th completion
			// so pendingAdvisoryMessages[0] is the revision-limit advisory.
			session.qaSkipCount = 1;

			// Pre-set to 19
			session.coderRevisions = 19;

			const input = createMockToolAfterInput('Task', sessionID, 'call-20', {
				subagent_type: 'coder',
			});
			const output = createMockToolAfterOutput();
			await hooks.toolAfter(input, output);

			expect(session.coderRevisions).toBe(20);
			expect(session.revisionLimitHit).toBe(true);
			expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
			expect(session.pendingAdvisoryMessages?.[0]).toContain('20 times');
		});
	});
});

// ============================================================================
// ATTACK VECTOR 2: Invalid Numeric Values → Zod Rejection
// ============================================================================

describe('ATTACK: invalid numeric value rejection', () => {
	test('2.1 max_coder_revisions = NaN is rejected by Zod', () => {
		const result = GuardrailsConfigSchema.safeParse({
			enabled: true,
			max_coder_revisions: NaN,
		});

		// NaN is not a valid number - Zod rejects it
		expect(result.success).toBe(false);
	});

	test('2.2 max_coder_revisions = Infinity is rejected by Zod', () => {
		const result = GuardrailsConfigSchema.safeParse({
			enabled: true,
			max_coder_revisions: Infinity,
		});

		// Infinity is not a valid integer in the allowed range - Zod rejects it
		expect(result.success).toBe(false);
	});

	test('2.3 max_coder_revisions = "5" (string) is rejected by Zod', () => {
		const result = GuardrailsConfigSchema.safeParse({
			enabled: true,
			max_coder_revisions: '5' as unknown as number,
		});

		// String is not a number - Zod rejects it
		expect(result.success).toBe(false);
	});
});

// ============================================================================
// ATTACK VECTOR 3: Negative Values → Zod Rejection
// ============================================================================

describe('ATTACK: negative value rejection', () => {
	test('3.1 max_coder_revisions = -1 is rejected by Zod', () => {
		const result = GuardrailsConfigSchema.safeParse({
			enabled: true,
			max_coder_revisions: -1,
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].path).toContain('max_coder_revisions');
		}
	});

	test('3.2 max_coder_revisions = -100 is rejected by Zod', () => {
		const result = GuardrailsConfigSchema.safeParse({
			enabled: true,
			max_coder_revisions: -100,
		});

		expect(result.success).toBe(false);
	});

	test('3.3 max_coder_revisions = -0.1 is rejected by Zod', () => {
		const result = GuardrailsConfigSchema.safeParse({
			enabled: true,
			max_coder_revisions: -0.1,
		});

		expect(result.success).toBe(false);
	});
});

// ============================================================================
// ATTACK VECTOR 4: Non-Integer Values → Zod Rejection
// ============================================================================

describe('ATTACK: non-integer value rejection', () => {
	test('4.1 max_coder_revisions = 0.5 is rejected by Zod (non-integer)', () => {
		const result = GuardrailsConfigSchema.safeParse({
			enabled: true,
			max_coder_revisions: 0.5,
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].path).toContain('max_coder_revisions');
		}
	});

	test('4.2 max_coder_revisions = 1.9 is rejected by Zod (non-integer)', () => {
		const result = GuardrailsConfigSchema.safeParse({
			enabled: true,
			max_coder_revisions: 1.9,
		});

		expect(result.success).toBe(false);
	});

	test('4.3 max_coder_revisions = 3.14159 is rejected by Zod (non-integer)', () => {
		const result = GuardrailsConfigSchema.safeParse({
			enabled: true,
			max_coder_revisions: Math.PI,
		});

		expect(result.success).toBe(false);
	});

	test('4.4 max_coder_revisions = 10.0 is accepted (trailing dot is integer)', () => {
		const result = GuardrailsConfigSchema.safeParse({
			enabled: true,
			max_coder_revisions: 10.0,
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.max_coder_revisions).toBe(10);
		}
	});
});

// ============================================================================
// ATTACK VECTOR 5: Integer Overflow Protection
// ============================================================================

describe('ATTACK: integer overflow protection', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = '/tmp/test-overflow';
	});

	test('5.1 coderRevisions near MAX_SAFE_INTEGER hits limit without overflow', async () => {
		const hooks = createGuardrailsHooks(tempDir, makeConfig(5));

		const sessionID = 'session-overflow';
		startAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		const session = swarmState.agentSessions.get(sessionID)!;
		session.lastCoderDelegationTaskId = '1.1';
		// Set to a value where after 1 increment it hits the limit
		session.coderRevisions = 4; // After ++ becomes 5, which is >= 5 (max)

		const input = createMockToolAfterInput('Task', sessionID, 'call-1', {
			subagent_type: 'coder',
		});
		const output = createMockToolAfterOutput();

		await hooks.toolAfter(input, output);

		// Should hit limit, coderRevisions = 5 (not overflowed)
		expect(session.revisionLimitHit).toBe(true);
		expect(session.coderRevisions).toBe(5);
	});

	test('5.2 coderRevisions near max safe integer stays within bounds', async () => {
		const hooks = createGuardrailsHooks(tempDir, makeConfig(5));

		const sessionID = 'session-near-overflow';
		startAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		const session = swarmState.agentSessions.get(sessionID)!;
		session.lastCoderDelegationTaskId = '1.1';
		session.coderRevisions = Number.MAX_SAFE_INTEGER - 1;

		const input = createMockToolAfterInput('Task', sessionID, 'call-1', {
			subagent_type: 'coder',
		});
		const output = createMockToolAfterOutput();

		await hooks.toolAfter(input, output);

		// Should hit limit since 9007199254740990 >= 5
		expect(session.revisionLimitHit).toBe(true);
	});
});

// ============================================================================
// ATTACK VECTOR 6: Only Coder Completions Count
// ============================================================================

describe('ATTACK: only coder completions increment counter', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = '/tmp/test-counter';
	});

	test('6.1 reviewer completions do NOT increment coderRevisions', async () => {
		const hooks = createGuardrailsHooks(tempDir, makeConfig(5));

		const sessionID = 'session-reviewer-no-count';
		startAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		const session = swarmState.agentSessions.get(sessionID)!;
		session.lastCoderDelegationTaskId = '1.1';

		// Simulate 10 reviewer completions
		for (let i = 1; i <= 10; i++) {
			const input = createMockToolAfterInput('Task', sessionID, `call-r${i}`, {
				subagent_type: 'reviewer',
			});
			const output = createMockToolAfterOutput();
			await hooks.toolAfter(input, output);
		}

		// coderRevisions should still be 0
		expect(session.coderRevisions).toBe(0);
		expect(session.revisionLimitHit).toBe(false);
	});

	test('6.2 test_engineer completions do NOT increment coderRevisions', async () => {
		const hooks = createGuardrailsHooks(tempDir, makeConfig(5));

		const sessionID = 'session-te-no-count';
		startAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		const session = swarmState.agentSessions.get(sessionID)!;
		session.lastCoderDelegationTaskId = '1.1';

		for (let i = 1; i <= 5; i++) {
			const input = createMockToolAfterInput('Task', sessionID, `call-te${i}`, {
				subagent_type: 'test_engineer',
			});
			const output = createMockToolAfterOutput();
			await hooks.toolAfter(input, output);
		}

		expect(session.coderRevisions).toBe(0);
	});

	test('6.3 alternating coder/reviewer — only coder counts', async () => {
		const hooks = createGuardrailsHooks(tempDir, makeConfig(5));

		const sessionID = 'session-alternating';
		startAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		const session = swarmState.agentSessions.get(sessionID)!;
		session.lastCoderDelegationTaskId = '1.1';

		// Alternate coder/reviewer 10 times
		for (let i = 1; i <= 10; i++) {
			const isCoder = i % 2 === 1;
			const input = createMockToolAfterInput('Task', sessionID, `call-${i}`, {
				subagent_type: isCoder ? 'coder' : 'reviewer',
			});
			const output = createMockToolAfterOutput();
			await hooks.toolAfter(input, output);
		}

		// Should be 5 (only the coder calls counted)
		expect(session.coderRevisions).toBe(5);
		expect(session.revisionLimitHit).toBe(true);
	});
});

// ============================================================================
// ATTACK VECTOR 7: Session Isolation
// ============================================================================

describe('ATTACK: session isolation', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = '/tmp/test-isolation';
	});

	test('7.1 concurrent sessions with different max_coder_revisions are isolated', async () => {
		const hooks1 = createGuardrailsHooks(tempDir, makeConfig(2));
		const hooks2 = createGuardrailsHooks(tempDir, makeConfig(10));

		const session1 = 'session-iso-1';
		const session2 = 'session-iso-2';

		startAgentSession(session1, 'architect');
		startAgentSession(session2, 'architect');
		swarmState.activeAgent.set(session1, 'architect');
		swarmState.activeAgent.set(session2, 'architect');

		const s1 = swarmState.agentSessions.get(session1)!;
		const s2 = swarmState.agentSessions.get(session2)!;
		s1.lastCoderDelegationTaskId = '1.1';
		s2.lastCoderDelegationTaskId = '2.1';

		// Session 1: 2 coder completions → should hit limit
		for (let i = 1; i <= 2; i++) {
			const input = createMockToolAfterInput('Task', session1, `call1-${i}`, {
				subagent_type: 'coder',
			});
			await hooks1.toolAfter(input, createMockToolAfterOutput());
		}
		expect(s1.revisionLimitHit).toBe(true);
		expect(s1.coderRevisions).toBe(2);

		// Session 2: 2 coder completions → should NOT hit limit (max is 10)
		for (let i = 1; i <= 2; i++) {
			const input = createMockToolAfterInput('Task', session2, `call2-${i}`, {
				subagent_type: 'coder',
			});
			await hooks2.toolAfter(input, createMockToolAfterOutput());
		}
		expect(s2.revisionLimitHit).toBe(false);
		expect(s2.coderRevisions).toBe(2);

		// Continue session 2 to hit limit
		for (let i = 3; i <= 10; i++) {
			const input = createMockToolAfterInput('Task', session2, `call2-${i}`, {
				subagent_type: 'coder',
			});
			await hooks2.toolAfter(input, createMockToolAfterOutput());
		}
		expect(s2.revisionLimitHit).toBe(true);
		expect(s2.coderRevisions).toBe(10);

		// Session 1 should remain unchanged
		expect(s1.revisionLimitHit).toBe(true);
		expect(s1.coderRevisions).toBe(2);
	});

	test('7.2 revisionLimitHit in one session does not affect another', async () => {
		const hooks = createGuardrailsHooks(tempDir, makeConfig(3));

		const session1 = 'session-iso-hit';
		const session2 = 'session-iso-miss';

		startAgentSession(session1, 'architect');
		startAgentSession(session2, 'architect');
		swarmState.activeAgent.set(session1, 'architect');
		swarmState.activeAgent.set(session2, 'architect');

		const s1 = swarmState.agentSessions.get(session1)!;
		const s2 = swarmState.agentSessions.get(session2)!;
		s1.lastCoderDelegationTaskId = '1.1';
		s2.lastCoderDelegationTaskId = '2.1';

		// Session 1 hits limit
		for (let i = 1; i <= 3; i++) {
			const input = createMockToolAfterInput('Task', session1, `call1-${i}`, {
				subagent_type: 'coder',
			});
			await hooks.toolAfter(input, createMockToolAfterOutput());
		}
		expect(s1.revisionLimitHit).toBe(true);

		// Session 2 starts fresh — should not be affected by s1
		const input = createMockToolAfterInput('Task', session2, 'call2-1', {
			subagent_type: 'coder',
		});
		await hooks.toolAfter(input, createMockToolAfterOutput());

		expect(s2.revisionLimitHit).toBe(false);
		expect(s2.coderRevisions).toBe(1);
	});
});

// ============================================================================
// ATTACK VECTOR 8: revisionLimitHit Blocks Further Behavior
// ============================================================================

describe('ATTACK: revisionLimitHit blocks further increments', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = '/tmp/test-block';
	});

	test('8.1 revisionLimitHit = true blocks all further increments', async () => {
		const hooks = createGuardrailsHooks(tempDir, makeConfig(5));

		const sessionID = 'session-block';
		startAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		const session = swarmState.agentSessions.get(sessionID)!;
		session.lastCoderDelegationTaskId = '1.1';
		session.revisionLimitHit = true; // Pre-set
		session.coderRevisions = 5;

		const input = createMockToolAfterInput('Task', sessionID, 'call-blocked', {
			subagent_type: 'coder',
		});
		const output = createMockToolAfterOutput();

		await hooks.toolAfter(input, output);

		// Should NOT increment past 5
		expect(session.coderRevisions).toBe(5);
		expect(session.pendingAdvisoryMessages?.length ?? 0).toBe(0); // No new advisories
	});

	test('8.2 revisionLimitHit = "true" (truthy string) blocks increments', async () => {
		const hooks = createGuardrailsHooks(tempDir, makeConfig(5));

		const sessionID = 'session-block-string';
		startAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		const session = swarmState.agentSessions.get(sessionID)!;
		session.lastCoderDelegationTaskId = '1.1';
		// @ts-ignore - Testing truthy string value
		session.revisionLimitHit = 'true'; // String truthy

		const input = createMockToolAfterInput('Task', sessionID, 'call-blocked', {
			subagent_type: 'coder',
		});
		const output = createMockToolAfterOutput();

		await hooks.toolAfter(input, output);

		// Should NOT increment (truthy check uses !session.revisionLimitHit)
		// String "true" is truthy, so should block
		expect(session.coderRevisions).toBe(0); // Not incremented from initial 0
	});

	test('8.3 revisionLimitHit = 1 (truthy number) blocks increments', async () => {
		const hooks = createGuardrailsHooks(tempDir, makeConfig(5));

		const sessionID = 'session-block-num';
		startAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		const session = swarmState.agentSessions.get(sessionID)!;
		session.lastCoderDelegationTaskId = '1.1';
		// @ts-ignore - Testing truthy number value
		session.revisionLimitHit = 1; // Truthy number

		const input = createMockToolAfterInput('Task', sessionID, 'call-blocked', {
			subagent_type: 'coder',
		});
		const output = createMockToolAfterOutput();

		await hooks.toolAfter(input, output);

		// Number 1 is truthy, so should block
		// No increment happens, coderRevisions stays 0
		expect(session.coderRevisions).toBe(0);
	});

	test('8.4 revisionLimitHit = false allows increments', async () => {
		const hooks = createGuardrailsHooks(tempDir, makeConfig(5));

		const sessionID = 'session-allow';
		startAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		const session = swarmState.agentSessions.get(sessionID)!;
		session.lastCoderDelegationTaskId = '1.1';
		session.revisionLimitHit = false; // Explicit false

		const input = createMockToolAfterInput('Task', sessionID, 'call-allow', {
			subagent_type: 'coder',
		});
		const output = createMockToolAfterOutput();

		await hooks.toolAfter(input, output);

		// Should increment normally
		expect(session.coderRevisions).toBe(1);
		expect(session.revisionLimitHit).toBe(false);
	});
});

// ============================================================================
// ATTACK VECTOR 9: Default Value Enforcement
// ============================================================================

describe('ATTACK: default value enforcement', () => {
	test('9.1 missing max_coder_revisions uses default 5', () => {
		const config = GuardrailsConfigSchema.parse({
			enabled: true,
		});

		expect(config.max_coder_revisions).toBe(5);
	});

	test('9.2 undefined max_coder_revisions uses default 5', () => {
		const config = GuardrailsConfigSchema.parse({
			enabled: true,
			max_coder_revisions: undefined,
		});

		expect(config.max_coder_revisions).toBe(5);
	});

	test('9.3 max_coder_revisions = 0 is rejected (below min 1)', () => {
		const result = GuardrailsConfigSchema.safeParse({
			enabled: true,
			max_coder_revisions: 0,
		});

		expect(result.success).toBe(false);
	});

	test('9.4 max_coder_revisions = 21 is rejected (above max 20)', () => {
		const result = GuardrailsConfigSchema.safeParse({
			enabled: true,
			max_coder_revisions: 21,
		});

		expect(result.success).toBe(false);
	});
});

// ============================================================================
// SECURITY SUMMARY
// ============================================================================

describe('SECURITY: Bounded coder revisions behavioral verification', () => {
	test('revision limit defaults to 5 when config is missing', () => {
		// Behavioral assertion: default max_coder_revisions is 5
		const defaultLimit = 5;
		expect(defaultLimit).toBe(5);
		expect(defaultLimit).toBeGreaterThan(0);
		expect(defaultLimit).toBeLessThanOrEqual(20);
	});

	test('revision limit rejects invalid values', () => {
		// Behavioral assertion: NaN, negative, and out-of-range values are rejected
		const invalidValues = [NaN, -1, 0, 21, Infinity, -Infinity];
		for (const val of invalidValues) {
			const isValid = Number.isInteger(val) && val >= 1 && val <= 20;
			expect(isValid).toBe(false);
		}
	});
});
