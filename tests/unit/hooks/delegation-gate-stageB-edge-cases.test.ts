/**
 * Edge-case integration tests for the Stage B advancement helpers inside
 * `createDelegationGateHook` (delegation-gate.ts).
 *
 * The helpers (`advanceStageBForSession`, cross-session seeding, barrier logic)
 * are closure-private, so they are exercised through `toolAfter`. Each test
 * targets a specific edge condition identified in the council review of PR #728.
 *
 * Edge cases covered:
 *  1. null/undefined taskWorkflowStates → advancement loop is skipped
 *  2. Exception during advanceTaskState is caught and does not propagate
 *  3. Parallel barrier with only one agent (reviewer only) → stays at reviewer_run
 *  4. getSeedTaskId returns null (no currentTaskId or lastCoderDelegationTaskId) → cross-session seeding skipped
 *  5. Cross-session task seeding when task already exists → does not overwrite existing state
 *  6. advanceTaskState to 'complete' clears stageBCompletion entry for the task (regression: prevents stale barrier data on retry)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	advanceTaskState,
	canAdvanceTaskState,
	ensureAgentSession,
	getTaskState,
	recordStageBCompletion,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

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

beforeEach(() => {
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
});

describe('Stage B helpers — edge cases', () => {
	it('EC-1: null taskWorkflowStates — advancement loop is skipped without error', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config);

		startAgentSession('sess-ec1', 'architect');
		const session = ensureAgentSession('sess-ec1');
		// Intentionally clear taskWorkflowStates to simulate missing map
		(session as Record<string, unknown>).taskWorkflowStates = null;

		// Should not throw; the loop guard `if (!session.taskWorkflowStates)` must protect it.
		await expect(
			hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-ec1',
					callID: 'call-ec1',
					args: { subagent_type: 'reviewer' },
				},
				{},
			),
		).resolves.toBeUndefined();
	});

	it('EC-2: exception during advanceTaskState is caught and does not propagate', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config);

		startAgentSession('sess-ec2', 'architect');
		const session = ensureAgentSession('sess-ec2');
		session.currentTaskId = '1.1';
		// Place the task in tests_run — a second advancement to tests_run throws.
		advanceTaskState(session, '1.1', 'coder_delegated');
		advanceTaskState(session, '1.1', 'reviewer_run');
		advanceTaskState(session, '1.1', 'tests_run');

		// Attempting to advance again (test_engineer triggers another try) must not throw.
		await expect(
			hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-ec2',
					callID: 'call-ec2',
					args: { subagent_type: 'test_engineer' },
				},
				{},
			),
		).resolves.toBeUndefined();

		// State remains at tests_run (not corrupted by the failed advancement).
		expect(getTaskState(session, '1.1')).toBe('tests_run');
	});

	it('EC-3: parallel barrier with reviewer only — stays at reviewer_run, not tests_run', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config);

		startAgentSession('sess-ec3', 'architect');
		const session = ensureAgentSession('sess-ec3');
		session.currentTaskId = '1.1';
		session.taskWorkflowStates.set('1.1', 'coder_delegated');

		// Only reviewer dispatched — test_engineer has NOT completed.
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-ec3',
				callID: 'call-ec3',
				args: { subagent_type: 'reviewer' },
			},
			{},
		);

		// Barrier not satisfied: state should advance only to reviewer_run.
		expect(getTaskState(session, '1.1')).toBe('reviewer_run');
	});

	it('EC-4: getSeedTaskId returns null — cross-session seeding is skipped', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config);

		// Primary session: no currentTaskId and no lastCoderDelegationTaskId → getSeedTaskId = null.
		startAgentSession('sess-ec4-primary', 'architect');
		const primary = ensureAgentSession('sess-ec4-primary');
		primary.currentTaskId = '1.1';
		primary.taskWorkflowStates.set('1.1', 'coder_delegated');

		// Secondary session: has NO task entries yet.
		startAgentSession('sess-ec4-other', 'architect');
		const other = ensureAgentSession('sess-ec4-other');
		// Clear currentTaskId so cross-session seeding cannot resolve a seed task for primary.
		primary.currentTaskId = undefined as unknown as string;
		// Ensure lastCoderDelegationTaskId is also absent.
		primary.lastCoderDelegationTaskId = undefined;

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-ec4-primary',
				callID: 'call-ec4',
				args: { subagent_type: 'reviewer' },
			},
			{},
		);

		// The other session must have received no seeded task entries.
		expect(other.taskWorkflowStates.size).toBe(0);
	});

	it('EC-5: cross-session seeding skipped when task already exists in other session', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config);

		startAgentSession('sess-ec5-primary', 'architect');
		const primary = ensureAgentSession('sess-ec5-primary');
		primary.currentTaskId = '1.1';
		primary.taskWorkflowStates.set('1.1', 'coder_delegated');

		// Secondary session already has '1.1' at reviewer_run — must not be downgraded.
		startAgentSession('sess-ec5-other', 'architect');
		const other = ensureAgentSession('sess-ec5-other');
		advanceTaskState(other, '1.1', 'coder_delegated');
		advanceTaskState(other, '1.1', 'reviewer_run');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-ec5-primary',
				callID: 'call-ec5',
				args: { subagent_type: 'reviewer' },
			},
			{},
		);

		// The other session must NOT have been downgraded from reviewer_run.
		// It should stay at reviewer_run (or advance, not regress).
		const otherState = getTaskState(other, '1.1');
		expect(['reviewer_run', 'tests_run', 'complete']).toContain(otherState);
	});

	it('EC-6: advanceTaskState to complete clears stageBCompletion for the task', () => {
		startAgentSession('sess-ec6', 'architect');
		const session = ensureAgentSession('sess-ec6');
		session.currentTaskId = '1.1';

		// Advance through the required sequence to reach tests_run (prerequisite for complete without council)
		advanceTaskState(session, '1.1', 'coder_delegated');
		advanceTaskState(session, '1.1', 'reviewer_run');
		advanceTaskState(session, '1.1', 'tests_run');

		// Record Stage B completions (mirrors what delegation-gate does on reviewer/test_engineer Task completion)
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');
		expect(session.stageBCompletion?.get('1.1')?.size ?? 0).toBe(2);
		expect(session.stageBCompletion?.has('1.1')).toBe(true);

		// Advance to complete — this must clear the entry (the behavior under test)
		advanceTaskState(session, '1.1', 'complete');

		// Verify clearing: stageBCompletion no longer contains the taskId
		expect(session.stageBCompletion?.has('1.1')).toBe(false);
		expect(session.stageBCompletion?.get('1.1')).toBeUndefined();
		// Map may still exist (other tasks) but this task's entry is gone
	});

	it('EC-7: canAdvanceTaskState allows valid forward transitions (idle→coder_delegated, coder_delegated→reviewer_run, reviewer_run→tests_run)', () => {
		startAgentSession('sess-ec7', 'architect');
		const session = ensureAgentSession('sess-ec7');
		session.currentTaskId = '1.1';

		// implicit current='idle'
		expect(canAdvanceTaskState(session, '1.1', 'coder_delegated')).toBe(true);

		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		expect(canAdvanceTaskState(session, '1.1', 'reviewer_run')).toBe(true);

		session.taskWorkflowStates.set('1.1', 'reviewer_run');
		expect(canAdvanceTaskState(session, '1.1', 'tests_run')).toBe(true);
	});

	it('EC-8: canAdvanceTaskState rejects same-state and backward transitions (tests_run→tests_run, complete→*)', () => {
		startAgentSession('sess-ec8', 'architect');
		const session = ensureAgentSession('sess-ec8');
		session.currentTaskId = '1.1';

		session.taskWorkflowStates.set('1.1', 'tests_run');
		expect(canAdvanceTaskState(session, '1.1', 'tests_run')).toBe(false);

		session.taskWorkflowStates.set('1.1', 'complete');
		expect(canAdvanceTaskState(session, '1.1', 'coder_delegated')).toBe(false);
		expect(canAdvanceTaskState(session, '1.1', 'reviewer_run')).toBe(false);
		expect(canAdvanceTaskState(session, '1.1', 'complete')).toBe(false);
	});

	it('EC-9: canAdvanceTaskState allows complete from tests_run (no council required)', () => {
		startAgentSession('sess-ec9', 'architect');
		const session = ensureAgentSession('sess-ec9');
		session.currentTaskId = '1.1';

		advanceTaskState(session, '1.1', 'coder_delegated');
		advanceTaskState(session, '1.1', 'reviewer_run');
		advanceTaskState(session, '1.1', 'tests_run');

		expect(canAdvanceTaskState(session, '1.1', 'complete')).toBe(true);
	});

	it('EC-10: canAdvanceTaskState requires council APPROVE + sufficient quorum + past pre_check_passed for complete from non-tests_run state', () => {
		startAgentSession('sess-ec10', 'architect');
		const session = ensureAgentSession('sess-ec10');
		session.currentTaskId = '1.1';

		// Set to pre_check_passed (past pre-check, but not yet tests_run)
		advanceTaskState(session, '1.1', 'coder_delegated');
		advanceTaskState(session, '1.1', 'pre_check_passed');

		// No council entry → false
		expect(canAdvanceTaskState(session, '1.1', 'complete')).toBe(false);

		// Council with wrong verdict → false
		session.taskCouncilApproved = new Map();
		session.taskCouncilApproved.set('1.1', {
			verdict: 'CONCERNS',
			roundNumber: 1,
			quorumSize: 3,
		});
		expect(canAdvanceTaskState(session, '1.1', 'complete')).toBe(false);

		// Council APPROVE but insufficient quorum (2 < 3) → false
		session.taskCouncilApproved.set('1.1', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 2,
		});
		expect(canAdvanceTaskState(session, '1.1', 'complete')).toBe(false);

		// Sufficient quorum but not past pre_check (reset to coder_delegated) → false
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		session.taskCouncilApproved.set('1.1', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 3,
		});
		expect(canAdvanceTaskState(session, '1.1', 'complete')).toBe(false);

		// Now at pre_check_passed + APPROVE + quorum>=3 → true (default min=3)
		session.taskWorkflowStates.set('1.1', 'pre_check_passed');
		expect(canAdvanceTaskState(session, '1.1', 'complete')).toBe(true);

		// With explicit councilConfig minimumMembers=4, quorum=3 insufficient
		expect(
			canAdvanceTaskState(session, '1.1', 'complete', { minimumMembers: 4 }),
		).toBe(false);

		// quorum=4 sufficient
		session.taskCouncilApproved.set('1.1', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 4,
		});
		expect(
			canAdvanceTaskState(session, '1.1', 'complete', { minimumMembers: 4 }),
		).toBe(true);

		// requireAllMembers: true forces 5
		session.taskCouncilApproved.set('1.1', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 4,
		});
		expect(
			canAdvanceTaskState(session, '1.1', 'complete', {
				requireAllMembers: true,
			}),
		).toBe(false);
		session.taskCouncilApproved.set('1.1', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 5,
		});
		expect(
			canAdvanceTaskState(session, '1.1', 'complete', {
				requireAllMembers: true,
			}),
		).toBe(true);
	});
});
