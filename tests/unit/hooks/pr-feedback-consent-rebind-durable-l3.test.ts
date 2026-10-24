/**
 * Issue #3316 PR-review PRR-002: the consent rebind must be durable — after a
 * foreign-session continuation the consent sidecar names the NEW session with
 * state "confirmed", and the rebind is ONE-SHOT: a further foreign session is
 * refused ("already rebound") and the sidecar is left untouched (PRR-005).
 * The rebind l3 acceptance suite asserts only run_id, which stays green even
 * if the durable rewrite is deleted; this suite fails in that case.
 *
 * The terminal-review ladder is fsync-heavy (~30 s on Windows hardware), so it
 * is built ONCE for the file in `beforeAll`.
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
const RUN_ID = 'test-run';
const SESSION_B = 'l3-rebind-durable-b';
const SESSION_C = 'l3-rebind-durable-c';

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
			provenance: ['durable-rebind-tests'],
		},
	};
}

async function writeArtifactChecked(
	input: Parameters<typeof executeWritePrReviewArtifact>[0],
): Promise<void> {
	const result = JSON.parse(
		await executeWritePrReviewArtifact(input, tempDir, {
			sessionID: SESSION_ID,
		}),
	) as { success: boolean; message?: string };
	if (!result.success) {
		throw new Error(
			`pr-review artifact write failed (${input.kind}:${input.boundary ?? input.run_id}): ${result.message}`,
		);
	}
}

async function materializeTerminalReview(): Promise<string> {
	await establishReviewPrerequisites();
	const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
		(_dimension, index) => `C-${index}`,
	);
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
							: boundary === 'post_critic' && id !== 'C-1'
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

let externalState: { handoffPath: string; exactCommand: string } | null = null;

beforeAll(async () => {
	setupPrWorkflowGateFixtures();
	const handoffPath = await materializeTerminalReview();
	const sessionPath = path.join(
		tempDir,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
	);
	await fs.rm(sessionPath, { force: true });
	externalState = {
		handoffPath,
		exactCommand: `/swarm pr-feedback ${PR_URL} continue from ${handoffPath}`,
	};
}, 120_000);

afterAll(async () => {
	externalState = null;
	await teardownPrWorkflowGateFixtures();
});

function consentPath(): string {
	return path.join(
		tempDir,
		'.swarm',
		'pr-review',
		RUN_ID,
		'feedback-consent.json',
	);
}

describe('PR_FEEDBACK consent rebind is durable and one-shot (PRR-002/005)', () => {
	test('the rebind writes the confirmed consent naming the new session', async () => {
		const { handoffPath, exactCommand } = externalState!;
		_test_exports.resetTrackedStateCache();

		const transitioned = await transitionPrReviewToFeedback(
			tempDir,
			SESSION_B,
			{
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
				exactCommand,
				confirmedByUser: true,
			},
		);
		expect(transitioned.mode).toBe('PR_FEEDBACK');

		const consent = JSON.parse(await fs.readFile(consentPath(), 'utf8')) as {
			session_id: string;
			state: string;
			confirmed_at: string | null;
		};
		// The durable rewrite is the point: session_id rewritten, confirmed
		// state, timestamp set. Deleting the rewrite (or forgetting the new
		// session id) fails exactly here.
		expect(consent.session_id).toBe(SESSION_B);
		expect(consent.state).toBe('confirmed');
		expect(
			consent.confirmed_at == null || consent.confirmed_at.length > 0,
		).toBe(true);
		const feedbackState = await readPrWorkflowGateState(tempDir, SESSION_B);
		expect(feedbackState?.mode).toBe('PR_FEEDBACK');

		// The audit event is part of the durable contract (PRR-002): renaming
		// or deleting the pr_feedback_consent_rebound emit must fail here.
		const events = (
			await fs.readFile(path.join(tempDir, '.swarm', 'events.jsonl'), 'utf8')
		)
			.split(/\r?\n/)
			.filter((line) => line.includes('pr_feedback_consent_rebound'))
			.map((line) => JSON.parse(line) as { sessionID?: string });
		expect(events.length).toBe(1);
		expect(events[0]?.sessionID).toBe(SESSION_B);
	});

	test('a further foreign session is refused (one-shot) and the consent is untouched', async () => {
		const { handoffPath, exactCommand } = externalState!;
		const consentBefore = await fs.readFile(consentPath(), 'utf8');
		_test_exports.resetTrackedStateCache();

		const outcome = await transitionPrReviewToFeedback(tempDir, SESSION_C, {
			runId: RUN_ID,
			handoffPath,
			prUrl: PR_URL,
			exactCommand,
			confirmedByUser: true,
		}).then(
			(state) => `transitioned:${state.mode}`,
			(error: unknown) => `rejected: ${(error as Error).message}`,
		);
		expect(outcome).toContain('already rebound');
		expect(await fs.readFile(consentPath(), 'utf8')).toBe(consentBefore);
	});
});
