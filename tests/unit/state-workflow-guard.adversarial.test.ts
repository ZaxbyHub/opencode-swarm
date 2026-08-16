import { beforeEach, describe, expect, it } from 'bun:test';
import {
	type AgentSessionState,
	advanceTaskState,
	getTaskState,
	type TaskWorkflowState,
} from '../../src/state';

/**
 * Creates a minimal AgentSessionState for testing adversarial attacks.
 * Uses type assertion since we're testing edge cases with incomplete state.
 */
function createMinimalSession(
	overrides?: Partial<AgentSessionState>,
): AgentSessionState {
	return {
		agentName: 'test-agent',
		lastToolCallTime: Date.now(),
		lastAgentEventTime: Date.now(),
		delegationActive: false,
		activeInvocationId: 0,
		lastInvocationIdByAgent: {},
		windows: {},
		lastCompactionHint: 0,
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: null,
		gateLog: new Map(),
		reviewerCallCount: new Map(),
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: new Set(),
		selfFixAttempted: false,
		catastrophicPhaseWarnings: new Set(),
		qaSkipCount: 0,
		qaSkipTaskIds: [],
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: new Set(),
		lastGateOutcome: null,
		declaredCoderScope: null,
		lastScopeViolation: null,
		scopeViolationDetected: false,
		modifiedFilesThisCoderTask: [],
		sessionRehydratedAt: 0,
		...overrides,
	} as AgentSessionState;
}

