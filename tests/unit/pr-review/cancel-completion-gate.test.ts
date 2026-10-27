/**
 * Issue #2971 — the retryable-remainder completion gate (deliberately not
 * purely additive: it blocks a previously admissible legacy-policy path,
 * issue AC8) and
 * the operator_cancelled admission path, driven at the completePrWorkflow
 * surface through the same five-plus-one fixtures the liveness-admission
 * suite (tests/unit/tools/write-pr-review-artifact-liveness-admission.test.ts)
 * established.
 *
 * Pinned surfaces per case (stated explicitly per the deviation rule):
 *  (1) contract-terminal sixth + legacy policy → the write_pr_review_artifact
 *      admission is REFUSED while the legacy contract retry budget remains
 *      (#3312 AC10 supersedes #2971's admission-success pin here: retry-first
 *      order, budget kept unconsumed, disclosure never written), and
 *      completePrWorkflow(INCOMPLETE) still BLOCKS with the
 *      retryable-remainder refusal (naming the dimension and the retry
 *      budget) — the completion surface, before coverage finalization. The
 *      dimension is undisclosed, so #3312 AC13's disclosed-tuple exclusion
 *      does not mute the completion gate.
 *  (2) same shape with the legacy contract retry consumed BEFORE the partial
 *      write (#3312 AC10 supersedes #2971's write-then-consume order; the
 *      unlaunched retry dispatch leaves the derived FAILED/contract entry
 *      unchanged) → completePrWorkflow INCOMPLETE COMPLETES (the full
 *      artifact ladder is driven first).
 *  (3) operator_cancelled sixth → write_pr_review_artifact admits INCOMPLETE
 *      with failure_class operator_cancelled (safeDetail names the operator,
 *      never host abandonment) AND completePrWorkflow INCOMPLETE completes.
 *  (4) liveness-cancelled sixth → same admission/completion, failure_class
 *      liveness — the #2615 regression pin carried forward under #2971.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	claimTerminalResult,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
	settleReviewerPhase,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const RUN_ID = 'cancel-gate-run';
const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');
/** Fixed instant for terminal events — no raw clock reads in this file. */
const TERMINAL_EPOCH = 1_700_000_000_000;

