import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { createDelegationTrackerHook } from '../../../src/hooks/delegation-tracker';
import {
	ensureAgentSession,
	getActiveWindow,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

describe('DelegationTrackerHook', () => {
	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};

	const enabledConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: true,
			delegation_gate: true,
			agent_awareness_max_chars: 300,
			delegation_max_chars: 4000,
		},
	};

	beforeEach(() => {
		resetSwarmState();
	});

	describe('activeAgent updates', () => {
		it('always updates activeAgent when agent is present', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);
			const sessionId = 'test-session-1';

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			expect(swarmState.activeAgent.get(sessionId)).toBe('coder');
		});

		it('skips when no agent is specified', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);
			const sessionId = 'test-session-1';

			// Set a previous agent
			swarmState.activeAgent.set(sessionId, 'architect');

			await hook({ sessionID: sessionId }, {});

			// Should remain unchanged
			expect(swarmState.activeAgent.get(sessionId)).toBe('architect');
			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
			expect(swarmState.pendingEvents).toBe(0);
		});

		it('skips when agent is empty string', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);
			const sessionId = 'test-session-1';

			// Set a previous agent
			swarmState.activeAgent.set(sessionId, 'architect');

			await hook({ sessionID: sessionId, agent: '' }, {});

			// Should remain unchanged
			expect(swarmState.activeAgent.get(sessionId)).toBe('architect');
			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
			expect(swarmState.pendingEvents).toBe(0);
		});

		it('activeAgent tracks correctly', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);
			const sessionId = 's1';

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			expect(swarmState.activeAgent.get('s1')).toBe('coder');
		});

		it('multiple sessions maintain independent active agents', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);

			await hook({ sessionID: 'session1', agent: 'architect' }, {});
			await hook({ sessionID: 'session2', agent: 'coder' }, {});
			await hook({ sessionID: 'session3', agent: 'reviewer' }, {});

			expect(swarmState.activeAgent.get('session1')).toBe('architect');
			expect(swarmState.activeAgent.get('session2')).toBe('coder');
			expect(swarmState.activeAgent.get('session3')).toBe('reviewer');
		});
	});

	describe('delegation tracking disabled by default', () => {
		it('delegation chain populated when delegation_tracker undefined (delegation_gate defaults to true)', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);
			const sessionId = 'test-session';

			// Set previous agent
			swarmState.activeAgent.set(sessionId, 'architect');

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			// With Task 1.1: delegation_gate defaults to true, so chain IS populated
			expect(swarmState.delegationChains.has(sessionId)).toBe(true);
			// But pendingEvents should NOT increment because delegation_tracker is not true
			expect(swarmState.pendingEvents).toBe(0);
			expect(swarmState.activeAgent.get(sessionId)).toBe('coder'); // But agent still updated
		});

		it('no delegation entries created when delegation_tracker is false and delegation_gate is false', async () => {
			const disabledConfig: PluginConfig = {
				...defaultConfig,
				hooks: {
					system_enhancer: false,
					compaction: false,
					agent_activity: false,
					delegation_tracker: false,
					delegation_gate: false,
					agent_awareness_max_chars: 300,
					delegation_max_chars: 4000,
				},
			};
			const hook = createDelegationTrackerHook(disabledConfig);
			const sessionId = 'test-session';

			// Set previous agent
			swarmState.activeAgent.set(sessionId, 'architect');

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
			expect(swarmState.pendingEvents).toBe(0);
			expect(swarmState.activeAgent.get(sessionId)).toBe('coder'); // But agent still updated
		});

		it('pendingEvents NOT incremented when delegation tracking disabled', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);
			const sessionId = 'test-session';

			swarmState.activeAgent.set(sessionId, 'architect');
			const initialEvents = swarmState.pendingEvents;

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			expect(swarmState.pendingEvents).toBe(initialEvents); // Should remain unchanged
		});
	});

	describe('delegation tracking enabled', () => {
		it('creates delegation entry when agent changes', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// Set previous agent
			swarmState.activeAgent.set(sessionId, 'architect');

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			expect(swarmState.delegationChains.has(sessionId)).toBe(true);
			const chain = swarmState.delegationChains.get(sessionId);
			expect(chain).toHaveLength(1);

			const entry = chain![0];
			expect(entry.from).toBe('architect');
			expect(entry.to).toBe('coder');
			expect(typeof entry.timestamp).toBe('number');
			expect(entry.timestamp).toBeGreaterThan(0);
		});

		it('same agent does not create delegation entry', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// Set previous agent
			swarmState.activeAgent.set(sessionId, 'architect');

			await hook({ sessionID: sessionId, agent: 'architect' }, {});

			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
			expect(swarmState.pendingEvents).toBe(0);
		});

		it('first agent assignment does not create delegation entry', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// No previous agent set
			await hook({ sessionID: sessionId, agent: 'architect' }, {});

			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
			expect(swarmState.pendingEvents).toBe(0);
		});

		it('chain accumulates multiple agent switches', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// Simulate a series of agent switches
			swarmState.activeAgent.set(sessionId, 'architect');
			await hook({ sessionID: sessionId, agent: 'coder' }, {});
			await hook({ sessionID: sessionId, agent: 'reviewer' }, {});
			await hook({ sessionID: sessionId, agent: 'sme' }, {});
			await hook({ sessionID: sessionId, agent: 'tester' }, {});

			const chain = swarmState.delegationChains.get(sessionId);
			expect(chain).toHaveLength(4); // 4 switches total

			expect(chain![0]).toEqual({
				from: 'architect',
				to: 'coder',
				timestamp: expect.any(Number),
			});
			expect(chain![1]).toEqual({
				from: 'coder',
				to: 'reviewer',
				timestamp: expect.any(Number),
			});
			expect(chain![2]).toEqual({
				from: 'reviewer',
				to: 'sme',
				timestamp: expect.any(Number),
			});
			expect(chain![3]).toEqual({
				from: 'sme',
				to: 'tester',
				timestamp: expect.any(Number),
			});
		});

		it('pendingEvents increments for each delegation', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			swarmState.activeAgent.set(sessionId, 'architect');
			const initialEvents = swarmState.pendingEvents;

			await hook({ sessionID: sessionId, agent: 'coder' }, {});
			expect(swarmState.pendingEvents).toBe(initialEvents + 1);

			await hook({ sessionID: sessionId, agent: 'reviewer' }, {});
			expect(swarmState.pendingEvents).toBe(initialEvents + 2);
		});

		it('pendingEvents NOT incremented when delegation tracking disabled', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// Use default config (delegation tracking disabled)
			const disabledHook = createDelegationTrackerHook(defaultConfig);

			swarmState.activeAgent.set(sessionId, 'architect');
			const initialEvents = swarmState.pendingEvents;

			await disabledHook({ sessionID: sessionId, agent: 'coder' }, {});

			expect(swarmState.pendingEvents).toBe(initialEvents); // Should remain unchanged
		});
	});

	describe('edge cases', () => {
		it('handles null agent gracefully', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			swarmState.activeAgent.set(sessionId, 'architect');

			// @ts-expect-error - testing runtime behavior with null
			await hook({ sessionID: sessionId, agent: null }, {});

			// Should remain unchanged since null is falsy
			expect(swarmState.activeAgent.get(sessionId)).toBe('architect');
			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
		});

		it('handles multiple sessions with different delegation patterns', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);

			// Session 1: agent switch (should create delegation)
			swarmState.activeAgent.set('session1', 'architect');
			await hook({ sessionID: 'session1', agent: 'coder' }, {});

			// Session 2: first agent (no delegation)
			await hook({ sessionID: 'session2', agent: 'reviewer' }, {});

			// Session 3: same agent (no delegation)
			swarmState.activeAgent.set('session3', 'sme');
			await hook({ sessionID: 'session3', agent: 'sme' }, {});

			// Session 4: agent switch (should create delegation)
			swarmState.activeAgent.set('session4', 'architect');
			await hook({ sessionID: 'session4', agent: 'tester' }, {});

			expect(swarmState.delegationChains.get('session1')).toHaveLength(1);
			expect(swarmState.delegationChains.get('session2')).toBeUndefined();
			expect(swarmState.delegationChains.get('session3')).toBeUndefined();
			expect(swarmState.delegationChains.get('session4')).toHaveLength(1);

			expect(swarmState.pendingEvents).toBe(2); // Only 2 actual delegations
		});

		it('delegation chain initialization creates new array on first switch', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'sess';

			// Set initial agent
			swarmState.activeAgent.set(sessionId, 'architect');

			// First delegation should create a new array
			await hook({ sessionID: sessionId, agent: 'coder' }, {});
			const firstChain = swarmState.delegationChains.get(sessionId);
			expect(firstChain).toHaveLength(1);

			// Second delegation should reuse the same array (not create a new one)
			const originalArray = firstChain;
			await hook({ sessionID: sessionId, agent: 'reviewer' }, {});
			const secondChain = swarmState.delegationChains.get(sessionId);

			// Verify it's the same array object (reference equality)
			expect(secondChain).toBe(originalArray);
			expect(secondChain).toHaveLength(2);
		});

		it('timestamps are monotonically increasing', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// Set initial agent
			swarmState.activeAgent.set(sessionId, 'architect');

			// Make rapid calls to ensure timestamps might be close together
			await hook({ sessionID: sessionId, agent: 'coder' }, {});
			await hook({ sessionID: sessionId, agent: 'reviewer' }, {});
			await hook({ sessionID: sessionId, agent: 'sme' }, {});

			const chain = swarmState.delegationChains.get(sessionId);
			expect(chain).toHaveLength(3);

			// Verify timestamps are monotonically increasing
			expect(chain![0].timestamp).toBeLessThanOrEqual(chain![1].timestamp);
			expect(chain![1].timestamp).toBeLessThanOrEqual(chain![2].timestamp);
		});

		it('handles undefined agent field explicitly', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// Set a previous agent
			swarmState.activeAgent.set(sessionId, 'architect');

			// Call hook with explicitly undefined agent
			await hook({ sessionID: sessionId, agent: undefined }, {});

			// Should remain unchanged since undefined is falsy
			expect(swarmState.activeAgent.get(sessionId)).toBe('architect');
			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
			expect(swarmState.pendingEvents).toBe(0);
		});
	});

	// Regression tests for v5.1.6 hotfix: architect identity-stuck
	describe('architect identity-stuck hotfix', () => {
		describe('lastAgentEventTime updates', () => {
			it('updates lastAgentEventTime when chat.message sets subagent', async () => {
				const hook = createDelegationTrackerHook(defaultConfig);
				const sessionId = 'test-session';
				const beforeTime = Date.now() - 1000; // 1 second ago

				// Set initial agent event time
				await hook({ sessionID: sessionId, agent: 'architect' }, {});
				const session = swarmState.agentSessions.get(sessionId);
				expect(session).toBeDefined();
				expect(session!.lastAgentEventTime).toBeGreaterThanOrEqual(beforeTime);
			});

			it('updates lastAgentEventTime when chat.message clears agent (handoff to architect)', async () => {
				const hook = createDelegationTrackerHook(defaultConfig);
				const sessionId = 'test-session';

				// First set a subagent
				await hook({ sessionID: sessionId, agent: 'coder' }, {});
				const beforeTime = Date.now();

				// Then clear agent to trigger handoff to architect
				await hook({ sessionID: sessionId, agent: '' }, {});

				const session = swarmState.agentSessions.get(sessionId);
				expect(session).toBeDefined();
				// lastAgentEventTime should be updated after handoff
				expect(session!.lastAgentEventTime).toBeGreaterThanOrEqual(beforeTime);
			});
		});

		describe('delegationActive semantics', () => {
			it('sets delegationActive=false for architect agent', async () => {
				const hook = createDelegationTrackerHook(defaultConfig);
				const sessionId = 'test-session';

				await hook({ sessionID: sessionId, agent: 'architect' }, {});

				const session = swarmState.agentSessions.get(sessionId);
				expect(session!.delegationActive).toBe(false);
			});

			it('sets delegationActive=false for architect-prefixed names (mega_architect)', async () => {
				const hook = createDelegationTrackerHook(defaultConfig);
				const sessionId = 'test-session';

				await hook({ sessionID: sessionId, agent: 'mega_architect' }, {});

				const session = swarmState.agentSessions.get(sessionId);
				expect(session!.delegationActive).toBe(false);
			});

			it('sets delegationActive=true for subagent (coder)', async () => {
				const hook = createDelegationTrackerHook(defaultConfig);
				const sessionId = 'test-session';

				await hook({ sessionID: sessionId, agent: 'coder' }, {});

				const session = swarmState.agentSessions.get(sessionId);
				expect(session!.delegationActive).toBe(true);
			});

			it('sets delegationActive=true for all subagent types', async () => {
				const hook = createDelegationTrackerHook(defaultConfig);
				const subagents = [
					'sme',
					'reviewer',
					'critic',
					'explorer',
					'test_engineer',
				];

				for (const agent of subagents) {
					const sessionId = `session-${agent}`;
					await hook({ sessionID: sessionId, agent }, {});

					const session = swarmState.agentSessions.get(sessionId);
					expect(session!.delegationActive).toBe(true);
				}
			});

			it('sets delegationActive=false when agent field is empty (architect handoff)', async () => {
				const hook = createDelegationTrackerHook(defaultConfig);
				const sessionId = 'test-session';

				// First set a subagent
				await hook({ sessionID: sessionId, agent: 'coder' }, {});
				expect(swarmState.agentSessions.get(sessionId)!.delegationActive).toBe(
					true,
				);

				// Then clear agent to trigger handoff
				await hook({ sessionID: sessionId, agent: '' }, {});

				const session = swarmState.agentSessions.get(sessionId);
				expect(session!.delegationActive).toBe(false);
			});
		});

		describe('architect-prefixed names treated as architect', () => {
			it('treats mega_architect as architect', async () => {
				const hook = createDelegationTrackerHook(defaultConfig);
				const sessionId = 'test-session';

				await hook({ sessionID: sessionId, agent: 'mega_architect' }, {});

				const session = swarmState.agentSessions.get(sessionId);
				expect(session!.delegationActive).toBe(false);
				expect(swarmState.activeAgent.get(sessionId)).toBe('mega_architect');
			});

			it('treats senior_architect as architect', async () => {
				const hook = createDelegationTrackerHook(defaultConfig);
				const sessionId = 'test-session';

				await hook({ sessionID: sessionId, agent: 'senior_architect' }, {});

				const session = swarmState.agentSessions.get(sessionId);
				expect(session!.delegationActive).toBe(false);
			});
		});
	});

	// Fix 4: guardrails disabled optimization tests
	describe('guardrails disabled optimization', () => {
		it('does not call beginInvocation when guardrails disabled', async () => {
			const hook = createDelegationTrackerHook(defaultConfig, false);
			const sessionId = 'test-session';

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			// Active agent should still be set
			expect(swarmState.activeAgent.get(sessionId)).toBe('coder');
			// Session should exist
			expect(swarmState.agentSessions.get(sessionId)).toBeDefined();
			// But no invocation window should be created
			expect(getActiveWindow(sessionId)).toBeUndefined();
		});

		it('calls beginInvocation when guardrails enabled (default)', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);
			const sessionId = 'test-session';

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			expect(swarmState.activeAgent.get(sessionId)).toBe('coder');
			expect(getActiveWindow(sessionId)).toBeDefined();
		});

		it('calls beginInvocation when guardrails explicitly enabled', async () => {
			const hook = createDelegationTrackerHook(defaultConfig, true);
			const sessionId = 'test-session';

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			expect(getActiveWindow(sessionId)).toBeDefined();
		});

		it('architect advances its safety boundary without a budget window', async () => {
			const hook = createDelegationTrackerHook(defaultConfig, true);
			const sessionId = 'test-session';

			await hook({ sessionID: sessionId, agent: 'architect' }, {});

			expect(getActiveWindow(sessionId)).toBeUndefined();
			expect(swarmState.agentSessions.get(sessionId)?.activeInvocationId).toBe(
				1,
			);
		});
	});

	// Task 1.1: delegation_gate behavior tests
	describe('delegation_gate feature (Task 1.1)', () => {
		// Behavior 1: Default config (delegation_tracker=false, delegation_gate not set)
		// — delegation chain IS populated when agents switch
		it('populates delegation chain with default config (no explicit delegation_tracker)', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);
			const sessionId = 'test-session';

			// Set previous agent
			swarmState.activeAgent.set(sessionId, 'architect');

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			// With default config, delegation_gate defaults to true (not false)
			// So chain SHOULD be populated
			expect(swarmState.delegationChains.has(sessionId)).toBe(true);
			const chain = swarmState.delegationChains.get(sessionId);
			expect(chain).toHaveLength(1);
			expect(chain![0].from).toBe('architect');
			expect(chain![0].to).toBe('coder');
		});

		it('pendingEvents NOT incremented with default config', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);
			const sessionId = 'test-session';

			swarmState.activeAgent.set(sessionId, 'architect');
			const initialEvents = swarmState.pendingEvents;

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			// pendingEvents should NOT increment because delegation_tracker is not explicitly true
			expect(swarmState.pendingEvents).toBe(initialEvents);
		});

		// Behavior 2: delegation_tracker=true, delegation_gate not set
		// — delegation chain IS populated AND pendingEvents increments
		it('populates delegation chain and increments pendingEvents when delegation_tracker=true', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			swarmState.activeAgent.set(sessionId, 'architect');
			const initialEvents = swarmState.pendingEvents;

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			// Chain should be populated
			expect(swarmState.delegationChains.has(sessionId)).toBe(true);
			expect(swarmState.delegationChains.get(sessionId)).toHaveLength(1);
			// pendingEvents SHOULD increment
			expect(swarmState.pendingEvents).toBe(initialEvents + 1);
		});

		// Behavior 3: delegation_tracker=false, delegation_gate=false
		// — delegation chain is NOT populated
		it('does NOT populate delegation chain when delegation_gate=false', async () => {
			const gateOnlyConfig: PluginConfig = {
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
				hooks: {
					system_enhancer: false,
					compaction: false,
					agent_activity: false,
					delegation_tracker: false,
					delegation_gate: false,
					agent_awareness_max_chars: 300,
					delegation_max_chars: 4000,
				},
			};
			const hook = createDelegationTrackerHook(gateOnlyConfig);
			const sessionId = 'test-session';

			swarmState.activeAgent.set(sessionId, 'architect');

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			// Chain should NOT be populated
			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
			expect(swarmState.pendingEvents).toBe(0);
		});

		// Behavior 4: delegation_tracker=true, delegation_gate=false
		// — delegation chain IS populated AND pendingEvents increments
		it('populates delegation chain when delegation_tracker=true even if delegation_gate=false', async () => {
			const explicitTrackerConfig: PluginConfig = {
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
				hooks: {
					system_enhancer: false,
					compaction: false,
					agent_activity: false,
					delegation_tracker: true,
					delegation_gate: false,
					agent_awareness_max_chars: 300,
					delegation_max_chars: 4000,
				},
			};
			const hook = createDelegationTrackerHook(explicitTrackerConfig);
			const sessionId = 'test-session';

			swarmState.activeAgent.set(sessionId, 'architect');
			const initialEvents = swarmState.pendingEvents;

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			// Chain SHOULD be populated because delegation_tracker=true
			expect(swarmState.delegationChains.has(sessionId)).toBe(true);
			expect(swarmState.delegationChains.get(sessionId)).toHaveLength(1);
			// pendingEvents SHOULD increment
			expect(swarmState.pendingEvents).toBe(initialEvents + 1);
		});

		// Behavior 5: Same agent repeated (no change)
		// — delegation chain is NOT populated regardless of config
		it('does NOT populate delegation chain when same agent repeated', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			swarmState.activeAgent.set(sessionId, 'architect');

			await hook({ sessionID: sessionId, agent: 'architect' }, {});

			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
		});

		it('does NOT populate delegation chain when same agent repeated with default config', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);
			const sessionId = 'test-session';

			swarmState.activeAgent.set(sessionId, 'architect');

			await hook({ sessionID: sessionId, agent: 'architect' }, {});

			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
		});

		// Behavior 6: No previous agent (first transition)
		// — delegation chain is NOT populated (previousAgent is undefined)
		it('does NOT populate delegation chain on first agent assignment', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// No previous agent set (undefined)

			await hook({ sessionID: sessionId, agent: 'architect' }, {});

			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
		});

		it('does NOT populate delegation chain on first agent assignment with default config', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);
			const sessionId = 'test-session';

			// No previous agent set (undefined)

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
		});

		// Additional edge case: delegation_gate=true explicitly
		it('populates delegation chain when delegation_gate=true explicitly', async () => {
			const gateOnlyConfig: PluginConfig = {
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
				hooks: {
					system_enhancer: false,
					compaction: false,
					agent_activity: false,
					delegation_tracker: false,
					delegation_gate: true,
					agent_awareness_max_chars: 300,
					delegation_max_chars: 4000,
				},
			};
			const hook = createDelegationTrackerHook(gateOnlyConfig);
			const sessionId = 'test-session';

			swarmState.activeAgent.set(sessionId, 'architect');

			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			// Chain SHOULD be populated because delegation_gate=true
			expect(swarmState.delegationChains.has(sessionId)).toBe(true);
			expect(swarmState.delegationChains.get(sessionId)).toHaveLength(1);
			// pendingEvents should NOT increment because delegation_tracker is false
			expect(swarmState.pendingEvents).toBe(0);
		});

		// Multiple switches with gate-only config
		it('accumulates delegation chain with gate-only config but does not increment pendingEvents', async () => {
			const gateOnlyConfig: PluginConfig = {
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
				hooks: {
					system_enhancer: false,
					compaction: false,
					agent_activity: false,
					delegation_tracker: false,
					delegation_gate: true,
					agent_awareness_max_chars: 300,
					delegation_max_chars: 4000,
				},
			};
			const hook = createDelegationTrackerHook(gateOnlyConfig);
			const sessionId = 'test-session';

			swarmState.activeAgent.set(sessionId, 'architect');
			await hook({ sessionID: sessionId, agent: 'coder' }, {});
			await hook({ sessionID: sessionId, agent: 'reviewer' }, {});
			await hook({ sessionID: sessionId, agent: 'sme' }, {});

			// Chain should accumulate all switches
			const chain = swarmState.delegationChains.get(sessionId);
			expect(chain).toHaveLength(3);
			// pendingEvents should still be 0 because delegation_tracker is false
			expect(swarmState.pendingEvents).toBe(0);
		});
	});

	// Task 2.4: Verify task handoff debug leakage is absent from visible output
	describe('task handoff debug leakage absent (Task 2.4)', () => {
		let consoleLogSpy: any;

		beforeEach(() => {
			// Spy on console.log to capture output during handoff
			consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
		});

		afterEach(() => {
			// Restore console.log after each test to avoid pollution
			consoleLogSpy.mockRestore();
		});

		it('does not emit debug text during agent handoff (architect to coder)', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// Set previous agent to architect
			swarmState.activeAgent.set(sessionId, 'architect');

			// Execute handoff
			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			// Verify no debug leakage in console output
			const loggedOutput = consoleLogSpy.mock.calls
				.map((c: any[]) => c.join(' '))
				.join('\n');
			expect(loggedOutput).not.toContain('[swarm-debug-task]');
			expect(loggedOutput).not.toContain('chat.message');
			expect(loggedOutput).not.toContain(`session=${sessionId}`);
			expect(loggedOutput).not.toContain('agent=');
			expect(loggedOutput).not.toContain('prevAgent=');
			expect(loggedOutput).not.toContain('taskStates=');

			// Also verify state is updated correctly
			expect(swarmState.activeAgent.get(sessionId)).toBe('coder');
			expect(swarmState.delegationChains.has(sessionId)).toBe(true);
		});

		it('does not emit debug text during agent handoff (coder to reviewer)', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// Set previous agent
			swarmState.activeAgent.set(sessionId, 'coder');

			// Execute handoff
			await hook({ sessionID: sessionId, agent: 'reviewer' }, {});

			// Verify no debug leakage in console output
			const loggedOutput = consoleLogSpy.mock.calls
				.map((c: any[]) => c.join(' '))
				.join('\n');
			expect(loggedOutput).not.toContain('[swarm-debug-task]');
			expect(loggedOutput).not.toContain('chat.message');
			expect(loggedOutput).not.toContain('taskStates=');

			// Verify state is updated correctly
			expect(swarmState.activeAgent.get(sessionId)).toBe('reviewer');
			const chain = swarmState.delegationChains.get(sessionId);
			expect(chain).toHaveLength(1);
			expect(chain![0].from).toBe('coder');
			expect(chain![0].to).toBe('reviewer');
		});

		it('does not emit debug text when clearing agent (handoff back to architect)', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// Set previous agent to a subagent
			swarmState.activeAgent.set(sessionId, 'coder');

			// Execute handoff back to architect (empty string triggers architect handoff)
			await hook({ sessionID: sessionId, agent: '' }, {});

			// Verify no debug leakage in console output
			const loggedOutput = consoleLogSpy.mock.calls
				.map((c: any[]) => c.join(' '))
				.join('\n');
			expect(loggedOutput).not.toContain('[swarm-debug-task]');
			expect(loggedOutput).not.toContain('chat.message');
			expect(loggedOutput).not.toContain('taskStates=');

			// Verify state is updated correctly - empty string results in architect handoff
			// The hook sets agent to ORCHESTRATOR_NAME ('architect') when empty string is passed
			expect(swarmState.activeAgent.get(sessionId)).toBe('architect');
			// Verify session exists and delegationActive is false
			const session = swarmState.agentSessions.get(sessionId);
			expect(session).toBeDefined();
			expect(session!.delegationActive).toBe(false);
		});

		it('does not emit debug text during multiple rapid handoffs', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// Multiple rapid handoffs
			swarmState.activeAgent.set(sessionId, 'architect');
			await hook({ sessionID: sessionId, agent: 'coder' }, {});
			await hook({ sessionID: sessionId, agent: 'reviewer' }, {});
			await hook({ sessionID: sessionId, agent: 'sme' }, {});
			await hook({ sessionID: sessionId, agent: '' }, {}); // Empty triggers architect handoff

			// Verify no debug leakage in any console output
			const loggedOutput = consoleLogSpy.mock.calls
				.map((c: any[]) => c.join(' '))
				.join('\n');
			expect(loggedOutput).not.toContain('[swarm-debug-task]');
			expect(loggedOutput).not.toContain('chat.message');
			expect(loggedOutput).not.toContain('taskStates=');

			// Verify all handoffs recorded correctly
			const chain = swarmState.delegationChains.get(sessionId);
			expect(chain).toHaveLength(3);
			// Empty string results in architect handoff, not clearing
			expect(swarmState.activeAgent.get(sessionId)).toBe('architect');
		});

		it('does not emit debug text when same agent is set (no handoff)', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// Set same agent - should not trigger any debug
			swarmState.activeAgent.set(sessionId, 'architect');
			await hook({ sessionID: sessionId, agent: 'architect' }, {});

			// Verify no debug leakage in console output
			const loggedOutput = consoleLogSpy.mock.calls
				.map((c: any[]) => c.join(' '))
				.join('\n');
			expect(loggedOutput).not.toContain('[swarm-debug-task]');
			expect(loggedOutput).not.toContain('chat.message');
			expect(loggedOutput).not.toContain('taskStates=');

			// Verify no delegation chain created
			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
			expect(swarmState.pendingEvents).toBe(0);
		});

		it('does not emit debug text on first agent assignment', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session';

			// First agent assignment - no previous agent
			await hook({ sessionID: sessionId, agent: 'architect' }, {});

			// Verify no debug leakage in console output
			const loggedOutput = consoleLogSpy.mock.calls
				.map((c: any[]) => c.join(' '))
				.join('\n');
			expect(loggedOutput).not.toContain('[swarm-debug-task]');
			expect(loggedOutput).not.toContain('chat.message');
			expect(loggedOutput).not.toContain('taskStates=');

			// Verify no delegation chain created for first assignment
			expect(swarmState.delegationChains.has(sessionId)).toBe(false);
			expect(swarmState.activeAgent.get(sessionId)).toBe('architect');
		});
	});

	// Task 2.5: Focused tests for chat-message debug leakage absence
	describe('chat-message debug leakage absent (Task 2.5)', () => {
		let consoleLogSpy: any;

		beforeEach(() => {
			// Spy on console.log to capture all output
			consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
		});

		afterEach(() => {
			consoleLogSpy.mockRestore();
		});

		// Helper to get all logged output as a single string
		function getLoggedOutput(): string {
			return consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
		}

		it('does not emit [swarm-debug-task] prefix during any hook execution', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session-1';

			// Various hook invocations that should NOT produce debug output
			await hook({ sessionID: sessionId, agent: 'architect' }, {});
			await hook({ sessionID: sessionId, agent: 'coder' }, {});
			await hook({ sessionID: sessionId, agent: '' }, {}); // Clear agent

			const output = getLoggedOutput();
			expect(output).not.toContain('[swarm-debug-task]');
		});

		it('does not emit chat.message debug pattern during agent handoff', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session-2';

			swarmState.activeAgent.set(sessionId, 'architect');
			await hook({ sessionID: sessionId, agent: 'mega_coder' }, {});

			const output = getLoggedOutput();
			// The specific debug pattern that should NOT appear
			expect(output).not.toMatch(/chat\.message/);
			expect(output).not.toMatch(/\[swarm-debug-task\]/);
		});

		it('does not emit session/agent debug info during state transitions', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session-3';

			// Multiple state transitions
			swarmState.activeAgent.set(sessionId, 'architect');
			await hook({ sessionID: sessionId, agent: 'sme' }, {});
			await hook({ sessionID: sessionId, agent: 'reviewer' }, {});
			await hook({ sessionID: sessionId, agent: 'tester' }, {});

			const output = getLoggedOutput();
			// Debug patterns that should be absent
			expect(output).not.toContain('session=');
			expect(output).not.toContain('agent=');
			expect(output).not.toContain('prevAgent=');
		});

		it('does not emit taskStates debug info during delegation tracking', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session-4';

			// Create a session with task workflow states using ensureAgentSession
			swarmState.activeAgent.set(sessionId, 'architect');

			// Use ensureAgentSession to create proper session object
			const session = ensureAgentSession(sessionId, 'architect');
			session.delegationActive = true;

			// Add some task states
			session.taskWorkflowStates['task-1'] = 'completed';
			session.taskWorkflowStates['task-2'] = 'in_progress';

			// Execute hook
			await hook({ sessionID: sessionId, agent: 'coder' }, {});

			const output = getLoggedOutput();
			// Task states should NOT appear in debug output
			expect(output).not.toContain('taskStates=');
			expect(output).not.toContain('task-1');
			expect(output).not.toContain('task-2');
		});

		it('produces no visible debug output with default config', async () => {
			const hook = createDelegationTrackerHook(defaultConfig);
			const sessionId = 'test-session-5';

			// Default config - no hooks enabled explicitly
			await hook({ sessionID: sessionId, agent: 'architect' }, {});
			await hook({ sessionID: sessionId, agent: 'coder' }, {});
			await hook({ sessionID: sessionId, agent: '' }, {});

			const output = getLoggedOutput();
			// No debug output should be visible
			expect(output).toBe('');
		});

		it('produces no visible debug output with enabled config', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session-6';

			// Enabled config - all hooks explicitly enabled
			swarmState.activeAgent.set(sessionId, 'architect');
			await hook({ sessionID: sessionId, agent: 'critic' }, {});
			await hook({ sessionID: sessionId, agent: 'explorer' }, {});

			const output = getLoggedOutput();
			// No debug output should be visible
			expect(output).toBe('');
		});

		it('handles guardrails disabled optimization without debug leakage', async () => {
			const hook = createDelegationTrackerHook(defaultConfig, false);
			const sessionId = 'test-session-7';

			// Guardrails disabled - should still not leak debug
			await hook({ sessionID: sessionId, agent: 'sme' }, {});
			await hook({ sessionID: sessionId, agent: 'test_engineer' }, {});

			const output = getLoggedOutput();
			expect(output).not.toContain('[swarm-debug-task]');
			expect(output).not.toContain('chat.message');
			expect(output).not.toContain('taskStates');
		});

		it('does not emit debug for any subagent type', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const subagents = [
				'coder',
				'sme',
				'reviewer',
				'critic',
				'explorer',
				'test_engineer',
			];

			for (const agent of subagents) {
				const sessionId = `session-${agent}`;
				swarmState.activeAgent.set(sessionId, 'architect');
				await hook({ sessionID: sessionId, agent }, {});

				const output = getLoggedOutput();
				expect(output).not.toContain('[swarm-debug-task]');
				expect(output).not.toContain('chat.message');
			}
		});

		it('verifies debug absence is consistent across multiple calls', async () => {
			const hook = createDelegationTrackerHook(enabledConfig);
			const sessionId = 'test-session-8';

			// Make many calls and verify no debug in any of them
			for (let i = 0; i < 10; i++) {
				swarmState.activeAgent.set(sessionId, 'architect');
				await hook({ sessionID: sessionId, agent: 'coder' }, {});
				await hook({ sessionID: sessionId, agent: 'reviewer' }, {});
			}

			const output = getLoggedOutput();
			// After 200 hook calls, there should be ZERO debug output
			expect(output).toBe('');
		});
	});
});
