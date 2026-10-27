/**
 * Issue #3313 (AC17) — a dispatched base dimension whose lane evidence is
 * semantically valid but recorded at a stale revision must settle as a typed
 * FAILED dimension under staged resilience with the retry budget exhausted,
 * instead of wedging the run in liveDimensions.
 *
 * Shape: a base lane whose record passes batch integrity
 * (`recordsPassingBatchIntegrity`) and whose artifact validates
 * revision-INDEPENDENTLY (`hasRevisionIndependentDiscoverySemantics` compares
 * against the artifact's OWN revisionDigest) but whose stored artifact digest
 * differs from the CURRENT gate revision digest fails
 * `loadArtifactPassingLaneIntegrity`'s `artifact.revision_digest` check, so
 * `successfulObligationsFromExactBatch` never credits the dimension. Today
 * `derivePrReviewDimensionSettlement` (src/pr-review/completion.ts) then
 * routes the dispatched-but-unresolved dimension to `liveDimensions`, which
 * admission (`assertPrReviewBaseCoverageSettled`) and completion refuse —
 * with the retry budget exhausted the run can never re-dispatch and wedges.
 *
 * POST-FIX CONTRACT under test: when staged resilience is enabled
 * (state.prReviewResilience.policy.enabled === true) AND the retry budget is
 * exhausted (attempts.length >= 1 + maxRetryAttemptsAfterInitial), a
 * dispatched dimension whose only lane evidence is semantically-valid-but-
 * stale-revision settles as an unresolvedDimensions entry
 * {terminalState: 'FAILED', reasonKind: 'lane_failure', failureClass:
 * 'resource', safeDetail containing 'stale revision'}; settlement.kind stays
 * 'PARTIAL' and liveDimensions is empty. Under the legacy policy (default)
 * the behavior is unchanged — the dimension stays live and the settled
 * assertion still throws the live-lanes error (scoped-fix control below).
 *
 * DISCRIMINATING at base: the stale dimension lands in liveDimensions, so
 * `expect(settlement.liveDimensions).toEqual([])` fails with:
 *   error: expect(received).toEqual(expected)
 *   - []
 *   + [
 *   +   "compatibility-delivery",
 *   + ]
 *
 * Fixture patterns reused from
 * tests/unit/hooks/pr-review-terminal-coverage-settlement.test.ts (gate
 * lifecycle + persistPrReviewBatch) and
 * tests/unit/pr-review/r14-evidence-read-repair-registered.test.ts (direct
 * derivePrReviewDimensionSettlement driving). The stale lane is seeded
 * manually through the same storeLaneOutput + delegation-transition chain as
 * tests/helpers/pr-review-artifact-fixtures.ts persistPrReviewBatch, with a
 * distinct revisionDigest.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	assertPrReviewBaseCoverageSettled,
	enforcePrReviewBaseDimensions,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { derivePrReviewDimensionSettlement } from '../../../src/pr-review/completion.js';
import {
	readPrWorkflowGateStateFromDisk,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

type Dimension = (typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];

const BATCH_ID = 'base-3313-all';
const STALE_DIMENSION: Dimension = 'compatibility-delivery';
const STALE_REVISION_DIGEST = 'stale-revision-3313';
const BASE_CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';

/**
 * Staged resilience policy with a zero retry budget: the initial attempt plus
 * zero retries, so one recorded attempt exhausts it
 * (attempts.length 1 >= 1 + maxRetryAttemptsAfterInitial 0). Field shape
 * matches PrReviewResiliencePolicyRecordSchema (pr-workflow-gate.ts) so the
 * state write below parses.
 */
