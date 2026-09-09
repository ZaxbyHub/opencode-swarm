import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	claimTerminalResult,
	recordPendingDelegation,
	sweepStaleDelegations,
} from '../../../src/background/pending-delegations.js';
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
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

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
	directory = canonicalMkdtemp('pr-artifact-liveness-admission-');
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
	await fs.rm(directory, { recursive: true, force: true });
});

/**
 * The #2615 acceptance-(c) fixture: the adversarial file's
 * `establishFivePlusOne` shape, except the unresolved dimension's lane record
 * is settled through `settleUnresolved` — either the shared exactly-once
 * terminal claim (the cancelled shape) or the Task-side presumed-stale sweep
 * (the claim-less `status`+`result` write shape) — a typed 'liveness' failure
 * instead of an unadmittable classless terminal.
 */
async function establishFivePlusOneUnresolvedLane(
	settleUnresolved: (subagentSessionId: string) => Promise<void>,
): Promise<{
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
	const batchId = 'base-failed-0';
	const cancelledLane = {
		laneId: `failed-${missingDimension}`,
		workflowLane: missingDimension,
	};
	await enforcePrReviewBaseDimensions(
		directory,
		PR_ARTIFACT_SESSION_ID,
		[cancelledLane],
		{
			batchId,
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
	// Seed the delegation record with the production dispatch shape, then hand
	// it to the caller's settle strategy.
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
		laneId: cancelledLane.laneId,
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
	await settleUnresolved(subagentSessionId);
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

describe('write_pr_review_artifact liveness-class admission (issue #2615)', () => {
	test('admits INCOMPLETE coverage when the unresolved lane settled cancelled with a typed liveness class', async () => {
		const { missingDimension, records } =
			await establishFivePlusOneUnresolvedLane(async (subagentSessionId) => {
				// Settle exactly as cancel_pending does (its settleDelegationTerminal
				// routes through this same claim): status 'cancelled' with the
				// empty-body-digest synthetic result and the typed 'liveness' class,
				// and no stored lane output.
				await claimTerminalResult(directory, subagentSessionId, {
					eventId: `fixture-terminal-${subagentSessionId}`,
					status: 'cancelled',
					// Real instant read through the helper (check:test-clock):
					// the terminal must sit between the fixture's writes and
					// the admission read, so it cannot be a fixed constant.
					recordedAt: withFrozenClock(() => Date.now(), {
						fixedNow: Date.now(),
					}),
					result: {
						error: 'lane cancelled via collect_lane_results cancel_pending',
						chars: 0,
						truncated: false,
						digest: createHash('sha256').update('').digest('hex'),
						workflowLaneFailureClass: 'liveness',
					},
				});
			});
		const result = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'liveness-run',
					pr_head_sha: PR_ARTIFACT_HEAD_SHA,
					boundary: 'post_explorer',
					records,
					partial_base_coverage: { unresolved_dimensions: [missingDimension] },
				},
				directory,
				{ sessionID: PR_ARTIFACT_SESSION_ID },
			),
		) as {
			success: boolean;
			partial_base_coverage?: {
				unresolved_dimensions: Array<{
					dimension: string;
					terminal_state: string;
					failure_class?: string;
				}>;
			};
		};
		// Acceptance (c): the class-carrying cancelled record admits instead of
		// tripping the untyped-terminal refusal.
		expect(result.success).toBe(true);
		expect(JSON.stringify(result)).not.toContain(
			'lacks a typed terminal failure',
		);
		const disclosed = result.partial_base_coverage?.unresolved_dimensions.find(
			(entry) => entry.dimension === missingDimension,
		);
		expect(disclosed?.terminal_state).toBe('FAILED');
		expect(disclosed?.failure_class).toBe('liveness');
		const onDisk = JSON.parse(
			await fs.readFile(
				path.join(
					directory,
					'.swarm',
					'pr-review',
					'liveness-run',
					'coverage-disclosure.json',
				),
				'utf8',
			),
		);
		expect(onDisk.unresolvedDimensions[0].failureClass).toBe('liveness');
		expect(onDisk.unresolvedDimensions[0].safeDetail).toMatch(
			/abandoned by its host/,
		);
	});

	test('admits INCOMPLETE coverage when the unresolved lane was swept stale with a typed liveness result', async () => {
		// The final-critic probe made durable: the Task-side presumed-stale sweep
		// settles by a DIRECT status+result write under the store lock — no
		// terminal claim event exists, so admission must reach the class through
		// the record.result fallback in latestTypedFailureForBaseDimension.
		const { missingDimension, records } =
			await establishFivePlusOneUnresolvedLane(async (subagentSessionId) => {
				// The updatedAt seam replays a persisted timestamp exactly — force
				// the record far past any sweep horizon without a clock.
				await appendDelegationTransition(directory, subagentSessionId, {
					status: 'running',
					updatedAt: 1_000,
					expectedCurrentStatuses: ['pending'],
				});
				const swept = await sweepStaleDelegations(directory, 60_000);
				expect(swept).toBeGreaterThanOrEqual(1);
			});
		const result = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'liveness-run',
					pr_head_sha: PR_ARTIFACT_HEAD_SHA,
					boundary: 'post_explorer',
					records,
					partial_base_coverage: { unresolved_dimensions: [missingDimension] },
				},
				directory,
				{ sessionID: PR_ARTIFACT_SESSION_ID },
			),
		) as {
			success: boolean;
			partial_base_coverage?: {
				unresolved_dimensions: Array<{
					dimension: string;
					terminal_state: string;
					failure_class?: string;
				}>;
			};
		};
		expect(result.success).toBe(true);
		expect(JSON.stringify(result)).not.toContain(
			'lacks a typed terminal failure',
		);
		const disclosed = result.partial_base_coverage?.unresolved_dimensions.find(
			(entry) => entry.dimension === missingDimension,
		);
		expect(disclosed?.terminal_state).toBe('FAILED');
		expect(disclosed?.failure_class).toBe('liveness');
		const onDisk = JSON.parse(
			await fs.readFile(
				path.join(
					directory,
					'.swarm',
					'pr-review',
					'liveness-run',
					'coverage-disclosure.json',
				),
				'utf8',
			),
		);
		expect(onDisk.unresolvedDimensions[0].failureClass).toBe('liveness');
	});
});
