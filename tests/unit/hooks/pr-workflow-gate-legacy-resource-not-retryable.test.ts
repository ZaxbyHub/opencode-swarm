import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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

// ACCEPTANCE CHECK AC28 (PRESERVING — GREEN at base and at head).
//
// Contract under test: under the LEGACY resilience policy (resilience
// disabled), a resource-class terminal failure is NOT eligible retryable work.
// A PARTIAL settlement whose unresolved dimension carries failureClass
// 'resource' — with an admitted disclosure — must never be refused completion
// on retryable-remainder grounds; the legacy policy's retryable set is
// contract-only (src/hooks/pr-workflow-gate.ts retryable-remainder gate:
// "resource-class terminals are not auto-retryable under legacy and never
// block"). The workflow completes INCOMPLETE.
//
// This file stays GREEN after the fix: the fix widens the typed-failure
// derivation (provider-terminal records derive 'resource'), and this pin
// guarantees that widening cannot regress the legacy no-block behavior for
// explicitly typed resource failures.

const RUN_ID = 'ac28-legacy-resource-run';
const TERMINAL_EPOCH = 1_700_000_000_000;
const RESOURCE_REASON =
	'lane exhausted its resource budget before producing valid output';

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
	directory = canonicalMkdtemp('ac28-legacy-resource-');
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

type BaseDimension = (typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];

/** Five covered dimensions plus a sixth settled with a typed resource failure. */
async function establishFivePlusOneResource(): Promise<{
	missingDimension: BaseDimension;
	records: Array<Record<string, unknown>>;
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
	const batchId = 'base-failed-resource';
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
		status: 'error',
		recordedAt: TERMINAL_EPOCH,
		result: {
			error: RESOURCE_REASON,
			chars: RESOURCE_REASON.length,
			truncated: false,
			digest: '8'.repeat(64),
			workflowLaneFailureClass: 'resource',
		},
	});
	return {
		missingDimension,
		records: successfulDimensions.map((_dimension, index) => ({
			finding_id: `C-${index}`,
			status: 'PENDING',
			file_line: 'src/index.ts:1',
			evidence: `authoritative candidate ${index}`,
			next_action: 'route_to_reviewer',
			severity: 'HIGH',
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
 * boundary writes.
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
			evidence: `AC28 fixture evidence for ${workflowLane}`,
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

describe('AC28: legacy policy never blocks completion on a resource-class unresolved dimension', () => {
	test('resource-class PARTIAL settlement admits and completes INCOMPLETE with no retryable-remainder refusal', async () => {
		const { missingDimension, records } = await establishFivePlusOneResource();
		const admitted = await writePartial(records, [missingDimension]);
		expect(
			admitted.success,
			`admission must accept the typed resource dimension; writer said: ${admitted.message ?? JSON.stringify(admitted)}`,
		).toBe(true);
		const disclosed =
			admitted.partial_base_coverage?.unresolved_dimensions.find(
				(entry) => entry.dimension === missingDimension,
			);
		expect(disclosed?.terminal_state).toBe('FAILED');
		expect(disclosed?.failure_class).toBe('resource');
		await finishPartialLadder(records);
		// The pinned surface: completion is NOT refused on retryable-remainder
		// grounds — resource never blocks under the legacy policy.
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
