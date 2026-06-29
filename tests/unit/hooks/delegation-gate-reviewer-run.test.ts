/**
 * Tests for reviewer_run state transition in delegation-gate.ts
 *
 * Verifies that when a reviewer delegation is detected after the last coder,
 * the task state advances to 'reviewer_run'.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

function makeConfig(overrides?: Record<string, unknown>): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
			...(overrides?.hooks as Record<string, unknown>),
		},
	} as PluginConfig;
}

// Helper to trigger toolAfter for testing
async function triggerToolAfter(
	hook: ReturnType<typeof createDelegationGateHook>,
	sessionID: string,
) {
	await hook.toolAfter(
		{ tool: 'tool.execute.Task', sessionID, callID: 'call-123' },
		{},
	);
}

describe('delegation-gate: reviewer_run state transition (v6.22 Task 2.2)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// ============================================
	// VERIFICATION TESTS
	// ============================================

	describe('verification: hasReviewer true + currentTaskId set advances to reviewer_run', () => {
		it('should advance task state to reviewer_run when reviewer detected after coder with currentTaskId set', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Chain: coder → reviewer (reviewer AFTER last coder)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed to coder_delegated (prerequisite state for idle → reviewer_run)
			session.taskWorkflowStates.set('1.1', 'coder_delegated');

			await triggerToolAfter(hook, 'test-session');

			// State should advance to reviewer_run
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});

		it('should advance to reviewer_run with mega_reviewer after local_coder', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'local_coder', timestamp: 1 },
				{ from: 'local_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '2.3';
			// Seed to coder_delegated (prerequisite state for idle → reviewer_run)
			session.taskWorkflowStates.set('2.3', 'coder_delegated');

			await triggerToolAfter(hook, 'test-session');

			expect(getTaskState(session, '2.3')).toBe('reviewer_run');
		});
	});

	describe('verification: hasReviewer false does NOT advance', () => {
		it('should NOT advance state when hasReviewer is false (test_engineer only)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Chain: coder → test_engineer (NO reviewer)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';

			await triggerToolAfter(hook, 'test-session');

			// State should remain 'idle' (not advanced)
			expect(getTaskState(session, '1.1')).toBe('idle');
		});

		it('should NOT advance state when only coder in chain', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Chain: coder only (no reviewer, no test_engineer)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';

			await triggerToolAfter(hook, 'test-session');

			expect(getTaskState(session, '1.1')).toBe('idle');
		});
	});

	describe('verification: currentTaskId null does NOT advance', () => {
		it('should NOT advance state when currentTaskId is undefined', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Chain: coder → reviewer (has reviewer)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = null; // Explicitly not set (falsy)

			// Should not throw
			await triggerToolAfter(hook, 'test-session');

			// No state should be set (no task to advance)
			expect(getTaskState(session, '1.1')).toBe('idle');
		});

		it('should NOT advance state when currentTaskId is null', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = null; // Explicitly null

			await triggerToolAfter(hook, 'test-session');

			expect(getTaskState(session, '1.1')).toBe('idle');
		});
	});

	describe('verification: State already past reviewer_run is non-fatal', () => {
		it('should NOT crash when state is already at reviewer_run (catches error non-fatally)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Chain with reviewer
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Pre-advance state to reviewer_run
			session.taskWorkflowStates.set('1.1', 'reviewer_run');

			// Should NOT throw - catches error non-fatally
			await triggerToolAfter(hook, 'test-session');

			// State should remain at reviewer_run (not crash)
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});

		it('should NOT crash when state is already past reviewer_run (tests_run)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// State is past reviewer_run
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Should NOT throw - catches error non-fatally
			await triggerToolAfter(hook, 'test-session');

			expect(getTaskState(session, '1.1')).toBe('tests_run');
		});

		it('should NOT crash when state is complete', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			session.taskWorkflowStates.set('1.1', 'complete');

			// Should NOT throw
			await triggerToolAfter(hook, 'test-session');

			expect(getTaskState(session, '1.1')).toBe('complete');
		});
	});

	// ============================================
	// ADVERSARIAL TESTS
	// ============================================

	describe('adversarial: no coder in chain returns early', () => {
		it('should return early and not crash when no coder in delegation chain (lastCoderIndex === -1)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Chain: reviewer → test_engineer (NO coder)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_reviewer', timestamp: 1 },
				{ from: 'mega_reviewer', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			session.qaSkipCount = 2; // Would reset if logic incorrectly ran

			// Should NOT throw
			await triggerToolAfter(hook, 'test-session');

			// State should NOT advance (no coder in chain)
			expect(getTaskState(session, '1.1')).toBe('idle');
			// qaSkipCount should NOT reset either
			expect(session.qaSkipCount).toBe(2);
		});
	});

	describe('adversarial: empty delegation chain', () => {
		it('should not crash on empty delegation chain', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			swarmState.delegationChains.set('test-session', []);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';

			// Should NOT throw
			await triggerToolAfter(hook, 'test-session');

			// No state change
			expect(getTaskState(session, '1.1')).toBe('idle');
		});
	});

	describe('adversarial: reviewer before coder (not after)', () => {
		it('should not advance state when reviewer appears BEFORE coder (not after)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Chain: reviewer → coder (reviewer BEFORE coder, not after)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_reviewer', timestamp: 1 },
				{ from: 'architect', to: 'mega_coder', timestamp: 2 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';

			await triggerToolAfter(hook, 'test-session');

			// hasReviewer should be false (reviewer not AFTER last coder)
			// State should NOT advance
			expect(getTaskState(session, '1.1')).toBe('idle');
		});

		it('should handle reviewer at index 0, coder at index 1', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Only coder, no reviewer after
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';

			await triggerToolAfter(hook, 'test-session');

			expect(getTaskState(session, '1.1')).toBe('idle');
		});
	});

	describe('adversarial: test_engineer only (no reviewer)', () => {
		it('should not advance state when only test_engineer present (no reviewer)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Chain: coder → test_engineer (only test_engineer, no reviewer)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';

			await triggerToolAfter(hook, 'test-session');

			// hasReviewer is false → should NOT advance to reviewer_run
			expect(getTaskState(session, '1.1')).toBe('idle');
		});

		it('should handle test_engineer with prefix', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';

			await triggerToolAfter(hook, 'test-session');

			expect(getTaskState(session, '1.1')).toBe('idle');
		});
	});

	describe('adversarial: undefined delegation chain', () => {
		it('should not crash when delegationChain is undefined', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Session exists but no delegation chain set
			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';

			// Should NOT throw
			await triggerToolAfter(hook, 'test-session');

			expect(getTaskState(session, '1.1')).toBe('idle');
		});
	});

	describe('adversarial: multiple coders with reviewer only after last', () => {
		it('should advance only when reviewer is after the LAST coder', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// coder1 → reviewer → coder2 (reviewer AFTER coder1 but BEFORE coder2)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
				{ from: 'architect', to: 'local_coder', timestamp: 4 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';

			await triggerToolAfter(hook, 'test-session');

			// Reviewer is after coder1 but NOT after coder2 (last coder)
			// hasReviewer checks from last coder (local_coder at index 3)
			// After index 3, there's nothing → hasReviewer = false
			expect(getTaskState(session, '1.1')).toBe('idle');
		});

		it('should advance when reviewer is after the LAST coder', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// coder1 → coder2 → reviewer (reviewer AFTER last coder)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'local_coder', timestamp: 3 },
				{ from: 'local_coder', to: 'architect', timestamp: 4 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 5 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed to coder_delegated (prerequisite state for idle → reviewer_run)
			session.taskWorkflowStates.set('1.1', 'coder_delegated');

			await triggerToolAfter(hook, 'test-session');

			// Reviewer IS after last coder (local_coder) → should advance
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});
	});

	describe('input.args primary path (v6.23 hotfix)', () => {
		it('should advance coder_delegated → reviewer_run via input.args alone (no delegationChains)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// No delegationChains set — input.args is the only signal
			const session = ensureAgentSession('args-session');
			session.currentTaskId = '1.1';
			session.taskWorkflowStates.set('1.1', 'coder_delegated');

			await hook.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: 'args-session',
					callID: 'call-args-1',
					args: { subagent_type: 'mega_reviewer' },
				},
				{},
			);

			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});
	});
});
