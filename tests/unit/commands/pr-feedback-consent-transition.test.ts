import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createSwarmCommandHandler } from '../../../src/commands/index.js';
import {
	_test_exports,
	completePrWorkflow,
	PR_REVIEW_BASE_DIMENSION_IDS,
	prWorkflowSessionFileStem,
	recordPrReviewValidationBatch,
	transitionPrReviewToFeedback,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as artifactInternals,
	executeWritePrReviewArtifact,
} from '../../../src/tools/write-pr-review-artifact.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const PR_URL = 'https://github.com/owner/repo/pull/155';
const RUN_ID = 'test-run';

beforeEach(setupPrWorkflowGateFixtures);
const originalAtomicCreate = artifactInternals.atomicCreate;
afterEach(async () => {
	_test_exports.beforePrFeedbackTransitionLock = undefined;
	artifactInternals.atomicCreate = originalAtomicCreate;
	await teardownPrWorkflowGateFixtures();
});

function handoffRelativePath(runId = RUN_ID): string {
	return `.swarm/pr-review/${runId}/feedback-handoff.json`;
}

function handoffInput(runId = RUN_ID) {
	return {
		kind: 'handoff' as const,
		run_id: runId,
		pr_head_sha: HEAD_SHA,
		handoff: {
			pr_url: PR_URL,
			finding_ids: ['C-1'],
			summary: 'validated actionable finding',
			provenance: ['review-boundaries', 'critic-boundaries'],
		},
	};
}

async function materializeTerminalReview(
	runId = RUN_ID,
	includeHandoff = true,
): Promise<string> {
	await establishReviewPrerequisites();
	const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
		(_dimension, index) => `C-${index}`,
	);
	const handoffIds = [candidateIds[1] ?? 'C-1'];
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: runId,
				workflowLane: runId,
				reviewItemIds: candidateIds,
			},
		],
		{ batchId: runId, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		runId,
		'swarm-pr-review:reviewer',
		[{ laneId: runId, workflowLane: runId }],
		{
			textOverride: candidateIds
				.map((id, index) =>
					index === 0
						? `[REVIEWED] | ${id} | DISPROVED | STRUCTURALLY_PROVEN | NONE | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | `
						: `[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | `,
				)
				.join('\n'),
		},
	);
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'critic',
		[
			{
				laneId: `${runId}-critic`,
				workflowLane: `${runId}-critic`,
				reviewItemIds: candidateIds.slice(1),
			},
		],
		{ batchId: `${runId}-critic`, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		`${runId}-critic`,
		'swarm-pr-review:critic',
		[{ laneId: `${runId}-critic`, workflowLane: `${runId}-critic` }],
		{
			textOverride: candidateIds
				.slice(1)
				.map(
					(id) => `[CRITIC] | ${id} | UPHELD | HIGH | reason | required change`,
				)
				.join('\n'),
		},
	);
	await executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			boundary: 'post_explorer',
			records: candidateIds.map((id) => ({
				finding_id: id,
				status: 'PENDING',
				file_line: 'src/index.ts:1',
				evidence: `explorer evidence for ${id}`,
				next_action: 'route_to_reviewer',
				severity: 'HIGH',
			})),
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);
	await executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			boundary: 'post_reviewer',
			records: candidateIds.map((id, index) => ({
				finding_id: id,
				status: index === 0 ? 'DISPROVED' : 'CONFIRMED',
				file_line: 'src/index.ts:1',
				evidence: `reviewer evidence for ${id}`,
				next_action: index === 0 ? 'suppress_with_reason' : 'route_to_critic',
				severity: index === 0 ? 'NONE' : 'HIGH',
				...(index === 0
					? {}
					: { risk_impact: 'ORDINARY' as const, risk_tags: [] as string[] }),
			})),
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);
	await executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			boundary: 'post_critic',
			records: candidateIds.map((id, index) => ({
				finding_id: id,
				status: index === 0 ? 'DISPROVED' : 'CONFIRMED',
				file_line: 'src/index.ts:1',
				evidence: `critic evidence for ${id}`,
				next_action:
					index === 0
						? 'suppress_with_reason'
						: handoffIds.includes(id)
							? 'handoff_to_feedback'
							: 'report',
				severity: index === 0 ? 'NONE' : 'HIGH',
				...(index === 0
					? {}
					: { risk_impact: 'ORDINARY' as const, risk_tags: [] as string[] }),
			})),
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);
	if (includeHandoff) {
		await executeWritePrReviewArtifact(handoffInput(runId), tempDir, {
			sessionID: SESSION_ID,
		});
	}
	return handoffRelativePath(runId);
}

