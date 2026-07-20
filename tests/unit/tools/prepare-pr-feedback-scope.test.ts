import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_test_exports,
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createScopeGuardHook,
	_internals as scopeGuardInternals,
} from '../../../src/hooks/scope-guard.js';
import { clearScopeBindings } from '../../../src/scope/scope-binding.js';
import { ensureAgentSession, resetSwarmState } from '../../../src/state.js';
import { executePreparePrFeedbackScope } from '../../../src/tools/prepare-pr-feedback-scope.js';
import { installLegacyScopeGuardTargetSeam } from '../../helpers/scope-guard-binding-seam';
import {
	createDelegationGateHook,
	makeConfig,
} from '../../unit/hooks/_delegation-gate-helpers';

const SESSION_ID = 'prepare-pr-feedback-scope';
const HEAD_SHA = 'abc123';
const REVISION_DIGEST = 'revision-1';

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;

beforeEach(() => {
	clearScopeBindings();
	resetSwarmState();
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'prepare-pr-feedback-scope-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	clearScopeBindings();
	resetSwarmState();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	await fs.rm(directory, { recursive: true, force: true });
});

async function persistPrFeedbackBatch(
	batchId: string,
	mode: string,
	lanes: ReadonlyArray<{ laneId: string; workflowLane: string }>,
	text: string,
): Promise<void> {
	for (const [index, lane] of lanes.entries()) {
		const correlationId = `${batchId}-${index}`;
		await recordPendingDelegation(directory, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: SESSION_ID,
			callID: `call-${correlationId}`,
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId,
			laneId: lane.laneId,
			mode,
			workflowLane: lane.workflowLane,
			workspace: {
				directory,
				gitHead: HEAD_SHA,
				dirtyHash: null,
				prHeadSha: HEAD_SHA,
				scope: null,
			},
		});
		const stored = storeLaneOutput(directory, {
			batchId,
			laneId: lane.laneId,
			agent: 'reviewer',
			role: 'reviewer',
			sessionId: correlationId,
			parentSessionId: SESSION_ID,
			mode,
			workflowLane: lane.workflowLane,
			prHeadSha: HEAD_SHA,
			gitHead: HEAD_SHA,
			revisionDigest: REVISION_DIGEST,
			source: 'collect_lane_results',
			text,
		});
		await appendDelegationTransition(directory, correlationId, {
			status: 'completed',
			result: {
				text,
				chars: stored.chars,
				truncated: false,
				digest: stored.digest,
				...(stored.ref ? { outputRef: stored.ref } : {}),
			},
		});
	}
}

describe('prepare_pr_feedback_scope', () => {
	test('enables a planless coder Task and scope-guard blocks out-of-scope writes', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-001'], {
			prHeadSha: HEAD_SHA,
		});
		await enforcePrFeedbackVerificationOwnership(
			directory,
			SESSION_ID,
			[{ laneId: 'verify-scope', ownedItemIds: ['FB-001'] }],
			{ batchId: 'feedback-scope', prHeadSha: HEAD_SHA },
		);
		await persistPrFeedbackBatch(
			'feedback-scope',
			'swarm-pr-feedback:verification',
			[{ laneId: 'verify-scope', workflowLane: 'verify-scope' }],
			'[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence',
		);

		const prepared = JSON.parse(
			await executePreparePrFeedbackScope(
				{ task_id: '1.1', files: ['src/index.ts'] },
				directory,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; task_id: string; files: string[] };
		expect(prepared).toMatchObject({
			success: true,
			task_id: '1.1',
			files: ['src/index.ts'],
		});

		ensureAgentSession(SESSION_ID, 'architect', directory);
		const delegationGate = createDelegationGateHook(makeConfig(), directory);
		await expect(
			delegationGate.toolBefore(
				{ tool: 'Task', sessionID: SESSION_ID, callID: 'feedback-task' },
				{
					args: {
						subagent_type: 'coder',
						task_id: '1.1',
						prompt:
							'TASK: 1.1\nFILE: src/index.ts\nACCEPTANCE: repair the feedback-scoped bug',
					},
				},
			),
		).resolves.toBeUndefined();
		await delegationGate.taskMetadata({
			callID: 'feedback-task',
			parentSessionID: SESSION_ID,
			childSessionID: 'feedback-child',
		});

		const restoreTargets =
			installLegacyScopeGuardTargetSeam(scopeGuardInternals);
		try {
			const scopeGuard = createScopeGuardHook(
				{ enabled: true, skip_in_turbo: false },
				directory,
			);
			await expect(
				scopeGuard.toolBefore(
					{
						tool: 'apply_patch',
						sessionID: 'feedback-child',
						callID: 'write-allowed',
					},
					{ args: { path: 'src/index.ts' } },
				),
			).resolves.toBeUndefined();
			await expect(
				scopeGuard.toolBefore(
					{
						tool: 'apply_patch',
						sessionID: 'feedback-child',
						callID: 'write-blocked',
					},
					{ args: { path: 'src/other.ts' } },
				),
			).rejects.toThrow('SCOPE VIOLATION');
		} finally {
			restoreTargets();
		}
	});
});
