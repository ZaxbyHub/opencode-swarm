/**
 * Review F-007 (PR #3066): a PR-feedback coder is admitted outside the wave
 * gate (its authority is the authenticated PR-feedback declaration, not a
 * plan task), so nothing stopped it from writing files a RUNNING wave task
 * owns. While a wave is issued, a PR-feedback coder whose declared files
 * overlap any wave task's frozen scope is refused; disjoint files are still
 * admitted, as with no active wave.
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

async function openEpicWithIssuedWave(frozen: string[]): Promise<void> {
	fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ epic: { mode: { enabled: true } } }),
	);
	await writeApprovedPlan(tempDir, [
		{ id: '1.1', files: ['src/index.ts'] },
		{ id: '1.2', files: frozen },
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
		activeWaveSeq: 1,
		waves: [
			{
				seq: 1,
				phase: 1,
				kind: 'exclusive',
				taskIds: ['1.2'],
				files: { '1.2': frozen },
				cochange: null,
				baseHead: null,
				issuedAt: '2026-10-05T00:00:00.000Z',
				status: 'issued',
			},
		],
	} as never);
	expect(isEpicOpenForProject(tempDir)).toBe(true);
}

async function preparePrFeedbackScope(files: string[]): Promise<void> {
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
		await executePreparePrFeedbackScope({ task_id: '1.1', files }, tempDir, {
			sessionID: SESSION_ID,
		}),
	) as { success: boolean };
	expect(prepared.success).toBe(true);
}

test('issued wave owning the same file: the PR-feedback coder is refused', async () => {
	await openEpicWithIssuedWave(['src/index.ts']);
	await preparePrFeedbackScope(['src/index.ts']);
	const delegation = createDelegationGateHook(makeConfig(), tempDir);
	await expect(
		delegation.toolBefore(
			{ tool: 'Task', sessionID: SESSION_ID, callID: 'feedback-coder' },
			{ args: coder('1.1', 'src/index.ts') },
		),
	).rejects.toThrow('EPIC_PR_FEEDBACK_SCOPE_OVERLAP');
});

test('issued wave owning a directory around the file: refused too', async () => {
	await openEpicWithIssuedWave(['src']);
	await preparePrFeedbackScope(['src/index.ts']);
	const delegation = createDelegationGateHook(makeConfig(), tempDir);
	await expect(
		delegation.toolBefore(
			{ tool: 'Task', sessionID: SESSION_ID, callID: 'feedback-coder' },
			{ args: coder('1.1', 'src/index.ts') },
		),
	).rejects.toThrow('EPIC_PR_FEEDBACK_SCOPE_OVERLAP');
});

test('issued wave owning other files: the PR-feedback coder is admitted', async () => {
	await openEpicWithIssuedWave(['src/other.ts']);
	await preparePrFeedbackScope(['src/index.ts']);
	const delegation = createDelegationGateHook(makeConfig(), tempDir);
	await expect(
		delegation.toolBefore(
			{ tool: 'Task', sessionID: SESSION_ID, callID: 'feedback-coder' },
			{ args: coder('1.1', 'src/index.ts') },
		),
	).resolves.toBeUndefined();
});
