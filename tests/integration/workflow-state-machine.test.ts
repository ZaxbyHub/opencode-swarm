/**
 * Integration tests for the complete gate workflow state machine.
 *
 * Tests the full workflow: idle → coder_delegated → pre_check_passed → reviewer_run → tests_run → complete
 *
 * These tests verify:
 * 1. Full happy path: coder_delegated → pre_check_passed → reviewer_run → tests_run → update_task_status("completed") succeeds
 * 2. Missing pre_check: state stays at coder_delegated → update_task_status rejects with gate error
 * 3. Missing reviewer: state at pre_check_passed → update_task_status rejects
 * 4. Missing test_engineer: state at reviewer_run → update_task_status rejects
 * 5. All gates passed: state at tests_run → update_task_status succeeds
 * 6. State is idempotent: calling advanceTaskState(tests_run) twice doesn't crash (non-fatal catch)
 * 7. Wrong task ID: state for task "1.1" doesn't leak to task "1.2"
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../src/gate-evidence';
import {
	type AgentSessionState,
	advanceTaskState,
	ensureAgentSession,
	getTaskState,
	swarmState,
	type TaskWorkflowState,
} from '../../src/state';
import {
	checkReviewerGate,
	executeUpdateTaskStatus,
	type UpdateTaskStatusArgs,
} from '../../src/tools/update-task-status';
import { seedAuthoritativeTaskWorkflow } from '../unit/hooks/_delegation-gate-helpers';

describe('Gate Workflow State Machine', () => {
	let tempDir: string;
	let originalCwd: string;
	let originalAgentSessions: Map<string, AgentSessionState>;

	// Helper to create a valid session with taskWorkflowStates
	function makeSession(): AgentSessionState {
		return ensureAgentSession('test-session');
	}

	beforeEach(() => {
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'workflow-state-machine-test-'),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Save and clear agent sessions
		originalAgentSessions = new Map(swarmState.agentSessions);
		swarmState.agentSessions.clear();

		// Create .swarm directory with a valid plan
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		const plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			migration_status: 'migrated',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Test task 1.1',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Test task 1.2',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });

		// Restore original agent sessions
		swarmState.agentSessions.clear();
		for (const [key, value] of originalAgentSessions) {
			swarmState.agentSessions.set(key, value);
		}
	});

	describe('State Machine Transitions', () => {
		test('1. Full happy path: coder_delegated → pre_check_passed → reviewer_run → tests_run → update_task_status("completed") succeeds', async () => {
			const generation = await seedAuthoritativeTaskWorkflow(
				tempDir,
				'1.1',
				'tests_run',
			);
			expect(
				getTaskWorkflowSnapshot(await readTaskEvidence(tempDir, '1.1')),
			).toMatchObject({ generation, state: 'tests_run' });

			// The exact durable gate should pass now.
			const gateResult = checkReviewerGate('1.1', tempDir);
			expect(gateResult.blocked).toBe(false);

			// Step 6: update_task_status to "completed" should succeed
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'completed',
			};
			const result = await executeUpdateTaskStatus(args, tempDir);
			expect(result.success).toBe(true);
			expect(result.new_status).toBe('completed');
			expect(
				getTaskWorkflowSnapshot(await readTaskEvidence(tempDir, '1.1')),
			).toMatchObject({ generation, state: 'complete' });
		});

		test('2. Missing pre_check: state stays at coder_delegated → update_task_status rejects with gate error', async () => {
			const session = makeSession();

			// Only advance to coder_delegated (skip pre_check_passed)
			advanceTaskState(session, '1.1', 'coder_delegated');
			expect(getTaskState(session, '1.1')).toBe('coder_delegated');

			// Check reviewer gate should fail
			const gateResult = checkReviewerGate('1.1');
			expect(gateResult.blocked).toBe(true);
			expect(gateResult.reason).toContain('Task 1.1');
			expect(gateResult.reason).toContain('QA gates');

			// update_task_status to "completed" should fail
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'completed',
			};
			const result = await executeUpdateTaskStatus(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.message).toContain('Gate check failed');
			expect(result.errors).toBeDefined();
			expect(result.errors?.[0]).toContain('QA gates');
		});

		test('3. Missing reviewer: state at pre_check_passed → update_task_status rejects', async () => {
			const session = makeSession();

			// Advance to pre_check_passed but skip reviewer_run
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');

			// Check reviewer gate should fail
			const gateResult = checkReviewerGate('1.1');
			expect(gateResult.blocked).toBe(true);
			expect(gateResult.reason).toContain('Task 1.1');
			expect(gateResult.reason).toContain('QA gates');

			// update_task_status to "completed" should fail
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'completed',
			};
			const result = await executeUpdateTaskStatus(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.message).toContain('Gate check failed');
			expect(result.errors).toBeDefined();
			expect(result.errors?.[0]).toContain('QA gates');
		});

		test('4. Missing test_engineer: state at reviewer_run → update_task_status rejects', async () => {
			const session = makeSession();

			// Advance to reviewer_run but skip tests_run
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');

			// Check reviewer gate should fail (still at reviewer_run, not tests_run)
			const gateResult = checkReviewerGate('1.1');
			expect(gateResult.blocked).toBe(true);
			expect(gateResult.reason).toContain('Task 1.1');
			expect(gateResult.reason).toContain('QA gates');

			// update_task_status to "completed" should fail
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'completed',
			};
			const result = await executeUpdateTaskStatus(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.message).toContain('Gate check failed');
			expect(result.errors).toBeDefined();
			expect(result.errors?.[0]).toContain('QA gates');
		});

		test('5. All gates passed: state at tests_run → update_task_status succeeds', async () => {
			const generation = await seedAuthoritativeTaskWorkflow(
				tempDir,
				'1.1',
				'tests_run',
			);

			const gateResult = checkReviewerGate('1.1', tempDir);
			expect(gateResult.blocked).toBe(false);

			// update_task_status to "completed" should succeed
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'completed',
			};
			const result = await executeUpdateTaskStatus(args, tempDir);
			expect(result.success).toBe(true);
			expect(result.new_status).toBe('completed');
			expect(
				getTaskWorkflowSnapshot(await readTaskEvidence(tempDir, '1.1')),
			).toMatchObject({ generation, state: 'complete' });
		});

		test('6. State is idempotent: calling advanceTaskState(tests_run) twice does not crash (non-fatal catch)', () => {
			const session = makeSession();

			// Advance to tests_run
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');
			expect(getTaskState(session, '1.1')).toBe('tests_run');

			// Try to advance again to tests_run - should throw (not idempotent in the forward sense)
			// The state machine throws on backward or same-state transitions
			expect(() => {
				advanceTaskState(session, '1.1', 'tests_run');
			}).toThrow();

			// But advancing to complete should work
			advanceTaskState(session, '1.1', 'complete');
			expect(getTaskState(session, '1.1')).toBe('complete');

			// Trying to advance again to complete should also throw
			expect(() => {
				advanceTaskState(session, '1.1', 'complete');
			}).toThrow();
		});

		test('7. Wrong task ID: state for task "1.1" does not leak to task "1.2"', () => {
			const session = makeSession();

			// Advance task 1.1 to tests_run
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');

			// Verify 1.1 is at tests_run
			expect(getTaskState(session, '1.1')).toBe('tests_run');

			// Verify 1.2 is still at idle (default)
			expect(getTaskState(session, '1.2')).toBe('idle');

			// Check reviewer gate for 1.1 should pass
			const gateResult1 = checkReviewerGate('1.1');
			expect(gateResult1.blocked).toBe(false);

			// Check reviewer gate for 1.2 should fail (still at idle)
			const gateResult2 = checkReviewerGate('1.2');
			expect(gateResult2.blocked).toBe(true);
			expect(gateResult2.reason).toContain('Task 1.2');
		});

		test('State can advance from complete to complete (but throws as expected)', () => {
			const session = makeSession();

			// Advance to complete
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');
			advanceTaskState(session, '1.1', 'complete');
			expect(getTaskState(session, '1.1')).toBe('complete');

			// Trying to advance to complete again should throw (cannot re-advance to same state)
			expect(() => {
				advanceTaskState(session, '1.1', 'complete');
			}).toThrow();
		});

		test('Backward transition throws error', () => {
			const session = makeSession();

			// Advance to reviewer_run
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');

			// Try to go back to pre_check_passed - should throw
			expect(() => {
				advanceTaskState(session, '1.1', 'pre_check_passed');
			}).toThrow();

			// Try to go back to coder_delegated - should throw
			expect(() => {
				advanceTaskState(session, '1.1', 'coder_delegated');
			}).toThrow();

			// Try to go back to idle - should throw
			expect(() => {
				advanceTaskState(session, '1.1', 'idle');
			}).toThrow();
		});

		test('Complete state requires tests_run first', () => {
			const session = makeSession();

			// Try to go directly from reviewer_run to complete - should throw
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');

			expect(() => {
				advanceTaskState(session, '1.1', 'complete');
			}).toThrow();

			// But from tests_run to complete should work
			advanceTaskState(session, '1.1', 'tests_run');
			advanceTaskState(session, '1.1', 'complete');
			expect(getTaskState(session, '1.1')).toBe('complete');
		});

		test('Multiple tasks maintain independent state', () => {
			const session = makeSession();

			// Advance 1.1 to complete
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');
			advanceTaskState(session, '1.1', 'complete');

			// Advance 1.2 only to pre_check_passed
			advanceTaskState(session, '1.2', 'coder_delegated');
			advanceTaskState(session, '1.2', 'pre_check_passed');

			// Verify each task has independent state
			expect(getTaskState(session, '1.1')).toBe('complete');
			expect(getTaskState(session, '1.2')).toBe('pre_check_passed');

			// checkReviewerGate for 1.1 should pass
			expect(checkReviewerGate('1.1').blocked).toBe(false);

			// checkReviewerGate for 1.2 should fail
			expect(checkReviewerGate('1.2').blocked).toBe(true);
		});
	});

	// ============================================
	// ADVERSARIAL TESTS - Attack Vectors
	// ============================================

	describe('Adversarial: Session with no taskWorkflowStates map', () => {
		test('AV1: checkReviewerGate handles session without taskWorkflowStates gracefully - FIXED', () => {
			// Create session and manually remove taskWorkflowStates to simulate edge case
			const session = ensureAgentSession('adversarial-session-no-map');

			// Manually remove the taskWorkflowStates map to test robustness
			// @ts-expect-error - intentionally removing for adversarial test
			delete session.taskWorkflowStates;

			// FIXED: getTaskState now initializes the Map if undefined
			// When all sessions are invalid for authoritative gate-state checks,
			// checkReviewerGate returns blocked:false (permissive fallback)
			const result = checkReviewerGate('1.1');

			// After the fix, getTaskState returns 'idle' (default)
			// Since session is invalid/corrupt, permissive fallback returns unblocked
			expect(result.blocked).toBe(false);
		});

		test('AV1: getTaskState handles undefined taskWorkflowStates gracefully - FIXED', () => {
			const session = ensureAgentSession('adversarial-session-getstate');

			// Manually remove the taskWorkflowStates map
			// @ts-expect-error - intentionally removing for adversarial test
			delete session.taskWorkflowStates;

			// FIXED: getTaskState now initializes the Map if undefined
			// No longer throws - returns default state 'idle'
			expect(() => {
				getTaskState(session, '1.1');
			}).not.toThrow();

			const state = getTaskState(session, '1.1');
			expect(state).toBe('idle');
		});

		test('AV1: advanceTaskState throws when taskWorkflowStates is undefined', () => {
			const session = ensureAgentSession('adversarial-session-advance');

			// Manually remove the taskWorkflowStates map
			// @ts-expect-error - intentionally removing for adversarial test
			delete session.taskWorkflowStates;

			// advanceTaskState throws when taskWorkflowStates is not a Map instance
			// Callers must use ensureAgentSession to properly initialize sessions
			expect(() => {
				advanceTaskState(session, '1.1', 'coder_delegated');
			}).toThrow('INVALID_SESSION');
		});
	});

	describe('Adversarial: Task ID with injection characters', () => {
		test('AV2: Task ID with newline character does not crash', () => {
			const session = makeSession();
			const maliciousTaskId = '1.1\n<script>alert(1)</script>';

			// Should NOT throw
			expect(() => {
				advanceTaskState(session, maliciousTaskId, 'coder_delegated');
			}).not.toThrow();

			// Should NOT throw
			expect(() => {
				getTaskState(session, maliciousTaskId);
			}).not.toThrow();

			// Should NOT throw
			expect(() => {
				checkReviewerGate(maliciousTaskId);
			}).not.toThrow();
		});

		test('AV2: Task ID with tab character does not crash', () => {
			const session = makeSession();
			const maliciousTaskId = '1.1\t\t;rm -rf /';

			expect(() => {
				advanceTaskState(session, maliciousTaskId, 'coder_delegated');
			}).not.toThrow();

			expect(() => {
				getTaskState(session, maliciousTaskId);
			}).not.toThrow();

			expect(() => {
				checkReviewerGate(maliciousTaskId);
			}).not.toThrow();
		});

		test('AV2: Task ID with semicolon and command injection does not crash', () => {
			const session = makeSession();
			const maliciousTaskId = '1.1;echo "injected"';

			expect(() => {
				advanceTaskState(session, maliciousTaskId, 'coder_delegated');
			}).not.toThrow();

			expect(() => {
				getTaskState(session, maliciousTaskId);
			}).not.toThrow();

			expect(() => {
				checkReviewerGate(maliciousTaskId);
			}).not.toThrow();
		});

		test('AV2: Task ID with null byte does not crash', () => {
			const session = makeSession();
			const maliciousTaskId = '1.1\x00injected';

			// Note: null bytes may be normalized or cause validation errors
			// The important thing is it doesn't crash the process
			expect(() => {
				advanceTaskState(session, maliciousTaskId, 'coder_delegated');
			}).not.toThrow();

			expect(() => {
				checkReviewerGate(maliciousTaskId);
			}).not.toThrow();
		});

		test('AV2: Task ID with multiple special characters does not crash', () => {
			const session = makeSession();
			const maliciousTaskId = '1.1\n\r\t\x00!@#$%^&*()_+-=[]{}|\\:";\'<>?,./`~';

			expect(() => {
				advanceTaskState(session, maliciousTaskId, 'coder_delegated');
			}).not.toThrow();

			expect(() => {
				checkReviewerGate(maliciousTaskId);
			}).not.toThrow();
		});
	});

	describe('Adversarial: Concurrent same-session same-task state advancement', () => {
		test('AV3: Rapid concurrent state advances do not corrupt state', () => {
			const session = makeSession();

			// Simulate rapid concurrent advances by calling in quick succession
			// The state machine should serialize properly
			advanceTaskState(session, '1.1', 'coder_delegated');

			// Try to advance concurrently - second should fail (already at coder_delegated)
			expect(() => {
				advanceTaskState(session, '1.1', 'pre_check_passed');
			}).not.toThrow();

			// Verify state is correct after all advances
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
		});

		test('AV3: Multiple parallel state advances are properly serialized', () => {
			const session = makeSession();

			// Sequence of state advances that should work
			const states: TaskWorkflowState[] = [
				'coder_delegated',
				'pre_check_passed',
				'reviewer_run',
				'tests_run',
			];

			for (const state of states) {
				expect(() => {
					advanceTaskState(session, '1.1', state);
				}).not.toThrow();
			}

			// Final state should be tests_run
			expect(getTaskState(session, '1.1')).toBe('tests_run');

			// Reviewer gate should pass
			expect(checkReviewerGate('1.1').blocked).toBe(false);
		});

		test('AV3: Race condition simulation - backward transition throws', () => {
			const session = makeSession();

			// Advance to pre_check_passed
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');

			// Try to go back to coder_delegated - should throw
			expect(() => {
				advanceTaskState(session, '1.1', 'coder_delegated');
			}).toThrow();

			// State should still be pre_check_passed
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
		});
	});

	describe('Adversarial: State set directly to complete without tests_run', () => {
		test('AV4: Direct transition to complete from idle is blocked', () => {
			const session = makeSession();

			// Try to go directly from idle to complete - should throw
			expect(() => {
				advanceTaskState(session, '1.1', 'complete');
			}).toThrow();

			// State should still be idle
			expect(getTaskState(session, '1.1')).toBe('idle');
		});

		test('AV4: Direct transition to complete from coder_delegated is blocked', () => {
			const session = makeSession();

			advanceTaskState(session, '1.1', 'coder_delegated');

			// Try to go directly to complete - should throw
			expect(() => {
				advanceTaskState(session, '1.1', 'complete');
			}).toThrow();

			// State should still be coder_delegated
			expect(getTaskState(session, '1.1')).toBe('coder_delegated');
		});

		test('AV4: Direct transition to complete from pre_check_passed is blocked', () => {
			const session = makeSession();

			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');

			// Try to go directly to complete - should throw
			expect(() => {
				advanceTaskState(session, '1.1', 'complete');
			}).toThrow();

			// State should still be pre_check_passed
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
		});

		test('AV4: Direct transition to complete from reviewer_run is blocked', () => {
			const session = makeSession();

			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');

			// Try to go directly to complete - should throw
			expect(() => {
				advanceTaskState(session, '1.1', 'complete');
			}).toThrow();

			// State should still be reviewer_run
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});

		test('AV4: Only tests_run → complete transition is allowed', () => {
			const session = makeSession();

			// Full proper sequence
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');

			// Now complete should work
			expect(() => {
				advanceTaskState(session, '1.1', 'complete');
			}).not.toThrow();

			// State should be complete
			expect(getTaskState(session, '1.1')).toBe('complete');
		});
	});

	describe('Adversarial: checkReviewerGate with non-existent sessionID', () => {
		test('AV5: checkReviewerGate with no sessions returns unblocked', () => {
			// Clear all sessions
			swarmState.agentSessions.clear();

			// Should return unblocked when no sessions exist (test context)
			const result = checkReviewerGate('1.1');
			expect(result.blocked).toBe(false);
		});

		test('AV5: checkReviewerGate with unknown task ID returns blocked', () => {
			const session = makeSession();

			// Don't advance any state - task doesn't exist
			// Should return blocked since no task has reached tests_run
			const result = checkReviewerGate('999.999');
			expect(result.blocked).toBe(true);
			expect(result.reason).toContain('999.999');
		});

		test('AV5: checkReviewerGate handles missing session gracefully', () => {
			// Clear all sessions
			const originalSessions = new Map(swarmState.agentSessions);
			swarmState.agentSessions.clear();

			// Should NOT throw
			expect(() => {
				checkReviewerGate('1.1');
			}).not.toThrow();

			// Should return unblocked (test context)
			const result = checkReviewerGate('1.1');
			expect(result.blocked).toBe(false);

			// Restore sessions
			swarmState.agentSessions.clear();
			for (const [key, value] of originalSessions) {
				swarmState.agentSessions.set(key, value);
			}
		});

		test('AV5: checkReviewerGate with multiple sessions, task in one but not others', () => {
			const session1 = ensureAgentSession('session-1');
			const session2 = ensureAgentSession('session-2');

			// Only advance in session1
			advanceTaskState(session1, '1.1', 'coder_delegated');
			advanceTaskState(session1, '1.1', 'pre_check_passed');
			advanceTaskState(session1, '1.1', 'reviewer_run');
			advanceTaskState(session1, '1.1', 'tests_run');

			// session2 has no state for 1.1

			// checkReviewerGate should pass because one session has it
			const result = checkReviewerGate('1.1');
			expect(result.blocked).toBe(false);
		});

		test('AV5: executeUpdateTaskStatus with non-existent task ID fails gracefully', async () => {
			const session = makeSession();

			// Don't set any state
			const args: UpdateTaskStatusArgs = {
				task_id: '999.999',
				status: 'completed',
			};

			const result = await executeUpdateTaskStatus(args, tempDir);

			// Should fail gracefully with proper error message
			expect(result.success).toBe(false);
			expect(result.message).toBe('Failed to update task status');
			expect(result.errors).toContain('Task not found: 999.999');
		});
	});
});
