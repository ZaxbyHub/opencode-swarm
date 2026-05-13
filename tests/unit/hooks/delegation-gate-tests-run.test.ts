/**
 * Tests for tests_run state transition in delegation-gate.ts (v6.22 Task 2.3)
 *
 * Verifies that when BOTH hasReviewer AND hasTestEngineer are true (after last coder)
 * AND session.currentTaskId is set, advanceTaskState advances state to 'tests_run'.
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

describe('delegation-gate: tests_run state transition (v6.22 Task 2.3)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// ============================================
	// VERIFICATION TESTS
	// ============================================

	describe('verification: hasReviewer + hasTestEngineer + currentTaskId advances to tests_run', () => {
		it('should advance task state to tests_run when both reviewer and test_engineer after coder with currentTaskId set', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: coder → reviewer → test_engineer (BOTH after last coder)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed state to pre_check_passed (prerequisite for reviewer_run → tests_run)
			session.taskWorkflowStates.set('1.1', 'pre_check_passed');

			// Trigger toolAfter
			await triggerToolAfter(hook, 'test-session');

			// State should advance to tests_run (pre_check_passed → reviewer_run → tests_run)
			expect(getTaskState(session, '1.1')).toBe('tests_run');
		});

		it('should advance to tests_run with test_engineer AFTER reviewer (correct order)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: coder → reviewer → test_engineer
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '2.3';
			// Seed state to reviewer_run (prerequisite for reviewer_run → tests_run)
			session.taskWorkflowStates.set('2.3', 'reviewer_run');

			await triggerToolAfter(hook, 'test-session');

			expect(getTaskState(session, '2.3')).toBe('tests_run');
		});

		it('should advance to tests_run with test_engineer BEFORE reviewer (either order works)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: coder → test_engineer → reviewer (test_engineer first)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 3 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 4 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '3.1';
			// Seed state to reviewer_run (prerequisite for reviewer_run → tests_run)
			session.taskWorkflowStates.set('3.1', 'reviewer_run');

			await triggerToolAfter(hook, 'test-session');

			// Should still advance - both are present after coder
			expect(getTaskState(session, '3.1')).toBe('tests_run');
		});
	});

	describe('verification: hasReviewer only (no test_engineer) does NOT advance to tests_run', () => {
		it('should NOT advance state to tests_run when hasReviewer is true but hasTestEngineer is false', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: coder → reviewer (NO test_engineer)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed state to reviewer_run (which should NOT advance further without test_engineer)
			session.taskWorkflowStates.set('1.1', 'reviewer_run');

			await triggerToolAfter(hook, 'test-session');

			// Should only stay at reviewer_run (can't advance to tests_run without test_engineer)
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});
	});

	describe('verification: hasTestEngineer only (no reviewer) does NOT advance', () => {
		it('should NOT advance state when only test_engineer present (no reviewer)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: coder → test_engineer (NO reviewer)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 3 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed state to pre_check_passed (needs reviewer first to advance to reviewer_run)
			session.taskWorkflowStates.set('1.1', 'pre_check_passed');

			await triggerToolAfter(hook, 'test-session');

			// State should remain at pre_check_passed (no reviewer in chain)
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
		});
	});

	describe('verification: Neither hasReviewer nor hasTestEngineer → no advance', () => {
		it('should NOT advance state when only coder in chain', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: coder only (no reviewer, no test_engineer)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed state to pre_check_passed
			session.taskWorkflowStates.set('1.1', 'pre_check_passed');

			await triggerToolAfter(hook, 'test-session');

			// State should remain at pre_check_passed (no reviewer in chain)
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
		});
	});

	describe('verification: currentTaskId null does NOT advance', () => {
		it('should NOT advance state when currentTaskId is undefined', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: coder → reviewer → test_engineer (has both)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = null; // Not set (falsy)

			// Should not throw - no task to advance
			await triggerToolAfter(hook, 'test-session');

			// No state should be set (no task to advance)
			expect(getTaskState(session, '1.1')).toBe('idle');
		});

		it('should NOT advance state when currentTaskId is null', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = null; // Explicitly null

			await triggerToolAfter(hook, 'test-session');

			expect(getTaskState(session, '1.1')).toBe('idle');
		});
	});

	describe('verification: State already past tests_run is non-fatal', () => {
		it('should NOT crash when state is already at tests_run', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain with both reviewer and test_engineer
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Pre-advance state to tests_run
			session.taskWorkflowStates.set('1.1', 'tests_run');

			// Should NOT throw - catches error non-fatally
			await triggerToolAfter(hook, 'test-session');

			// State should remain at tests_run (not crash)
			expect(getTaskState(session, '1.1')).toBe('tests_run');
		});

		it('should NOT crash when state is already complete', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
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

	describe('adversarial: reviewer before coder + test_engineer after coder → hasReviewer still false', () => {
		it('should NOT advance when reviewer appears BEFORE coder (not after)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: reviewer → coder → test_engineer (reviewer BEFORE coder)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_reviewer', timestamp: 1 },
				{ from: 'architect', to: 'mega_coder', timestamp: 2 },
				{ from: 'mega_coder', to: 'architect', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed to pre_check_passed - should NOT advance because reviewer is before coder
			session.taskWorkflowStates.set('1.1', 'pre_check_passed');

			await triggerToolAfter(hook, 'test-session');

			// hasReviewer is false (reviewer not AFTER last coder)
			// hasTestEngineer is true but hasReviewer is false → should NOT advance
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
		});

		it('should handle test_engineer after coder but reviewer before coder', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: reviewer → coder → test_engineer (reviewer at index 0, coder at index 1)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_reviewer', timestamp: 1 },
				{ from: 'architect', to: 'mega_coder', timestamp: 2 },
				{ from: 'mega_coder', to: 'architect', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed to reviewer_run - should NOT advance to tests_run because hasReviewer is false
			session.taskWorkflowStates.set('1.1', 'reviewer_run');

			await triggerToolAfter(hook, 'test-session');

			// After last coder (index 2), only test_engineer is present
			// hasReviewer = false, hasTestEngineer = true → should NOT advance
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});
	});

	describe('adversarial: multiple coders - reviewer/test_engineer after first coder but not last', () => {
		it('should NOT advance when reviewer/test_engineer are after first coder but BEFORE last coder', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: coder1 → reviewer → test_engineer → coder2
			// Both are after coder1 but BEFORE coder2 (the LAST coder)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
				{ from: 'architect', to: 'local_coder', timestamp: 5 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed to reviewer_run - should NOT advance because last coder hasn't been seen yet
			session.taskWorkflowStates.set('1.1', 'reviewer_run');

			await triggerToolAfter(hook, 'test-session');

			// Last coder is local_coder (index 4)
			// After index 4, there's nothing → hasReviewer = false, hasTestEngineer = false
			// Should NOT advance
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});
	});

	describe('adversarial: multiple coders - reviewer/test_engineer after LAST coder', () => {
		it('should advance when both reviewer and test_engineer are after the LAST coder', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: coder1 → coder2 → reviewer → test_engineer
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'local_coder', timestamp: 3 },
				{ from: 'local_coder', to: 'architect', timestamp: 4 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 5 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 6 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed to reviewer_run (prerequisite for reviewer_run → tests_run)
			session.taskWorkflowStates.set('1.1', 'reviewer_run');

			await triggerToolAfter(hook, 'test-session');

			// Last coder is local_coder (index 3)
			// After index 3: reviewer, test_engineer → both present
			// Should advance to tests_run
			expect(getTaskState(session, '1.1')).toBe('tests_run');
		});

		it('should handle exactly 2 coders with QA after last', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: coder → reviewer → test_engineer → (no more coders)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '2.1';
			// Seed to reviewer_run (prerequisite for reviewer_run → tests_run)
			session.taskWorkflowStates.set('2.1', 'reviewer_run');

			await triggerToolAfter(hook, 'test-session');

			expect(getTaskState(session, '2.1')).toBe('tests_run');
		});
	});

	describe('adversarial: same invocation - reviewer_run THEN tests_run fires', () => {
		it('should advance to tests_run in single toolAfter call (both conditions met)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: coder → reviewer → test_engineer
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed to pre_check_passed to test full chain: pre_check_passed → reviewer_run → tests_run
			session.taskWorkflowStates.set('1.1', 'pre_check_passed');

			// Single toolAfter call
			await triggerToolAfter(hook, 'test-session');

			// Should directly advance to tests_run (pre_check_passed → reviewer_run → tests_run)
			// The logic checks hasReviewer first (advances to reviewer_run)
			// Then checks hasReviewer && hasTestEngineer (advances to tests_run)
			// Result should be tests_run (the final state)
			expect(getTaskState(session, '1.1')).toBe('tests_run');
		});

		it('should NOT cause state to oscillate or crash with both transitions in same call', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain with both after coder
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '5.5';
			// Seed to pre_check_passed
			session.taskWorkflowStates.set('5.5', 'pre_check_passed');

			// Should NOT throw - both transitions fire in same call
			await triggerToolAfter(hook, 'test-session');

			// Final state should be tests_run
			expect(getTaskState(session, '5.5')).toBe('tests_run');
		});
	});

	describe('adversarial: no coder in chain returns early', () => {
		it('should return early and not crash when no coder in delegation chain', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Chain: reviewer → test_engineer (NO coder)
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_reviewer', timestamp: 1 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 2 },
			]);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed to pre_check_passed - should NOT advance (no coder in chain)
			session.taskWorkflowStates.set('1.1', 'pre_check_passed');

			// Should NOT throw
			await triggerToolAfter(hook, 'test-session');

			// State should NOT advance (no coder in chain)
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
		});
	});

	describe('adversarial: empty/undefined chain', () => {
		it('should not crash on empty delegation chain', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			swarmState.delegationChains.set('test-session', []);

			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed to pre_check_passed
			session.taskWorkflowStates.set('1.1', 'pre_check_passed');

			// Should NOT throw
			await triggerToolAfter(hook, 'test-session');

			// No state change (early return due to empty chain)
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
		});

		it('should not crash when delegationChain is undefined', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Session exists but no delegation chain set
			const session = ensureAgentSession('test-session');
			session.currentTaskId = '1.1';
			// Seed to pre_check_passed
			session.taskWorkflowStates.set('1.1', 'pre_check_passed');

			// Should NOT throw
			await triggerToolAfter(hook, 'test-session');

			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
		});
	});

	// ============================================
	// CROSS-SESSION FALLBACK TESTS (v6.22 Task 2.4)
	// ============================================

	describe('cross-session fallback: architect session seeded, different session has delegation chain', () => {
		it('should advance task state in architect session when toolAfter runs in different session', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Architect session has the task seeded with coder_delegated state
			const architectSession = ensureAgentSession('architect-session');
			architectSession.currentTaskId = '4.1';
			architectSession.taskWorkflowStates.set('4.1', 'coder_delegated');

			// Different session (e.g., coder's session) has the delegation chain
			swarmState.delegationChains.set('coder-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			]);

			const coderSession = ensureAgentSession('coder-session');
			coderSession.currentTaskId = '4.1';
			// coder session has no task state - it should be advanced via fallback

			// Trigger toolAfter in coder's session (has the delegation chain)
			await triggerToolAfter(hook, 'coder-session');

			// Architect session's task should advance from coder_delegated → reviewer_run
			expect(getTaskState(architectSession, '4.1')).toBe('reviewer_run');
		});

		it('should advance from reviewer_run to tests_run in architect session via fallback', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Architect session has the task seeded at reviewer_run
			const architectSession = ensureAgentSession('architect-session');
			architectSession.currentTaskId = '5.1';
			architectSession.taskWorkflowStates.set('5.1', 'reviewer_run');

			// Different session has the full delegation chain (reviewer + test_engineer)
			swarmState.delegationChains.set('reviewer-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
				{ from: 'architect', to: 'mega_test_engineer', timestamp: 4 },
			]);

			const reviewerSession = ensureAgentSession('reviewer-session');
			reviewerSession.currentTaskId = '5.1';

			// Trigger toolAfter in reviewer's session
			await triggerToolAfter(hook, 'reviewer-session');

			// Architect session's task should advance from reviewer_run → tests_run
			expect(getTaskState(architectSession, '5.1')).toBe('tests_run');
		});

		it('should NOT advance states in sessions without relevant states', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Architect session has tasks at different states
			const architectSession = ensureAgentSession('architect-session');
			architectSession.currentTaskId = '6.1';
			architectSession.taskWorkflowStates.set('6.1', 'idle'); // Not a transitionable state
			architectSession.taskWorkflowStates.set('6.2', 'complete'); // Already complete

			// Session with delegation chain
			swarmState.delegationChains.set('test-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			]);

			const testSession = ensureAgentSession('test-session');
			testSession.currentTaskId = '6.1';

			// Should NOT throw
			await triggerToolAfter(hook, 'test-session');

			// States should remain unchanged
			expect(getTaskState(architectSession, '6.1')).toBe('idle');
			expect(getTaskState(architectSession, '6.2')).toBe('complete');
		});

		it('should handle multiple sessions with taskWorkflowStates correctly', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Session A has task at coder_delegated
			const sessionA = ensureAgentSession('session-a');
			sessionA.currentTaskId = '7.1';
			sessionA.taskWorkflowStates.set('7.1', 'coder_delegated');

			// Session B has task at pre_check_passed
			const sessionB = ensureAgentSession('session-b');
			sessionB.currentTaskId = '7.2';
			sessionB.taskWorkflowStates.set('7.2', 'pre_check_passed');

			// Session C has the delegation chain
			swarmState.delegationChains.set('session-c', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			]);

			const sessionC = ensureAgentSession('session-c');
			sessionC.currentTaskId = '7.1';

			// Trigger toolAfter in session C (has the delegation chain)
			await triggerToolAfter(hook, 'session-c');

			// Both session A and B should advance to reviewer_run
			expect(getTaskState(sessionA, '7.1')).toBe('reviewer_run');
			expect(getTaskState(sessionB, '7.2')).toBe('reviewer_run');
		});

		it('should not advance current session twice (already handled in Pass 1)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Session has both the delegation chain and the task state
			swarmState.delegationChains.set('same-session', [
				{ from: 'architect', to: 'mega_coder', timestamp: 1 },
				{ from: 'mega_coder', to: 'architect', timestamp: 2 },
				{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			]);

			const session = ensureAgentSession('same-session');
			session.currentTaskId = '8.1';
			session.taskWorkflowStates.set('8.1', 'coder_delegated');

			// Trigger toolAfter in the same session
			await triggerToolAfter(hook, 'same-session');

			// State should advance once (not crash or double-advance)
			expect(getTaskState(session, '8.1')).toBe('reviewer_run');
		});
	});

	describe('input.args primary path (v6.23 hotfix)', () => {
		it('should advance reviewer_run → tests_run via input.args alone (no delegationChains)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// No delegationChains set — input.args is the only signal
			const session = ensureAgentSession('args-te-session');
			session.currentTaskId = '1.1';
			session.taskWorkflowStates.set('1.1', 'reviewer_run');

			await hook.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: 'args-te-session',
					callID: 'call-args-te-1',
					args: { subagent_type: 'mega_test_engineer' },
				},
				{},
			);

			expect(getTaskState(session, '1.1')).toBe('tests_run');
		});
	});
});
