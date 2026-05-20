/**
 * Tests for cross-session task state seeding in delegation-gate.ts
 *
 * Verifies that new sessions with empty taskWorkflowStates Maps get seeded
 * with the correct initial state so that cross-session propagation works correctly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../config';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
	swarmState,
} from '../state';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
} from '../telemetry';
import { createDelegationGateHook } from './delegation-gate';

function makeConfig(): PluginConfig {
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
		},
	} as PluginConfig;
}

describe('delegation-gate: cross-session seed-state fix', () => {
	beforeEach(() => {
		resetSwarmState();
		resetTelemetryForTesting();
		initTelemetry(process.cwd());
	});

	afterEach(() => {
		resetSwarmState();
		resetTelemetryForTesting();
	});

	it('reviewer delegation seeds task state in new sessions with empty Maps', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const events: Array<{ event: string; data: Record<string, unknown> }> = [];
		addTelemetryListener((event, data) => {
			events.push({ event, data });
		});

		// Session-1 is the originating (architect) session that knows about the task
		const session1 = ensureAgentSession('session-1');
		session1.currentTaskId = '1.1';
		session1.taskWorkflowStates.set('1.1', 'coder_delegated');

		swarmState.delegationChains.set('session-1', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
		]);

		// Session-2 is a new session with an empty taskWorkflowStates Map
		ensureAgentSession('session-2');
		// session-2.taskWorkflowStates is empty — simulates a newly created session

		await hook.toolAfter(
			{
				tool: 'tool.execute.Task',
				sessionID: 'session-1',
				callID: 'call-reviewer-1',
				args: { subagent_type: 'mega_reviewer' },
			},
			{},
		);

		// Session-2 should have been seeded and then advanced to reviewer_run
		const session2 = swarmState.agentSessions.get('session-2')!;
		expect(getTaskState(session2, '1.1')).toBe('reviewer_run');
		const mirroredSessionEvents = events.filter(
			(entry) =>
				entry.event === 'task_state_changed' &&
				entry.data.sessionId === 'session-2',
		);
		expect(mirroredSessionEvents).toHaveLength(0);
	});

	it('test_engineer delegation seeds task state in new sessions with empty Maps', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Session-1 is the originating session
		const session1 = ensureAgentSession('session-1');
		session1.currentTaskId = '1.1';
		session1.taskWorkflowStates.set('1.1', 'reviewer_run');

		swarmState.delegationChains.set('session-1', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
			{ from: 'mega_reviewer', to: 'architect', timestamp: 4 },
			{ from: 'architect', to: 'mega_test_engineer', timestamp: 5 },
		]);

		// Session-2 is a new session with an empty taskWorkflowStates Map
		ensureAgentSession('session-2');

		await hook.toolAfter(
			{
				tool: 'tool.execute.Task',
				sessionID: 'session-1',
				callID: 'call-te-1',
				args: { subagent_type: 'mega_test_engineer' },
			},
			{},
		);

		// Session-2 should have been seeded and then advanced to tests_run
		const session2 = swarmState.agentSessions.get('session-2')!;
		expect(getTaskState(session2, '1.1')).toBe('tests_run');
	});

	it('seeding does not overwrite existing state in other sessions', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Session-1 is the originating session
		const session1 = ensureAgentSession('session-1');
		session1.currentTaskId = '1.1';
		session1.taskWorkflowStates.set('1.1', 'coder_delegated');

		swarmState.delegationChains.set('session-1', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_reviewer', timestamp: 3 },
		]);

		// Session-2 already has task '1.1' at a later state (tests_run)
		const session2 = ensureAgentSession('session-2');
		session2.taskWorkflowStates.set('1.1', 'tests_run');

		await hook.toolAfter(
			{
				tool: 'tool.execute.Task',
				sessionID: 'session-1',
				callID: 'call-no-overwrite-1',
				args: { subagent_type: 'mega_reviewer' },
			},
			{},
		);

		// Session-2 state should remain at tests_run — seeding must not overwrite
		expect(getTaskState(session2, '1.1')).toBe('tests_run');
	});
});