describe('ADVERSARIAL: TaskWorkflowState guard attacks', () => {
	describe('ATTACK 1: Try to skip states and jump directly to complete', () => {
		it('BLOCKED: Cannot jump from idle to complete directly', () => {
			const session = createMinimalSession({ taskWorkflowStates: undefined });

			// Attempt to skip all states and go directly to complete - BLOCKED by special guard
			expect(() =>
				advanceTaskState(session, 'test-task', 'complete'),
			).toThrow();
		});

		it('BLOCKED: Cannot jump from undefined state to complete in one call', () => {
			const session = createMinimalSession({ taskWorkflowStates: undefined });

			// Even though guard initializes the Map, the special 'complete' guard blocks this
			expect(() => advanceTaskState(session, 'new-task', 'complete')).toThrow();

			// Verify state was NOT set to complete
			expect(getTaskState(session, 'new-task')).toBe('idle');
		});

		it('ALLOWED BY DESIGN: Can skip from idle to tests_run (forward jump allowed)', () => {
			const session = createMinimalSession({ taskWorkflowStates: new Map() });

			// The state machine allows forward jumps (not just adjacent states)
			// So idle → tests_run IS allowed
			expect(() =>
				advanceTaskState(session, 'test-task', 'tests_run'),
			).not.toThrow();
			expect(getTaskState(session, 'test-task')).toBe('tests_run');
		});

		it('ALLOWED BY DESIGN: Can skip from idle to reviewer_run (forward jump allowed)', () => {
			const session = createMinimalSession({ taskWorkflowStates: new Map() });

			// Forward jumps are allowed, just complete has special guard
			expect(() =>
				advanceTaskState(session, 'test-task', 'reviewer_run'),
			).not.toThrow();
			expect(getTaskState(session, 'test-task')).toBe('reviewer_run');
		});

		it('ALLOWED BY DESIGN: Can skip from idle to pre_check_passed (forward jump allowed)', () => {
			const session = createMinimalSession({ taskWorkflowStates: new Map() });

			// Forward jumps are allowed, just complete has special guard
			expect(() =>
				advanceTaskState(session, 'test-task', 'pre_check_passed'),
			).not.toThrow();
			expect(getTaskState(session, 'test-task')).toBe('pre_check_passed');
		});
	});

	describe('ATTACK 2: Inject session with undefined taskWorkflowStates, try to advance to complete in one call', () => {
		it('BLOCKED: Guard initializes Map but transition rules still enforced', () => {
			const session = createMinimalSession({ taskWorkflowStates: undefined });

			// The guard will initialize the Map, but the transition rule should block complete
			expect(() => advanceTaskState(session, 'task-1', 'complete')).toThrow();

			// Verify state was NOT set to complete
			expect(getTaskState(session, 'task-1')).toBe('idle'); // Default when task not found
		});

		it('BLOCKED: Even after guard fires, cannot skip to complete', () => {
			const session = createMinimalSession({ taskWorkflowStates: undefined });

			// First call: guard fires, initializes Map, but transition fails
			try {
				advanceTaskState(session, 'task-1', 'complete');
			} catch (e) {
				// Expected to throw
			}

			// Verify still at idle (not corrupted)
			expect(getTaskState(session, 'task-1')).toBe('idle');

			// Now try again with proper path - should work
			advanceTaskState(session, 'task-1', 'coder_delegated');
			expect(getTaskState(session, 'task-1')).toBe('coder_delegated');
		});
	});

	describe('ATTACK 3: Call advanceTaskState multiple times with undefined taskWorkflowStates', () => {
		it('BLOCKED: State does NOT persist incorrectly across calls with undefined', () => {
			const session = createMinimalSession({ taskWorkflowStates: undefined });

			// First call - guard initializes Map but transition blocked
			expect(() => advanceTaskState(session, 'task-1', 'complete')).toThrow();

			// The task should NOT have any state set because the transition was rejected
			// getTaskState returns 'idle' as default
			expect(getTaskState(session, 'task-1')).toBe('idle');

			// Second call with same invalid target - should also throw
			expect(() => advanceTaskState(session, 'task-1', 'complete')).toThrow();

			// Verify still idle
			expect(getTaskState(session, 'task-1')).toBe('idle');
		});

		it('BLOCKED: Proper transition path works after failed attempts', () => {
			const session = createMinimalSession({ taskWorkflowStates: new Map() });

			// Attempt invalid jump (complete from idle)
			expect(() => advanceTaskState(session, 'task-1', 'complete')).toThrow();

			// Now do it properly — session has a valid Map so this works
			advanceTaskState(session, 'task-1', 'coder_delegated');
			expect(getTaskState(session, 'task-1')).toBe('coder_delegated');

			// Continue proper path
			advanceTaskState(session, 'task-1', 'pre_check_passed');
			advanceTaskState(session, 'task-1', 'reviewer_run');
			advanceTaskState(session, 'task-1', 'tests_run');
			advanceTaskState(session, 'task-1', 'complete');

			expect(getTaskState(session, 'task-1')).toBe('complete');
		});

		it('BLOCKED: Multiple tasks with properly initialized Map - each stays independent', () => {
			const session = createMinimalSession({ taskWorkflowStates: new Map() });

			// Task A - invalid jump (complete from idle)
			expect(() => advanceTaskState(session, 'task-A', 'complete')).toThrow();

			// Task B - proper path
			advanceTaskState(session, 'task-B', 'coder_delegated');

			// Task A should still be idle (not corrupted)
			expect(getTaskState(session, 'task-A')).toBe('idle');
			expect(getTaskState(session, 'task-B')).toBe('coder_delegated');
		});
	});

	describe('ATTACK 4: Try taskWorkflowStates as plain object {} instead of Map', () => {
		it('BLOCKED: Plain object is not a Map - should throw TypeError or fail gracefully', () => {
			const session = createMinimalSession({ taskWorkflowStates: {} as any });

			// Plain object doesn't have .get() and .set() methods like Map
			// The code calls session.taskWorkflowStates.get() which should fail on plain object
			expect(() =>
				advanceTaskState(session, 'task-1', 'coder_delegated'),
			).toThrow();
		});

		it('BLOCKED: getTaskState with plain object should throw', () => {
			const session = createMinimalSession({ taskWorkflowStates: {} as any });

			expect(() => getTaskState(session, 'task-1')).toThrow();
		});

		it('BLOCKED: Array instead of Map should throw', () => {
			const session = createMinimalSession({ taskWorkflowStates: [] as any });

			expect(() =>
				advanceTaskState(session, 'task-1', 'coder_delegated'),
			).toThrow();
		});
	});

	describe('ATTACK 5: Concurrent/re-entrant - modify taskWorkflowStates to undefined between guard and .get()', () => {
		it('BLOCKED: Setting taskWorkflowStates to undefined mid-operation does not corrupt state', () => {
			const session = createMinimalSession({ taskWorkflowStates: new Map() });

			// Set up a proper state first
			advanceTaskState(session, 'task-1', 'coder_delegated');
			expect(getTaskState(session, 'task-1')).toBe('coder_delegated');

			// Attacker tries to set it to undefined between calls
			(session as any).taskWorkflowStates = undefined;

			// Now try to get state - guard should re-initialize
			// Should NOT return corrupted data - should return 'idle' as default
			expect(getTaskState(session, 'task-1')).toBe('idle');

			// The old state was lost - this is acceptable behavior (guard re-initializes)
			// But it should NOT throw or corrupt
		});

		it('BLOCKED: Race simulation - undefined set after guard check but before get()', () => {
			// This tests the window between guard and .get() in the same function
			// In a real race, another thread could modify between lines
			const session = createMinimalSession({ taskWorkflowStates: undefined });

			// First call - guard initializes
			getTaskState(session, 'task-1');

			// Attacker sets to undefined after initialization
			(session as any).taskWorkflowStates = undefined;

			// Next call should re-initialize
			const state = getTaskState(session, 'task-1');
			expect(state).toBe('idle'); // Returns default since map was reset
		});

		it('BLOCKED: Multiple re-entrancy attacks do not cause memory leaks or corruption', () => {
			const session = createMinimalSession({ taskWorkflowStates: undefined });

			// Perform multiple attacks
			for (let i = 0; i < 10; i++) {
				// Try invalid transition
				try {
					advanceTaskState(session, 'task-1', 'complete');
				} catch (e) {
					// Expected
				}

				// Try to corrupt state
				(session as any).taskWorkflowStates = undefined;

				// Call getTaskState - should handle gracefully
				expect(() => getTaskState(session, 'task-1')).not.toThrow();
			}

			// After all attacks, proper path should still work
			advanceTaskState(session, 'task-1', 'coder_delegated');
			expect(getTaskState(session, 'task-1')).toBe('coder_delegated');
		});
	});

	describe('ATTACK 6: After guard fires, confirm forward-only transition rule still blocks direct jump to complete', () => {
		it('BLOCKED: Guard initializes Map but complete transition still requires tests_run', () => {
			const session = createMinimalSession({ taskWorkflowStates: undefined });

			// Guard fires here (initializes Map), but transition still blocked
			expect(() => advanceTaskState(session, 'task-1', 'complete')).toThrow();

			// Verify still at idle
			expect(getTaskState(session, 'task-1')).toBe('idle');

			// Guard fires again on getTaskState
			expect(getTaskState(session, 'task-1')).toBe('idle');

			// Even with fresh Map from guard, complete requires proper sequence
			expect(() => advanceTaskState(session, 'task-1', 'complete')).toThrow();
		});

		it('BLOCKED: Cannot reach complete from any state except tests_run, even with guard', () => {
			const states: TaskWorkflowState[] = [
				'idle',
				'coder_delegated',
				'pre_check_passed',
				'reviewer_run',
			];

			for (const currentState of states) {
				const session = createMinimalSession({
					taskWorkflowStates: new Map([['task-1', currentState]]),
				});

				// All should block except tests_run
				if (currentState !== 'tests_run') {
					expect(() =>
						advanceTaskState(session, 'task-1', 'complete'),
					).toThrow();
				} else {
					// Only tests_run can go to complete
					expect(() =>
						advanceTaskState(session, 'task-1', 'complete'),
					).not.toThrow();
				}
			}
		});

		it('BLOCKED: Backward transitions always blocked, regardless of guard', () => {
			const session = createMinimalSession({
				taskWorkflowStates: new Map([['task-1', 'tests_run']]),
			});

			// Try backward transition
			expect(() =>
				advanceTaskState(session, 'task-1', 'reviewer_run'),
			).toThrow();
			expect(() => advanceTaskState(session, 'task-1', 'idle')).toThrow();
			expect(() =>
				advanceTaskState(session, 'task-1', 'coder_delegated'),
			).toThrow();

			// State should be unchanged
			expect(getTaskState(session, 'task-1')).toBe('tests_run');
		});
	});

	describe('ATTACK 7: Pre-seed taskWorkflowStates with complete state - can it bypass gates?', () => {
		it('BLOCKED: Pre-seeding complete does NOT allow skipping gates on next advance', () => {
			// Attacker tries to pre-seed 'complete' state hoping to bypass forward-only checks
			const session = createMinimalSession({
				taskWorkflowStates: new Map([['task-1', 'complete']]),
			});

			// The current state is already 'complete'
			expect(getTaskState(session, 'task-1')).toBe('complete');

			// Try to advance from complete to anything - should be blocked (backward/stationary)
			expect(() =>
				advanceTaskState(session, 'task-1', 'coder_delegated'),
			).toThrow();
			expect(() => advanceTaskState(session, 'task-1', 'tests_run')).toThrow();
			expect(() => advanceTaskState(session, 'task-1', 'complete')).toThrow(); // Same state
		});

		it('BLOCKED: From tests_run, can go to complete - this is valid and expected', () => {
			// Pre-seed at tests_run - can we jump to complete? YES (this is valid)
			const session = createMinimalSession({
				taskWorkflowStates: new Map([['task-1', 'tests_run']]),
			});

			// From tests_run, can go to complete - this is valid forward transition
			expect(() =>
				advanceTaskState(session, 'task-1', 'complete'),
			).not.toThrow();
			expect(getTaskState(session, 'task-1')).toBe('complete');
		});

		it('BLOCKED: Pre-seeding does NOT allow direct jump to complete (except from tests_run)', () => {
			// Pre-seed at idle - try to jump to complete directly - BLOCKED
			const session = createMinimalSession({
				taskWorkflowStates: new Map([['task-1', 'idle']]),
			});

			// Special guard blocks idle → complete
			expect(() => advanceTaskState(session, 'task-1', 'complete')).toThrow();

			// Pre-seed at pre_check_passed - try to jump to complete - BLOCKED
			const session2 = createMinimalSession({
				taskWorkflowStates: new Map([['task-1', 'pre_check_passed']]),
			});

			// Special guard blocks pre_check_passed → complete
			expect(() => advanceTaskState(session2, 'task-1', 'complete')).toThrow();

			// Pre-seed at reviewer_run - try to jump to complete - BLOCKED
			const session3 = createMinimalSession({
				taskWorkflowStates: new Map([['task-1', 'reviewer_run']]),
			});

			expect(() => advanceTaskState(session3, 'task-1', 'complete')).toThrow();
		});

		it('BLOCKED: Pre-seeding allows forward jumps but special guard blocks complete', () => {
			const session = createMinimalSession({
				taskWorkflowStates: new Map([
					['task-A', 'complete'],
					['task-B', 'tests_run'],
					['task-C', 'idle'],
				]),
			});

			// Task A - at complete, cannot advance (backward/stationary blocked)
			expect(() =>
				advanceTaskState(session, 'task-A', 'coder_delegated'),
			).toThrow();

			// Task B - at tests_run, can go to complete (valid)
			expect(() =>
				advanceTaskState(session, 'task-B', 'complete'),
			).not.toThrow();

			// Task C - at idle, forward jumps allowed but complete blocked
			// idle → reviewer_run is allowed (forward jump)
			expect(() =>
				advanceTaskState(session, 'task-C', 'reviewer_run'),
			).not.toThrow();
			expect(getTaskState(session, 'task-C')).toBe('reviewer_run');

			// But idle → complete is BLOCKED
			const sessionD = createMinimalSession({
				taskWorkflowStates: new Map([['task-D', 'idle']]),
			});
			expect(() => advanceTaskState(sessionD, 'task-D', 'complete')).toThrow();
		});

		it('BLOCKED: Invalid state string in pre-seeded Map - all transitions blocked', () => {
			// Try to inject an invalid state value
			const session = createMinimalSession({
				taskWorkflowStates: new Map([['task-1', 'invalid_state' as any]]),
			});

			// getTaskState returns the invalid state
			const current = getTaskState(session, 'task-1');
			expect(current).toBe('invalid_state');

			// Invalid stored states fail closed instead of being treated as a state
			// before the beginning of the workflow order.
			expect(() =>
				advanceTaskState(session, 'task-1', 'coder_delegated'),
			).toThrow(
				'INVALID_TASK_STATE_TRANSITION: task-1 invalid_state → coder_delegated',
			);
			expect(getTaskState(session, 'task-1')).toBe('invalid_state');
		});
	});

	describe('ATTACK 8: Edge cases - guard bypass attempts', () => {
		it('BLOCKED: NaN as taskWorkflowStates is not a Map - throws INVALID_SESSION', () => {
			const session = createMinimalSession({ taskWorkflowStates: NaN as any });

			// NaN is not a Map instance - guard throws INVALID_SESSION
			expect(() =>
				advanceTaskState(session, 'task-1', 'coder_delegated'),
			).toThrow('INVALID_SESSION');
		});

		it('BLOCKED: Symbol as taskWorkflowStates - truthy, not Map, has no .get()/.set()', () => {
			const session = createMinimalSession({
				taskWorkflowStates: Symbol('fake') as any,
			});

			// Symbol is truthy so guard doesn't run, but Symbol doesn't have Map methods
			expect(() =>
				advanceTaskState(session, 'task-1', 'coder_delegated'),
			).toThrow();
		});

		it('BLOCKED: Function as taskWorkflowStates - truthy, not Map, may not work as expected', () => {
			const session = createMinimalSession({
				taskWorkflowStates: (() => {}) as any,
			});

			// Function is truthy so guard doesn't run, might work but is wrong
			expect(() =>
				advanceTaskState(session, 'task-1', 'coder_delegated'),
			).toThrow();
		});

		it('BLOCKED: Proxy as taskWorkflowStates', () => {
			const session = createMinimalSession({
				taskWorkflowStates: new Proxy({}, {}) as any,
			});

			// Proxy might pass the instanceof Map check but has wrong behavior
			expect(() =>
				advanceTaskState(session, 'task-1', 'coder_delegated'),
			).toThrow();
		});

		it('BLOCKED: Plain object with Map-like methods passes guard but fails on actual use', () => {
			// Create object that might confuse the guard - truthy so guard passes
			const obj = { get: () => 'complete', set: () => {} };
			const session = createMinimalSession({ taskWorkflowStates: obj as any });

			// The guard only checks `if (!session.taskWorkflowStates)`
			// which passes for truthy objects, but then .get() and .set()
			// might not behave as expected
			expect(() =>
				advanceTaskState(session, 'task-1', 'coder_delegated'),
			).toThrow();
		});
	});

	describe('ATTACK 9: String manipulation attacks', () => {
		it('Empty task ID is rejected by isValidTaskId guard', () => {
			const session = createMinimalSession({ taskWorkflowStates: new Map() });

			// Empty string is rejected — advanceTaskState silently returns
			advanceTaskState(session, '', 'coder_delegated');
			expect(getTaskState(session, '')).toBe('idle');
		});

		it('BLOCKED: Very long task ID does not overflow', () => {
			const session = createMinimalSession({ taskWorkflowStates: new Map() });

			const longId = 'task-' + 'x'.repeat(10000);
			advanceTaskState(session, longId, 'coder_delegated');
			expect(getTaskState(session, longId)).toBe('coder_delegated');
		});

		it('BLOCKED: Unicode task ID works correctly', () => {
			const session = createMinimalSession({ taskWorkflowStates: new Map() });

			const unicodeId = 'task-\u0000\uFFFF\u{10FFFF}';
			advanceTaskState(session, unicodeId, 'coder_delegated');
			expect(getTaskState(session, unicodeId)).toBe('coder_delegated');
		});
	});

	describe('ATTACK 10: Null taskId and state', () => {
		it('Null taskId is rejected by isValidTaskId guard', () => {
			const session = createMinimalSession({ taskWorkflowStates: new Map() });

			// Null is rejected — advanceTaskState silently returns
			advanceTaskState(session, null as any, 'coder_delegated');
			expect(getTaskState(session, null as any)).toBe('idle');
		});

		it('BLOCKED: Undefined newState should throw', () => {
			const session = createMinimalSession({ taskWorkflowStates: new Map() });

			// undefined is not a valid TaskWorkflowState
			expect(() =>
				advanceTaskState(session, 'task-1', undefined as any),
			).toThrow();
		});

		it('BLOCKED: Invalid state string throws', () => {
			const session = createMinimalSession({ taskWorkflowStates: new Map() });

			expect(() =>
				advanceTaskState(session, 'task-1', 'invalid' as any),
			).toThrow();
		});
	});
});
