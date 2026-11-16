import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

// Feedback F18a (issue #3312): the INCOMPLETE bypass arm's ADMISSIBLE-phase
// branch — the `if (probe.settled || !probe.admissible) continue; ...
// assertPrReviewValidationSettled` loop in completePrWorkflow — must be the
// ONLY writer of the reviewer verdict-settlement receipt in this world. A
// reviewer phase whose unclaimed items are N-of-M-ADMISSIBLE (typed
// liveness-dead owner lanes across 1+budget distinct batches; the seeding
// shape of tests/unit/pr-review/n-of-m-verdict-settlement*) enters
// completePrWorkflow UNSETTLED with NO persisted receipt; the arm's admissible
// loop settles it through the ladder's exact admission path, the receipt
// persists under .swarm/pr-review/<runId>/verdict-settlement.reviewer.json,
// and the skip disclosure must NOT list the reviewer phase as skipped (it
// settled via admission). The arm's entry condition (one probe neither
// settled nor admissible) is supplied by a declared council batch whose
// obligation's artifact is destroyed after the reviewer declarations; the
// critic phase (no declared critic batch) joins the disclosure only in the
// post-settlement re-probe, once the reviewer's surviving CONFIRMED/HIGH
// claims project a non-empty critic inventory.

const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const RUN_ID = 'i1-admissible-run';
const LIVE_LANE = 'i1-live-reviewer';
const DEAD_LANE = 'i1-dead-reviewer';
const COUNCIL_LANE = 'i1-council-lane';
const COUNCIL_BATCH_ID = `${RUN_ID}-cc-1`;
const MICRO_HEADER =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
/** The council artifact's exact text — its sha256 locates the stored file. */
const COUNCIL_ARTIFACT_TEXT = `${MICRO_HEADER}\n[CLEAN] | ${COUNCIL_LANE} | exact reviewed diff | council adjudicated no unresolved review question`;
let directory = '';

const ORIGINALS = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-incomplete-bypass-i1-');
	await fs.mkdir(path.join(directory, '.git'), { recursive: true });
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = ORIGINALS.head;
	gateInternals.resolveCurrentGitHeadAsync = ORIGINALS.headAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = ORIGINALS.revision;
	gateInternals.resolveIsWorkingTreeClean = ORIGINALS.clean;
	gateInternals.resolveIsWorkingTreeCleanAsync = ORIGINALS.cleanAsync;
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

/**
 * PARTIAL-settlement fixture (same shape as the AC1 bypass test): five base
 * dimensions settle clean, the sixth terminally fails operator_cancelled, the
 * partial-base disclosure is admitted through the artifact writer (binding
 * prReviewArtifactRunId = RUN_ID), every required micro lane settles CLEAN,
 * and trigger evaluation is marked complete. Returns the covered candidate
 * inventory (C-0..C-4).
 */
