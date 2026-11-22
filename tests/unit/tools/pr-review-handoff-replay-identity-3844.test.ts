/**
 * #3844 Stage-B (FB-008): the handoff replay identity must be computed over
 * ONE comparable — the RAW one.
 *
 * The claim fingerprint and the comparison fingerprint used to be built over
 * DIFFERENT inputs (the claim over the REDACTED pr_url/provenance, the
 * comparison over the RAW ones). Whenever the raw text actually carried a
 * credential the two fingerprints disagreed, so an IDENTICAL retry was
 * refused as a "conflicting handoff content" and two different raw payloads
 * that redact to the same text shared one claim.
 *
 * Synthetic tokens only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	PR_REVIEW_BASE_DIMENSION_IDS,
	recordPrReviewValidationBatch,
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

const GH = `ghp_${'h'.repeat(30)}`;
// The fixture's established review run id — the artifact tool refuses a
// run_id that does not match the workflow's own lane identity.
const RUN_ID = 'test-run';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(async () => {
	_test_exports.beforePrFeedbackTransitionLock = undefined;
	await teardownPrWorkflowGateFixtures();
});

/**
 * Drive the review to its terminal boundary and write the handoff.
 *
 * `provenance` carries a synthetic credential so the REDACTED handoff record
 * and the RAW handoff payload genuinely differ — the shape that made the two
 * fingerprints disagree.
 */
async function writeHandoff(provenance: string[]) {
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
		...(index === 0
			? {}
			: { risk_impact: 'ORDINARY' as const, risk_tags: [] as string[] }),
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
		...(index === 0
			? {}
			: { risk_impact: 'ORDINARY' as const, risk_tags: [] as string[] }),
	}));
	const reviewerRows = candidateIds
		.map((id, index) =>
			index === 0
				? `[REVIEWED] | ${id} | DISPROVED | STRUCTURALLY_PROVEN | NONE | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | `
				: `[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | `,
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
				laneId: RUN_ID,
				workflowLane: RUN_ID,
				reviewItemIds: candidateIds,
			},
		],
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
		SESSION_ID,
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

	await executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: RUN_ID,
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
			run_id: RUN_ID,
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
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			boundary: 'post_critic',
			records: criticRecords,
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);

	const handoff = {
		pr_url: 'https://github.com/owner/repo/pull/155',
		finding_ids: handoffIds,
		summary: 'validated actionable finding',
		provenance,
	};
	await executeWritePrReviewArtifact(
		{
			kind: 'handoff',
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			handoff,
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);
	return { handoff, handoffIds };
}

describe('#3844 FB-008: the handoff replay identity uses ONE comparable', () => {
	test('an IDENTICAL retry of a credential-bearing handoff is not refused as a conflict', async () => {
		const provenance = ['review-boundaries', `critic-boundaries?token=${GH}`];
		const { handoff } = await writeHandoff(provenance);

		// The persisted artifact is redacted — the raw credential is gone.
		const persisted = await Bun.file(
			`${tempDir}/.swarm/pr-review/${RUN_ID}/feedback-handoff.json`,
		).text();
		expect(persisted).not.toContain(GH);
		expect(persisted).toContain('[REDACTED]');

		// The SAME raw payload again: the replay identity must recognise it.
		const retry = await executeWritePrReviewArtifact(
			{
				kind: 'handoff',
				run_id: RUN_ID,
				pr_head_sha: HEAD_SHA,
				handoff,
			},
			tempDir,
			{ sessionID: SESSION_ID },
		);
		const retryResult = JSON.parse(retry) as {
			success?: boolean;
			message?: string;
		};
		expect(retryResult.success).toBe(true);
		expect(String(retryResult.message ?? '')).not.toContain('conflicting');
	}, 60_000);

	test('a DIFFERENT raw handoff is still refused as a conflict', async () => {
		const { handoffIds } = await writeHandoff([
			'review-boundaries',
			`critic-boundaries?token=${GH}`,
		]);

		const conflicting = await executeWritePrReviewArtifact(
			{
				kind: 'handoff',
				run_id: RUN_ID,
				pr_head_sha: HEAD_SHA,
				handoff: {
					pr_url: 'https://github.com/owner/repo/pull/155',
					finding_ids: handoffIds,
					summary: 'a different summary',
					provenance: ['review-boundaries', 'critic-boundaries'],
				},
			},
			tempDir,
			{ sessionID: SESSION_ID },
		);
		const conflictResult = JSON.parse(conflicting) as {
			success?: boolean;
			message?: string;
		};
		expect(conflictResult.success).toBe(false);
		expect(String(conflictResult.message ?? '')).toContain('conflicting');
	}, 60_000);
});