describe('PR feedback continuation consent gates (#2333)', () => {
	test('direct transition API rejects a handoff that was not explicitly confirmed by the command path', async () => {
		const handoffPath = await materializeTerminalReview();

		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
			} as never),
		).rejects.toThrow(/confirm|consent|exact command/i);
	});

	test('post-clear first exact continuation confirms the persisted offer and starts PR_FEEDBACK', async () => {
		const handoffPath = await materializeTerminalReview();
		await expect(
			completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
				reportVerdict: 'APPROVE',
			}),
		).resolves.toBe('completed');

		const handler = createSwarmCommandHandler(tempDir, {});
		const output = { parts: [] as unknown[] };
		await handler(
			{
				command: 'swarm-pr-feedback',
				sessionID: SESSION_ID,
				arguments: `${PR_URL} continue from ${handoffPath}`,
			},
			output,
		);

		expect(output.parts).toHaveLength(1);
		expect((output.parts[0] as { text: string }).text).toContain(
			'[MODE: PR_FEEDBACK',
		);
	});

	test('an exact response-loss retry reports already_offered and rewrites nothing', async () => {
		const handoffPath = await materializeTerminalReview();
		const handoffAbsolute = path.join(tempDir, handoffPath);
		const consentAbsolute = path.join(
			tempDir,
			'.swarm',
			'pr-review',
			RUN_ID,
			'feedback-consent.json',
		);
		const stateAbsolute = path.join(
			tempDir,
			'.swarm',
			'pr-workflow-gates',
			`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
		);
		const beforeHandoff = await fs.readFile(handoffAbsolute, 'utf8');
		const beforeConsent = await fs.readFile(consentAbsolute, 'utf8');
		const beforeState = await fs.readFile(stateAbsolute, 'utf8');

		const retry = JSON.parse(
			await executeWritePrReviewArtifact(handoffInput(), tempDir, {
				sessionID: SESSION_ID,
			}),
		) as { success: boolean; already_offered?: boolean };
		expect(retry).toMatchObject({ success: true, already_offered: true });
		expect(await fs.readFile(handoffAbsolute, 'utf8')).toBe(beforeHandoff);
		expect(await fs.readFile(consentAbsolute, 'utf8')).toBe(beforeConsent);
		expect(await fs.readFile(stateAbsolute, 'utf8')).toBe(beforeState);
	});

	test('handoff create I/O failures return operation and path without publishing state', async () => {
		await materializeTerminalReview(RUN_ID, false);
		artifactInternals.atomicCreate = async () => {
			throw new Error('injected permission denied');
		};
		const result = JSON.parse(
			await executeWritePrReviewArtifact(handoffInput(), tempDir, {
				sessionID: SESSION_ID,
			}),
		) as { success: boolean; message: string };
		expect(result.success).toBe(false);
		expect(result.message).toContain('operation create path');
		expect(result.message).toContain('feedback-handoff.json');
		expect(result.message).toContain('permission denied');
	});

	test('post-clear continuation rejects a tampered source workflow identity', async () => {
		const handoffPath = await materializeTerminalReview();
		await completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
			reportVerdict: 'APPROVE',
		});
		const consentPath = path.join(
			tempDir,
			'.swarm',
			'pr-review',
			RUN_ID,
			'feedback-consent.json',
		);
		const consent = JSON.parse(await fs.readFile(consentPath, 'utf8'));
		consent.source_workflow_instance_id = 'tampered-workflow';
		await fs.writeFile(consentPath, JSON.stringify(consent, null, 2), 'utf8');
		const exactCommand = `/swarm pr-feedback ${PR_URL} continue from ${handoffPath}`;

		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
				exactCommand,
				confirmedByUser: true,
			}),
		).rejects.toThrow(/consent artifact does not match/i);
	});

	test('active continuation rejects a consent sidecar from another workflow identity', async () => {
		const handoffPath = await materializeTerminalReview();
		const consentPath = path.join(
			tempDir,
			'.swarm',
			'pr-review',
			RUN_ID,
			'feedback-consent.json',
		);
		const consent = JSON.parse(await fs.readFile(consentPath, 'utf8'));
		consent.source_workflow_instance_id = 'other-active-workflow';
		await fs.writeFile(consentPath, JSON.stringify(consent, null, 2), 'utf8');
		const exactCommand = `/swarm pr-feedback ${PR_URL} continue from ${handoffPath}`;

		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
				exactCommand,
				confirmedByUser: true,
			}),
		).rejects.toThrow(/consent artifact does not match/i);
	});
});
