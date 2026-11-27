import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence.js';
import {
	createDelegationGateHook,
	_internals as delegationGateInternals,
} from '../../../src/hooks/delegation-gate.js';
import { routeReceiptPathForTask } from '../../../src/review/routing-enforcement.js';
import {
	advanceTaskState,
	getStageBRouteEvidence,
	getTaskState,
	recordModifiedFilesForTask,
	recordStageBRouteEvidence,
	reserveStageBRouteEvidence,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const config = {
	hooks: { delegation_gate: true },
} as PluginConfig;
const originalSettlementRouteEnforcer =
	delegationGateInternals.enforcePersistedReviewRouteReceiptAtSettlement;

let directory = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

beforeEach(async () => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	directory = canonicalMkdtemp('issue-2491-direct-route-gate-');
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	startAgentSession('parent-2491', 'architect', directory);
	// Drain the asynchronous session rehydration before mutating the in-memory
	// workflow; the delegation gate awaits this queue before Stage-B dispatch.
	await Promise.allSettled([...swarmState.pendingRehydrations]);
	await transitionTaskWorkflowEvidence(directory, '1.1', {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: 'coder:1.1',
	});
	await transitionTaskWorkflowEvidence(directory, '1.1', {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: 'stage-a:1.1',
	});
	const session = swarmState.agentSessions.get('parent-2491')!;
	recordModifiedFilesForTask(session, '1.1', ['src/example.ts']);
	advanceTaskState(session, '1.1', 'coder_delegated');
	advanceTaskState(session, '1.1', 'pre_check_passed');
	session.currentTaskId = '1.1';
});

afterEach(() => {
	delegationGateInternals.enforcePersistedReviewRouteReceiptAtSettlement =
		originalSettlementRouteEnforcer;
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

describe('issue #2491 direct delegation-gate route authorization', () => {
	async function completeDispatch(
		hook: ReturnType<typeof createDelegationGateHook>,
		role: 'reviewer' | 'test_engineer',
		callID: string,
		childSessionID: string,
	): Promise<void> {
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent-2491', callID },
			{
				args: {
					subagent_type: role,
					task_id: '1.1',
					prompt: `${role} task-1.1.\nACCEPTANCE: return a structured ${role} result for task-1.1.`,
				},
			},
		);
		await hook.taskMetadata({
			callID,
			parentSessionID: 'parent-2491',
			childSessionID,
		});
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'parent-2491',
				callID,
				args: { subagent_type: role, task_id: '1.1' },
			},
			{
				text:
					role === 'reviewer'
						? '[REVIEWED] | task-1.1 | APPROVED | looks good'
						: '[TESTED] | task-1.1 | PASS | focused tests passed',
			},
		);
	}

	test('overlapping sibling settlements refresh live completeness after both stale pre-lock decisions', async () => {
		const hook = createDelegationGateHook(config, directory);
		const dispatch = async (
			role: 'reviewer' | 'test_engineer',
			callID: string,
			childSessionID: string,
		) => {
			const args = {
				subagent_type: role,
				task_id: '1.1',
				prompt: `${role} task-1.1.\nACCEPTANCE: return a structured ${role} result.`,
			};
			await hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent-2491', callID },
				{ args },
			);
			await hook.taskMetadata({
				callID,
				parentSessionID: 'parent-2491',
				childSessionID,
			});
			return { role, callID, args };
		};
		const reviewer = await dispatch(
			'reviewer',
			'overlap-review',
			'overlap-review-child',
		);
		const testEngineer = await dispatch(
			'test_engineer',
			'overlap-test',
			'overlap-test-child',
		);
		let forcedStaleDecisions = 0;
		delegationGateInternals.enforcePersistedReviewRouteReceiptAtSettlement = (
			input,
		) => {
			if (!input.requireCompleteEvidence) {
				return originalSettlementRouteEnforcer(input);
			}
			forcedStaleDecisions += 1;
			return {
				canAdvance: false,
				mode: 'enforced',
				reason: 'FORCED_STALE_PRELOCK',
			};
		};
		try {
			await Promise.all([
				hook.toolAfter(
					{
						tool: 'Task',
						sessionID: 'parent-2491',
						callID: reviewer.callID,
						args: reviewer.args,
					},
					{ text: '[REVIEWED] | task-1.1 | APPROVED | overlap review' },
				),
				hook.toolAfter(
					{
						tool: 'Task',
						sessionID: 'parent-2491',
						callID: testEngineer.callID,
						args: testEngineer.args,
					},
					{ text: '[TESTED] | task-1.1 | PASS | overlap tests' },
				),
			]);
		} finally {
			delegationGateInternals.enforcePersistedReviewRouteReceiptAtSettlement =
				originalSettlementRouteEnforcer;
		}

		const session = swarmState.agentSessions.get('parent-2491')!;
		const evidence = await readTaskEvidence(directory, '1.1');
		expect(forcedStaleDecisions).toBe(2);
		expect(evidence.workflow.state).toBe('tests_run');
		expect(getTaskState(session, '1.1')).toBe('tests_run');
		expect(getStageBRouteEvidence(session, '1.1')).toHaveLength(2);
	});
});
