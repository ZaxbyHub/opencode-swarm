import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	getPrimaryText,
	getSystemWarningText,
	makeConfig,
	makeMessages,
} from './_delegation-gate-helpers';

// ============================================
// Task 3.2 — state machine secondary signal for priorTaskStuckAtCoder
// ============================================
describe('Task 3.2 — priorTaskStuckAtCoder state machine secondary signal', () => {
	beforeEach(() => {
		// Reset all swarm state before each test
		resetSwarmState();
	});

	afterEach(() => {
		// Clean up after each test
		resetSwarmState();
	});

	it('State machine stuck detection — warn path: priorCoderTaskId stuck at coder_delegated triggers warning even with hasReviewer && hasTestEngineer from chain', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-3-2-1';

		// Setup: First coder delegation for task 2.1
		const session = ensureAgentSession(sessionID);
		session.lastCoderDelegationTaskId = '2.1';

		// Manually set the prior task state to 'coder_delegated' (stuck)
		// This simulates task 2.1 never having reviewer/test_engineer run on it
		session.taskWorkflowStates.set('2.1', 'coder_delegated');

		// Setup delegation chain that has reviewer AND test_engineer between coders
		// This would normally pass the chain-based check, BUT the state machine says prior task is stuck
		swarmState.delegationChains.set(sessionID, [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 }, // First coder (2.1)
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			{ from: 'mega_reviewer', to: 'architect', timestamp: 4 },
			{ from: 'architect', to: 'mega_test_engineer', timestamp: 5 },
			{ from: 'mega_test_engineer', to: 'architect', timestamp: 6 },
			{ from: 'architect', to: 'mega_coder', timestamp: 7 }, // Second coder (2.2)
		]);

		// Send second coder delegation for task 2.2
		const messages = makeMessages(
			'mega_coder\nTASK: 2.2\nFILE: src/feature.ts\nINPUT: implement feature',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// Should warn because prior task 2.1 is stuck at coder_delegated
		// Even though chain has reviewer AND test_engineer, state machine check catches the stuck prior task
		expect(getSystemWarningText(messages)).toContain('⚠️ PROTOCOL VIOLATION');

		// qaSkipCount should be incremented
		expect(session.qaSkipCount).toBe(1);
		expect(session.qaSkipTaskIds).toContain('2.2');
	});

	it('State machine stuck detection — block path: priorCoderTaskId stuck at coder_delegated with qaSkipCount >= 1 throws hard block', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-3-2-2';

		// Setup: Prior task 2.1 is stuck at coder_delegated
		const session = ensureAgentSession(sessionID);
		session.lastCoderDelegationTaskId = '2.1';
		session.taskWorkflowStates.set('2.1', 'coder_delegated');

		// Also set qaSkipCount to 1 (already had one warning)
		session.qaSkipCount = 1;
		session.qaSkipTaskIds = ['2.1'];

		// Setup delegation chain (has reviewer AND test_engineer, but prior task is stuck)
		swarmState.delegationChains.set(sessionID, [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			{ from: 'mega_reviewer', to: 'architect', timestamp: 4 },
			{ from: 'architect', to: 'mega_test_engineer', timestamp: 5 },
			{ from: 'mega_test_engineer', to: 'architect', timestamp: 6 },
			{ from: 'architect', to: 'mega_coder', timestamp: 7 },
		]);

		// Send third coder delegation - should throw
		const messages = makeMessages(
			'mega_coder\nTASK: 2.2\nFILE: src/feature.ts\nINPUT: implement feature',
			'architect',
			sessionID,
		);

		// Should throw with QA GATE ENFORCEMENT
		await expect(hook.messagesTransform({}, messages)).rejects.toThrow(
			'QA GATE ENFORCEMENT',
		);
	});

	it('State machine clear — no false positive: priorCoderTaskId advanced past coder_delegated does NOT trigger escalation', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-3-2-3';

		// Setup: First task 2.1 has ADVANCED past coder_delegated (e.g., to reviewer_run)
		const session = ensureAgentSession(sessionID);
		session.lastCoderDelegationTaskId = '2.1';
		session.taskWorkflowStates.set('2.1', 'reviewer_run'); // Advanced past coder_delegated

		// Setup delegation chain WITHOUT reviewer AND test_engineer between coders
		// This would normally trigger the chain-based check
		swarmState.delegationChains.set(sessionID, [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_coder', timestamp: 3 }, // No QA between
		]);

		// Send second coder delegation for task 2.2
		const messages = makeMessages(
			'mega_coder\nTASK: 2.2\nFILE: src/feature.ts\nINPUT: implement feature',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// Should warn because chain-based check catches it (no reviewer/test_engineer)
		// But state machine check should NOT trigger because prior task is NOT stuck
		expect(getSystemWarningText(messages)).toContain('⚠️ PROTOCOL VIOLATION');
	});

	it('No prior coder task — no false positive: priorCoderTaskId === null does NOT trigger state machine check', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-3-2-4';

		// Setup: No prior coder delegation (first coder ever)
		const session = ensureAgentSession(sessionID);
		session.lastCoderDelegationTaskId = null; // No prior task

		// Setup delegation chain WITHOUT reviewer AND test_engineer between coders
		swarmState.delegationChains.set(sessionID, [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_coder', timestamp: 3 }, // No QA between
		]);

		// Send second coder delegation (but this is actually the first one since prior is null)
		const messages = makeMessages(
			'mega_coder\nTASK: 2.1\nFILE: src/feature.ts\nINPUT: implement feature',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// Should NOT warn about prior task being stuck (no prior task)
		// The chain-based check would still trigger for coder → coder without QA
		// But the state machine check should NOT be the cause
		expect(getSystemWarningText(messages)).toContain('⚠️ PROTOCOL VIOLATION');
	});

	it('priorCoderTaskId captured correctly: first coder sets lastCoderDelegationTaskId, second coder captures the first task ID', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-3-2-5';

		// First coder delegation
		const messages1 = makeMessages(
			'mega_coder\nTASK: 2.1\nFILE: src/feature.ts',
			'architect',
			sessionID,
		);
		await hook.messagesTransform({}, messages1);

		// After first delegation, lastCoderDelegationTaskId should be 2.1
		let session = ensureAgentSession(sessionID);
		expect(session.lastCoderDelegationTaskId).toBe('2.1');

		// Second coder delegation for a different task
		const messages2 = makeMessages(
			'mega_coder\nTASK: 2.2\nFILE: src/feature2.ts',
			'architect',
			sessionID,
		);

		// Before processing, manually set prior task state to stuck
		// This simulates: task 2.1 got coder delegation but never got reviewer/test_engineer
		session.taskWorkflowStates.set('2.1', 'coder_delegated');

		// Setup chain with no QA between coders
		swarmState.delegationChains.set(sessionID, [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_coder', timestamp: 3 },
		]);

		await hook.messagesTransform({}, messages2);

		// Should warn because:
		// 1. Chain check: coder → coder without reviewer/test_engineer
		// 2. State machine check: prior task (2.1) is stuck at coder_delegated
		expect(getSystemWarningText(messages2)).toContain('⚠️ PROTOCOL VIOLATION');

		// After second delegation, lastCoderDelegationTaskId should be 2.2
		session = ensureAgentSession(sessionID);
		expect(session.lastCoderDelegationTaskId).toBe('2.2');

		// qaSkipCount should be incremented
		expect(session.qaSkipCount).toBe(1);
		expect(session.qaSkipTaskIds).toContain('2.2');
	});

	it('state machine stuck detection works with task advanced to tests_run (clear, not stuck)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-3-2-6';

		// Setup: First task 2.1 has advanced to tests_run (complete QA cycle)
		const session = ensureAgentSession(sessionID);
		session.lastCoderDelegationTaskId = '2.1';
		session.taskWorkflowStates.set('2.1', 'tests_run'); // Fully completed

		// No delegation chain needed - we're testing the state machine check alone
		// Set up chain with reviewer AND test_engineer between coders
		swarmState.delegationChains.set(sessionID, [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			{ from: 'mega_reviewer', to: 'architect', timestamp: 4 },
			{ from: 'architect', to: 'mega_test_engineer', timestamp: 5 },
			{ from: 'mega_test_engineer', to: 'architect', timestamp: 6 },
			{ from: 'architect', to: 'mega_coder', timestamp: 7 },
		]);

		const messages = makeMessages(
			'mega_coder\nTASK: 2.2\nFILE: src/feature.ts\nINPUT: implement feature',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// Should NOT warn - prior task completed full QA cycle (tests_run)
		// Both chain check AND state machine check should pass
		expect(getPrimaryText(messages)).not.toContain('⚠️ PROTOCOL VIOLATION');
	});

	it('state machine stuck detection works with task at pre_check_passed (not stuck)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-3-2-7';

		// Setup: First task 2.1 is at pre_check_passed (moved past coder_delegated but not full cycle)
		const session = ensureAgentSession(sessionID);
		session.lastCoderDelegationTaskId = '2.1';
		session.taskWorkflowStates.set('2.1', 'pre_check_passed');

		// Chain with no QA between coders
		swarmState.delegationChains.set(sessionID, [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_coder', timestamp: 3 },
		]);

		const messages = makeMessages(
			'mega_coder\nTASK: 2.2\nFILE: src/feature.ts\nINPUT: implement feature',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// Should warn due to chain check (no reviewer/test_engineer between coders)
		// But NOT due to state machine check (prior task is at pre_check_passed, not coder_delegated)
		expect(getSystemWarningText(messages)).toContain('⚠️ PROTOCOL VIOLATION');
	});

	it('state machine stuck detection works with task at idle (never delegated before)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-3-2-8';

		// Setup: prior task 2.1 is at idle (default state, never delegated)
		const session = ensureAgentSession(sessionID);
		session.lastCoderDelegationTaskId = '2.1';
		// taskWorkflowStates.get('2.1') would return undefined, so getTaskState returns 'idle'

		// Chain with reviewer AND test_engineer between coders
		swarmState.delegationChains.set(sessionID, [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			{ from: 'mega_reviewer', to: 'architect', timestamp: 4 },
			{ from: 'architect', to: 'mega_test_engineer', timestamp: 5 },
			{ from: 'mega_test_engineer', to: 'architect', timestamp: 6 },
			{ from: 'architect', to: 'mega_coder', timestamp: 7 },
		]);

		const messages = makeMessages(
			'mega_coder\nTASK: 2.2\nFILE: src/feature.ts\nINPUT: implement feature',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// Should NOT warn - prior task was never stuck (idle != coder_delegated)
		// and chain has reviewer AND test_engineer
		expect(getPrimaryText(messages)).not.toContain('⚠️ PROTOCOL VIOLATION');
	});
});
