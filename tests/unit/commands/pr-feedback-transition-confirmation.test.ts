import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import { withFrozenClock } from '../../helpers/test-clock.js';
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

async function materializeTerminalReview(): Promise<string> {
	const runId = RUN_ID;
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
		SESSION_ID,
		'reviewer',
		[{ laneId: runId, workflowLane: runId, reviewItemIds: candidateIds }],
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
			records: candidateIds.map((id) => ({
				finding_id: id,
				status: 'PENDING' as const,
				file_line: 'src/index.ts:1',
				evidence: `explorer evidence for ${id}`,
				next_action: 'route_to_reviewer' as const,
				severity: 'HIGH' as const,
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
				status: index === 0 ? ('DISPROVED' as const) : ('CONFIRMED' as const),
				file_line: 'src/index.ts:1',
				evidence: `reviewer evidence for ${id}`,
				next_action:
					index === 0
						? ('suppress_with_reason' as const)
						: ('route_to_critic' as const),
				severity: index === 0 ? ('NONE' as const) : ('HIGH' as const),
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
			})),
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);
	await executeWritePrReviewArtifact(handoffInput(), tempDir, {
		sessionID: SESSION_ID,
	});
	return handoffRelativePath(runId);
}

describe('PR feedback transition confirmation hardening (#2333)', () => {
	test('active review transition requires explicit command confirmation', async () => {
		const handoffPath = await materializeTerminalReview();
		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/confirm|exact command|user/i);

		const exactCommand = `/swarm pr-feedback ${PR_URL} continue from ${handoffPath}`;
		const transitioned = await transitionPrReviewToFeedback(
			tempDir,
			SESSION_ID,
			{
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
				exactCommand,
				confirmedByUser: true,
			},
		);
		expect(transitioned.mode).toBe('PR_FEEDBACK');
		expect(transitioned.prFeedbackReviewHandoff?.path).toBe(
			`pr-review/${RUN_ID}/feedback-handoff.json`,
		);
	});

	test('exact retry recovers only when persisted review handoff provenance is intact', async () => {
		const handoffPath = await materializeTerminalReview();
		const exactCommand = `/swarm pr-feedback ${PR_URL} continue from ${handoffPath}`;
		await transitionPrReviewToFeedback(tempDir, SESSION_ID, {
			runId: RUN_ID,
			handoffPath,
			prUrl: PR_URL,
			exactCommand,
			confirmedByUser: true,
		});

		const retried = await transitionPrReviewToFeedback(tempDir, SESSION_ID, {
			runId: RUN_ID,
			handoffPath,
			prUrl: PR_URL,
			exactCommand,
			confirmedByUser: true,
		});
		expect(retried.mode).toBe('PR_FEEDBACK');

		const statePath = path.join(
			tempDir,
			'.swarm',
			'pr-workflow-gates',
			`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
		);
		const raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
		delete raw.prFeedbackReviewHandoff;
		await fs.writeFile(statePath, JSON.stringify(raw, null, 2), 'utf8');

		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
				exactCommand,
				confirmedByUser: true,
			}),
		).rejects.toThrow(/handoff provenance|different handoff|already active/i);
	});

	test('external restart path also requires explicit command confirmation', async () => {
		const handoffPath = await materializeTerminalReview();
		const reviewState = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(reviewState?.mode).toBe('PR_REVIEW');
		const sessionPath = path.join(
			tempDir,
			'.swarm',
			'pr-workflow-gates',
			`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
		);
		await fs.rm(sessionPath, { force: true });

		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/confirm|exact command|user/i);
	});

	test('an exact handoff retry repairs a crash between handoff persistence and the durable offer', async () => {
		const handoffPath = await materializeTerminalReview();
		const handoffAbsolutePath = path.join(tempDir, handoffPath);
		const consentPath = path.join(
			tempDir,
			'.swarm',
			'pr-review',
			RUN_ID,
			'feedback-consent.json',
		);
		const originalHandoff = await fs.readFile(handoffAbsolutePath, 'utf8');
		await fs.rm(consentPath, { force: true });
		const statePath = path.join(
			tempDir,
			'.swarm',
			'pr-workflow-gates',
			`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
		);
		const rawState = JSON.parse(await fs.readFile(statePath, 'utf8'));
		delete rawState.prReviewHandoffPath;
		await fs.writeFile(statePath, JSON.stringify(rawState, null, 2), 'utf8');
		_test_exports.resetTrackedStateCache();

		const replay = JSON.parse(
			await executeWritePrReviewArtifact(handoffInput(), tempDir, {
				sessionID: SESSION_ID,
			}),
		) as { success: boolean; confirmation_command?: string };
		expect(replay.success).toBe(true);
		expect(replay.confirmation_command).toBe(
			`/swarm pr-feedback ${PR_URL} continue from ${handoffPath}`,
		);
		expect(await fs.readFile(handoffAbsolutePath, 'utf8')).toBe(
			originalHandoff,
		);
		expect(JSON.parse(await fs.readFile(consentPath, 'utf8')).state).toBe(
			'offered',
		);
	});

	test('a corrupt persisted handoff fails bounded and is never overwritten on retry', async () => {
		const handoffPath = await materializeTerminalReview();
		const handoffAbsolutePath = path.join(tempDir, handoffPath);
		await fs.writeFile(handoffAbsolutePath, '{not-json}\n', 'utf8');

		const retry = JSON.parse(
			await executeWritePrReviewArtifact(handoffInput(), tempDir, {
				sessionID: SESSION_ID,
			}),
		) as { success: boolean; message: string };
		expect(retry.success).toBe(false);
		expect(retry.message).toContain('operation read path');
		expect(retry.message).toContain('feedback-handoff.json');
		expect(retry.message).toContain('invalid JSON');
		expect(await fs.readFile(handoffAbsolutePath, 'utf8')).toBe('{not-json}\n');
	});

	test('an exact command finishes a crash after consent confirmation but before feedback state persistence', async () => {
		const handoffPath = await materializeTerminalReview();
		const consentPath = path.join(
			tempDir,
			'.swarm',
			'pr-review',
			RUN_ID,
			'feedback-consent.json',
		);
		const consent = JSON.parse(await fs.readFile(consentPath, 'utf8'));
		consent.state = 'confirmed';
		consent.confirmed_at = withFrozenClock(() => new Date().toISOString());
		await fs.writeFile(consentPath, JSON.stringify(consent, null, 2), 'utf8');
		const exactCommand = `/swarm pr-feedback ${PR_URL} continue from ${handoffPath}`;

		const transitioned = await transitionPrReviewToFeedback(
			tempDir,
			SESSION_ID,
			{
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
				exactCommand,
				confirmedByUser: true,
			},
		);
		expect(transitioned.mode).toBe('PR_FEEDBACK');
		expect(JSON.parse(await fs.readFile(consentPath, 'utf8')).state).toBe(
			'confirmed',
		);
	});

	test('a sidecar and handoff must both survive restart before external confirmation can route', async () => {
		const handoffPath = await materializeTerminalReview();
		const exactCommand = `/swarm pr-feedback ${PR_URL} continue from ${handoffPath}`;
		const sessionPath = path.join(
			tempDir,
			'.swarm',
			'pr-workflow-gates',
			`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
		);
		await fs.rm(sessionPath, { force: true });
		await fs.rm(path.join(tempDir, handoffPath), { force: true });
		_test_exports.resetTrackedStateCache();
		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: RUN_ID,
				handoffPath,
				prUrl: PR_URL,
				exactCommand,
				confirmedByUser: true,
			}),
		).rejects.toThrow(/handoff|does not exist/i);
	});
});
