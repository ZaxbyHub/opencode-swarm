/**
 * Adversarial tests for modifiedFilesThisCoderTask field in src/state.ts
 * Tests malformed inputs, boundary violations, mutation safety, type coercion
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	type AgentSessionState,
	ensureAgentSession,
	getAgentSession,
	recordModifiedFilesForTask,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../src/state';

/**
 * Direct import of the module to access internal state for corruption tests
 */
const stateModule = require('../../src/state');

describe('modifiedFilesThisCoderTask adversarial tests', () => {
	const sessionId1 = 'session-agent-1';
	const sessionId2 = 'session-agent-2';

	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	describe('migration guard with invalid values', () => {
		it('should handle undefined modifiedFilesThisCoderTask (migration case)', () => {
			// Create a session manually with undefined field (simulating old session)
			const legacySession = {
				agentName: 'legacy',
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
				taskWorkflowStates: new Map(),
				lastGateOutcome: null,
				declaredCoderScope: null,
				lastScopeViolation: null,
				lastPhaseCompleteTimestamp: 0,
				lastPhaseCompletePhase: 0,
				phaseAgentsDispatched: new Set(),
				// NOTE: modifiedFilesThisCoderTask is intentionally NOT set (undefined)
			} as any; // Type assertion to simulate partial legacy object

			swarmState.agentSessions.set('legacy-session', legacySession);

			// Now call ensureAgentSession - migration guard should handle undefined
			const session = ensureAgentSession('legacy-session', 'migrated');

			// Should be initialized to empty array
			expect(session.modifiedFilesThisCoderTask).toEqual([]);
			expect(Array.isArray(session.modifiedFilesThisCoderTask)).toBe(true);
		});

		it('should handle null assigned to modifiedFilesThisCoderTask', () => {
			const session = ensureAgentSession(sessionId1, 'coder');
			session.currentTaskId = 'task-null-repair';
			expect(
				recordModifiedFilesForTask(session, 'task-null-repair', ['trusted.ts']),
			).toBe(true);

			// Corrupt the field with null
			(session as any).modifiedFilesThisCoderTask = null;

			// The task-keyed map is authoritative. Re-projecting the active task
			// repairs a corrupted legacy compatibility field.
			const sessionAgain = ensureAgentSession(sessionId1, 'coder');

			expect(sessionAgain.modifiedFilesThisCoderTask).toEqual(['trusted.ts']);
			expect(Array.isArray(sessionAgain.modifiedFilesThisCoderTask)).toBe(true);
		});

		it('should handle number (42) assigned to modifiedFilesThisCoderTask', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			// Corrupt with number
			(session as any).modifiedFilesThisCoderTask = 42;

			// Verify it can be read (type coercion happens)
			expect((session as any).modifiedFilesThisCoderTask).toBe(42);

			// Should not crash when accessing array methods (if used)
			expect(() => {
				// These would fail but shouldn't crash the state system
				// The key is that ensureAgentSession doesn't crash
				ensureAgentSession(sessionId1, 'coder');
			}).not.toThrow();
		});

		it('should handle string assigned to modifiedFilesThisCoderTask', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			// Corrupt with string
			(session as any).modifiedFilesThisCoderTask = 'invalid-string';

			// Verify it persists
			expect((session as any).modifiedFilesThisCoderTask).toBe(
				'invalid-string',
			);

			// Should not crash ensureAgentSession
			expect(() => {
				ensureAgentSession(sessionId1, 'coder');
			}).not.toThrow();
		});

		it('should handle empty object {} assigned to modifiedFilesThisCoderTask', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			// Corrupt with object
			(session as any).modifiedFilesThisCoderTask = {};

			// Should not crash
			expect(() => {
				ensureAgentSession(sessionId1, 'coder');
			}).not.toThrow();
		});

		it('should handle array-like object assigned to modifiedFilesThisCoderTask', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			// Corrupt with array-like object (has length but not real array)
			const arrayLike = { length: 3, '0': 'file1' };
			(session as any).modifiedFilesThisCoderTask = arrayLike;

			// Should not crash
			expect(() => {
				ensureAgentSession(sessionId1, 'coder');
			}).not.toThrow();
		});
	});

	describe('pushing non-string values into array', () => {
		it('should not crash when pushing number into modifiedFilesThisCoderTask', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			// Push a number (type violation)
			expect(() => {
				session.modifiedFilesThisCoderTask.push(123 as any);
			}).not.toThrow();

			// Array now contains non-string
			expect(session.modifiedFilesThisCoderTask).toContain(123);
		});

		it('should not crash when pushing null into modifiedFilesThisCoderTask', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			expect(() => {
				session.modifiedFilesThisCoderTask.push(null as any);
			}).not.toThrow();

			expect(session.modifiedFilesThisCoderTask).toContain(null);
		});

		it('should not crash when pushing undefined into modifiedFilesThisCoderTask', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			expect(() => {
				session.modifiedFilesThisCoderTask.push(undefined as any);
			}).not.toThrow();

			expect(session.modifiedFilesThisCoderTask).toContain(undefined);
		});

		it('should not crash when pushing object into modifiedFilesThisCoderTask', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			const obj = { path: '../etc/passwd' };
			expect(() => {
				session.modifiedFilesThisCoderTask.push(obj as any);
			}).not.toThrow();

			expect(session.modifiedFilesThisCoderTask).toContain(obj);
		});

		it('should not crash when pushing array into modifiedFilesThisCoderTask', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			expect(() => {
				session.modifiedFilesThisCoderTask.push(['file1', 'file2'] as any);
			}).not.toThrow();

			expect(session.modifiedFilesThisCoderTask[0]).toEqual(['file1', 'file2']);
		});

		it('should not crash when pushing boolean into modifiedFilesThisCoderTask', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			expect(() => {
				session.modifiedFilesThisCoderTask.push(true as any);
				session.modifiedFilesThisCoderTask.push(false as any);
			}).not.toThrow();

			expect(session.modifiedFilesThisCoderTask).toContain(true);
			expect(session.modifiedFilesThisCoderTask).toContain(false);
		});
	});

	describe('session isolation', () => {
		it('should NOT share modifiedFilesThisCoderTask between different sessions', () => {
			// Create two different sessions
			const session1 = ensureAgentSession(sessionId1, 'coder');
			const session2 = ensureAgentSession(sessionId2, 'reviewer');

			// Add files to session 1
			session1.modifiedFilesThisCoderTask.push('file-a.ts');
			session1.modifiedFilesThisCoderTask.push('file-b.ts');

			// Session 2 should be independent (new session gets fresh empty array)
			expect(session2.modifiedFilesThisCoderTask).toEqual([]);

			// Verify they are different array references
			expect(session1.modifiedFilesThisCoderTask).not.toBe(
				session2.modifiedFilesThisCoderTask,
			);
		});

		it('should maintain isolation when both sessions are from same agent type', () => {
			const sessionA = ensureAgentSession('session-a', 'coder');
			const sessionB = ensureAgentSession('session-b', 'coder');

			// Modify session A
			sessionA.modifiedFilesThisCoderTask.push('a.ts');

			// Session B should remain empty
			expect(sessionB.modifiedFilesThisCoderTask).toEqual([]);
			expect(sessionB.modifiedFilesThisCoderTask.length).toBe(0);
		});

		it('should isolate corrupted arrays between sessions', () => {
			const session1 = ensureAgentSession(sessionId1, 'coder');
			const session2 = ensureAgentSession(sessionId2, 'coder');

			// Corrupt session 1 with number
			(session1 as any).modifiedFilesThisCoderTask = 999;

			// Session 2 should still be a proper empty array
			expect(session2.modifiedFilesThisCoderTask).toEqual([]);
			expect(Array.isArray(session2.modifiedFilesThisCoderTask)).toBe(true);
		});
	});

	describe('resetSwarmState clears arrays', () => {
		it('should clear all sessions with modifiedFilesThisCoderTask on reset', () => {
			// Create sessions with data
			const session1 = ensureAgentSession(sessionId1, 'coder');
			const session2 = ensureAgentSession(sessionId2, 'reviewer');

			// Add files
			session1.modifiedFilesThisCoderTask.push('file1.ts');
			session1.modifiedFilesThisCoderTask.push('file2.ts');
			session2.modifiedFilesThisCoderTask.push('review-file.ts');

			// Verify data exists
			expect(session1.modifiedFilesThisCoderTask.length).toBe(2);
			expect(session2.modifiedFilesThisCoderTask.length).toBe(1);

			// Reset
			resetSwarmState();

			// Sessions should be gone
			expect(getAgentSession(sessionId1)).toBeUndefined();
			expect(getAgentSession(sessionId2)).toBeUndefined();

			// Creating new sessions should get fresh arrays
			const newSession1 = ensureAgentSession(sessionId1, 'coder');
			expect(newSession1.modifiedFilesThisCoderTask).toEqual([]);
		});

		it('should clear sessions with corrupted modifiedFilesThisCoderTask', () => {
			// Create session with corrupted value
			const session = ensureAgentSession(sessionId1, 'coder');
			(session as any).modifiedFilesThisCoderTask = 'corrupted';

			// Reset should clear everything
			resetSwarmState();

			// New session should be clean
			const newSession = ensureAgentSession(sessionId1, 'coder');
			expect(newSession.modifiedFilesThisCoderTask).toEqual([]);
			expect(Array.isArray(newSession.modifiedFilesThisCoderTask)).toBe(true);
		});

		it('should handle reset after undefined field session', () => {
			// Manually create legacy session with undefined field
			const legacySession = {
				agentName: 'legacy',
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
				taskWorkflowStates: new Map(),
				lastGateOutcome: null,
				declaredCoderScope: null,
				lastScopeViolation: null,
				lastPhaseCompleteTimestamp: 0,
				lastPhaseCompletePhase: 0,
				phaseAgentsDispatched: new Set(),
				// modifiedFilesThisCoderTask is undefined
			} as any; // Type assertion to simulate partial legacy object

			swarmState.agentSessions.set('legacy', legacySession);

			// Reset should handle undefined field gracefully
			expect(() => {
				resetSwarmState();
			}).not.toThrow();

			// Should be clean
			expect(getAgentSession('legacy')).toBeUndefined();
		});
	});

	describe('concurrent push / mutation hazard', () => {
		it('should handle rapid sequential pushes without data loss', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			// Rapidly push many files
			const fileCount = 100;
			for (let i = 0; i < fileCount; i++) {
				session.modifiedFilesThisCoderTask.push(`file-${i}.ts`);
			}

			// All files should be present
			expect(session.modifiedFilesThisCoderTask.length).toBe(fileCount);
		});

		it('should handle push after reassignment attempts', () => {
			const session = ensureAgentSession(sessionId1, 'coder');
			session.currentTaskId = 'task-reassignment-repair';

			// Seed the authoritative task-keyed attribution.
			expect(
				recordModifiedFilesForTask(session, 'task-reassignment-repair', [
					'original.ts',
				]),
			).toBe(true);

			// Attempt to reassign the array entirely (simulating mutation attack)
			(session as any).modifiedFilesThisCoderTask = ['hacked.js'];

			// Re-projection discards direct reassignment of the compatibility view.
			const sessionAgain = ensureAgentSession(sessionId1, 'coder');

			expect(sessionAgain.modifiedFilesThisCoderTask).toEqual(['original.ts']);
		});

		it('should handle concurrent-like access patterns', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			// Simulate concurrent modifications
			const operations: Array<() => void> = [];

			for (let i = 0; i < 50; i++) {
				operations.push(() => {
					session.modifiedFilesThisCoderTask.push(`concurrent-${i}.ts`);
				});
			}

			// Execute all operations
			operations.forEach((op) => op());

			// All should be present
			expect(session.modifiedFilesThisCoderTask.length).toBe(50);
		});

		it('should handle splice operations without crashing', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			// Add files
			session.modifiedFilesThisCoderTask.push('file1.ts');
			session.modifiedFilesThisCoderTask.push('file2.ts');
			session.modifiedFilesThisCoderTask.push('file3.ts');

			// Splice should work
			expect(() => {
				session.modifiedFilesThisCoderTask.splice(1, 1);
			}).not.toThrow();

			expect(session.modifiedFilesThisCoderTask).toEqual([
				'file1.ts',
				'file3.ts',
			]);
		});

		it('should handle length manipulation attempts', () => {
			const session = ensureAgentSession(sessionId1, 'coder');

			session.modifiedFilesThisCoderTask.push('file.ts');

			// Try to truncate
			expect(() => {
				(session.modifiedFilesThisCoderTask as any).length = 0;
			}).not.toThrow();

			// Length should be updated
			expect(session.modifiedFilesThisCoderTask.length).toBe(0);
		});
	});

	describe('startAgentSession initialization', () => {
		it('should initialize modifiedFilesThisCoderTask to empty array', () => {
			startAgentSession(sessionId1, 'coder');

			const session = getAgentSession(sessionId1);
			expect(session).toBeDefined();
			expect(session!.modifiedFilesThisCoderTask).toEqual([]);
			expect(Array.isArray(session!.modifiedFilesThisCoderTask)).toBe(true);
		});

		it('should create independent arrays for new sessions', () => {
			startAgentSession(sessionId1, 'coder');
			startAgentSession(sessionId2, 'reviewer');

			const s1 = getAgentSession(sessionId1);
			const s2 = getAgentSession(sessionId2);

			// Different array references
			expect(s1!.modifiedFilesThisCoderTask).not.toBe(
				s2!.modifiedFilesThisCoderTask,
			);

			// Both are empty arrays
			expect(s1!.modifiedFilesThisCoderTask).toEqual([]);
			expect(s2!.modifiedFilesThisCoderTask).toEqual([]);
		});
	});
});
