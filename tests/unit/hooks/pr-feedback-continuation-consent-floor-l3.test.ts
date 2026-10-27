/**
 * Issue #3316 AC19 (L3 acceptance, PRESERVING): whatever session-rebinding
 * AC18 admits, the consent CONTRACT itself stays binding — no confirmation
 * flag, a mutated command, or an edited handoff artifact must never complete
 * a transition, at base AND after the fix.
 *
 * The terminal-review ladder is built ONCE for the file in `beforeAll`; each
 * leg then attempts a continuation against the shared external-restart state.
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
// establishReviewPrerequisites hardcodes its trigger-eval run id.
const RUN_ID = 'test-run';
const SESSION_A = SESSION_ID;
const SESSION_B = 'l3-continuation-b';

function handoffRelativePath(): string {
	return `.swarm/pr-review/${RUN_ID}/feedback-handoff.json`;
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

async function materializeTerminalReview(): Promise<void> {
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
}

const exactCommand = `/swarm pr-feedback ${PR_URL} continue from ${handoffRelativePath()}`;
const handoffPath = handoffRelativePath();

beforeAll(async () => {
	setupPrWorkflowGateFixtures();
	await materializeTerminalReview();
	const reviewState = await readPrWorkflowGateState(tempDir, SESSION_A);
	expect(reviewState?.mode).toBe('PR_REVIEW');
	const sessionPath = path.join(
		tempDir,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(SESSION_A)}.json`,
	);
	await fs.rm(sessionPath, { force: true });
	_test_exports.resetTrackedStateCache();
}, 120_000);

afterAll(async () => {
	await teardownPrWorkflowGateFixtures();
});

describe('PR_FEEDBACK continuation consent floors (AC19)', () => {
	test('a foreign session without explicit user confirmation is refused', async () => {
		_test_exports.resetTrackedStateCache();
		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_B, {
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
			}),
		).rejects.toThrow();
	});

	test('a foreign session with a mutated command is refused', async () => {
		_test_exports.resetTrackedStateCache();
		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_B, {
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
				exactCommand: 'git status',
				confirmedByUser: true,
			}),
		).rejects.toThrow();
	});

	test('the owning session still needs the exact offered command', async () => {
		_test_exports.resetTrackedStateCache();
		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_A, {
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
				exactCommand: 'git status',
				confirmedByUser: true,
			}),
		).rejects.toThrow(/explicit confirmation with the offered command/);
	});

	test('the owning session still needs confirmedByUser', async () => {
		_test_exports.resetTrackedStateCache();
		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_A, {
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
				exactCommand,
				confirmedByUser: false,
			}),
		).rejects.toThrow(/explicit confirmation with the offered command/);
	});

	test('a handoff artifact edited after the consent offer is refused', async () => {
		_test_exports.resetTrackedStateCache();
		const handoffAbsolute = path.join(tempDir, handoffPath);
		const original = await fs.readFile(handoffAbsolute, 'utf8');
		try {
			// The persisted handoff record is flattened (schema_version, run_id,
			// pr_head_sha, created_at, pr_url, finding_ids, summary, provenance);
			// tamper the free-text summary so every other consent-bound field
			// stays identical and only the digest changes.
			const edited = JSON.parse(original) as { summary: string };
			edited.summary = 'tampered after consent';
			await fs.writeFile(handoffAbsolute, JSON.stringify(edited), 'utf8');
			_test_exports.resetTrackedStateCache();
			await expect(
				transitionPrReviewToFeedback(tempDir, SESSION_A, {
					runId: RUN_ID,
					handoffPath,
					prUrl: PR_URL,
					exactCommand,
					confirmedByUser: true,
				}),
			).rejects.toThrow();
		} finally {
			await fs.writeFile(handoffAbsolute, original, 'utf8');
		}
	});

	test('a foreign session with a mismatched handoff digest is refused pre-write and the consent sidecar is unchanged (review round 1)', async () => {
		_test_exports.resetTrackedStateCache();
		const handoffAbsolute = path.join(tempDir, handoffPath);
		const original = await fs.readFile(handoffAbsolute, 'utf8');
		const consentAbsolute = path.join(
			tempDir,
			'.swarm',
			'pr-review',
			RUN_ID,
			'feedback-consent.json',
		);
		const consentBefore = await fs.readFile(consentAbsolute, 'utf8');
		try {
			const edited = JSON.parse(original) as { summary: string };
			edited.summary = 'tampered for the foreign session';
			await fs.writeFile(handoffAbsolute, JSON.stringify(edited), 'utf8');
			_test_exports.resetTrackedStateCache();
			await expect(
				transitionPrReviewToFeedback(tempDir, SESSION_B, {
					runId: RUN_ID,
					handoffPath,
					prUrl: PR_URL,
					exactCommand,
					confirmedByUser: true,
				}),
			).rejects.toThrow();
			// No silent rebind: the refused transition leaves the consent
			// record byte-identical (still owned by the review session).
			expect(await fs.readFile(consentAbsolute, 'utf8')).toBe(consentBefore);
		} finally {
			await fs.writeFile(handoffAbsolute, original, 'utf8');
		}
	});
});