async function establishPartialBase(): Promise<string[]> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
		prHeadSha: HEAD_SHA,
	});
	const successful = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 5);
	const failed = PR_REVIEW_BASE_DIMENSION_IDS.slice(5);
	const lanes = successful.map((workflowLane) => ({
		laneId: `ok-${workflowLane}`,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(directory, SESSION_ID, lanes, {
		batchId: 'base-successful',
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	await persistPrReviewBatch(
		directory,
		'base-successful',
		'swarm-pr-review:base',
		lanes,
	);
	for (const [index, workflowLane] of failed.entries()) {
		const batchId = `base-failed-${index}`;
		const failedLanes = [{ laneId: `failed-${workflowLane}`, workflowLane }];
		await enforcePrReviewBaseDimensions(directory, SESSION_ID, failedLanes, {
			batchId,
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		});
		await persistPrReviewBatch(
			directory,
			batchId,
			'swarm-pr-review:base',
			failedLanes,
			{
				status: 'cancelled',
				workflowLaneFailureClass: 'operator_cancelled',
			},
		);
	}
	const records = successful.map((_dimension, index) => ({
		finding_id: `C-${index}`,
		status: 'PENDING',
		file_line: 'file.ts:1',
		evidence: `authoritative candidate ${index}`,
		next_action: 'route_to_reviewer',
		severity: 'HIGH',
	}));
	const disclosureWrite = await executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			boundary: 'post_explorer',
			records,
			partial_base_coverage: { unresolved_dimensions: [...failed] },
		},
		directory,
		{ sessionID: SESSION_ID },
	);
	expect(disclosureWrite).toContain('"success": true');
	const triggerRows: Array<Record<string, string>> = [];
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		await persistPrReviewBatch(
			directory,
			batchId,
			'swarm-pr-review:micro',
			[{ laneId, workflowLane }],
			{
				textOverride: `${MICRO_HEADER}\n[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
			},
		);
		triggerRows.push({
			trigger_id: workflowLane,
			result: 'MATCHED',
			evidence: `fixture evidence for ${workflowLane}`,
			source_batch_id: batchId,
			source_lane_id: laneId,
		});
	}
	const triggerRelative = path.join('pr-review', RUN_ID, 'trigger-eval.json');
	const triggerAbsolute = path.join(directory, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		directory,
		SESSION_ID,
		RUN_ID,
		triggerRelative,
	);
	return records.map((record) => record.finding_id);
}

/** The [REVIEWED] rows a live reviewer lane produces for its claimed items. */
function reviewedRows(ids: readonly string[]): string {
	return ids
		.map(
			(id) =>
				`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer | ORDINARY | `,
		)
		.join('\n');
}

/**
 * Seed one typed liveness-dead owner record for a (batch, lane) pair — the
 * controller-observed terminality evidence N-of-M admission cites (issue
 * #3101; the seeding shape of n-of-m-verdict-settlement.fixtures).
 */
async function seedLivenessDeadReviewerLane(batchId: string, laneId: string) {
	const correlationId = `${batchId}--${laneId}--dead`;
	const reason = `lane ${laneId} presumed stale: idle host session past the stale horizon`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${batchId}-${laneId}-call`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
		mode: 'swarm-pr-review:reviewer',
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: laneId,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
		promptHash: `${batchId}-${laneId}-hash`,
		generation: 1,
	});
	const settled = await appendDelegationTransition(directory, correlationId, {
		status: 'stale',
		result: {
			error: reason,
			chars: reason.length,
			truncated: false,
			digest: createHash('sha256').update(reason).digest('hex'),
			workflowLaneFailureClass: 'liveness',
		},
		expectedCurrentStatuses: ['pending', 'running'],
	});
	expect(settled?.status).toBe('stale');
}

/**
 * Declare ONLY the reviewer N-of-M world over the candidate inventory: the first
 * batch's LIVE lane claims the first two items with real [REVIEWED] rows
 * while its DEAD lane covers the rest, and two retry batches re-declare the
 * dead lane's items (1 + PR_REVIEW_VERDICT_RETRY_BUDGET = 3 distinct owner
 * batches per dead item, each liveness-dead). The reviewer phase is thereby
 * N-of-M-ADMISSIBLE over its unclaimed items but UNSETTLED — no receipt
 * exists anywhere on disk (deriveVerdictSettlementAdmission admits; the exact
 * seeding shape of the n-of-m-verdict-settlement suites).
 *
 * F18a tautology guard: NO critic batch is declared. Recording a critic batch
 * runs the ladder's reviewer settlement assert AT DECLARATION TIME
 * (recordPrReviewValidationBatch's `phase === 'critic'` branch), which
 * persists the verdict-settlement receipt before completePrWorkflow runs —
 * the bypass arm's admissible loop then never executes its assert, and
 * deleting that assert keeps the test green (the tautology this rework
 * eliminates). Reviewer declarations run no reviewer assert (only the
 * council and critic branches do), so the arm's admissible loop is the ONLY
 * writer of the reviewer receipt in this world.
 *
 * The bypass arm still needs one probe that is neither settled nor
 * admissible, and no critic probe can exist at entry: with an
 * admissible-but-unreceipted reviewer, `authoritativeReviewerClaims` projects
 * an empty map (claims flow only once unclaimed is empty or a receipt covers
 * it), so the critic inventory is empty and the critic phase is not even
 * probed. A declared-but-satisfied COUNCIL batch supplies that probe instead:
 * it is declared FIRST (the reviewer window spans everything after the latest
 * council batch) with a satisfying micro-family [CLEAN] artifact, so every
 * reviewer declaration's ladder council assert PASSES; the artifact is then
 * destroyed, leaving the council obligation missing at completion — the
 * genuinely unsettled, non-admissible phase that admits the run into the
 * bypass arm and stays disclosed as skipped.
 */
async function seedAdmissibleReviewerWorld(itemIds: readonly string[]) {
	const liveItems = itemIds.slice(0, 2);
	const deadItems = itemIds.slice(2);
	await recordPrReviewValidationBatch(
		directory,
		SESSION_ID,
		'council',
		[{ laneId: COUNCIL_LANE, workflowLane: COUNCIL_LANE }],
		{ batchId: COUNCIL_BATCH_ID, prHeadSha: HEAD_SHA },
	);
	await persistPrReviewBatch(
		directory,
		COUNCIL_BATCH_ID,
		'swarm-pr-review:council',
		[{ laneId: COUNCIL_LANE, workflowLane: COUNCIL_LANE }],
		{ textOverride: COUNCIL_ARTIFACT_TEXT },
	);
	await recordPrReviewValidationBatch(
		directory,
		SESSION_ID,
		'reviewer',
		[
			{ laneId: LIVE_LANE, workflowLane: LIVE_LANE, reviewItemIds: liveItems },
			{ laneId: DEAD_LANE, workflowLane: DEAD_LANE, reviewItemIds: deadItems },
		],
		{ batchId: `${RUN_ID}-rv-1`, prHeadSha: HEAD_SHA },
	);
	await persistPrReviewBatch(
		directory,
		`${RUN_ID}-rv-1`,
		'swarm-pr-review:reviewer',
		[{ laneId: LIVE_LANE, workflowLane: LIVE_LANE }],
		{ textOverride: reviewedRows(liveItems) },
	);
	await seedLivenessDeadReviewerLane(`${RUN_ID}-rv-1`, DEAD_LANE);
	for (const suffix of ['2', '3']) {
		const batchId = `${RUN_ID}-rv-${suffix}`;
		await recordPrReviewValidationBatch(
			directory,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: DEAD_LANE,
					workflowLane: DEAD_LANE,
					reviewItemIds: deadItems,
				},
			],
			{ batchId, prHeadSha: HEAD_SHA },
		);
		await seedLivenessDeadReviewerLane(batchId, DEAD_LANE);
	}
	// Destroy the council lane's stored artifact (the store's ref layout is
	// sha256(batchId)/sha256(laneId)/sha256(text).json): the obligation the
	// council assert verified during the reviewer declarations is now missing
	// evidence, so the completion probe sees the council phase as unsettled
	// and non-admissible — the arm's entry condition.
	await fs.rm(
		path.join(
			directory,
			'.swarm',
			'lane-results',
			createHash('sha256').update(COUNCIL_BATCH_ID).digest('hex'),
			createHash('sha256').update(COUNCIL_LANE).digest('hex'),
			`${createHash('sha256').update(COUNCIL_ARTIFACT_TEXT).digest('hex')}.json`,
		),
		{ force: true },
	);
	return { liveItems, deadItems };
}