type UnresolvedClass = 'contract' | 'operator_cancelled' | 'liveness';

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveRevisionDigestDetailed =
	_test_exports.resolvePrWorkflowRevisionDigestDetailed;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(() => {
	directory = canonicalMkdtemp('cancel-completion-gate-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	_test_exports.resolvePrWorkflowRevisionDigestDetailed = () => ({
		ok: true,
		digest: PR_ARTIFACT_REVISION_DIGEST,
	});
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolvePrWorkflowRevisionDigestDetailed =
		originalResolveRevisionDigestDetailed;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

/**
 * Five covered base dimensions plus a sixth settled through the shared
 * exactly-once terminal claim with the requested failure class — the
 * liveness-admission fixture shape, parameterized over the class under test.
 */
async function establishFivePlusOne(unresolvedClass: UnresolvedClass): Promise<{
	missingDimension: (typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];
	records: Array<{
		finding_id: string;
		status: 'PENDING';
		file_line: string;
		evidence: string;
		next_action: 'route_to_reviewer';
		severity: 'HIGH';
	}>;
}> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
	});
	const successfulDimensions = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 5);
	const missingDimension = PR_REVIEW_BASE_DIMENSION_IDS.slice(5)[0]!;
	const successfulLanes = successfulDimensions.map((workflowLane) => ({
		laneId: `ok-${workflowLane}`,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(
		directory,
		PR_ARTIFACT_SESSION_ID,
		successfulLanes,
		{
			batchId: 'base-successful-five',
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
	await persistPrReviewBatch(
		directory,
		'base-successful-five',
		'swarm-pr-review:base',
		successfulLanes,
	);
	const batchId = 'base-failed-0';
	const unresolvedLane = {
		laneId: `failed-${missingDimension}`,
		workflowLane: missingDimension,
	};
	await enforcePrReviewBaseDimensions(
		directory,
		PR_ARTIFACT_SESSION_ID,
		[unresolvedLane],
		{
			batchId,
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
	const subagentSessionId = `${batchId}-0`;
	await recordPendingDelegation(directory, {
		correlationId: subagentSessionId,
		jobId: null,
		subagentSessionId,
		parentSessionId: PR_ARTIFACT_SESSION_ID,
		callID: `call-${subagentSessionId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId: unresolvedLane.laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: missingDimension,
		workspace: {
			directory,
			gitHead: PR_ARTIFACT_HEAD_SHA,
			dirtyHash: null,
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			scope: null,
		},
		prReviewLegacyTranscriptCompatibility: true,
	});
	await claimTerminalResult(directory, subagentSessionId, {
		eventId: `fixture-terminal-${subagentSessionId}`,
		status: unresolvedClass === 'contract' ? 'error' : 'cancelled',
		recordedAt: TERMINAL_EPOCH,
		result: {
			error:
				unresolvedClass === 'operator_cancelled'
					? 'lane cancelled via cancel_lane_batch: completion-gate fixture'
					: unresolvedClass === 'liveness'
						? 'lane cancelled via collect_lane_results cancel_pending'
						: 'lane failed its response contract',
			chars: 0,
			truncated: false,
			digest: EMPTY_DIGEST,
			workflowLaneFailureClass: unresolvedClass,
		},
	});
	return {
		missingDimension,
		records: successfulDimensions.map((_dimension, index) => ({
			finding_id: `C-${index}`,
			status: 'PENDING' as const,
			file_line: 'src/index.ts:1',
			evidence: `authoritative candidate ${index}`,
			next_action: 'route_to_reviewer' as const,
			severity: 'HIGH' as const,
		})),
	};
}

interface PartialWriteResult {
	success: boolean;
	message?: string;
	partial_base_coverage?: {
		unresolved_dimensions: Array<{
			dimension: string;
			terminal_state: string;
			failure_class?: string;
		}>;
	};
}

async function writePartial(
	records: Array<Record<string, unknown>>,
	unresolved: readonly string[],
): Promise<PartialWriteResult> {
	return JSON.parse(
		await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: RUN_ID,
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				boundary: 'post_explorer',
				records,
				partial_base_coverage: { unresolved_dimensions: [...unresolved] },
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		),
	) as PartialWriteResult;
}

/**
 * Drive the artifact ladder a PARTIAL INCOMPLETE completion requires: all
 * eleven micro lanes (CLEAN attestations), trigger evaluation, the reviewer
 * phase with every candidate DISPROVED, and the post_reviewer/post_critic
 * boundary writes — the pr-review-terminal-coverage-settlement recipe.
 */
async function finishPartialLadder(
	records: Array<Record<string, unknown>>,
): Promise<void> {
	const MICRO_HEADER =
		'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
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
			evidence: `Completion-gate fixture evidence for ${workflowLane}`,
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
		PR_ARTIFACT_SESSION_ID,
		RUN_ID,
		triggerRelative,
	);
	const itemIds = records.map((record) => record.finding_id as string);
	await settleReviewerPhase(
		directory,
		RUN_ID,
		itemIds.map(
			(id) =>
				`[REVIEWED] | ${id} | DISPROVED | STRUCTURALLY_PROVEN | NONE | YES | file.ts:1 | refuted by direct test | probe | reviewer | ORDINARY | `,
		),
		itemIds,
	);
	const reviewerRecords = records.map((record) => ({
		finding_id: record.finding_id as string,
		status: 'DISPROVED' as const,
		file_line: 'file.ts:1',
		evidence: 'refuted by direct test',
		next_action: 'suppress_with_reason' as const,
		severity: 'NONE' as const,
	}));
	for (const boundary of ['post_reviewer', 'post_critic'] as const) {
		const raw = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: RUN_ID,
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				boundary,
				records: reviewerRecords,
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(JSON.parse(raw).success).toBe(true);
	}
}

describe('PR_REVIEW completion retryable-remainder gate + operator_cancelled admission (issue #2971)', () => {
	test('contract-terminal sixth with budget left refuses INCOMPLETE completion', async () => {
		const { missingDimension, records } =
			await establishFivePlusOne('contract');
		// #3312 AC10 supersedes the #2971 case-(1) admission-success pin: the
		// artifact admission now refuses a contract-class partial disclosure
		// while the legacy retry budget remains (retry-first order), so the
		// budget stays unconsumed here and the disclosure is never written.
		const admitted = await writePartial(records, [missingDimension]);
		expect(admitted.success).toBe(false);
		expect(admitted.message).toMatch(
			/refused while contract retry budget remains/,
		);
		expect(admitted.message).toContain(missingDimension);
		// Surface pinned: completePrWorkflow — the refusal fires before coverage
		// finalization, naming the dimension and the retry budget. The dimension
		// is UNdisclosed (admission above was refused), so #3312 AC13's
		// disclosed-tuple exclusion does not apply and the gate's
		// retryable-remainder refusal still fires at completion.
		let message = '';
		try {
			await completePrWorkflow(
				directory,
				PR_ARTIFACT_SESSION_ID,
				'PR_REVIEW',
				PR_ARTIFACT_HEAD_SHA,
				{ reportVerdict: 'INCOMPLETE' },
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/refused while eligible retryable work remains/);
		expect(message).toContain(missingDimension);
		expect(message).toContain('Retry budget');
		// Issue #2971 review round 1: the BLOCKED message no longer advertises
		// cancel_lane_batch as an escape HERE (it fires only after every lane is
		// terminal, which cancel_lane_batch cannot act on) — it now points at
		// re-dispatch and the human force path.
		expect(message).toContain('/swarm abort-pr-workflow');
		expect(message).toContain('dispatch_lanes_async');
	});

	test('the same shape completes once the legacy contract retry is consumed', async () => {
		const { missingDimension, records } =
			await establishFivePlusOne('contract');
		// #3312 AC10 supersedes the #2971 case-(2) write-then-consume order: the
		// admission now refuses a contract-class disclosure with an unconsumed
		// legacy budget, so the ONE contract retry for the dimension (the entire
		// legacy retry budget) is consumed BEFORE the partial write. The derived
		// FAILED/contract entry is unchanged by the unlaunched retry dispatch —
		// its batch carries no delegation record, which reads as "never
		// dispatched" — so admission still sees the same terminal settlement.
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			[{ laneId: 'contract-retry', workflowLane: missingDimension }],
			{
				batchId: 'contract-retry',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewContractRetry: true,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		expect((await writePartial(records, [missingDimension])).success).toBe(
			true,
		);
		await finishPartialLadder(records);
		const status = await completePrWorkflow(
			directory,
			PR_ARTIFACT_SESSION_ID,
			'PR_REVIEW',
			PR_ARTIFACT_HEAD_SHA,
			{ reportVerdict: 'INCOMPLETE' },
		);
		expect(status).toBe('completed');
	});

	test('an operator_cancelled sixth admits INCOMPLETE and never blocks completion', async () => {
		const { missingDimension, records } =
			await establishFivePlusOne('operator_cancelled');
		const admitted = await writePartial(records, [missingDimension]);
		expect(admitted.success).toBe(true);
		// Surface pinned: the write_pr_review_artifact admission disclosure.
		const disclosed =
			admitted.partial_base_coverage?.unresolved_dimensions.find(
				(entry) => entry.dimension === missingDimension,
			);
		expect(disclosed?.terminal_state).toBe('FAILED');
		expect(disclosed?.failure_class).toBe('operator_cancelled');
		const onDisk = JSON.parse(
			await fs.readFile(
				path.join(
					directory,
					'.swarm',
					'pr-review',
					RUN_ID,
					'coverage-disclosure.json',
				),
				'utf8',
			),
		);
		expect(onDisk.unresolvedDimensions[0].failureClass).toBe(
			'operator_cancelled',
		);
		expect(onDisk.unresolvedDimensions[0].safeDetail).toMatch(/operator/);
		expect(onDisk.unresolvedDimensions[0].safeDetail).not.toMatch(
			/abandoned by its host/,
		);
		// Surface pinned: completePrWorkflow INCOMPLETE completes — the
		// retryable-remainder gate never fires for operator_cancelled.
		await finishPartialLadder(records);
		const status = await completePrWorkflow(
			directory,
			PR_ARTIFACT_SESSION_ID,
			'PR_REVIEW',
			PR_ARTIFACT_HEAD_SHA,
			{ reportVerdict: 'INCOMPLETE' },
		);
		expect(status).toBe('completed');
	});

	test('a liveness-cancelled sixth still admits and completes INCOMPLETE (regression pin)', async () => {
		const { missingDimension, records } =
			await establishFivePlusOne('liveness');
		const admitted = await writePartial(records, [missingDimension]);
		expect(admitted.success).toBe(true);
		const disclosed =
			admitted.partial_base_coverage?.unresolved_dimensions.find(
				(entry) => entry.dimension === missingDimension,
			);
		expect(disclosed?.terminal_state).toBe('FAILED');
		expect(disclosed?.failure_class).toBe('liveness');
		await finishPartialLadder(records);
		const status = await completePrWorkflow(
			directory,
			PR_ARTIFACT_SESSION_ID,
			'PR_REVIEW',
			PR_ARTIFACT_HEAD_SHA,
			{ reportVerdict: 'INCOMPLETE' },
		);
		expect(status).toBe('completed');
	});
});
