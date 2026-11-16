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
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
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

// ACCEPTANCE CHECK AC5 (DISCRIMINATING — RED at base, GREEN after the fix).
//
// Contract under test: a base dimension whose ONLY terminal record is a
// provider-terminal lane failure — durable status 'error' with a PRESENT
// terminalErrorClass (the typed #2382 classification executeCollectLaneResults
// persists at settle time) and NO workflowLaneFailureClass — must derive a
// TYPED terminal failure for the dimension settlement. Post-fix the dimension
// derives terminalState FAILED with failureClass 'resource' and the partial
// base coverage admission ACCEPTS it (no throw).
//
// RED at base: latestTypedFailureForBaseDimension
// (src/pr-review/completion.ts) skips records without
// workflowLaneFailureClass, so the derived unresolved dimension carries no
// failureClass and the admission refuses with `BLOCKED: partial base coverage
// dimension "<d>" lacks a typed terminal failure`. GREEN after the fix: the
// admission succeeds and discloses the dimension as FAILED/resource.

const RUN_ID = 'ac5-provider-terminal-run';
/** Fixed instant for terminal events — no raw clock reads in this file. */
const TERMINAL_EPOCH = 1_700_000_000_000;
/**
 * The exact display reason a provider-terminal settle persists
 * (laneTerminalErrorReason): category-led, bounded, kind/name/status tail.
 */
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
	directory = canonicalMkdtemp('ac5-provider-terminal-');
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
 * Five covered base dimensions plus a sixth whose ONLY terminal record is the
 * provider-terminal shape: claimed status 'error' with a typed
 * terminalErrorClass and NO workflowLaneFailureClass, no retained artifact.
 */
async function establishFivePlusOneProviderTerminal(): Promise<{
	missingDimension: (typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];
	records: Array<{
		finding_id: string;
		status: 'PENDING';
		file_line: string;
		evidence: string;
		next_action: 'route_to_reviewer';
		severity: 'HIGH';
		risk_impact: 'UNKNOWN';
		risk_tags: string[];
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
			digest: '5'.repeat(64),
			// The pre-upgrade provider-terminal settle: typed terminalErrorClass
			// captured at settle time, NO workflowLaneFailureClass, no outputRef.
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
			status: 'PENDING' as const,
			file_line: 'src/index.ts:1',
			evidence: `authoritative candidate ${index}`,
			next_action: 'route_to_reviewer' as const,
			severity: 'HIGH' as const,
			risk_impact: 'UNKNOWN' as const,
			risk_tags: [] as string[],
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

describe('AC5: provider-terminal base dimension derives a typed FAILED/resource terminal failure', () => {
	test('partial admission accepts the provider-terminal dimension as FAILED with failure class resource', async () => {
		const { missingDimension, records } =
			await establishFivePlusOneProviderTerminal();
		const admitted = await writePartial(records, [missingDimension]);
		// RED at base: the writer returns success:false with
		// `BLOCKED: partial base coverage dimension "<d>" lacks a typed terminal
		// failure` because the provider-terminal record carries no
		// workflowLaneFailureClass.
		expect(
			admitted.success,
			`admission must accept the provider-terminal dimension; writer said: ${admitted.message ?? JSON.stringify(admitted)}`,
		).toBe(true);
		const disclosed =
			admitted.partial_base_coverage?.unresolved_dimensions.find(
				(entry) => entry.dimension === missingDimension,
			);
		expect(disclosed?.terminal_state).toBe('FAILED');
		expect(disclosed?.failure_class).toBe('resource');
		// The disclosure on disk carries the derived class (admission mirrors it).
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
		expect(onDisk.unresolvedDimensions[0].failureClass).toBe('resource');
		expect(onDisk.unresolvedDimensions[0].terminalState).toBe('FAILED');
	});
});
