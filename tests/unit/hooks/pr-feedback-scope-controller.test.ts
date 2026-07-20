import { beforeEach, describe, expect, test } from 'bun:test';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate.js';
import {
	_test_exports,
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
} from '../../../src/hooks/pr-workflow-gate.js';
import { createScopeGuardHook } from '../../../src/hooks/scope-guard.js';
import {
	clearScopeBindings,
	getAuthorizedPrFeedbackScopeBinding,
} from '../../../src/scope/scope-binding.js';
import { ensureAgentSession, resetSwarmState } from '../../../src/state.js';
import { executePreparePrFeedbackScope } from '../../../src/tools/prepare-pr-feedback-scope.js';
import { makeConfig } from './_delegation-gate-helpers.js';
import {
	HEAD_SHA,
	persistBatch,
	REVISION_DIGEST,
	SESSION_ID,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

async function settleFeedbackVerification(): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
	await declarePrFeedbackInventory(tempDir, SESSION_ID, ['FB-001'], {
		prHeadSha: HEAD_SHA,
	});
	await enforcePrFeedbackVerificationOwnership(
		tempDir,
		SESSION_ID,
		[{ laneId: 'verify-scope', ownedItemIds: ['FB-001'] }],
		{ batchId: 'verify-scope', prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		'verify-scope',
		'swarm-pr-feedback:verification',
		[{ laneId: 'verify-scope', workflowLane: 'verify-scope' }],
		{
			textOverride: '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence',
		},
	);
}

describe('PR_FEEDBACK dedicated coder scope controller', () => {
	beforeEach(() => {
		resetSwarmState();
		ensureAgentSession(SESSION_ID, 'architect', tempDir);
	});

	test('fails closed before immutable verification settles', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		const result = JSON.parse(
			await executePreparePrFeedbackScope(
				{ task_id: '1.1', files: ['src/index.ts'] },
				tempDir,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/verification/i);
	});

	test('authorizes exactly one planless coder Task and enforces its bound files', async () => {
		await settleFeedbackVerification();
		const prepared = JSON.parse(
			await executePreparePrFeedbackScope(
				{ task_id: '1.1', files: ['src/index.ts'] },
				tempDir,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; files: string[] };
		expect(prepared).toMatchObject({
			success: true,
			files: ['src/index.ts'],
		});

		const delegation = createDelegationGateHook(makeConfig(), tempDir);
		await delegation.toolBefore(
			{ tool: 'Task', sessionID: SESSION_ID, callID: 'feedback-coder-call' },
			{
				args: {
					subagent_type: 'coder',
					task_id: '1.1',
					prompt:
						'TASK: 1.1\nFILE: src/index.ts\nACCEPTANCE: close FB-001 with focused validation',
				},
			},
		);
		await delegation.taskMetadata({
			callID: 'feedback-coder-call',
			parentSessionID: SESSION_ID,
			childSessionID: 'feedback-coder-child',
		});

		const binding = getAuthorizedPrFeedbackScopeBinding({
			directory: tempDir,
			activeSessionId: 'feedback-coder-child',
			taskId: '1.1',
		});
		expect(binding).toMatchObject({
			source: 'pr_feedback',
			files: ['src/index.ts'],
			workflowSessionId: SESSION_ID,
			workflowRevisionDigest: REVISION_DIGEST,
		});
		await expect(
			delegation.toolBefore(
				{
					tool: 'Task',
					sessionID: SESSION_ID,
					callID: 'feedback-coder-call-2',
				},
				{
					args: {
						subagent_type: 'coder',
						task_id: '1.1',
						prompt:
							'TASK: 1.1\nFILE: src/index.ts\nACCEPTANCE: duplicate dispatch',
					},
				},
			),
		).rejects.toThrow(/already consumed/i);
		const redeclared = JSON.parse(
			await executePreparePrFeedbackScope(
				{ task_id: '1.1', files: ['src/other.ts'] },
				tempDir,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };
		expect(redeclared.success).toBe(false);
		expect(redeclared.message).toMatch(/already consumed/i);

		const scopeGuard = createScopeGuardHook(
			{ enabled: true },
			tempDir,
			() => undefined,
		);
		await expect(
			scopeGuard.toolBefore(
				{
					tool: 'edit',
					sessionID: 'feedback-coder-child',
					callID: 'allowed-edit',
				},
				{ args: { path: 'src/index.ts' } },
			),
		).resolves.toBeUndefined();
		await expect(
			scopeGuard.toolBefore(
				{
					tool: 'edit',
					sessionID: 'feedback-coder-child',
					callID: 'blocked-edit',
				},
				{ args: { path: 'src/other.ts' } },
			),
		).rejects.toThrow(/SCOPE VIOLATION/i);

		clearScopeBindings();
		resetSwarmState();
		ensureAgentSession('feedback-coder-child', 'coder', tempDir);
		const restartedGuard = createScopeGuardHook(
			{ enabled: true },
			tempDir,
			() => undefined,
		);
		await expect(
			restartedGuard.toolBefore(
				{
					tool: 'edit',
					sessionID: 'feedback-coder-child',
					callID: 'restarted-edit',
				},
				{ args: { path: 'src/index.ts' } },
			),
		).resolves.toBeUndefined();
	});

	test('invalidates a prepared scope when the feedback revision changes', async () => {
		await settleFeedbackVerification();
		const result = JSON.parse(
			await executePreparePrFeedbackScope(
				{ task_id: '1.1', files: ['src/index.ts'] },
				tempDir,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean };
		expect(result.success).toBe(true);
		_test_exports.resolvePrWorkflowRevisionDigest = () => 'changed-revision';

		const delegation = createDelegationGateHook(makeConfig(), tempDir);
		await expect(
			delegation.toolBefore(
				{ tool: 'Task', sessionID: SESSION_ID, callID: 'stale-call' },
				{
					args: {
						subagent_type: 'coder',
						task_id: '1.1',
						prompt: 'TASK: 1.1\nFILE: src/index.ts\nACCEPTANCE: close FB-001',
					},
				},
			),
		).rejects.toThrow(/verification ownership is incomplete/i);
	});
});
