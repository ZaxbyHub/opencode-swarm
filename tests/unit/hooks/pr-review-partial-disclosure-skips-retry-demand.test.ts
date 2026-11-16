import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
	settleReviewerPhase,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

// ACCEPTANCE CHECK AC13 (DISCRIMINATING — RED at base, GREEN after the fix).
//
// Contract under test: the retryable-remainder completion gate
// ('BLOCKED: PR_REVIEW PARTIAL completion refused while eligible retryable
// work remains and retry budget is available') must SKIP dimensions that are
// covered by a matching ADMITTED disclosure. Under the STAGED resilience
// policy (persisted prReviewResilience.policy.enabled true, attempts budget
// 0 of max), a resource-class dimension is staged-retryable — but once its
// FAILED/resource terminal state is truthfully disclosed and admitted, an
// INCOMPLETE completion must not demand a retry for it. The issue-2840
// catch-and-assert-not pattern is used so a LATER unrelated failure would
// still surface instead of masking as success.
//
// RED at base: the retryable-remainder filter counts the disclosed
// resource-class dimension anyway (staged policy includes 'resource'), so
// completePrWorkflow(INCOMPLETE) throws the retryable-remainder refusal —
// the captured message matches /refused while eligible retryable work
// remains/ and the not-match assertion fails. GREEN after the fix: the
// disclosed dimension is skipped, the completion runs the full artifact
// ladder and returns 'completed'.

const RUN_ID = 'ac13-skip-retry-demand-run';

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(() => {
	directory = canonicalMkdtemp('ac13-skip-retry-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

type BaseDimension = (typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];

/** Five covered dimensions plus a resource-class FAILED sixth (legacy setup). */
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
	await persistPrReviewBatch(
		directory,
		batchId,
		'swarm-pr-review:base',
		[unresolvedLane],
		{ status: 'error', workflowLaneFailureClass: 'resource' },
	);
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
 * boundary writes (pr-review-terminal-coverage-settlement recipe).
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
			evidence: `AC13 fixture evidence for ${workflowLane}`,
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
		'utf8',
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

/**
 * Flip the persisted gate state to the STAGED resilience policy with an
 * UNTOUCHED attempt budget (0 of 1 + maxRetryAttemptsAfterInitial), mirroring
 * the AC27 seed. Seeded LAST: every ladder writer re-persists gate state and
 * would drop the hand-seeded field.
 */
async function seedStagedResilienceBudgetAvailable(
	missingDimension: BaseDimension,
): Promise<void> {
	const current = await readPrWorkflowGateState(
		directory,
		PR_ARTIFACT_SESSION_ID,
	);
	if (!current) throw new Error('AC13 seed: no gate state to merge into');
	await writeAuthoritativePrWorkflowState(directory, {
		...current,
		prReviewResilience: {
			policy: {
				enabled: true,
				canaryProbeMs: DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.canary_probe_ms,
				statusProbeTimeoutMs:
					DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.status_probe_timeout_ms,
				correlatedFailureThreshold:
					DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.correlated_failure_threshold,
				maxRetryAttemptsAfterInitial:
					DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.max_retry_attempts_after_initial,
				circuitOpenDurationMs:
					DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.circuit_open_duration_ms,
			},
			attempts: [],
		},
	});
	_test_exports.resetTrackedStateCache();
}

describe('AC13: retryable-remainder gate skips dimensions covered by a matching admitted disclosure', () => {
	test('staged policy + disclosed resource-class dimension: INCOMPLETE completion does not demand a retry for it', async () => {
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
		await seedStagedResilienceBudgetAvailable(missingDimension);
		let message = '';
		let status: string | undefined;
		try {
			status = await completePrWorkflow(
				directory,
				PR_ARTIFACT_SESSION_ID,
				'PR_REVIEW',
				PR_ARTIFACT_HEAD_SHA,
				{ reportVerdict: 'INCOMPLETE' },
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		// The pinned surface: the disclosed dimension must NOT trigger the
		// retryable-remainder refusal. At base this not-match assertion fails
		// with exactly the captured refusal message (the RED signature).
		expect(message).not.toMatch(
			/refused while eligible retryable work remains/,
		);
		// With the refusal gone the fully driven ladder completes.
		expect(status).toBe('completed');
		expect(
			await readPrWorkflowGateState(directory, PR_ARTIFACT_SESSION_ID),
		).toBeNull();
	});
});