const STAGED_EXHAUSTED_POLICY = {
	enabled: true,
	canaryProbeMs: 300_000,
	statusProbeTimeoutMs: 2_000,
	correlatedFailureThreshold: 2,
	maxRetryAttemptsAfterInitial: 0,
	circuitOpenDurationMs: 60_000,
} as const;

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveWorkingTreeClean = _test_exports.resolveIsWorkingTreeClean;
const originalResolveWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(() => {
	directory = canonicalMkdtemp('stale-revision-partial-3313-');
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
	_test_exports.resolveIsWorkingTreeClean = originalResolveWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveWorkingTreeCleanAsync;
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

/**
 * Seed one completed base lane whose stored artifact carries `revisionDigest`.
 * Mirrors persistPrReviewBatch's record + storeLaneOutput + transition chain,
 * parameterized on the digest (the shared helper hardcodes the current one).
 */
async function seedBaseLaneAtRevision(
	batchId: string,
	lane: { laneId: string; workflowLane: Dimension },
	revisionDigest: string,
): Promise<void> {
	const correlationId = `${batchId}-${lane.laneId}`;
	const text = `${BASE_CANDIDATE_HEADER}\nC-${lane.laneId} | ${lane.workflowLane} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH | UNKNOWN | `;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: PR_ARTIFACT_SESSION_ID,
		callID: `call-${correlationId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId: lane.laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: lane.workflowLane,
		workspace: {
			directory,
			gitHead: PR_ARTIFACT_HEAD_SHA,
			dirtyHash: null,
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			scope: null,
		},
		prReviewLegacyTranscriptCompatibility: true,
	});
	const stored = storeLaneOutput(directory, {
		batchId,
		laneId: lane.laneId,
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: correlationId,
		parentSessionId: PR_ARTIFACT_SESSION_ID,
		mode: 'swarm-pr-review:base',
		workflowLane: lane.workflowLane,
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
		gitHead: PR_ARTIFACT_HEAD_SHA,
		revisionDigest,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(directory, correlationId, {
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
 * One PR_REVIEW workflow with all six base dimensions declared in one batch:
 * five lanes record artifacts at the CURRENT revision digest (covered), and
 * the stale dimension's lane records a semantically valid artifact at an
 * older revision digest (never creditable on the current worktree).
 */
async function seedFiveFreshPlusOneStaleLane(): Promise<void> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
	});
	const freshDimensions = PR_REVIEW_BASE_DIMENSION_IDS.filter(
		(dimension) => dimension !== STALE_DIMENSION,
	);
	const freshLanes = freshDimensions.map((workflowLane) => ({
		laneId: `lane-3313-${workflowLane}`,
		workflowLane,
	}));
	const staleLane = {
		laneId: `lane-3313-${STALE_DIMENSION}`,
		workflowLane: STALE_DIMENSION,
	};
	await enforcePrReviewBaseDimensions(
		directory,
		PR_ARTIFACT_SESSION_ID,
		[...freshLanes, staleLane],
		{
			batchId: BATCH_ID,
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
	await persistPrReviewBatch(
		directory,
		BATCH_ID,
		'swarm-pr-review:base',
		freshLanes,
	);
	await seedBaseLaneAtRevision(BATCH_ID, staleLane, STALE_REVISION_DIGEST);
}

/**
 * Flip the persisted gate state onto the staged policy with the retry budget
 * already exhausted (attempt 0 recorded, maxRetryAttemptsAfterInitial 0), the
 * durable shape the AC17 settlement reads.
 */
async function injectExhaustedStagedResilience(): Promise<void> {
	const current = await readPrWorkflowGateStateFromDisk(
		directory,
		PR_ARTIFACT_SESSION_ID,
	);
	if (!current) throw new Error('expected an active PR_REVIEW gate state');
	await writeStateWhileLocked(directory, {
		...current,
		prReviewResilience: {
			policy: STAGED_EXHAUSTED_POLICY,
			attempts: [
				{
					attempt: 0,
					targetDimensions: [...PR_REVIEW_BASE_DIMENSION_IDS],
					canaryBatchId: BATCH_ID,
					canaryLaneId: `lane-3313-${STALE_DIMENSION}`,
					canaryWorkflowLane: STALE_DIMENSION,
					admittedAt: '2026-01-01T00:00:00.000Z',
					fanoutBatchId: BATCH_ID,
				},
			],
		},
	});
	_test_exports.resetTrackedStateCache();
}

describe('stale-revision base dimension settles FAILED under exhausted staged resilience (#3313 AC17)', () => {
	test('staged + exhausted budget classifies the stale dimension FAILED/resource, PARTIAL, not live', async () => {
		await seedFiveFreshPlusOneStaleLane();
		await injectExhaustedStagedResilience();

		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(state).not.toBeNull();
		const settlement = derivePrReviewDimensionSettlement(
			directory,
			state!,
			PR_ARTIFACT_REVISION_DIGEST,
		);

		// The five current-digest lanes stay covered and the run settles PARTIAL.
		expect(settlement.kind).toBe('PARTIAL');
		expect(settlement.coveredDimensions).toHaveLength(
			PR_REVIEW_BASE_DIMENSION_IDS.length - 1,
		);
		// DISCRIMINATING: the stale-revision dimension is terminal, never live.
		expect(settlement.liveDimensions).toEqual([]);
		const entry = settlement.unresolvedDimensions.find(
			(candidate) => candidate.dimension === STALE_DIMENSION,
		);
		expect(entry).toBeDefined();
		expect(entry!.terminalState).toBe('FAILED');
		expect(entry!.reasonKind).toBe('lane_failure');
		expect(entry!.failureClass).toBe('resource');
		expect(entry!.safeDetail).toMatch(/stale revision/);

		// The settled assertion must no longer throw the live-lanes wedge for
		// the stale dimension (the no-disclosure-admitted refusal is fine).
		let message = '';
		try {
			await assertPrReviewBaseCoverageSettled(
				directory,
				PR_ARTIFACT_SESSION_ID,
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).not.toMatch(/still has live lanes/);
	});

	test('legacy policy keeps the stale-revision dimension live (scoped-fix control)', async () => {
		await seedFiveFreshPlusOneStaleLane();

		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(state).not.toBeNull();
		const settlement = derivePrReviewDimensionSettlement(
			directory,
			state!,
			PR_ARTIFACT_REVISION_DIGEST,
		);
		// Unchanged pre-fix behavior under the legacy (default) policy: the
		// dispatched-but-unresolved dimension blocks settlement as live.
		expect(settlement.liveDimensions).toEqual([STALE_DIMENSION]);
		await expect(
			assertPrReviewBaseCoverageSettled(directory, PR_ARTIFACT_SESSION_ID),
		).rejects.toThrow(/still has live lanes/);
	});
});
