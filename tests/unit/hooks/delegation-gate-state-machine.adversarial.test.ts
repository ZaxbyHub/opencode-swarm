/**
 * Adversarial tests for delegation-gate state machine wiring
 *
 * Tests the advanceTaskState wiring in delegation-gate.ts
 * Focus on attack vectors: malformed inputs, injection attempts, bypass attempts, boundary violations
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	advanceTaskState,
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

function makeMessages(
	text: string,
	agent?: string,
	sessionID = 'test-session',
) {
	return {
		messages: [
			{
				info: { role: 'user' as const, agent, sessionID },
				parts: [{ type: 'text', text }],
			},
		],
	};
}

describe('delegation-gate state machine adversarial tests', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	describe('ATTACK VECTOR 1: Special characters in taskId', () => {
		it('should handle path traversal attempt in taskId (task/../../../etc)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-path-traversal';

			// Create session first
			ensureAgentSession(sessionID);

			// Crafted delegation with path traversal in taskId
			const text = `coder

TASK: task/../../../etc
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// Verify state machine handled it gracefully - should be stored as string key
			const state = getTaskState(
				ensureAgentSession(sessionID),
				'task/../../../etc',
			);
			expect(state).toBe('coder_delegated');
		});

		it('should handle SQL injection attempt in taskId', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-sql-injection';

			// Create session first
			ensureAgentSession(sessionID);

			// SQL injection attempt
			const text = `coder

TASK: '; DROP TABLE tasks; --
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// Verify state machine handled it - stored as literal string key
			const state = getTaskState(
				ensureAgentSession(sessionID),
				"'; DROP TABLE tasks; --",
			);
			expect(state).toBe('coder_delegated');
		});

		it('should handle XSS attempt in taskId', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-xss';

			ensureAgentSession(sessionID);

			const text = `coder

TASK: <script>alert('xss')</script>
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			const state = getTaskState(
				ensureAgentSession(sessionID),
				"<script>alert('xss')</script>",
			);
			expect(state).toBe('coder_delegated');
		});

		it('should handle null byte injection in taskId', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-null-byte';

			ensureAgentSession(sessionID);

			// Null byte injection attempt
			const text = `coder

TASK: task\x00injected
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// State machine should handle it - Map uses string keys
			const state = getTaskState(
				ensureAgentSession(sessionID),
				'task\x00injected',
			);
			expect(state).toBe('coder_delegated');
		});
	});

	describe('ATTACK VECTOR 2: Extremely long taskId (10,000 chars)', () => {
		it('should not crash with 10000 character taskId', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-long-taskid';

			ensureAgentSession(sessionID);

			// Generate 10000 character taskId
			const longTaskId = 'a'.repeat(10000);

			const text = `coder

TASK: ${longTaskId}
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// Should not throw
			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// Verify state was set
			const state = getTaskState(ensureAgentSession(sessionID), longTaskId);
			expect(state).toBe('coder_delegated');
		});

		it('should handle taskId at maximum reasonable length (100k chars)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-max-taskid';

			ensureAgentSession(sessionID);

			// Generate 100k character taskId
			const hugeTaskId = 'x'.repeat(100000);

			const text = `coder

TASK: ${hugeTaskId}
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// Should not crash (may be slow but should complete)
			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			const state = getTaskState(ensureAgentSession(sessionID), hugeTaskId);
			expect(state).toBe('coder_delegated');
		});
	});

	describe('ATTACK VECTOR 3: Attempt to advance to complete via fake coder delegation', () => {
		it('should NOT allow direct advancement to complete from coder_delegated', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-fake-complete';

			ensureAgentSession(sessionID);

			// First, advance to coder_delegated
			advanceTaskState(ensureAgentSession(sessionID), '1.1', 'coder_delegated');

			// Now try to craft a message that claims to complete the task
			// The delegation gate only advances to 'coder_delegated', not 'complete'
			const text = `coder

TASK: 1.1
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// State should still be 'coder_delegated' - NOT 'complete'
			// The coder delegation pattern only triggers advanceTaskState(session, taskId, 'coder_delegated')
			const state = getTaskState(ensureAgentSession(sessionID), '1.1');
			expect(state).toBe('coder_delegated');
			expect(state).not.toBe('complete');
		});

		it('should enforce forward-only state progression', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-forward-only';

			const session = ensureAgentSession(sessionID);

			// Valid progression: idle -> coder_delegated
			advanceTaskState(session, '2.1', 'coder_delegated');

			// Try to jump to complete directly - should fail
			expect(() => {
				advanceTaskState(session, '2.1', 'complete');
			}).toThrow();

			// Verify state is still coder_delegated
			const state = getTaskState(session, '2.1');
			expect(state).toBe('coder_delegated');
		});

		it('should require sequential progression through all states to reach complete', async () => {
			const session = ensureAgentSession('session-sequential');

			// Valid full progression
			advanceTaskState(session, '3.1', 'coder_delegated');
			expect(getTaskState(session, '3.1')).toBe('coder_delegated');

			advanceTaskState(session, '3.1', 'pre_check_passed');
			expect(getTaskState(session, '3.1')).toBe('pre_check_passed');

			advanceTaskState(session, '3.1', 'reviewer_run');
			expect(getTaskState(session, '3.1')).toBe('reviewer_run');

			advanceTaskState(session, '3.1', 'tests_run');
			expect(getTaskState(session, '3.1')).toBe('tests_run');

			// Only now can we reach 'complete'
			advanceTaskState(session, '3.1', 'complete');
			expect(getTaskState(session, '3.1')).toBe('complete');
		});
	});

	describe('ATTACK VECTOR 4: Rapid coder delegations (1000 rapid calls)', () => {
		it('should handle 1000 rapid coder delegations without crash', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-rapid';

			ensureAgentSession(sessionID);

			const text = `coder

TASK: rapid-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			const messages = makeMessages(text, undefined, sessionID);

			// First delegation should succeed
			await hook.messagesTransform({}, messages);

			let state = getTaskState(ensureAgentSession(sessionID), 'rapid-task');
			expect(state).toBe('coder_delegated');

			// Subsequent delegations should catch INVALID_TASK_STATE_TRANSITION and swallow
			// Run 999 more times (total 1000)
			for (let i = 0; i < 999; i++) {
				await hook.messagesTransform({}, messages);
			}

			// State should remain coder_delegated, no crash
			state = getTaskState(ensureAgentSession(sessionID), 'rapid-task');
			expect(state).toBe('coder_delegated');
		});

		it('should handle concurrent rapid delegations for different tasks', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-concurrent';

			ensureAgentSession(sessionID);

			// Rapid delegations for different taskIds
			for (let i = 0; i < 100; i++) {
				const taskId = `task-${i}`;
				const text = `coder

TASK: ${taskId}
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

				await hook.messagesTransform(
					{},
					makeMessages(text, undefined, sessionID),
				);
			}

			// All tasks should be in coder_delegated state
			for (let i = 0; i < 100; i++) {
				const state = getTaskState(ensureAgentSession(sessionID), `task-${i}`);
				expect(state).toBe('coder_delegated');
			}
		});
	});

	describe('ATTACK VECTOR 5: Ambiguous taskId extraction (multiple TASK: lines)', () => {
		it('should handle multiple TASK: lines - only first one used', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-multi-task';

			ensureAgentSession(sessionID);

			// Message with multiple TASK: lines - ambiguity attack
			const text = `coder

TASK: 1.2
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes

Some other text here

TASK: 1.3
TARGETAGENT: coder
ACTION: review
COMMANDTYPE: task
FILES: src/other.ts
ACCEPTANCECRITERA: review passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// Based on the code, it uses text.match(/TASK:\s*(.+?)(?:\n|$)/i) which is greedy but non-greedy
			// The regex captures the first TASK: line content
			// So task 1.2 should be the one advanced

			// Note: The actual implementation extracts taskId from the FIRST match only
			const state1 = getTaskState(ensureAgentSession(sessionID), '1.2');
			expect(state1).toBe('coder_delegated');

			// Task 1.3 should NOT be advanced (only first TASK: is used)
			const state2 = getTaskState(ensureAgentSession(sessionID), '1.3');
			expect(state2).toBe('idle');
		});

		it('should handle TASK: with colons inside the value', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-colon-task';

			ensureAgentSession(sessionID);

			// TASK: with multiple colons - should extract full value after TASK:
			const text = `coder

TASK: http://example.com:8080/path
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// Should extract the full URL including colons
			const state = getTaskState(
				ensureAgentSession(sessionID),
				'http://example.com:8080/path',
			);
			expect(state).toBe('coder_delegated');
		});
	});

	describe('ATTACK VECTOR 6: Out-of-order delegation (reviewer before coder)', () => {
		it('should throw when advancing from reviewer_run to coder_delegated (out of order)', () => {
			const session = ensureAgentSession('session-out-of-order');

			// First advance to reviewer_run (simulating prior work)
			advanceTaskState(session, 'out-of-order-task', 'reviewer_run');
			expect(getTaskState(session, 'out-of-order-task')).toBe('reviewer_run');

			// Try to go back to coder_delegated - should throw
			expect(() => {
				advanceTaskState(session, 'out-of-order-task', 'coder_delegated');
			}).toThrow();
		});

		it('should remain at higher state when coder delegation attempted after reviewer', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-after-reviewer';

			const session = ensureAgentSession(sessionID);

			// Simulate: task already advanced to reviewer_run through some other mechanism
			advanceTaskState(session, 'post-review-task', 'reviewer_run');

			// Now try coder delegation again
			const text = `coder

TASK: post-review-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// The delegation-gate tries to advance to coder_delegated but should fail
			// Error is caught and swallowed in the hook
			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// State should remain at reviewer_run (or higher)
			const state = getTaskState(session, 'post-review-task');
			expect(state).toBe('reviewer_run');
			// Should NOT be coder_delegated
			expect(state).not.toBe('coder_delegated');
		});

		it('should handle tests_run to complete correctly', () => {
			const session = ensureAgentSession('session-tests-complete');

			// Progress to tests_run
			advanceTaskState(session, 'complete-task', 'coder_delegated');
			advanceTaskState(session, 'complete-task', 'pre_check_passed');
			advanceTaskState(session, 'complete-task', 'reviewer_run');
			advanceTaskState(session, 'complete-task', 'tests_run');

			// Now can advance to complete
			advanceTaskState(session, 'complete-task', 'complete');
			expect(getTaskState(session, 'complete-task')).toBe('complete');
		});

		it('should reject complete from any state except tests_run', () => {
			const session = ensureAgentSession('session-invalid-complete');

			// From idle
			expect(() => advanceTaskState(session, 'task1', 'complete')).toThrow();

			// From coder_delegated
			advanceTaskState(session, 'task2', 'coder_delegated');
			expect(() => advanceTaskState(session, 'task2', 'complete')).toThrow();

			// From pre_check_passed
			advanceTaskState(session, 'task3', 'coder_delegated');
			advanceTaskState(session, 'task3', 'pre_check_passed');
			expect(() => advanceTaskState(session, 'task3', 'complete')).toThrow();

			// From reviewer_run
			advanceTaskState(session, 'task4', 'coder_delegated');
			advanceTaskState(session, 'task4', 'pre_check_passed');
			advanceTaskState(session, 'task4', 'reviewer_run');
			expect(() => advanceTaskState(session, 'task4', 'complete')).toThrow();
		});

		// v6.71+ Council fast-path coverage: complete-from-pre_check_passed should
		// remain rejected without a council APPROVE record, and allowed with one.
		it('should reject complete from pre_check_passed when no council APPROVE recorded', () => {
			const session = ensureAgentSession('session-no-council-approve');

			advanceTaskState(session, 'council-task', 'coder_delegated');
			advanceTaskState(session, 'council-task', 'pre_check_passed');

			// taskCouncilApproved is empty — must throw the standard guard.
			expect(() =>
				advanceTaskState(session, 'council-task', 'complete'),
			).toThrow(/INVALID_TASK_STATE_TRANSITION/);
			// State should remain at pre_check_passed.
			expect(getTaskState(session, 'council-task')).toBe('pre_check_passed');
		});

		it('should allow complete from pre_check_passed when council APPROVE is recorded', () => {
			const session = ensureAgentSession('session-council-approve');

			advanceTaskState(session, 'council-task', 'coder_delegated');
			advanceTaskState(session, 'council-task', 'pre_check_passed');

			// Simulate submit_council_verdicts recording an APPROVE verdict on the session.
			// quorumSize: 3 satisfies the default minimumMembers quorum gate.
			session.taskCouncilApproved = new Map();
			session.taskCouncilApproved.set('council-task', {
				verdict: 'APPROVE',
				roundNumber: 1,
				quorumSize: 3,
			});

			// Council fast-path: should allow complete from pre_check_passed.
			expect(() =>
				advanceTaskState(session, 'council-task', 'complete'),
			).not.toThrow();
			expect(getTaskState(session, 'council-task')).toBe('complete');
		});

		it('should NOT allow complete from coder_delegated even with council APPROVE (Stage A still required)', () => {
			const session = ensureAgentSession('session-council-no-precheck');

			advanceTaskState(session, 'council-task', 'coder_delegated');

			// APPROVE recorded but no pre_check_passed — Stage A is still required.
			session.taskCouncilApproved = new Map();
			session.taskCouncilApproved.set('council-task', {
				verdict: 'APPROVE',
				roundNumber: 1,
				quorumSize: 3,
			});

			expect(() =>
				advanceTaskState(session, 'council-task', 'complete'),
			).toThrow(/INVALID_TASK_STATE_TRANSITION/);
			expect(getTaskState(session, 'council-task')).toBe('coder_delegated');
		});

		it('should NOT allow complete from pre_check_passed when council recorded REJECT', () => {
			const session = ensureAgentSession('session-council-reject');

			advanceTaskState(session, 'council-task', 'coder_delegated');
			advanceTaskState(session, 'council-task', 'pre_check_passed');

			session.taskCouncilApproved = new Map();
			session.taskCouncilApproved.set('council-task', {
				verdict: 'REJECT',
				roundNumber: 1,
				quorumSize: 3,
			});

			expect(() =>
				advanceTaskState(session, 'council-task', 'complete'),
			).toThrow(/INVALID_TASK_STATE_TRANSITION/);
		});
	});

	describe('state machine isolation between sessions', () => {
		it('should keep sessions isolated - different sessions have independent states', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			const session1 = 'session-1';
			const session2 = 'session-2';

			ensureAgentSession(session1);
			ensureAgentSession(session2);

			// Delegation in session 1
			const text1 = `coder

TASK: shared-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text1, undefined, session1),
			);

			// Session 1 should have coder_delegated
			expect(getTaskState(ensureAgentSession(session1), 'shared-task')).toBe(
				'coder_delegated',
			);

			// Session 2 should still be idle (not affected)
			expect(getTaskState(ensureAgentSession(session2), 'shared-task')).toBe(
				'idle',
			);
		});
	});

	// ============================================================================
	// NEW TESTS FOR TASK 3.2: State Machine Secondary Signal for QA Gate
	// ============================================================================

	describe('ATTACK VECTOR 7: State machine bypass via rapid state advancement', () => {
		it('should catch coder→coder without QA even if prior task state was advanced to pre_check_passed', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-state-bypass';

			const session = ensureAgentSession(sessionID);

			// First coder delegation - task 1.1
			const text1 = `coder

TASK: 1.1
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/a.ts
ACCEPTANCECRITERA: a works`;

			await hook.messagesTransform(
				{},
				makeMessages(text1, undefined, sessionID),
			);

			// Verify first task is coder_delegated
			expect(getTaskState(session, '1.1')).toBe('coder_delegated');

			// Simulate bypassing QA: directly advance task to pre_check_passed
			// (attacker trying to make priorTaskStuckAtCoder = false)
			advanceTaskState(session, '1.1', 'pre_check_passed');
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');

			// Now fire second coder delegation WITHOUT reviewer/test_engineer in chain
			// Setup: add first coder to chain (this happens in real flow via guardrails)
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 1000 },
			]);

			const text2 = `coder

TASK: 1.2
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/b.ts
ACCEPTANCECRITERA: b works`;

			// This should still trigger the warning because !hasReviewer || !hasTestEngineer
			await hook.messagesTransform(
				{},
				makeMessages(text2, undefined, sessionID),
			);

			// Should get warning since there's no reviewer/test_engineer in delegation chain
			// The original !hasReviewer || !hasTestEngineer check should still catch it
			// Note: We can't easily check for warning injection in message, but we verify no crash
			expect(getTaskState(session, '1.2')).toBe('coder_delegated');
		});

		it('should trigger hard block on second skip even if state was advanced', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-hard-block';

			const session = ensureAgentSession(sessionID);

			// First coder delegation
			const text1 = `coder

TASK: task-a
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/a.ts
ACCEPTANCECRITERA: a works`;

			await hook.messagesTransform(
				{},
				makeMessages(text1, undefined, sessionID),
			);

			// Advance state to bypass QA
			advanceTaskState(session, 'task-a', 'pre_check_passed');
			advanceTaskState(session, 'task-a', 'reviewer_run');
			advanceTaskState(session, 'task-a', 'tests_run');
			advanceTaskState(session, 'task-a', 'complete');

			// Second coder delegation - should warn (first skip) - need TWO coder entries for check
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 2000 },
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 1000 },
			]);

			const text2 = `coder

TASK: task-b
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/b.ts
ACCEPTANCECRITERA: b works`;

			await hook.messagesTransform(
				{},
				makeMessages(text2, undefined, sessionID),
			);
			expect(session.qaSkipCount).toBe(1);

			// Third coder delegation - should HARD BLOCK (second skip)
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 3000 },
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 2000 },
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 1000 },
			]);

			const text3 = `coder

TASK: task-c
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/c.ts
ACCEPTANCECRITERA: c works`;

			// Should throw hard block error
			await expect(
				hook.messagesTransform({}, makeMessages(text3, undefined, sessionID)),
			).rejects.toThrow('QA GATE ENFORCEMENT');
		});
	});

	describe('ATTACK VECTOR 8: NULL/undefined task ID injection', () => {
		it('should handle missing TASK: line gracefully (null currentTaskId)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-null-taskid';

			ensureAgentSession(sessionID);

			// Message without TASK: line
			const text = `coder

TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// Should not throw, should handle gracefully
			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// Verify session state is not corrupted
			const session = ensureAgentSession(sessionID);
			expect(session.lastCoderDelegationTaskId).toBe(null);
		});

		it('should handle malformed TASK: line with empty value', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-empty-taskid';

			ensureAgentSession(sessionID);

			// Empty TASK: value
			const text = `coder

TASK: 
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// Should not throw
			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// Session should be intact
			const session = ensureAgentSession(sessionID);
			expect(session).toBeDefined();
		});

		it('should handle undefined sessionID gracefully', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);

			// Message with no sessionID
			const messages = {
				messages: [
					{
						info: { role: 'user' as const, agent: undefined },
						parts: [
							{
								type: 'text',
								text: 'coder\n\nTASK: task1\nTARGETAGENT: coder\nACTION: implement\nCOMMANDTYPE: task\nFILES: src/test.ts\nACCEPTANCECRITERA: test passes',
							},
						],
					},
				],
			};

			// Should not throw
			await hook.messagesTransform({}, messages);

			// No crash = pass
		});
	});

	describe('ATTACK VECTOR 9: Same task ID re-delegation (retry scenario)', () => {
		it('should not false-positive on same-task re-delegation (retry)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-same-task';

			const session = ensureAgentSession(sessionID);

			// First coder delegation
			const text1 = `coder

TASK: retry-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text1, undefined, sessionID),
			);

			// Verify priorCoderTaskId was set
			expect(session.lastCoderDelegationTaskId).toBe('retry-task');

			// Setup delegation chain with coder→reviewer→test_engineer (completed QA)
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 3000 },
				{ from: 'architect', to: 'reviewer', timestamp: Date.now() - 2000 },
				{
					from: 'architect',
					to: 'test_engineer',
					timestamp: Date.now() - 1000,
				},
			]);

			// Now re-delegate to SAME task (retry scenario)
			const text2 = `coder

TASK: retry-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// priorCoderTaskId === currentTaskId here, but QA was completed
			// Should NOT trigger warning because hasReviewer && hasTestEngineer
			await hook.messagesTransform(
				{},
				makeMessages(text2, undefined, sessionID),
			);

			// qaSkipCount should remain 0 because QA was done
			expect(session.qaSkipCount).toBe(0);
		});

		it('should handle same-task re-delegation without QA (double skip)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-double-skip';

			const session = ensureAgentSession(sessionID);

			// First coder delegation
			const text1 = `coder

TASK: double-skip-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text1, undefined, sessionID),
			);

			// Setup chain with TWO coder entries for the check to trigger (requires coderIndices.length === 2)
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 2000 },
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 1000 },
			]);

			// Second delegation to same task - should warn (first skip)
			const text2 = `coder

TASK: double-skip-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text2, undefined, sessionID),
			);
			expect(session.qaSkipCount).toBe(1);

			// Third to same task - should hard block
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 3000 },
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 2000 },
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 1000 },
			]);

			const text3 = `coder

TASK: double-skip-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await expect(
				hook.messagesTransform({}, makeMessages(text3, undefined, sessionID)),
			).rejects.toThrow('QA GATE ENFORCEMENT');
		});
	});

	describe('ATTACK VECTOR 10: Empty lastCoderDelegationTaskId at first delegation', () => {
		it('should handle null priorCoderTaskId on first delegation correctly', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-first-delegation';

			const session = ensureAgentSession(sessionID);

			// Verify initial state
			expect(session.lastCoderDelegationTaskId).toBe(null);

			// First coder delegation
			const text = `coder

TASK: first-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// priorCoderTaskId should be null, so priorTaskStuckAtCoder should be false
			// This should not trigger any QA enforcement
			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// qaSkipCount should still be 0 (no prior task to check)
			expect(session.qaSkipCount).toBe(0);
			expect(session.lastCoderDelegationTaskId).toBe('first-task');
		});

		it('should handle fresh session with no prior history', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-fresh';

			// Don't create session beforehand - let hook create it
			const text = `coder

TASK: fresh-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// Should not throw
			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// Session should have been created with proper defaults
			const session = ensureAgentSession(sessionID);
			expect(session.lastCoderDelegationTaskId).toBe('fresh-task');
			expect(session.qaSkipCount).toBe(0);
		});
	});

	describe('ATTACK VECTOR 11: getTaskState returns idle for unknown task', () => {
		it('should not trigger priorTaskStuckAtCoder for non-existent prior task', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-unknown-task';

			const session = ensureAgentSession(sessionID);

			// Manually set lastCoderDelegationTaskId to a task that was never created
			session.lastCoderDelegationTaskId = 'never-created-task';

			// Setup chain with TWO coder entries for the check to trigger
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 2000 },
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 1000 },
			]);

			// New coder delegation
			const text = `coder

TASK: current-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// priorTaskStuckAtCoder should be false because:
			// - priorCoderTaskId !== null (it's "never-created-task")
			// - getTaskState(session, "never-created-task") returns 'idle' (not 'coder_delegated')
			// So priorTaskStuckAtCoder = false
			// But !hasReviewer || !hasTestEngineer = true, so it should still warn
			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// Should have warned due to missing QA in chain
			expect(session.qaSkipCount).toBe(1);
		});

		it('should handle unknown prior task ID that looks like a valid task ID', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-fake-unknown';

			const session = ensureAgentSession(sessionID);

			// Set a task ID that looks valid but was never registered
			session.lastCoderDelegationTaskId = '1.5.3.2.1';

			// Setup chain with QA completed
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 3000 },
				{ from: 'architect', to: 'reviewer', timestamp: Date.now() - 2000 },
				{
					from: 'architect',
					to: 'test_engineer',
					timestamp: Date.now() - 1000,
				},
			]);

			const text = `coder

TASK: new-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// QA was completed, so should not warn
			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// qaSkipCount should be 0 because hasReviewer && hasTestEngineer
			expect(session.qaSkipCount).toBe(0);
		});
	});

	describe('ATTACK VECTOR 12: Very long task ID string (DoS)', () => {
		it('should handle 10000 character taskId in priorTaskStuckAtCoder check', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-long-prior';

			const session = ensureAgentSession(sessionID);
			const longTaskId = 'x'.repeat(10000);

			// First delegation sets a long task ID
			const text1 = `coder

TASK: ${longTaskId}
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text1, undefined, sessionID),
			);

			// Verify it was set
			expect(session.lastCoderDelegationTaskId).toBe(longTaskId);

			// Setup chain with TWO coder delegations (prior + current) for the check
			// Code requires: delegationChain.length >= 2 AND coderIndices.length === 2
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 2000 },
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 1000 },
			]);

			// Second delegation - priorTaskStuckAtCoder checks the long task ID
			const text2 = `coder

TASK: short-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// Should not crash or hang
			await hook.messagesTransform(
				{},
				makeMessages(text2, undefined, sessionID),
			);

			// Should have warned due to missing QA (no reviewer/test_engineer between coders)
			expect(session.qaSkipCount).toBe(1);
		});

		it('should handle 100000 character taskId without DoS', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-huge-taskid';

			const session = ensureAgentSession(sessionID);
			const hugeTaskId = 'a'.repeat(100000);

			const text = `coder

TASK: ${hugeTaskId}
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// Should complete without timeout or crash
			const start = Date.now();
			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);
			const duration = Date.now() - start;

			// Should complete in reasonable time (< 5 seconds)
			expect(duration).toBeLessThan(5000);
			expect(session.lastCoderDelegationTaskId).toBe(hugeTaskId);
		});
	});

	describe('ATTACK VECTOR 13: Unicode/special characters in task ID', () => {
		it('should handle null byte in task ID for priorTaskStuckAtCoder', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-null-byte-prior';

			const session = ensureAgentSession(sessionID);
			const nullByteTaskId = 'task\x00injected';

			// First delegation with null byte in task ID
			const text1 = `coder

TASK: ${nullByteTaskId}
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text1, undefined, sessionID),
			);

			// Verify it was stored
			expect(session.lastCoderDelegationTaskId).toBe(nullByteTaskId);

			// Setup chain with TWO coder delegations for the check to trigger
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 2000 },
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 1000 },
			]);

			const text2 = `coder

TASK: another-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// Should handle safely - Map keys handle strings with null bytes
			await hook.messagesTransform(
				{},
				makeMessages(text2, undefined, sessionID),
			);

			expect(session.qaSkipCount).toBe(1);
		});

		it('should handle XSS attempt in task ID for priorTaskStuckAtCoder', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-xss-prior';

			const session = ensureAgentSession(sessionID);
			const xssTaskId = "<script>alert('xss')</script>";

			// First delegation
			const text1 = `coder

TASK: ${xssTaskId}
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text1, undefined, sessionID),
			);

			// Verify first task was stored with special chars
			expect(session.lastCoderDelegationTaskId).toBe(xssTaskId);

			// Second delegation
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 1000 },
			]);

			const text2 = `coder

TASK: safe-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// Should not execute or evaluate the XSS - just use as Map key
			// No crash = pass
			await hook.messagesTransform(
				{},
				makeMessages(text2, undefined, sessionID),
			);

			// State was tracked safely - after second delegation, it's updated to new task
			expect(session.lastCoderDelegationTaskId).toBe('safe-task');
		});

		it('should handle SQL injection in task ID for priorTaskStuckAtCoder', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-sql-prior';

			const session = ensureAgentSession(sessionID);
			const sqlTaskId = "'; DROP TABLE tasks; --";

			// First delegation
			const text1 = `coder

TASK: ${sqlTaskId}
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text1, undefined, sessionID),
			);

			// Verify first task was stored safely
			expect(session.lastCoderDelegationTaskId).toBe(sqlTaskId);

			// Second delegation
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 1000 },
			]);

			const text2 = `coder

TASK: next-task
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			// Should be handled as literal string, not SQL - no crash
			await hook.messagesTransform(
				{},
				makeMessages(text2, undefined, sessionID),
			);

			// After second delegation, updated to new task
			expect(session.lastCoderDelegationTaskId).toBe('next-task');
		});

		it('should handle unicode emoji and mixed scripts in task ID', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config);
			const sessionID = 'session-unicode';

			const session = ensureAgentSession(sessionID);
			const unicodeTaskId = '任务🔒🔓💻🚀日本語🎉';

			const text = `coder

TASK: ${unicodeTaskId}
TARGETAGENT: coder
ACTION: implement
COMMANDTYPE: task
FILES: src/test.ts
ACCEPTANCECRITERA: test passes`;

			await hook.messagesTransform(
				{},
				makeMessages(text, undefined, sessionID),
			);

			// Should handle unicode correctly as Map key
			expect(session.lastCoderDelegationTaskId).toBe(unicodeTaskId);
			expect(getTaskState(session, unicodeTaskId)).toBe('coder_delegated');
		});
	});
});
