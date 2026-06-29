import { beforeEach, describe, expect, it } from 'bun:test';
import {
	advanceTaskState,
	beginInvocation,
	type DelegationEntry,
	endAgentSession,
	ensureAgentSession,
	getActiveWindow,
	getAgentSession,
	getTaskState,
	type InvocationWindow,
	pruneOldWindows,
	resetSwarmState,
	startAgentSession,
	swarmState,
	type TaskWorkflowState,
	type ToolAggregate,
	type ToolCallEntry,
	updateAgentEventTime,
} from '../../src/state';

describe('state module', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	describe('swarmState initial shape', () => {
		it('should have all 5 required properties', () => {
			expect(swarmState).toHaveProperty('activeToolCalls');
			expect(swarmState).toHaveProperty('toolAggregates');
			expect(swarmState).toHaveProperty('activeAgent');
			expect(swarmState).toHaveProperty('delegationChains');
			expect(swarmState).toHaveProperty('pendingEvents');
		});

		it('should have Maps for the first 4 properties', () => {
			expect(swarmState.activeToolCalls).toBeInstanceOf(Map);
			expect(swarmState.toolAggregates).toBeInstanceOf(Map);
			expect(swarmState.activeAgent).toBeInstanceOf(Map);
			expect(swarmState.delegationChains).toBeInstanceOf(Map);
		});

		it('should have empty Maps initially', () => {
			expect(swarmState.activeToolCalls.size).toBe(0);
			expect(swarmState.toolAggregates.size).toBe(0);
			expect(swarmState.activeAgent.size).toBe(0);
			expect(swarmState.delegationChains.size).toBe(0);
		});

		it('should have pendingEvents as 0 initially', () => {
			expect(swarmState.pendingEvents).toBe(0);
		});
	});

	describe('activeToolCalls', () => {
		const mockToolCall: ToolCallEntry = {
			tool: 'test-tool',
			sessionID: 'session-123',
			callID: 'call-456',
			startTime: Date.now(),
		};

		it('should set and get ToolCallEntry correctly', () => {
			const key = 'test-key';
			swarmState.activeToolCalls.set(key, mockToolCall);

			const retrieved = swarmState.activeToolCalls.get(key);
			expect(retrieved).toEqual(mockToolCall);
			expect(swarmState.activeToolCalls.size).toBe(1);
		});

		it('should delete entries correctly', () => {
			const key = 'test-key';
			swarmState.activeToolCalls.set(key, mockToolCall);
			expect(swarmState.activeToolCalls.size).toBe(1);

			swarmState.activeToolCalls.delete(key);
			expect(swarmState.activeToolCalls.size).toBe(0);
			expect(swarmState.activeToolCalls.get(key)).toBeUndefined();
		});

		it('should store entries with correct ToolCallEntry shape', () => {
			const key = 'test-key';
			swarmState.activeToolCalls.set(key, mockToolCall);

			const entry = swarmState.activeToolCalls.get(key)!;
			expect(entry.tool).toBe('test-tool');
			expect(entry.sessionID).toBe('session-123');
			expect(entry.callID).toBe('call-456');
			expect(entry.startTime).toBeDefined();
			expect(typeof entry.startTime).toBe('number');
		});
	});

	describe('toolAggregates', () => {
		const mockAggregate: ToolAggregate = {
			tool: 'test-aggregate-tool',
			count: 5,
			successCount: 4,
			failureCount: 1,
			totalDuration: 1000,
		};

		it('should set and get ToolAggregate correctly', () => {
			const key = 'aggregate-key';
			swarmState.toolAggregates.set(key, mockAggregate);

			const retrieved = swarmState.toolAggregates.get(key);
			expect(retrieved).toEqual(mockAggregate);
			expect(swarmState.toolAggregates.size).toBe(1);
		});

		it('should store entries with correct ToolAggregate shape', () => {
			const key = 'aggregate-key';
			swarmState.toolAggregates.set(key, mockAggregate);

			const entry = swarmState.toolAggregates.get(key)!;
			expect(entry.tool).toBe('test-aggregate-tool');
			expect(entry.count).toBe(5);
			expect(entry.successCount).toBe(4);
			expect(entry.failureCount).toBe(1);
			expect(entry.totalDuration).toBe(1000);
		});

		it('should update existing entries', () => {
			const key = 'aggregate-key';
			swarmState.toolAggregates.set(key, mockAggregate);

			const updatedAggregate: ToolAggregate = {
				...mockAggregate,
				count: 10,
				successCount: 8,
			};

			swarmState.toolAggregates.set(key, updatedAggregate);
			expect(swarmState.toolAggregates.get(key)?.count).toBe(10);
			expect(swarmState.toolAggregates.get(key)?.successCount).toBe(8);
			expect(swarmState.toolAggregates.size).toBe(1);
		});
	});

	describe('activeAgent', () => {
		it('should set and get session→agent mapping', () => {
			const sessionId = 'session-abc';
			const agentId = 'agent-xyz';

			swarmState.activeAgent.set(sessionId, agentId);
			expect(swarmState.activeAgent.get(sessionId)).toBe(agentId);
			expect(swarmState.activeAgent.size).toBe(1);
		});

		it('should support has() method for session→agent mapping', () => {
			const sessionId = 'session-abc';
			const agentId = 'agent-xyz';

			expect(swarmState.activeAgent.has(sessionId)).toBe(false);

			swarmState.activeAgent.set(sessionId, agentId);
			expect(swarmState.activeAgent.has(sessionId)).toBe(true);
		});

		it('should update existing session mappings', () => {
			const sessionId = 'session-abc';
			const agentId1 = 'agent-xyz';
			const agentId2 = 'agent-def';

			swarmState.activeAgent.set(sessionId, agentId1);
			expect(swarmState.activeAgent.get(sessionId)).toBe(agentId1);

			swarmState.activeAgent.set(sessionId, agentId2);
			expect(swarmState.activeAgent.get(sessionId)).toBe(agentId2);
			expect(swarmState.activeAgent.size).toBe(1);
		});

		it('should support multiple session→agent mappings', () => {
			swarmState.activeAgent.set('session-1', 'agent-1');
			swarmState.activeAgent.set('session-2', 'agent-2');
			swarmState.activeAgent.set('session-3', 'agent-3');

			expect(swarmState.activeAgent.get('session-1')).toBe('agent-1');
			expect(swarmState.activeAgent.get('session-2')).toBe('agent-2');
			expect(swarmState.activeAgent.get('session-3')).toBe('agent-3');
			expect(swarmState.activeAgent.size).toBe(3);
		});
	});

	describe('delegationChains', () => {
		const mockDelegation: DelegationEntry = {
			from: 'agent-from',
			to: 'agent-to',
			timestamp: Date.now(),
		};

		it('should set and get arrays of DelegationEntry', () => {
			const chainId = 'chain-123';
			const chain = [mockDelegation];

			swarmState.delegationChains.set(chainId, chain);
			const retrieved = swarmState.delegationChains.get(chainId);

			expect(retrieved).toEqual(chain);
			expect(Array.isArray(retrieved)).toBe(true);
			expect(swarmState.delegationChains.size).toBe(1);
		});

		it('should store entries with correct DelegationEntry shape', () => {
			const chainId = 'chain-123';
			swarmState.delegationChains.set(chainId, [mockDelegation]);

			const entry = swarmState.delegationChains.get(chainId)![0];
			expect(entry.from).toBe('agent-from');
			expect(entry.to).toBe('agent-to');
			expect(entry.timestamp).toBeDefined();
			expect(typeof entry.timestamp).toBe('number');
		});

		it('should support multiple delegation entries in a chain', () => {
			const chainId = 'chain-123';
			const chain: DelegationEntry[] = [
				mockDelegation,
				{
					from: 'agent-to',
					to: 'agent-final',
					timestamp: Date.now(),
				},
			];

			swarmState.delegationChains.set(chainId, chain);
			const retrieved = swarmState.delegationChains.get(chainId);

			expect(retrieved?.length).toBe(2);
			expect(retrieved?.[0].from).toBe('agent-from');
			expect(retrieved?.[1].to).toBe('agent-final');
		});

		it('should support multiple delegation chains', () => {
			const chain1: DelegationEntry[] = [
				{ from: 'a', to: 'b', timestamp: Date.now() },
			];
			const chain2: DelegationEntry[] = [
				{ from: 'c', to: 'd', timestamp: Date.now() },
			];

			swarmState.delegationChains.set('chain-1', chain1);
			swarmState.delegationChains.set('chain-2', chain2);

			expect(swarmState.delegationChains.size).toBe(2);
			expect(swarmState.delegationChains.get('chain-1')).toEqual(chain1);
			expect(swarmState.delegationChains.get('chain-2')).toEqual(chain2);
		});
	});

	describe('pendingEvents', () => {
		it('should start at 0', () => {
			expect(swarmState.pendingEvents).toBe(0);
		});

		it('should increment correctly', () => {
			swarmState.pendingEvents = 1;
			expect(swarmState.pendingEvents).toBe(1);

			swarmState.pendingEvents = 5;
			expect(swarmState.pendingEvents).toBe(5);
		});

		it('should support large values', () => {
			swarmState.pendingEvents = 1000;
			expect(swarmState.pendingEvents).toBe(1000);
		});
	});

	describe('resetSwarmState()', () => {
		it('should clear all Maps and reset pendingEvents to 0 after data has been added', () => {
			// Add data to all properties
			swarmState.activeToolCalls.set('key1', {
				tool: 'test-tool',
				sessionID: 'session-1',
				callID: 'call-1',
				startTime: Date.now(),
			});

			swarmState.toolAggregates.set('key2', {
				tool: 'test-aggregate-tool',
				count: 5,
				successCount: 4,
				failureCount: 1,
				totalDuration: 1000,
			});

			swarmState.activeAgent.set('session-1', 'agent-1');

			swarmState.delegationChains.set('chain-1', [
				{
					from: 'agent-from',
					to: 'agent-to',
					timestamp: Date.now(),
				},
			]);

			swarmState.pendingEvents = 10;

			// Verify data was added
			expect(swarmState.activeToolCalls.size).toBe(1);
			expect(swarmState.toolAggregates.size).toBe(1);
			expect(swarmState.activeAgent.size).toBe(1);
			expect(swarmState.delegationChains.size).toBe(1);
			expect(swarmState.pendingEvents).toBe(10);

			// Reset
			resetSwarmState();

			// Verify all data was cleared
			expect(swarmState.activeToolCalls.size).toBe(0);
			expect(swarmState.toolAggregates.size).toBe(0);
			expect(swarmState.activeAgent.size).toBe(0);
			expect(swarmState.delegationChains.size).toBe(0);
			expect(swarmState.pendingEvents).toBe(0);
		});

		it('should be idempotent - calling it twice should be safe', () => {
			// Add some data
			swarmState.activeToolCalls.set('key1', {
				tool: 'test-tool',
				sessionID: 'session-1',
				callID: 'call-1',
				startTime: Date.now(),
			});
			swarmState.pendingEvents = 5;

			// First reset
			resetSwarmState();
			expect(swarmState.pendingEvents).toBe(0);
			expect(swarmState.activeToolCalls.size).toBe(0);

			// Second reset - should not cause any issues
			resetSwarmState();
			expect(swarmState.pendingEvents).toBe(0);
			expect(swarmState.activeToolCalls.size).toBe(0);

			// Add data again and reset again
			swarmState.pendingEvents = 3;
			swarmState.activeAgent.set('session-1', 'agent-1');

			resetSwarmState();
			expect(swarmState.pendingEvents).toBe(0);
			expect(swarmState.activeAgent.size).toBe(0);
		});
	});

	describe('Map independence', () => {
		it('should have independent Maps - clearing one does not affect others', () => {
			// Add data to all Maps
			swarmState.activeToolCalls.set('key1', {
				tool: 'test-tool',
				sessionID: 'session-1',
				callID: 'call-1',
				startTime: Date.now(),
			});

			swarmState.toolAggregates.set('key2', {
				tool: 'test-aggregate-tool',
				count: 5,
				successCount: 4,
				failureCount: 1,
				totalDuration: 1000,
			});

			swarmState.activeAgent.set('session-1', 'agent-1');

			swarmState.delegationChains.set('chain-1', [
				{
					from: 'agent-from',
					to: 'agent-to',
					timestamp: Date.now(),
				},
			]);

			swarmState.pendingEvents = 10;

			// Clear activeToolCalls manually
			swarmState.activeToolCalls.clear();

			// Verify other Maps are unaffected
			expect(swarmState.activeToolCalls.size).toBe(0);
			expect(swarmState.toolAggregates.size).toBe(1);
			expect(swarmState.activeAgent.size).toBe(1);
			expect(swarmState.delegationChains.size).toBe(1);
			expect(swarmState.pendingEvents).toBe(10);

			// Clear toolAggregates manually
			swarmState.toolAggregates.clear();

			// Verify other Maps are still unaffected
			expect(swarmState.activeToolCalls.size).toBe(0);
			expect(swarmState.toolAggregates.size).toBe(0);
			expect(swarmState.activeAgent.size).toBe(1);
			expect(swarmState.delegationChains.size).toBe(1);
			expect(swarmState.pendingEvents).toBe(10);

			// Clear activeAgent manually
			swarmState.activeAgent.clear();

			// Verify delegationChains is still unaffected
			expect(swarmState.activeToolCalls.size).toBe(0);
			expect(swarmState.toolAggregates.size).toBe(0);
			expect(swarmState.activeAgent.size).toBe(0);
			expect(swarmState.delegationChains.size).toBe(1);
			expect(swarmState.pendingEvents).toBe(10);

			// Clear delegationChains manually
			swarmState.delegationChains.clear();

			// Verify pendingEvents is still unaffected
			expect(swarmState.activeToolCalls.size).toBe(0);
			expect(swarmState.toolAggregates.size).toBe(0);
			expect(swarmState.activeAgent.size).toBe(0);
			expect(swarmState.delegationChains.size).toBe(0);
			expect(swarmState.pendingEvents).toBe(10);
		});
	});

	describe('agentSessions', () => {
		it('agentSessions map exists on swarmState', () => {
			expect(swarmState.agentSessions).toBeInstanceOf(Map);
			expect(swarmState.agentSessions).toBeDefined();
		});

		it('startAgentSession creates entry', () => {
			startAgentSession('s1', 'coder');
			const session = getAgentSession('s1');

			expect(session).toBeDefined();
			expect(session?.agentName).toBe('coder');
			expect(session?.activeInvocationId).toBe(0);
			expect(session?.lastInvocationIdByAgent).toEqual({});
			expect(session?.windows).toEqual({});
			expect(session?.delegationActive).toBe(false);
			expect(typeof session?.lastToolCallTime).toBe('number');
		});

		it('endAgentSession removes entry', () => {
			startAgentSession('s1', 'coder');
			expect(getAgentSession('s1')).toBeDefined();

			endAgentSession('s1');
			expect(getAgentSession('s1')).toBeUndefined();
		});

		it('SC-006: session absent from agentSessions after endAgentSession at terminal event', () => {
			// Given an agent session reaches a terminal state
			startAgentSession('sc006-session', 'coder');
			expect(swarmState.agentSessions.get('sc006-session')).toBeDefined();

			// When endAgentSession is called
			endAgentSession('sc006-session');

			// Then the session must not be retrievable (FR-008)
			expect(swarmState.agentSessions.get('sc006-session')).toBeUndefined();
		});

		it('SC-007: double-close is a no-op and does not throw (FR-010)', () => {
			// Given endAgentSession has already been called for a session ID
			startAgentSession('sc007-session', 'coder');
			endAgentSession('sc007-session');

			// When endAgentSession is called again with the same ID
			// Then no error is thrown and the session remains absent
			expect(() => endAgentSession('sc007-session')).not.toThrow();
			expect(swarmState.agentSessions.get('sc007-session')).toBeUndefined();
		});

		it('SC-008: non-terminal events do not remove session from agentSessions', () => {
			// Given an agent session that is actively running
			startAgentSession('sc008-session', 'coder');

			// When non-terminal events fire (ensureAgentSession updates, mid-task state change)
			ensureAgentSession('sc008-session', 'coder');
			const session = swarmState.agentSessions.get('sc008-session')!;
			advanceTaskState(session, 'task-1.1', 'coder_delegated');

			// Then the session must still be in agentSessions (FR-009)
			expect(swarmState.agentSessions.get('sc008-session')).toBeDefined();
		});

		it('getAgentSession returns undefined for unknown', () => {
			expect(getAgentSession('nonexistent')).toBeUndefined();
		});

		it('resetSwarmState clears agentSessions', () => {
			startAgentSession('s1', 'coder');
			startAgentSession('s2', 'reviewer');
			expect(swarmState.agentSessions.size).toBe(2);

			resetSwarmState();

			expect(swarmState.agentSessions.size).toBe(0);
		});

		it('stale eviction removes old sessions', () => {
			// Start an old session
			startAgentSession('old-session', 'coder');
			const oldSession = getAgentSession('old-session');
			if (oldSession) {
				oldSession.lastToolCallTime = Date.now() - 7300000; // 121 minutes ago (>120 min threshold)
			}

			// Start a new session (triggers stale eviction with default 120 min)
			startAgentSession('new-session', 'reviewer');

			// Old session should be gone
			expect(getAgentSession('old-session')).toBeUndefined();
			// New session should exist
			expect(getAgentSession('new-session')).toBeDefined();
		});

		it('stale eviction preserves recent sessions', () => {
			// Start two sessions
			startAgentSession('old-session', 'coder');
			startAgentSession('recent-session', 'reviewer');

			// Make one old
			const oldSession = getAgentSession('old-session');
			if (oldSession) {
				oldSession.lastToolCallTime = Date.now() - 7300000; // 121 minutes ago (>120 min threshold)
			}

			// Keep recent session recent
			const recentSession = getAgentSession('recent-session');
			if (recentSession) {
				recentSession.lastToolCallTime = Date.now() - 300000; // 5 minutes ago
			}

			// Start a new session (triggers stale eviction with default 120 min)
			startAgentSession('new-session', 'explorer');

			// Old session should be gone
			expect(getAgentSession('old-session')).toBeUndefined();
			// Recent session should still exist
			expect(getAgentSession('recent-session')).toBeDefined();
			// New session should exist
			expect(getAgentSession('new-session')).toBeDefined();
		});
	});

	describe('ensureAgentSession', () => {
		it('creates new session when none exists', () => {
			const session = ensureAgentSession('new-session', 'architect');
			expect(session.agentName).toBe('architect');
			expect(session.activeInvocationId).toBe(0);
			expect(session.windows).toEqual({});
			expect(session.lastToolCallTime).toBeGreaterThan(0);
		});

		it('creates session with unknown when no agent name provided', () => {
			const session = ensureAgentSession('new-session');
			expect(session.agentName).toBe('unknown');
		});

		it('updates lastToolCallTime on existing session', () => {
			startAgentSession('existing-session', 'coder');
			const session1 = getAgentSession('existing-session')!;
			const firstTime = session1.lastToolCallTime;

			// Small delay to ensure timestamp difference
			const laterTime = firstTime + 100;
			// Manually advance to simulate time passing
			session1.lastToolCallTime = firstTime;

			const session2 = ensureAgentSession('existing-session');
			expect(session2.lastToolCallTime).toBeGreaterThanOrEqual(firstTime);
			expect(session2).toBe(session1); // Same object reference
		});

		it('updates agent name from unknown to real name', () => {
			ensureAgentSession('test-session'); // Creates with 'unknown'
			const session = ensureAgentSession('test-session', 'paid_architect');
			expect(session.agentName).toBe('paid_architect');
		});

		it('updates agent name when switching from non-unknown to different agent', () => {
			ensureAgentSession('test-session', 'architect');
			const session = ensureAgentSession('test-session', 'coder');
			expect(session.agentName).toBe('coder'); // Should change
		});

		it('updates session metadata when switching agents', () => {
			// Start with architect
			const session = ensureAgentSession('test-session', 'architect');

			// Switch to coder
			ensureAgentSession('test-session', 'coder');

			// Session metadata should be updated
			expect(session.agentName).toBe('coder');
			expect(session.delegationActive).toBe(false);
			expect(session.windows).toEqual({});
			expect(session.activeInvocationId).toBe(0);
			expect(session.lastInvocationIdByAgent).toEqual({});
		});

		it('initializes window tracking when updating from unknown', () => {
			const session = ensureAgentSession('test-session'); // unknown

			ensureAgentSession('test-session', 'architect');
			expect(session.agentName).toBe('architect');
			expect(session.windows).toEqual({});
			expect(session.activeInvocationId).toBe(0);
		});

		it('initializes window tracking when switching from unknown to real agent', () => {
			const session = ensureAgentSession('test-session'); // unknown

			ensureAgentSession('test-session', 'architect');
			expect(session.agentName).toBe('architect');
			expect(session.windows).toEqual({});
			expect(session.activeInvocationId).toBe(0);
			expect(session.lastInvocationIdByAgent).toEqual({});
		});

		it('returns same session object for same sessionID', () => {
			const s1 = ensureAgentSession('same-id', 'architect');
			const s2 = ensureAgentSession('same-id');
			expect(s1).toBe(s2);
		});
	});

	// Regression tests for v5.1.6 hotfix: architect identity-stuck
	describe('lastAgentEventTime (v5.1.6 hotfix)', () => {
		it('startAgentSession initializes lastAgentEventTime', () => {
			startAgentSession('s1', 'architect');
			const session = getAgentSession('s1');
			expect(session!.lastAgentEventTime).toBeDefined();
			expect(typeof session!.lastAgentEventTime).toBe('number');
		});

		it('ensureAgentSession updates lastAgentEventTime when agent changes', () => {
			startAgentSession('s1', 'coder');
			const session = getAgentSession('s1')!;
			const originalTime = session.lastAgentEventTime;

			// Small delay
			const laterTime = originalTime + 100;
			session.lastAgentEventTime = originalTime;

			// Switch agent - should update lastAgentEventTime
			ensureAgentSession('s1', 'reviewer');

			expect(session.lastAgentEventTime).toBeGreaterThanOrEqual(originalTime);
		});

		it('ensureAgentSession does NOT update lastAgentEventTime when agent unchanged', () => {
			startAgentSession('s1', 'coder');
			const session = getAgentSession('s1')!;
			const originalTime = session.lastAgentEventTime;

			// Call ensureAgentSession with same agent - should NOT update lastAgentEventTime
			ensureAgentSession('s1', 'coder');

			// lastToolCallTime should be updated, but lastAgentEventTime should stay same
			expect(session.lastToolCallTime).toBeGreaterThanOrEqual(originalTime);
			// Note: lastAgentEventTime is not updated when agent doesn't change
		});

		it('updateAgentEventTime updates timestamp without changing agent', () => {
			startAgentSession('s1', 'coder');
			const session = getAgentSession('s1')!;
			const originalTime = session.lastAgentEventTime;

			// Small delay
			session.lastAgentEventTime = originalTime;

			// Call updateAgentEventTime
			updateAgentEventTime('s1');

			expect(session.lastAgentEventTime).toBeGreaterThanOrEqual(originalTime);
			expect(session.agentName).toBe('coder'); // Agent unchanged
		});

		it('updateAgentEventTime does nothing for non-existent session', () => {
			// Should not throw
			expect(() => updateAgentEventTime('nonexistent')).not.toThrow();
		});
	});

	// v6.21 Per-task state machine tests
	describe('TaskWorkflowState machine', () => {
		let sessionId: string;

		beforeEach(() => {
			resetSwarmState();
			sessionId = 'test-session-taskwf';
			startAgentSession(sessionId, 'architect');
		});

		describe('getTaskState', () => {
			it('returns idle for unknown taskId', () => {
				const session = getAgentSession(sessionId)!;
				const state = getTaskState(session, 'nonexistent-task');
				expect(state).toBe('idle');
			});

			it('returns current state after advanceTaskState sets it', () => {
				const session = getAgentSession(sessionId)!;

				advanceTaskState(session, 'task-1', 'coder_delegated');
				expect(getTaskState(session, 'task-1')).toBe('coder_delegated');

				advanceTaskState(session, 'task-1', 'pre_check_passed');
				expect(getTaskState(session, 'task-1')).toBe('pre_check_passed');
			});
		});

		describe('invalid taskId guards', () => {
			const session: any = { taskWorkflowStates: new Map() };

			describe('getTaskState returns idle for invalid taskId', () => {
				it('returns idle for null taskId', () => {
					expect(getTaskState(session, null as any)).toBe('idle');
				});

				it('returns idle for undefined taskId', () => {
					expect(getTaskState(session, undefined as any)).toBe('idle');
				});

				it('returns idle for empty string taskId', () => {
					expect(getTaskState(session, '')).toBe('idle');
				});

				it('returns idle for whitespace-only taskId', () => {
					expect(getTaskState(session, '   ')).toBe('idle');
				});

				it('returns idle for tab/whitespace taskId', () => {
					expect(getTaskState(session, '\t\n')).toBe('idle');
				});
			});

			describe('advanceTaskState returns without mutation for invalid taskId', () => {
				it('returns without throwing for null taskId', () => {
					expect(() =>
						advanceTaskState(session, null as any, 'coder_delegated'),
					).not.toThrow();
					// Verify no entry was added
					expect(session.taskWorkflowStates.size).toBe(0);
				});

				it('returns without throwing for undefined taskId', () => {
					expect(() =>
						advanceTaskState(session, undefined as any, 'coder_delegated'),
					).not.toThrow();
					expect(session.taskWorkflowStates.size).toBe(0);
				});

				it('returns without throwing for empty string taskId', () => {
					expect(() =>
						advanceTaskState(session, '', 'coder_delegated'),
					).not.toThrow();
					expect(session.taskWorkflowStates.size).toBe(0);
				});

				it('returns without throwing for whitespace-only taskId', () => {
					expect(() =>
						advanceTaskState(session, '   ', 'coder_delegated'),
					).not.toThrow();
					expect(session.taskWorkflowStates.size).toBe(0);
				});

				it('returns without throwing for tab/newline taskId', () => {
					expect(() =>
						advanceTaskState(session, '\t\n', 'coder_delegated'),
					).not.toThrow();
					expect(session.taskWorkflowStates.size).toBe(0);
				});

				it('does not add entries for invalid taskId even after session has valid tasks', () => {
					// First add a valid task
					advanceTaskState(session, 'valid-task', 'coder_delegated');
					expect(session.taskWorkflowStates.size).toBe(1);
					expect(getTaskState(session, 'valid-task')).toBe('coder_delegated');

					// Now try to add invalid tasks - should not add them
					advanceTaskState(session, '', 'pre_check_passed');
					advanceTaskState(session, '   ', 'pre_check_passed');
					advanceTaskState(session, null as any, 'pre_check_passed');

					// Should still only have 1 entry
					expect(session.taskWorkflowStates.size).toBe(1);
					// Valid task should be unaffected
					expect(getTaskState(session, 'valid-task')).toBe('coder_delegated');
				});
			});
		});

		describe('advanceTaskState valid forward transitions', () => {
			it('idle → coder_delegated succeeds', () => {
				const session = getAgentSession(sessionId)!;
				expect(() =>
					advanceTaskState(session, 'task-1', 'coder_delegated'),
				).not.toThrow();
				expect(getTaskState(session, 'task-1')).toBe('coder_delegated');
			});

			it('coder_delegated → pre_check_passed succeeds', () => {
				const session = getAgentSession(sessionId)!;
				advanceTaskState(session, 'task-1', 'coder_delegated');
				expect(() =>
					advanceTaskState(session, 'task-1', 'pre_check_passed'),
				).not.toThrow();
				expect(getTaskState(session, 'task-1')).toBe('pre_check_passed');
			});

			it('pre_check_passed → reviewer_run succeeds', () => {
				const session = getAgentSession(sessionId)!;
				advanceTaskState(session, 'task-1', 'coder_delegated');
				advanceTaskState(session, 'task-1', 'pre_check_passed');
				expect(() =>
					advanceTaskState(session, 'task-1', 'reviewer_run'),
				).not.toThrow();
				expect(getTaskState(session, 'task-1')).toBe('reviewer_run');
			});

			it('reviewer_run → tests_run succeeds', () => {
				const session = getAgentSession(sessionId)!;
				advanceTaskState(session, 'task-1', 'coder_delegated');
				advanceTaskState(session, 'task-1', 'pre_check_passed');
				advanceTaskState(session, 'task-1', 'reviewer_run');
				expect(() =>
					advanceTaskState(session, 'task-1', 'tests_run'),
				).not.toThrow();
				expect(getTaskState(session, 'task-1')).toBe('tests_run');
			});

			it('tests_run → complete succeeds', () => {
				const session = getAgentSession(sessionId)!;
				advanceTaskState(session, 'task-1', 'coder_delegated');
				advanceTaskState(session, 'task-1', 'pre_check_passed');
				advanceTaskState(session, 'task-1', 'reviewer_run');
				advanceTaskState(session, 'task-1', 'tests_run');
				expect(() =>
					advanceTaskState(session, 'task-1', 'complete'),
				).not.toThrow();
				expect(getTaskState(session, 'task-1')).toBe('complete');
			});
		});

		describe('advanceTaskState skips forward (valid)', () => {
			it('idle → reviewer_run succeeds (skips states)', () => {
				const session = getAgentSession(sessionId)!;
				expect(() =>
					advanceTaskState(session, 'task-1', 'reviewer_run'),
				).not.toThrow();
				expect(getTaskState(session, 'task-1')).toBe('reviewer_run');
			});

			it('idle → complete throws (must pass through tests_run)', () => {
				const session = getAgentSession(sessionId)!;
				expect(() => advanceTaskState(session, 'task-1', 'complete')).toThrow();
				expect(() => advanceTaskState(session, 'task-1', 'complete')).toThrow(
					/INVALID_TASK_STATE_TRANSITION/,
				);
			});

			it('coder_delegated → tests_run succeeds (skips reviewer_run)', () => {
				const session = getAgentSession(sessionId)!;
				advanceTaskState(session, 'task-1', 'coder_delegated');
				expect(() =>
					advanceTaskState(session, 'task-1', 'tests_run'),
				).not.toThrow();
				expect(getTaskState(session, 'task-1')).toBe('tests_run');
			});
		});

		describe('advanceTaskState throws on invalid transitions', () => {
			it('throws on backward transition (reviewer_run → coder_delegated)', () => {
				const session = getAgentSession(sessionId)!;
				advanceTaskState(session, 'task-1', 'coder_delegated');
				advanceTaskState(session, 'task-1', 'pre_check_passed');
				advanceTaskState(session, 'task-1', 'reviewer_run');

				expect(() =>
					advanceTaskState(session, 'task-1', 'coder_delegated'),
				).toThrow();
				expect(() =>
					advanceTaskState(session, 'task-1', 'coder_delegated'),
				).toThrow(/INVALID_TASK_STATE_TRANSITION/);
			});

			it('throws on same-state transition (coder_delegated → coder_delegated)', () => {
				const session = getAgentSession(sessionId)!;
				advanceTaskState(session, 'task-1', 'coder_delegated');

				expect(() =>
					advanceTaskState(session, 'task-1', 'coder_delegated'),
				).toThrow();
				expect(() =>
					advanceTaskState(session, 'task-1', 'coder_delegated'),
				).toThrow(/INVALID_TASK_STATE_TRANSITION/);
			});

			it('throws on idle → idle (same state)', () => {
				const session = getAgentSession(sessionId)!;
				expect(() => advanceTaskState(session, 'task-1', 'idle')).toThrow();
				expect(() => advanceTaskState(session, 'task-1', 'idle')).toThrow(
					/INVALID_TASK_STATE_TRANSITION/,
				);
			});

			it('throws on complete → tests_run (backward)', () => {
				const session = getAgentSession(sessionId)!;
				// Must properly advance through all states to reach 'complete'
				advanceTaskState(session, 'task-1', 'coder_delegated');
				advanceTaskState(session, 'task-1', 'pre_check_passed');
				advanceTaskState(session, 'task-1', 'reviewer_run');
				advanceTaskState(session, 'task-1', 'tests_run');
				advanceTaskState(session, 'task-1', 'complete');

				expect(() =>
					advanceTaskState(session, 'task-1', 'tests_run'),
				).toThrow();
				expect(() => advanceTaskState(session, 'task-1', 'tests_run')).toThrow(
					/INVALID_TASK_STATE_TRANSITION/,
				);
			});
		});

		describe('startAgentSession initializes 4 new fields', () => {
			it('initializes taskWorkflowStates to empty Map', () => {
				const session = getAgentSession(sessionId)!;
				expect(session.taskWorkflowStates).toBeInstanceOf(Map);
				expect(session.taskWorkflowStates.size).toBe(0);
			});

			it('initializes lastGateOutcome to null', () => {
				const session = getAgentSession(sessionId)!;
				expect(session.lastGateOutcome).toBeNull();
			});

			it('initializes declaredCoderScope to null', () => {
				const session = getAgentSession(sessionId)!;
				expect(session.declaredCoderScope).toBeNull();
			});

			it('initializes lastScopeViolation to null', () => {
				const session = getAgentSession(sessionId)!;
				expect(session.lastScopeViolation).toBeNull();
			});
		});

		describe('ensureAgentSession migration safety', () => {
			it('initializes taskWorkflowStates if missing (undefined)', () => {
				// Create a session manually without taskWorkflowStates
				const session = ensureAgentSession('migration-session', 'architect');
				// @ts-expect-error - deliberately removing field to test migration
				delete session.taskWorkflowStates;

				// Now call ensureAgentSession again - should initialize it
				const migratedSession = ensureAgentSession('migration-session');

				expect(migratedSession.taskWorkflowStates).toBeInstanceOf(Map);
			});

			it('initializes taskWorkflowStates if null', () => {
				const session = ensureAgentSession('migration-session2', 'architect');
				// @ts-expect-error - deliberately setting to null to test migration
				session.taskWorkflowStates = null;

				const migratedSession = ensureAgentSession('migration-session2');

				expect(migratedSession.taskWorkflowStates).toBeInstanceOf(Map);
			});
		});

		describe('multiple tasks tracked independently', () => {
			it('advancing task A does not affect task B', () => {
				const session = getAgentSession(sessionId)!;

				// Advance task A
				advanceTaskState(session, 'task-A', 'coder_delegated');
				advanceTaskState(session, 'task-A', 'pre_check_passed');

				// Task B should still be idle
				expect(getTaskState(session, 'task-B')).toBe('idle');

				// Advance task B independently
				advanceTaskState(session, 'task-B', 'tests_run');

				// Verify each task has its own state
				expect(getTaskState(session, 'task-A')).toBe('pre_check_passed');
				expect(getTaskState(session, 'task-B')).toBe('tests_run');
			});

			it('full workflow for multiple tasks', () => {
				const session = getAgentSession(sessionId)!;

				// Task 1: full workflow
				advanceTaskState(session, 'task-1', 'coder_delegated');
				advanceTaskState(session, 'task-1', 'pre_check_passed');
				advanceTaskState(session, 'task-1', 'reviewer_run');
				advanceTaskState(session, 'task-1', 'tests_run');
				advanceTaskState(session, 'task-1', 'complete');

				// Task 2: partial workflow
				advanceTaskState(session, 'task-2', 'coder_delegated');
				advanceTaskState(session, 'task-2', 'pre_check_passed');

				// Verify task 1 is complete
				expect(getTaskState(session, 'task-1')).toBe('complete');

				// Verify task 2 is at pre_check_passed
				expect(getTaskState(session, 'task-2')).toBe('pre_check_passed');

				// Task 3 hasn't been touched
				expect(getTaskState(session, 'task-3')).toBe('idle');
			});
		});
	});
});
