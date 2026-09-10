import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence.js';
import {
	markStageBRouteRequired,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state.js';
import {
	checkReviewerGate,
	recoverTaskStateFromDelegations,
} from '../../../src/tools/update-task-status.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';

async function writeCompleteUnroutedEvidence(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:${taskId}`,
	});
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `stage-a:${taskId}`,
	});
	await recordGateEvidence(
		directory,
		taskId,
		'reviewer',
		'legacy-reviewer',
		undefined,
		{ expectedGeneration: 1, transitionId: `review:${taskId}` },
	);
	await recordGateEvidence(
		directory,
		taskId,
		'test_engineer',
		'legacy-test-engineer',
		undefined,
		{ expectedGeneration: 1, transitionId: `test:${taskId}` },
	);
}

beforeEach(() => {
	resetSwarmState();
	directory = canonicalMkdtemp('issue-2491-route-bypass-');
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	startAgentSession('parent-2491', 'architect', directory);
});

afterEach(() => {
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('issue #2491 route enforcement at advancement and recovery paths', () => {
	test('normal durable-evidence completion is blocked after the task is marked routed', async () => {
		const taskId = '1.1';
		const session = swarmState.agentSessions.get('parent-2491')!;
		markStageBRouteRequired(session, taskId);
		await writeCompleteUnroutedEvidence(taskId);

		const result = checkReviewerGate(taskId, directory, false, 'parent-2491');
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('review route receipt');
	});

	test('recovery does not advance a marked task when its route receipt is missing', async () => {
		const taskId = '1.2';
		const session = swarmState.agentSessions.get('parent-2491')!;
		markStageBRouteRequired(session, taskId);
		await writeCompleteUnroutedEvidence(taskId);
		session.taskWorkflowStates.set(taskId, 'pre_check_passed');

		recoverTaskStateFromDelegations(taskId, directory);
		expect(session.taskWorkflowStates.get(taskId)).toBe('pre_check_passed');
	});
});