describe('issue #3312 F18a — INCOMPLETE bypass settles an ADMISSIBLE reviewer phase through admission', () => {
	test('an N-of-M-admissible reviewer phase persists its receipt and is NOT disclosed as skipped', async () => {
		const itemIds = await establishPartialBase();
		const { liveItems, deadItems } = await seedAdmissibleReviewerWorld(itemIds);

		const receiptPath = path.join(
			directory,
			'.swarm',
			'pr-review',
			RUN_ID,
			'verdict-settlement.reviewer.json',
		);
		// (1) Sequencing floor: NO receipt exists before completion. The seeding
		// declares reviewer batches only, so nothing ran the ladder's reviewer
		// assert — the bypass arm's admissible loop must be the receipt's ONLY
		// writer (delete that assert and step (3) fails: the file stays absent).
		await expect(fs.access(receiptPath)).rejects.toThrow();

		// (2) The INCOMPLETE completion succeeds through the bypass arm (the
		// council phase's destroyed-artifact obligation is unsettled and
		// non-admissible, which admits the run into the arm).
		const status = await completePrWorkflow(
			directory,
			SESSION_ID,
			'PR_REVIEW',
			HEAD_SHA,
			{ reportVerdict: 'INCOMPLETE' },
		);
		expect(status).toBe('completed');
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();

		// (3) The receipt NOW exists — persisted by the arm's admissible-phase
		// assert (the ladder's exact admission path), naming exactly the
		// liveness-dead items the retry budget exhausted.
		const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf-8')) as {
			phase: string;
			runId: string;
			items: Array<{ itemId: string; terminalStatus: string }>;
		};
		expect(receipt.phase).toBe('reviewer');
		expect(receipt.runId).toBe(RUN_ID);
		expect(receipt.items.map((item) => item.itemId).sort()).toEqual(
			[...deadItems].sort(),
		);

		// (4) The skip disclosure does NOT list the reviewer phase — it settled
		// through the arm's admissible assert, so disclosing it as skipped would
		// understate the run's settlement (feedback F-7 tail). The skipped phases
		// are the council phase (destroyed artifact, the arm's entry condition)
		// and — in the RE-probe only, now that the reviewer's surviving
		// CONFIRMED/HIGH claims flow through the receipt-backed map — the critic
		// phase over those claims with no declared critic batch.
		const disclosurePath = path.join(
			directory,
			'.swarm',
			'pr-review',
			RUN_ID,
			'validation-skip-disclosure.json',
		);
		const disclosure = JSON.parse(
			await fs.readFile(disclosurePath, 'utf-8'),
		) as {
			reportVerdict: string;
			skippedPhases: Array<{ phase: string; unsettledItemIds: string[] }>;
		};
		expect(disclosure.reportVerdict).toBe('INCOMPLETE');
		expect(disclosure.skippedPhases.map((entry) => entry.phase)).not.toContain(
			'reviewer',
		);
		expect(disclosure.skippedPhases.map((entry) => entry.phase)).toEqual([
			'council',
			'critic',
		]);
		expect(disclosure.skippedPhases[0]?.unsettledItemIds).toEqual([
			COUNCIL_LANE,
		]);
		expect(disclosure.skippedPhases[1]?.unsettledItemIds.sort()).toEqual(
			[...liveItems].sort(),
		);
	});
});
