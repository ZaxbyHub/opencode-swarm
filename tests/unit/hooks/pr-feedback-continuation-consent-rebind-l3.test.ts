/**
 * Issue #3316 AC18 (L3 acceptance, DISCRIMINATING): a completed PR_REVIEW
 * continuation confirmed with the EXACT offered command must be consumable by
 * a different session than the one that ran the review — the durable consent
 * record (handoff digest + exact command) is the authority, not the session
 * that happens to hold the run reservation. Base behavior pins the
 * reservation to the review session and rejects every other session id.
 *
 * The terminal-review ladder is fsync-heavy (~30 s on Windows hardware), so it
 * is built ONCE for the file in `beforeAll`; the per-test body stays inside
 * the standard 30 s test budget.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
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
} from './pr-workflow-gate.test-fixtures.js';

const PR_URL = 'https://github.com/owner/repo/pull/3316';
// establishReviewPrerequisites hardcodes its trigger-eval run id; the review
// artifacts must reuse it.
const RUN_ID = 'test-run';
/** The session that ran the review and owns the durable run reservation. */
const SESSION_A = SESSION_ID;
/** A different session confirming the exact offered command. */
const SESSION_B = 'l3-continuation-b';

function handoffRelativePath(runId = RUN_ID): string {
	return `.swarm/pr-review/${runId}/feedback-handoff.json`;
}

function handoffInput() {
	return {
		kind: 'handoff' as const,
		run_id: RUN_ID,
		pr_head_sha: HEAD_SHA,
		handoff: {
			pr_url: PR_URL,
			finding_ids: ['C-1'],
			summary: 'validated actionable finding',
			provenance: ['confirmation-tests'],
		},
	};
}

async function writeArtifactChecked(
	input: Parameters<typeof executeWritePrReviewArtifact>[0],
): Promise<void> {
	const result = JSON.parse(
		await executeWritePrReviewArtifact(input, tempDir, {
			sessionID: SESSION_A,
		}),
	) as { success: boolean; message?: string };
	if (!result.success) {
		throw new Error(
			`pr-review artifact write failed (${input.kind}:${input.boundary ?? input.run_id}): ${result.message}`,
		);
	}
}

/** Full terminal review for SESSION_A: ladder, artifacts, handoff, consent. */
async function materializeTerminalReview(): Promise<string> {
	await establishReviewPrerequisites();
	const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
		(_dimension, index) => `C-${index}`,
	);
	const handoffIds = [candidateIds[1] ?? 'C-1'];
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
		SESSION_A,
		'reviewer',
		[{ laneId: RUN_ID, workflowLane: RUN_ID, reviewItemIds: candidateIds }],
		{ batchId: RUN_ID, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		RUN_ID,
		'swarm-pr-review:reviewer',
		[{ laneId: RUN_ID, workflowLane: RUN_ID }],
		{ textOverride: reviewerRows },
	);
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_A,
		'critic',
		[
			{
				laneId: `${RUN_ID}-critic`,
				agent: 'critic',
				workflowLane: `${RUN_ID}-critic`,
				reviewItemIds: candidateIds.slice(1),
			},
		],
		{ batchId: `${RUN_ID}-critic`, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		`${RUN_ID}-critic`,
		'swarm-pr-review:critic',
		[{ laneId: `${RUN_ID}-critic`, workflowLane: `${RUN_ID}-critic` }],
		{ textOverride: criticRows },
	);
	for (const [boundary, nextAction] of [
		['post_explorer', 'route_to_reviewer'],
		['post_reviewer', 'route_to_critic'],
		['post_critic', 'handoff_to_feedback'],
	] as const) {
		await writeArtifactChecked({
			kind: 'findings',
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			boundary,
			records: candidateIds.map((id, index) => ({
				finding_id: id,
				status:
					boundary === 'post_explorer'
						? ('PENDING' as const)
						: index === 0
							? ('DISPROVED' as const)
							: ('CONFIRMED' as const),
				file_line: 'src/index.ts:1',
				evidence: `${boundary} evidence for ${id}`,
				next_action:
					boundary === 'post_explorer'
						? (nextAction as 'route_to_reviewer')
						: index === 0
							? ('suppress_with_reason' as const)
							: boundary === 'post_critic' && !handoffIds.includes(id)
								? ('report' as const)
								: (nextAction as typeof nextAction),
				severity:
					boundary === 'post_explorer' || index !== 0
						? ('HIGH' as const)
						: ('NONE' as const),
				risk_impact: 'UNKNOWN' as const,
				risk_tags: [] as string[],
			})),
		});
	}
	await writeArtifactChecked(handoffInput());
	return handoffRelativePath();
}

/** Terminal review on disk, SESSION_A gate state deleted (external restart). */
async function externalRestartState(): Promise<{
	handoffPath: string;
	exactCommand: string;
}> {
	const handoffPath = await materializeTerminalReview();
	const reviewState = await readPrWorkflowGateState(tempDir, SESSION_A);
	expect(reviewState?.mode).toBe('PR_REVIEW');
	const sessionPath = path.join(
		tempDir,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(SESSION_A)}.json`,
	);
	await fs.rm(sessionPath, { force: true });
	return {
		handoffPath,
		exactCommand: `/swarm pr-feedback ${PR_URL} continue from ${handoffPath}`,
	};
}

let externalState: { handoffPath: string; exactCommand: string } | null = null;

beforeAll(async () => {
	setupPrWorkflowGateFixtures();
	externalState = await externalRestartState();
}, 120_000);

afterAll(async () => {
	externalState = null;
	await teardownPrWorkflowGateFixtures();
});

describe('PR_FEEDBACK continuation consent rebind (AC18)', () => {
	test('a different session confirming the exact offered command completes the transition', async () => {
		const { handoffPath, exactCommand } = externalState!;
		_test_exports.resetTrackedStateCache();

		const transitionOutcome = await transitionPrReviewToFeedback(
			tempDir,
			SESSION_B,
			{
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
				exactCommand,
				confirmedByUser: true,
			},
		).then(
			(state) => `transitioned:${state.mode}`,
			(error: unknown) => `rejected: ${(error as Error).message}`,
		);
		expect(transitionOutcome).toBe('transitioned:PR_FEEDBACK');

		// The durable consent record survives the rebind and stays parseable.
		const consentPath = path.join(
			tempDir,
			'.swarm',
			'pr-review',
			RUN_ID,
			'feedback-consent.json',
		);
		const consent = JSON.parse(await fs.readFile(consentPath, 'utf8')) as {
			run_id: string;
		};
		expect(consent.run_id).toBe(RUN_ID);
	});
});
