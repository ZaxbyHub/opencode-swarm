import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createSwarmCommandHandler } from '../../../src/commands/index.js';
import {
	_test_exports,
	bindPrWorkflowHead,
	completePrWorkflow,
	declarePrFeedbackInventory,
	PR_REVIEW_BASE_DIMENSION_IDS,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
	recordPrReviewValidationBatch,
	transitionPrReviewToFeedback,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
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
afterEach(async () => {
	_test_exports.beforePrFeedbackTransitionLock = undefined;
	await teardownPrWorkflowGateFixtures();
});

function handoffRelativePath(runId = RUN_ID): string {
	return `.swarm/pr-review/${runId}/feedback-handoff.json`;
}

function confirmedTransitionRequest(handoffPath: string, runId = RUN_ID) {
	return {
		runId,
		handoffPath,
		prUrl: PR_URL,
		exactCommand: `/swarm pr-feedback ${PR_URL} continue from ${handoffPath}`,
		confirmedByUser: true,
	};
}

function confirmedUrlLessTransitionRequest(
	handoffPath: string,
	runId = RUN_ID,
) {
	return {
		runId,
		handoffPath,
		exactCommand: `/swarm pr-feedback continue from ${handoffPath}`,
		confirmedByUser: true,
	};
}

function gateStatePath(): string {
	return path.join(
		tempDir,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
	);
}

async function overwriteHandoffArtifact(
	runId: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const absolute = path.join(tempDir, handoffRelativePath(runId));
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(absolute, JSON.stringify(payload, null, 2), 'utf8');
}

async function materializeTerminalReview(runId = RUN_ID): Promise<{
	handoffPath: string;
	findingIds: string[];
}> {
	await establishReviewPrerequisites();
	const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
		(_dimension, index) => `C-${index}`,
	);
	const handoffIds = [candidateIds[1] ?? 'C-1'];
	const explorerRecords = candidateIds.map((id) => ({
		finding_id: id,
		status: 'PENDING' as const,
		file_line: 'src/index.ts:1',
		evidence: `explorer evidence for ${id}`,
		next_action: 'route_to_reviewer' as const,
		severity: 'HIGH' as const,
	}));
	const reviewerRecords = candidateIds.map((id, index) => ({
		finding_id: id,
		status: index === 0 ? ('DISPROVED' as const) : ('CONFIRMED' as const),
		file_line: 'src/index.ts:1',
		evidence: `reviewer evidence for ${id}`,
		next_action:
			index === 0
				? ('suppress_with_reason' as const)
				: ('route_to_critic' as const),
		severity: index === 0 ? ('NONE' as const) : ('HIGH' as const),
	}));
	const criticRecords = candidateIds.map((id, index) => ({
		finding_id: id,
		status: index === 0 ? ('DISPROVED' as const) : ('CONFIRMED' as const),
		file_line: 'src/index.ts:1',
		evidence: `critic evidence for ${id}`,
		next_action:
			index === 0
				? ('suppress_with_reason' as const)
				: handoffIds.includes(id)
					? ('handoff_to_feedback' as const)
					: ('report' as const),
		severity: index === 0 ? ('NONE' as const) : ('HIGH' as const),
	}));
	const reviewerRows = candidateIds
		.map((id, index) =>
			index === 0
				? `[REVIEWED] | ${id} | DISPROVED | STRUCTURALLY_PROVEN | NONE | YES | file.ts:1 | rationale | probe | reviewer`
				: `[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
		)
		.join('\n');
	const criticRows = candidateIds
		.slice(1)
		.map((id) => `[CRITIC] | ${id} | UPHELD | HIGH | reason | no change`)
		.join('\n');

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
		{ textOverride: reviewerRows },
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
		{ textOverride: criticRows },
	);

	await executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			boundary: 'post_explorer',
			records: explorerRecords,
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
			records: reviewerRecords,
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
			records: criticRecords,
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);
	await executeWritePrReviewArtifact(
		{
			kind: 'handoff',
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			handoff: {
				pr_url: PR_URL,
				finding_ids: handoffIds,
				summary: 'validated actionable finding',
				provenance: ['review-boundaries', 'critic-boundaries'],
			},
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);
	return { handoffPath: handoffRelativePath(runId), findingIds: handoffIds };
}

describe('PR feedback continuation transition', () => {
	test('command transition replaces a terminal PR_REVIEW gate with unbound PR_FEEDBACK', async () => {
		const { handoffPath, findingIds } = await materializeTerminalReview();
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
			`[MODE: PR_FEEDBACK pr="${PR_URL}"] continue from ${handoffPath}`,
		);
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(state).toMatchObject({
			mode: 'PR_FEEDBACK',
			prFeedbackReviewHandoff: {
				path: `pr-review/${RUN_ID}/feedback-handoff.json`,
				runId: RUN_ID,
				sourcePrHeadSha: HEAD_SHA,
				prUrl: PR_URL,
				findingIds,
				provenance: 'active-review-v1',
			},
		});
		expect(state?.prHeadSha).toBeUndefined();
		expect(state?.prFeedbackInventory).toBeUndefined();

		const bound = await bindPrWorkflowHead(tempDir, SESSION_ID, HEAD_SHA);
		expect(bound).toMatchObject({
			mode: 'PR_FEEDBACK',
			prHeadSha: HEAD_SHA,
		});
		expect(bound.prFeedbackReviewHandoff?.findingIds).toEqual(findingIds);
	});

	test('nonterminal active reviews reject the continuation and preserve PR_REVIEW', async () => {
		await establishReviewPrerequisites();
		await overwriteHandoffArtifact(RUN_ID, {
			schema_version: 1,
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			created_at: '2026-08-01T00:00:00.000Z',
			pr_url: PR_URL,
			finding_ids: ['C-1'],
			summary: 'premature handoff',
			provenance: ['manual-test'],
		});

		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: RUN_ID,
				handoffPath: handoffRelativePath(RUN_ID),
				prUrl: PR_URL,
			}),
		).rejects.toThrow(
			/reviewer batch|trigger evaluation|durable findings checkpoints|feedback handoff artifact/i,
		);
		await expect(
			readPrWorkflowGateState(tempDir, SESSION_ID),
		).resolves.toMatchObject({
			mode: 'PR_REVIEW',
		});
	});

	test('completed reviews can continue externally with either exact continuation command form', async () => {
		const { handoffPath, findingIds } = await materializeTerminalReview();
		await expect(
			completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA),
		).resolves.toBe('completed');
		const feedback = await transitionPrReviewToFeedback(
			tempDir,
			SESSION_ID,
			confirmedUrlLessTransitionRequest(handoffPath),
		);
		expect(feedback).toMatchObject({
			mode: 'PR_FEEDBACK',
			prFeedbackReviewHandoff: {
				findingIds,
				provenance: 'external-v1',
			},
		});
	});

	test('exact retries are idempotent but different handoffs are blocked', async () => {
		const { handoffPath } = await materializeTerminalReview();
		const first = await transitionPrReviewToFeedback(
			tempDir,
			SESSION_ID,
			confirmedTransitionRequest(handoffPath),
		);
		const retried = await transitionPrReviewToFeedback(
			tempDir,
			SESSION_ID,
			confirmedTransitionRequest(handoffPath),
		);
		expect(retried.workflowInstanceId).toBe(first.workflowInstanceId);

		await overwriteHandoffArtifact('other-run', {
			schema_version: 1,
			run_id: 'other-run',
			pr_head_sha: HEAD_SHA,
			created_at: '2026-08-01T00:00:00.000Z',
			pr_url: PR_URL,
			finding_ids: ['C-9'],
			summary: 'other handoff',
			provenance: ['manual-test'],
		});
		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: 'other-run',
				handoffPath: handoffRelativePath('other-run'),
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/already active in PR_FEEDBACK/i);
	});

	test('mismatched handoff content is rejected fail-closed', async () => {
		await materializeTerminalReview();
		const absolute = path.join(tempDir, handoffRelativePath(RUN_ID));
		const original = JSON.parse(await fs.readFile(absolute, 'utf8')) as Record<
			string,
			unknown
		>;
		const variants: Array<[string, Record<string, unknown>, RegExp]> = [
			[
				'wrong url',
				{ ...original, pr_url: 'https://github.com/owner/repo/pull/999' },
				/GitHub PR URL|active review state/i,
			],
			[
				'wrong head',
				{ ...original, pr_head_sha: 'b'.repeat(40) },
				/active review state/i,
			],
			[
				'wrong finding ids',
				{ ...original, finding_ids: ['C-404'] },
				/finding IDs do not match/i,
			],
		];
		for (const [_label, payload, pattern] of variants) {
			await fs.writeFile(absolute, JSON.stringify(payload, null, 2), 'utf8');
			await expect(
				transitionPrReviewToFeedback(tempDir, SESSION_ID, {
					runId: RUN_ID,
					handoffPath: handoffRelativePath(RUN_ID),
					prUrl: PR_URL,
				}),
			).rejects.toThrow(pattern);
		}
	});

	test('inventory must include every handed-off finding but may include more', async () => {
		const { handoffPath, findingIds } = await materializeTerminalReview();
		await transitionPrReviewToFeedback(
			tempDir,
			SESSION_ID,
			confirmedTransitionRequest(handoffPath),
		);

		await expect(
			declarePrFeedbackInventory(tempDir, SESSION_ID, ['FB-999'], {
				prHeadSha: HEAD_SHA,
			}),
		).rejects.toThrow(/must include every continued review finding/i);
		const declared = await declarePrFeedbackInventory(
			tempDir,
			SESSION_ID,
			[...findingIds, 'FB-999'],
			{ prHeadSha: HEAD_SHA },
		);
		expect(declared.prFeedbackInventory).toEqual(['C-1', 'FB-999']);
	});

	test('fails closed if the active review state changes during the transition lock', async () => {
		const { handoffPath } = await materializeTerminalReview();
		_test_exports.beforePrFeedbackTransitionLock = async () => {
			const stateFile = gateStatePath();
			const current = JSON.parse(
				await fs.readFile(stateFile, 'utf8'),
			) as Record<string, unknown>;
			await fs.writeFile(
				stateFile,
				JSON.stringify(
					{
						...current,
						revision: Number(current.revision ?? 0) + 1,
						workflowInstanceId: 'other-review-instance',
					},
					null,
					2,
				),
				'utf8',
			);
		};

		await expect(
			transitionPrReviewToFeedback(
				tempDir,
				SESSION_ID,
				confirmedTransitionRequest(handoffPath),
			),
		).rejects.toThrow(/state changed while validating the feedback handoff/i);
	});

	test('rejects malformed and oversized external handoff artifacts', async () => {
		await overwriteHandoffArtifact('malformed', {
			not: 'a valid handoff',
		});
		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: 'malformed',
				handoffPath: handoffRelativePath('malformed'),
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/artifact is invalid/i);

		const oversizedSummary = 'x'.repeat(140 * 1024);
		await overwriteHandoffArtifact('oversized', {
			schema_version: 1,
			run_id: 'oversized',
			pr_head_sha: HEAD_SHA,
			created_at: '2026-08-01T00:00:00.000Z',
			pr_url: PR_URL,
			finding_ids: ['C-1'],
			summary: oversizedSummary,
			provenance: ['manual-test'],
		});
		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: 'oversized',
				handoffPath: handoffRelativePath('oversized'),
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/exceeds 131072 bytes|artifact is invalid/i);
	});
});
