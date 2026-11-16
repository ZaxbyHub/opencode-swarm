import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	bindPrReviewTriggerLedger,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	recordPrReviewMicroFamilyDispatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// ACCEPTANCE CHECK AC19 (DISCRIMINATING — RED at base, GREEN after the fix).
//
// Contract under test: a MATCHED micro family whose every dispatch died with a
// RESOURCE-class terminal lane record (durable status 'error', typed
// workflowLaneFailureClass 'resource', no retained artifact, pr head identity
// matching, persisted dispatch-attempt ledger past 1 + retry budget) must be
// admissible as a dead-family disclosure by write_pr_review_trigger_eval.
//
// RED at base: deadFamilyRecordShape in src/tools/write-pr-review-trigger-eval.ts
// requires workflowLaneFailureClass === 'liveness' exactly, so a resource-class
// terminal record falls through to the provenance refusal and the writer
// returns success:false with "does not reference a verifiable micro-lane
// provenance chain". GREEN after the fix: the disclosure is accepted — the
// writer returns success:true (no provenance-chain failure) and persists the
// trigger-eval receipt.

const tempDirs: string[] = [];
const SESSION_ID = 'ac19-dead-family-resource-session';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'ac19-dead-family-resource-revision';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
const DEAD_TRIGGER = 'unclassified-risk';
const DEAD_BATCH = 'micro-batch-dead-resource';
const DEAD_LANE = 'lane-unclassified-dead-resource';
// Exact resource-terminal sweep shape: durable status 'error' with a typed
// resource class and NO retained artifact (no storeLaneOutput, no outputRef).
const RESOURCE_REASON =
	'provider_overloaded: upstream capacity exhausted [kind=provider name=ApiError status=503]';
const RESOURCE_DIGEST = createHash('sha256')
	.update(RESOURCE_REASON)
	.digest('hex');
const PROVENANCE_FAILURE =
	'does not reference a verifiable micro-lane provenance chain';

const originalGateInternals = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
	gateDigest: gateInternals.resolvePrWorkflowRevisionDigest,
	diffStats: gateInternals.resolvePrReviewDiffStats,
	diffStatsAsync: gateInternals.resolvePrReviewDiffStatsAsync,
};
const originalWriterInternals = {
	digest: writerInternals.resolvePrWorkflowRevisionDigest,
	mergeBase: writerInternals.resolveMergeBase,
};

function tempRoot(): string {
	const root = canonicalMkdtemp('ac19-dead-family-resource-');
	mkdirSync(join(root, '.git'), { recursive: true });
	tempDirs.push(root);
	return root;
}

/** Ledger where only the mandatory fallback family is MATCHED; every other
 * family is NOT_TRIGGERED. The MATCHED row cites the dead lane's tuple. */
function rows() {
	return PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) =>
		definition.id === DEAD_TRIGGER
			? {
					trigger_id: definition.id,
					result: 'MATCHED' as const,
					evidence: `mandatory review focus for ${definition.id}`,
					source_batch_id: DEAD_BATCH,
					source_lane_id: DEAD_LANE,
				}
			: {
					trigger_id: definition.id,
					result: 'NOT_TRIGGERED' as const,
					evidence: `no ${definition.id} surface is touched by this change set`,
				},
	);
}

