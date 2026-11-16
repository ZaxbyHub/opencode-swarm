import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
} as PluginConfig;

let tmpDir = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

beforeEach(async () => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	tmpDir = canonicalMkdtemp('dg-rework-remediation-');
	await fs.mkdir(`${tmpDir}/.swarm`, { recursive: true });
	await fs.mkdir(`${tmpDir}/.opencode`, { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	closeAllProjectDbs();
	// Issue #3261/#3203: raw `await fs.rm` here had no EBUSY/EPERM retry,
	// which hard-failed windows-latest merge-group shards under AV/cold-FS
	// handle contention (the #3242/#3261 evidence). Route through
	// safeRmRecursive — the bounded retry pattern proven for the
	// #2190/#2807 class.
	safeRmRecursive(tmpDir);
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

async function seedCoderDelegated(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `seed-coder:${taskId}`,
	});
}

async function seedReworkRequired(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `seed-coder:${taskId}`,
	});
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `seed-stage-a:${taskId}`,
	});
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'stage_b_failed',
		gate: 'test_engineer',
		expectedGeneration: 1,
		transitionId: `seed-stage-b-fail:${taskId}`,
	});
}

async function dispatchReviewerAndGetError(
	callID: string,
	agent: 'reviewer' | 'test_engineer',
): Promise<Error> {
	const hook = createDelegationGateHook(config, tmpDir);
	const thrown = await hook
		.toolBefore(
			{ tool: 'Task', sessionID: 'rework-remediation-session', callID },
			{
				args: {
					subagent_type: agent,
					task_id: '1.1',
					prompt:
						'TASK: 1.1\nACCEPTANCE: Verify the exact task and report a bound positive verdict.',
				},
			},
		)
		.catch((error: unknown) => error);
	expect(thrown).toBeInstanceOf(Error);
	return thrown as Error;
}

/**
 * Issue #2755 AC4: the TASK_WORKFLOW_STAGE_A_REQUIRED remediation is
 * state-specific. The rework_required branch must name the architect-legal
 * autonomous move (recover_rework_task) and must NOT offer the human-only
 * /swarm recover; the pre-Stage-A attribution-wedge branch keeps the
 * /swarm recover guidance where it actually applies.
 */
describe('delegation gate rework_required remediation text (issue #2755)', () => {
	test('from rework_required the refusal names recover_rework_task and never /swarm recover', async () => {
		await seedReworkRequired('1.1');
		const error = await dispatchReviewerAndGetError(
			'call-rework-reviewer',
			'reviewer',
		);
		expect(error.message).toContain('TASK_WORKFLOW_STAGE_A_REQUIRED');
		expect(error.message).toContain('from rework_required');
		expect(error.message).toContain('recover_rework_task');
		expect(error.message).not.toContain('/swarm recover');
	});

	test('from rework_required the same holds for test_engineer dispatch', async () => {
		await seedReworkRequired('1.1');
		const error = await dispatchReviewerAndGetError(
			'call-rework-te',
			'test_engineer',
		);
		expect(error.message).toContain('recover_rework_task');
		expect(error.message).not.toContain('/swarm recover');
	});

	test('from coder_delegated the attribution-wedge guidance with /swarm recover is preserved', async () => {
		await seedCoderDelegated('1.1');
		const error = await dispatchReviewerAndGetError(
			'call-wedge-reviewer',
			'reviewer',
		);
		expect(error.message).toContain('TASK_WORKFLOW_STAGE_A_REQUIRED');
		expect(error.message).toContain('/swarm recover 1.1');
		expect(error.message).not.toContain('recover_rework_task');
	});
});
