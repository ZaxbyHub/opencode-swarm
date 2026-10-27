import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	claimTerminalResult,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
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

// ACCEPTANCE CHECK AC27 (DISCRIMINATING — RED at base, GREEN after the fix).
//
// Contract under test: under the STAGED resilience policy (persisted
// prReviewResilience.policy.enabled true, attempts budget 0 of max 2), a base
// dimension whose ONLY failure is the provider-terminal record (classless at
// base; derived class 'resource' after the fix) flows through completion as a
// TYPED resource failure:
//   * #3312 AC13 supersedes #3311 AC27's budget-available refusal pin: once
//     the dimension is ADMITTED through the typed-resource disclosure, the
//     retryable-remainder gate no longer re-demands it at completion (that
//     re-demand was the F-class wedge #3312 closes) — the completion runs to
//     'completed' with no refusal. The typed-resource ADMISSION assertions
//     (the discriminating surface of #3311 AC27) are retained below.
//   * once the retry budget is CONSUMED (attempts 3 of 3), a PARTIAL
//     INCOMPLETE completion completes without any
//     "lacks a typed terminal failure" throw.
//
// RED at base: the partial-coverage admission itself refuses the classless
// provider-terminal dimension (`BLOCKED: partial base coverage dimension
// "<d>" lacks a typed terminal failure`), so neither completion behavior is
// reachable. GREEN after the fix: admission discloses FAILED/resource and the
// two completion behaviors above hold.

const RUN_ID = 'ac27-staged-retryable-run';
const TERMINAL_EPOCH = 1_700_000_000_000;
const PROVIDER_REASON =
	'provider_overloaded: upstream capacity exhausted [kind=provider name=ApiError status=503 host_retryable=false]';

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
	directory = canonicalMkdtemp('ac27-staged-retryable-');
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

/** Five covered dimensions plus a provider-terminal (classless) sixth. */
async function establishFivePlusOneProviderTerminal(): Promise<{
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
	const batchId = 'base-failed-provider';
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
			error: PROVIDER_REASON,
			chars: PROVIDER_REASON.length,
			truncated: false,
			digest: '7'.repeat(64),
			terminalErrorClass: {
				kind: 'provider',
				category: 'provider_overloaded',
				statusCode: 503,
				hostRetryable: false,
			},
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

/**
 * Flip the persisted gate state to the STAGED resilience policy (the live
 * config's enabled flag is authoritative for the completion gate, and the
 * persisted record carries the numeric knobs + attempt ledger). `attempts`
 * seeds the consumed retry budget: 0 records = budget untouched; 3 records =
 * 1 + maxRetryAttemptsAfterInitial consumed.
 */
async function seedStagedResilience(
	missingDimension: BaseDimension,
	attemptCount: 0 | 3,
): Promise<void> {
	// Write through the AUTHORITATIVE state store (SQLite coordination
	// authority): hand-editing the persisted JSON projection is invisible to
	// readPrWorkflowGateState, so the seed must merge into the live state.
	const current = await readPrWorkflowGateState(
		directory,
		PR_ARTIFACT_SESSION_ID,
	);
	if (!current) throw new Error('AC27 seed: no gate state to merge into');
	const attempts = Array.from({ length: attemptCount }, (_v, index) => ({
		attempt: index as 0 | 1 | 2,
		targetDimensions: [missingDimension] as BaseDimension[],
		canaryBatchId: 'ac27-canary-' + index,
		canaryLaneId: 'ac27-canary-lane-' + index,
		canaryWorkflowLane: missingDimension,
		admittedAt: '2026-01-01T00:00:00.000Z',
	}));
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
			attempts,
		},
	});
	_test_exports.resetTrackedStateCache();
}

interface PartialWriteResult {
	success: boolean;
	message?: string;
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
			evidence: `AC27 fixture evidence for ${workflowLane}`,
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

describe('AC27: provider-terminal dimension is retryable-class resource under the staged policy', () => {
	test('retry budget available: a disclosed typed-resource dimension completes instead of re-demanding a retry', async () => {
		const { missingDimension, records } =
			await establishFivePlusOneProviderTerminal();
		const admitted = await writePartial(records, [missingDimension]);
		// Typed-resource admission assertions (the discriminating #3311 AC27
		// surface, retained through the #3312 supersession).
		expect(
			admitted.success,
			`admission must accept the provider-terminal dimension; writer said: ${admitted.message ?? JSON.stringify(admitted)}`,
		).toBe(true);
		// Post-admission completion needs the universal trigger-evaluation
		// precondition (the ladder fixture persists trigger-eval.json); at base
		// this test never reached completion, so the fixture gap was invisible.
		// The resilience snapshot is seeded LAST because every ladder writer
		// re-persists gate state and would drop the hand-seeded field.
		await finishPartialLadder(records);
		await seedStagedResilience(missingDimension, 0);
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
		// #3312 AC13 supersedes #3311 AC27's budget-available refusal pin: the
		// dimension is covered by the ADMITTED typed-resource disclosure, so
		// the retryable-remainder gate no longer re-demands it (the C13 shape,
		// pr-review-partial-disclosure-skips-retry-demand.test.ts) — the
		// fully driven ladder completes instead of throwing.
		expect(message).not.toMatch(
			/refused while eligible retryable work remains/,
		);
		expect(status).toBe('completed');
		expect(message).not.toMatch(/lacks a typed terminal failure/);
	});

	test('retry budget consumed: PARTIAL INCOMPLETE completes without the classless typed-terminal throw', async () => {
		const { missingDimension, records } =
			await establishFivePlusOneProviderTerminal();
		const admitted = await writePartial(records, [missingDimension]);
		// RED at base: the same classless admission refusal fires here too.
		expect(
			admitted.success,
			`admission must accept the provider-terminal dimension; writer said: ${admitted.message ?? JSON.stringify(admitted)}`,
		).toBe(true);
		await finishPartialLadder(records);
		await seedStagedResilience(missingDimension, 3);
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