async function recordCompletedBaseLane(
	root: string,
	laneId: string,
): Promise<void> {
	const correlationId = `base-all-${laneId}-session`;
	const header =
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';
	const text = `${header}\n[CLEAN] | ${laneId} | exact reviewed diff | no candidate survived the focused review`;
	await recordPendingDelegation(root, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `base-all-${laneId}-call`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'base-all',
		laneId,
		mode: 'swarm-pr-review:base',
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: laneId,
		workspace: {
			directory: root,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: REVIEW_SCOPE,
		},
	});
	const stored = storeLaneOutput(root, {
		batchId: 'base-all',
		laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-review:base',
		workflowLane: laneId,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: REVIEW_SCOPE,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(root, correlationId, {
		status: 'completed',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

/**
 * Settle the cited micro lane with a typed RESOURCE-class terminal record:
 * durable status 'error', workflowLaneFailureClass 'resource', and NO retained
 * artifact (the exact shape a resource-budget-exhaustion settle persists).
 */
async function recordResourceDeadMicroLane(root: string): Promise<void> {
	const correlationId = `${DEAD_BATCH}-${DEAD_LANE}-session`;
	await recordPendingDelegation(root, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${DEAD_BATCH}-call`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: DEAD_BATCH,
		laneId: DEAD_LANE,
		mode: 'swarm-pr-review:micro',
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: DEAD_TRIGGER,
		workspace: {
			directory: root,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: REVIEW_SCOPE,
		},
	});
	await appendDelegationTransition(root, correlationId, {
		status: 'error',
		result: {
			error: RESOURCE_REASON,
			chars: RESOURCE_REASON.length,
			truncated: false,
			digest: RESOURCE_DIGEST,
			workflowLaneFailureClass: 'resource',
		},
	});
}

async function establishBoundReviewGate(root: string): Promise<void> {
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 10,
		changedFiles: 1,
		hasSubmoduleChange: false,
	});
	writerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolveMergeBase = () => BASE_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolvePrReviewDiffStatsAsync = async (dir, base, head) =>
		gateInternals.resolvePrReviewDiffStats(dir, base, head);
	await activatePrWorkflow(root, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(root, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: BASE_REF,
		baseSha: BASE_SHA,
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(root, SESSION_ID, baseLanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
	});
	for (const lane of baseLanes) {
		await recordCompletedBaseLane(root, lane.laneId);
	}
	await bindPrReviewTriggerLedger(
		root,
		SESSION_ID,
		rows().map(({ trigger_id, result, evidence }) => ({
			trigger_id,
			result,
			evidence,
		})),
	);
	// The dead-family admission requires the bounded retry budget provably
	// exhausted: record the initial dispatch plus two retries, with the cited
	// dead batch as the last attempt.
	for (const batchId of ['micro-attempt-1', 'micro-attempt-2', DEAD_BATCH]) {
		await recordPrReviewMicroFamilyDispatch(
			root,
			SESSION_ID,
			[{ laneId: DEAD_LANE, workflowLane: DEAD_TRIGGER }],
			{ batchId, prHeadSha: HEAD_SHA },
		);
	}
	await recordResourceDeadMicroLane(root);
}

afterEach(() => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalGateInternals.head;
	gateInternals.resolveCurrentGitHeadAsync = originalGateInternals.headAsync;
	gateInternals.resolveIsWorkingTreeClean = originalGateInternals.clean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originalGateInternals.cleanAsync;
	gateInternals.resolvePrWorkflowRevisionDigest =
		originalGateInternals.gateDigest;
	gateInternals.resolvePrReviewDiffStats = originalGateInternals.diffStats;
	gateInternals.resolvePrReviewDiffStatsAsync =
		originalGateInternals.diffStatsAsync;
	writerInternals.resolvePrWorkflowRevisionDigest =
		originalWriterInternals.digest;
	writerInternals.resolveMergeBase = originalWriterInternals.mergeBase;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('AC19: dead-family disclosure admits a resource-class terminal micro lane', () => {
	test('a resource-dead MATCHED family with an exhausted dispatch budget is accepted, not provenance-rejected', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const result = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'ac19-dead-family-resource-run',
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: BASE_REF,
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };

		// RED at base: the writer returns success:false with the provenance-chain
		// refusal because deadFamilyRecordShape only admits class 'liveness'.
		expect(
			result.success,
			`writer must accept the resource-dead family disclosure; writer said: ${result.message}`,
		).toBe(true);
		expect(String(result.message)).not.toContain(PROVENANCE_FAILURE);
		expect(
			existsSync(
				join(
					root,
					'.swarm',
					'pr-review',
					'ac19-dead-family-resource-run',
					'trigger-eval.json',
				),
			),
			'the trigger-eval receipt must be persisted for an accepted disclosure',
		).toBe(true);
	});
});
