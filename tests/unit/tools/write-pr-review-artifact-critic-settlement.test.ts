import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_test_exports,
	completePrWorkflow,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readAuthoritativePrReviewCriticSettlements,
	readPrReviewFinalFindingPolicyForReport,
	recordPrReviewValidationBatch,
	resolvePrReviewWriterRunId,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as artifactInternals,
	executeWritePrReviewArtifact,
} from '../../../src/tools/write-pr-review-artifact.js';
import {
	establishPrReviewPrerequisites,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Review PRR-003 (CRITICAL) / PRR-009 / PRR-010: the FIRST end-to-end
// execution of the critic-phase N-of-M settlement through the REAL artifact
// writer — the flow the review proved was deadlocked (records-match
// rejected the disclosed-dead critic record before the writer's settlement
// injection could run) and that no committed test ever executed.

const SESSION_ID = 'write-pr-review-artifact';
const HEAD_SHA = 'abc123';
const REVISION_DIGEST = 'revision-1';
let directory = '';

const LIVE_LANE = 'e2e-live';
const DEAD_LANE = 'e2e-dead';
const CRITIC_LIVE_LANE = 'e2e-critic-live';
const CRITIC_DEAD_LANE = 'e2e-critic-dead';

const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolvePrWorkflowRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

const reviewedRows = (ids: readonly string[]): string =>
	ids
		.map(
			(id) =>
				`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer | ORDINARY | `,
		)
		.join('\n');

const criticisedRows = (ids: readonly string[]): string =>
	ids
		.map(
			(id) =>
				`[CRITIC] | ${id} | UPHELD | HIGH | reason ${id} | required change ${id}`,
		)
		.join('\n');

async function seedLivenessDeadLane(args: {
	batchId: string;
	laneId: string;
	phase: 'reviewer' | 'critic';
}): Promise<void> {
	const correlationId = `${args.batchId}-${args.laneId}-session`;
	const reason = `lane ${args.laneId} presumed stale: idle host session past the stale horizon`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${args.batchId}-${args.laneId}-call`,
		normalizedAgent: args.phase,
		swarmPrefixedAgent: args.phase,
		planTaskId: null,
		evidenceTaskId: null,
		batchId: args.batchId,
		laneId: args.laneId,
		mode: `swarm-pr-review:${args.phase}`,
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: args.laneId,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	await appendDelegationTransition(directory, correlationId, {
		status: 'stale',
		result: {
			error: reason,
			chars: reason.length,
			truncated: false,
			digest: createHash('sha256').update(reason).digest('hex'),
			workflowLaneFailureClass: 'liveness',
		},
	});
}

const record = (
	findingId: string,
	nextAction: 'route_to_critic' | 'report' | 'route_to_reviewer',
) => ({
	finding_id: findingId,
	status: (nextAction === 'route_to_reviewer' ? 'PENDING' : 'CONFIRMED') as
		| 'PENDING'
		| 'CONFIRMED',
	file_line: 'src/index.ts:1',
	evidence: 'e2e settlement evidence',
	next_action: nextAction,
	severity: 'HIGH' as const,
	...(nextAction === 'route_to_reviewer'
		? {}
		: { risk_impact: 'ORDINARY' as const, risk_tags: [] as string[] }),
});

async function writeBoundary(
	runId: string,
	boundary: 'post_explorer' | 'post_reviewer' | 'post_critic',
	records: ReadonlyArray<ReturnType<typeof record>>,
): Promise<string> {
	return executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			boundary,
			records: [...records],
		},
		directory,
		{ sessionID: SESSION_ID },
	);
}

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-critic-settlement-e2e-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest =
		originalResolvePrWorkflowRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	_test_exports.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('critic-phase N-of-M settlement end-to-end (issue #3101, review PRR-003/009/010)', () => {
	test('a critic-dead item settles as a disclosed terminal CRITIC_UNAVAILABLE and the run completes', async () => {
		// Activate the gate + prerequisites under a chosen run id, THEN reserve
		// it (the reservation adopts the bound trigger-eval run id): the
		// trigger-eval binding AND the settlement receipts live under it.
		await establishPrReviewPrerequisites(directory, 'e2e-run');
		const runId = await resolvePrReviewWriterRunId(directory, SESSION_ID);
		expect(runId).toBe('e2e-run');
		const inventory = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_lane, index) => `C-${index}`,
		);
		const reviewerLive = inventory.slice(0, 3);
		const reviewerDead = inventory.slice(3);
		const criticLive = reviewerLive.slice(0, 2);
		const criticDead = reviewerLive.slice(2);

		// Reviewer phase: live lane covers reviewerLive; dead lane covers
		// reviewerDead across three batches (per-item budget exhaustion).
		await recordPrReviewValidationBatch(
			directory,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: LIVE_LANE,
					workflowLane: LIVE_LANE,
					reviewItemIds: reviewerLive,
				},
				{
					laneId: DEAD_LANE,
					workflowLane: DEAD_LANE,
					reviewItemIds: reviewerDead,
				},
			],
			{ batchId: 'e2e-rv-1', prHeadSha: HEAD_SHA },
		);
		await persistPrReviewBatch(
			directory,
			'e2e-rv-1',
			'swarm-pr-review:reviewer',
			[{ laneId: LIVE_LANE, workflowLane: LIVE_LANE }],
			{ textOverride: reviewedRows(reviewerLive) },
		);
		await seedLivenessDeadLane({
			batchId: 'e2e-rv-1',
			laneId: DEAD_LANE,
			phase: 'reviewer',
		});
		for (const suffix of ['2', '3']) {
			const batchId = `e2e-rv-${suffix}`;
			await recordPrReviewValidationBatch(
				directory,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: DEAD_LANE,
						workflowLane: DEAD_LANE,
						reviewItemIds: reviewerDead,
					},
				],
				{ batchId, prHeadSha: HEAD_SHA },
			);
			await seedLivenessDeadLane({
				batchId,
				laneId: DEAD_LANE,
				phase: 'reviewer',
			});
		}

		// post_explorer covers the FULL inventory (no settlement exists yet).
		const explorerRecords = inventory.map((id) =>
			record(id, 'route_to_reviewer'),
		);
		await expect(
			writeBoundary(runId, 'post_explorer', explorerRecords),
		).resolves.toContain('"success": true');

		// post_reviewer: the disclosed-dead reviewer items are EXEMPT from
		// exact-cover (review PRR-010 drives reviewerDeadForCover non-empty
		// through the real boundary) — records for the live items only, and a
		// record for a dead item is a named violation.
		const reviewerRecords = reviewerLive.map((id) =>
			record(id, 'route_to_critic'),
		);
		const reviewerRecordsWithDead = [
			...reviewerRecords,
			record(reviewerDead[0]!, 'route_to_critic'),
		];
		await expect(
			writeBoundary(runId, 'post_reviewer', reviewerRecordsWithDead),
		).resolves.toMatch(/disclosed-dead items carry no verdict-bearing record/);
		await expect(
			writeBoundary(runId, 'post_reviewer', reviewerRecords),
		).resolves.toContain('"success": true');

		// Critic phase: live lane covers criticLive; dead lane covers
		// criticDead across three batches.
		await recordPrReviewValidationBatch(
			directory,
			SESSION_ID,
			'critic',
			[
				{
					laneId: CRITIC_LIVE_LANE,
					agent: 'critic',
					workflowLane: CRITIC_LIVE_LANE,
					reviewItemIds: criticLive,
				},
				{
					laneId: CRITIC_DEAD_LANE,
					agent: 'critic',
					workflowLane: CRITIC_DEAD_LANE,
					reviewItemIds: criticDead,
				},
			],
			{ batchId: 'e2e-cr-1', prHeadSha: HEAD_SHA },
		);
		await persistPrReviewBatch(
			directory,
			'e2e-cr-1',
			'swarm-pr-review:critic',
			[{ laneId: CRITIC_LIVE_LANE, workflowLane: CRITIC_LIVE_LANE }],
			{ textOverride: criticisedRows(criticLive) },
		);
		await seedLivenessDeadLane({
			batchId: 'e2e-cr-1',
			laneId: CRITIC_DEAD_LANE,
			phase: 'critic',
		});
		for (const suffix of ['2', '3']) {
			const batchId = `e2e-cr-${suffix}`;
			await recordPrReviewValidationBatch(
				directory,
				SESSION_ID,
				'critic',
				[
					{
						laneId: CRITIC_DEAD_LANE,
						agent: 'critic',
						workflowLane: CRITIC_DEAD_LANE,
						reviewItemIds: criticDead,
					},
				],
				{ batchId, prHeadSha: HEAD_SHA },
			);
			await seedLivenessDeadLane({
				batchId,
				laneId: CRITIC_DEAD_LANE,
				phase: 'critic',
			});
		}

		// post_critic: criticLive keep their UPHELD critic verdicts; the
		// critic-dead item's record keeps the reviewer disposition with NO
		// model-supplied critic_status (the settlement derives it).
		const criticRecords = [
			...criticLive.map((id) => record(id, 'report')),
			...criticDead.map((id) => record(id, 'route_to_critic')),
		];
		const result = await writeBoundary(runId, 'post_critic', criticRecords);
		expect(result).toContain('"success": true');

		// The authoritative settlement projection carries the disclosed
		// terminal CRITIC_UNAVAILABLE for exactly the dead critic items.
		const settlements = await readAuthoritativePrReviewCriticSettlements(
			directory,
			SESSION_ID,
		);
		for (const deadId of criticDead) {
			expect(settlements).toContainEqual(
				expect.objectContaining({
					findingId: deadId,
					terminal: true,
					status: 'CRITIC_UNAVAILABLE',
				}),
			);
		}
		for (const liveId of criticLive) {
			expect(settlements).toContainEqual(
				expect.objectContaining({
					findingId: liveId,
					terminal: true,
					status: 'UPHELD',
				}),
			);
		}

		// Downgrade-only (issue constraint 3): the policy matrix permits
		// REQUEST_CHANGES and never APPROVE under the disclosed degradation.
		const policy = await readPrReviewFinalFindingPolicyForReport(
			directory,
			SESSION_ID,
		);
		expect(policy.permittedVerdicts).toEqual(
			expect.arrayContaining(['REQUEST_CHANGES']),
		);
		expect(policy.permittedVerdicts).not.toContain('APPROVE');

		try {
			const outcome = await completePrWorkflow(
				directory,
				SESSION_ID,
				'PR_REVIEW',
				HEAD_SHA,
				{ reportVerdict: 'REQUEST_CHANGES' },
			);
			expect(outcome).toBe('completed');
		} catch (error) {
			throw new Error(
				`completePrWorkflow rejected: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});

	test('a model-supplied critic_status on a disclosed-dead critic item is rejected (review PRR-009, writer branch)', () => {
		const deadRecord = {
			finding_id: 'F-dead',
			status: 'CONFIRMED' as const,
			file_line: 'src/index.ts:1',
			evidence: 'evidence',
			next_action: 'route_to_critic' as const,
			severity: 'HIGH' as const,
			critic_status: 'UPHELD' as const,
		};
		expect(() =>
			artifactInternals.assertCriticSettlements(
				[deadRecord],
				[],
				new Map(),
				new Set(['F-dead']),
			),
		).toThrow(/model-supplied critic_status on a disclosed-dead critic item/);
	});

	test('a clean disclosed-dead record settles as writer-derived terminal CRITIC_UNAVAILABLE (review PRR-009, writer branch)', () => {
		const cleanRecord = {
			finding_id: 'F-dead',
			status: 'CONFIRMED' as const,
			file_line: 'src/index.ts:1',
			evidence: 'evidence',
			next_action: 'route_to_critic' as const,
			severity: 'HIGH' as const,
		};
		const settlements = artifactInternals.assertCriticSettlements(
			[cleanRecord],
			[],
			new Map(),
			new Set(['F-dead']),
		);
		expect(settlements).toHaveLength(1);
		expect(settlements[0]).toMatchObject({
			findingId: 'F-dead',
			terminal: true,
			status: 'CRITIC_UNAVAILABLE',
		});
		expect(settlements[0]?.finalFinding).toMatchObject({
			id: 'F-dead',
			status: 'CONFIRMED',
			severity: 'HIGH',
		});
	});
});
