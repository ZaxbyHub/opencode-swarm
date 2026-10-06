/**
 * Epic v2 C4 (r3 MINOR 10) — a PR-feedback coder is never wave-gated. Its
 * authenticated PR-feedback scope (no plan task) is admitted by the gate's
 * `pr_feedback` early return, which runs BEFORE the Epic dispatch seam, so
 * an open epic with no active wave refuses an ordinary plan coder
 * (EPIC_NO_ACTIVE_WAVE) but not the PR-feedback coder.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { isEpicOpenForProject } from '../../../src/epic/lifecycle.js';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate.js';
import {
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
} from '../../../src/hooks/pr-workflow-gate.js';
import { ensureAgentSession, resetSwarmState } from '../../../src/state.js';
import { executePreparePrFeedbackScope } from '../../../src/tools/prepare-pr-feedback-scope.js';
import { writeApprovedPlan } from '../../helpers/approved-plan.js';
import { openEpicForTest } from '../../helpers/epic-lifecycle.js';
import { makeConfig } from './_delegation-gate-helpers.js';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	resetSwarmState();
	ensureAgentSession(SESSION_ID, 'architect', tempDir);
});

afterEach(async () => {
	resetSwarmState();
	closeAllProjectDbs();
	await teardownPrWorkflowGateFixtures();
});

const coder = (taskId: string, file: string) => ({
	subagent_type: 'coder',
	task_id: taskId,
	prompt: `TASK: ${taskId}\nFILE: ${file}\nACCEPTANCE: close FB-001`,
});

test('open epic, no active wave: plan coder refused, PR-feedback coder admitted', async () => {
	fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			epic: { mode: { enabled: true } },
		}),
	);
	await writeApprovedPlan(tempDir, [
		{ id: '1.1', files: ['src/index.ts'] },
		{ id: '1.2', files: ['src/other.ts'] },
	]);
	openEpicForTest(tempDir, {
		config: {
			commitPolicy: 'current-branch',
			isolation: 'main-tree-nogit',
			maxParallel: 1,
		},
		git: {
			isRepo: false,
			baseCommit: null,
			originalBranch: null,
			epicBranch: null,
		},
	});
	expect(isEpicOpenForProject(tempDir)).toBe(true);
	const delegation = createDelegationGateHook(makeConfig(), tempDir);

	// Control: an ordinary plan coder is wave-gated.
	await expect(
		delegation.toolBefore(
			{ tool: 'Task', sessionID: SESSION_ID, callID: 'plan-coder' },
			{ args: coder('1.2', 'src/other.ts') },
		),
	).rejects.toThrow('EPIC_NO_ACTIVE_WAVE');

	// Settle PR-feedback verification and prepare the dedicated scope.
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
		{ textOverride: '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence' },
	);
	const prepared = JSON.parse(
		await executePreparePrFeedbackScope(
			{ task_id: '1.1', files: ['src/index.ts'] },
			tempDir,
			{ sessionID: SESSION_ID },
		),
	) as { success: boolean };
	expect(prepared.success).toBe(true);

	await expect(
		delegation.toolBefore(
			{ tool: 'Task', sessionID: SESSION_ID, callID: 'feedback-coder' },
			{ args: coder('1.1', 'src/index.ts') },
		),
	).resolves.toBeUndefined();
});
