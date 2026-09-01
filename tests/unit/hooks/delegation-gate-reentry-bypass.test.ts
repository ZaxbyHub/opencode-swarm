import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { PluginConfig } from '../../../src/config';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	issuePrReviewReentryAuthorization,
	_internals as reentryInternals,
} from '../../../src/pr-review/authorization';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate';
import { resetSwarmState } from '../../../src/state';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
} as PluginConfig;

let tmpDir = '';
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	gateInternals.resolvePrWorkflowRevisionDigest;

beforeEach(async () => {
	resetSwarmState();
	gateInternals.resetTrackedStateCache();
	tmpDir = canonicalMkdtemp('dg-reentry-test-');
	await fs.mkdir(`${tmpDir}/.swarm`, { recursive: true });
	gateInternals.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	gateInternals.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
});

afterEach(async () => {
	resetSwarmState();
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Task evidence at a pre-Stage-A state, so reviewer dispatch needs a bypass. */
async function seedPreStageATask(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `seed-coder:${taskId}`,
	});
}

async function dispatchReviewer(callID: string): Promise<void> {
	const hook = createDelegationGateHook(config, tmpDir);
	await hook.toolBefore(
		{ tool: 'Task', sessionID: PR_ARTIFACT_SESSION_ID, callID },
		{
			args: {
				subagent_type: 'reviewer',
				task_id: '1.1',
				prompt:
					'TASK: 1.1\nACCEPTANCE: Verify the exact task and report a bound positive verdict.',
			},
		},
	);
}

describe('delegation gate PR-review re-entry bypass (issue #2383)', () => {
	test('without an authorization, the generic Stage-A requirement still throws', async () => {
		await seedPreStageATask('1.1');
		await expect(dispatchReviewer('call-plain')).rejects.toThrow(
			/TASK_WORKFLOW_STAGE_A_REQUIRED/,
		);
	});

	test('an ordinary session with no PR_REVIEW gate is unchanged (no bypass)', async () => {
		await seedPreStageATask('1.1');
		await expect(dispatchReviewer('call-no-gate')).rejects.toThrow(
			/TASK_WORKFLOW_STAGE_A_REQUIRED/,
		);
	});

	test('a consumed one-use authorization bypasses ONLY the Stage-A throw', async () => {
		await seedPreStageATask('1.1');
		await activatePrWorkflow(tmpDir, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		const record = await issuePrReviewReentryAuthorization(
			tmpDir,
			PR_ARTIFACT_SESSION_ID,
			{ prHeadSha: PR_ARTIFACT_HEAD_SHA, role: 'reviewer' },
		);
		expect(record.role).toBe('reviewer');
		// The dispatch passes (no throw) and the authorization is consumed.
		await dispatchReviewer('call-authorized');
		const store = JSON.parse(
			readFileSync(
				reentryInternals.reentryAuthorizationFilePath(
					tmpDir,
					PR_ARTIFACT_SESSION_ID,
				),
				'utf8',
			),
		).authorizations as Array<{ consumedAt?: string }>;
		expect(store.some((entry) => entry.consumedAt)).toBe(true);
	});

	test('the bypass is one-use: a second dispatch hits Stage-A again', async () => {
		await seedPreStageATask('1.1');
		await activatePrWorkflow(tmpDir, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		await issuePrReviewReentryAuthorization(tmpDir, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		await dispatchReviewer('call-first');
		await expect(dispatchReviewer('call-second')).rejects.toThrow(
			/TASK_WORKFLOW_STAGE_A_REQUIRED/,
		);
	});

	test('a wrong-role authorization does not bypass a reviewer dispatch', async () => {
		await seedPreStageATask('1.1');
		await activatePrWorkflow(tmpDir, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		await issuePrReviewReentryAuthorization(tmpDir, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'test_engineer',
		});
		await expect(dispatchReviewer('call-wrong-role')).rejects.toThrow(
			/TASK_WORKFLOW_STAGE_A_REQUIRED/,
		);
	});
});
