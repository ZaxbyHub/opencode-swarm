import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	advanceTaskState,
	getTaskState,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { recoverTaskStateFromDelegations } from '../../../src/tools/update-task-status';

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'exempt-recovery-'));
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

/**
 * Seed the exempt wedge shape (Wirtschaftssimulation task 1.8): a docs-only
 * task whose durable evidence proves test_engineer_exempt, whose reviewer
 * gate passed, but whose workflow state is pinned at reviewer_run because
 * the Stage-B completeness barrier recorded routeComplete: false.
 */
async function seedExemptReviewerRun(
	taskId: string,
	reviewerSessionId: string,
): Promise<void> {
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		context: { testEngineerExempt: true },
		expectedGeneration: 0,
		transitionId: `test-coder:${taskId}`,
	});
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `test-stage-a:${taskId}`,
	});
	await recordGateEvidence(
		tmpDir,
		taskId,
		'reviewer',
		reviewerSessionId,
		false,
		{
			expectedGeneration: 1,
			transitionId: `test-reviewer:${taskId}`,
			// The pre-fix completeness barrier outcome for an exempt task whose
			// route receipt still demanded a test engineer.
			routeComplete: false,
		},
	);
}

/** Seed the non-exempt control shape: full coder gates, reviewer only. */
async function seedNonExemptReviewerRun(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `test-coder:${taskId}`,
	});
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `test-stage-a:${taskId}`,
	});
	await recordGateEvidence(
		tmpDir,
		taskId,
		'reviewer',
		'sess-reviewer-6',
		false,
		{
			expectedGeneration: 1,
			transitionId: `test-reviewer:${taskId}`,
		},
	);
}

describe('recoverTaskStateFromDelegations — durable test-engineer exemption', () => {
	it('regression: an exempt reviewer_run task advances to tests_run from the reviewer proof alone', async () => {
		// Previous code: the reviewer_run → tests_run advance required
		// hasTestEngineer, which is false by definition for an exempt task —
		// the recovery sync could never advance the wedge, and completion
		// stayed blocked on "all required proof exists but workflow state is
		// reviewer_run".
		const taskId = '5.1';
		await seedExemptReviewerRun(taskId, 'sess-reviewer-5');
		const seeded = await readTaskEvidence(tmpDir, taskId);
		expect(seeded?.test_engineer_exempt).toBe(true);
		expect(seeded?.workflow.state).toBe('reviewer_run');

		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		expect(session).toBeDefined();
		if (!session) return;
		advanceTaskState(session, taskId, 'coder_delegated');
		advanceTaskState(session, taskId, 'pre_check_passed');
		advanceTaskState(session, taskId, 'reviewer_run');
		expect(getTaskState(session, taskId)).toBe('reviewer_run');

		recoverTaskStateFromDelegations(taskId, tmpDir);

		expect(getTaskState(session, taskId)).toBe('tests_run');
	});

	it('a non-exempt reviewer_run task without test-engineer proof still does not advance', async () => {
		const taskId = '5.2';
		await seedNonExemptReviewerRun(taskId);

		startAgentSession('session-2', 'architect');
		const session = swarmState.agentSessions.get('session-2');
		expect(session).toBeDefined();
		if (!session) return;
		advanceTaskState(session, taskId, 'coder_delegated');
		advanceTaskState(session, taskId, 'pre_check_passed');
		advanceTaskState(session, taskId, 'reviewer_run');

		recoverTaskStateFromDelegations(taskId, tmpDir);

		// The full Stage B pair is still required for non-exempt tasks.
		expect(getTaskState(session, taskId)).toBe('reviewer_run');
	});
});
