/**
 * Issue #2585 live-proof regression (AC11 case-01, found against the real
 * host; defect present byte-identically on main 3ea01cbc7): the collect-time
 * discovery validation in `settleCollectedLane` built its `expected` WITHOUT
 * the workflow identity triple, so `validateExactStructuredReceiptCoverage`
 * rejected EVERY child-submitted structured receipt with `missing live
 * workflow instance/revision/base identity` — deterministic and unrepairable
 * from the orchestrator — settling every base dimension as a contract failure
 * (NO_COVERAGE → forced INCOMPLETE).
 *
 * The fix derives the triple from the record (jobId binding + generation)
 * and the dispatching parent's live gate state via
 * `resolveCollectExpectedWorkflowIdentity`. These tests pin:
 *   1. the pure derivation legs (mode gate, missing legs, instance
 *      cross-check against the live gate, baseSha requirement), and
 *   2. the composed behavior against a real activated gate: with the derived
 *      identity the gate's collect-time validator ACCEPTS an exact structured
 *      receipt shaped like the live run's durable record, and without it (the
 *      pre-fix expected shape) the same receipt is rejected — leg 2's
 *      without-identity expectation reproduces the observed live failure and
 *      is the falsifiable mutation for this fix.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	encodePrReviewWorkflowBinding,
	prReviewLaneResultEnvelopeDigest,
} from '../../../src/background/pr-review-contract.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
	validatePrReviewDiscoveryLaneCompletion,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _test_exports as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const BASE_SHA = '5f9144349970d5af3e2d46773599a1208a60ec01';
const RECEIPT_REVISION_DIGEST = 'd'.repeat(64);
const BATCH_ID = 'collect-identity-batch';
const LANE_ID = 'collect-identity-lane';
const CHILD_SESSION = 'child-collect-identity';
const CREDITED_LANE = 'intent-architecture';
const UNRESOLVED_LANE = 'security-trust';
const WORKFLOW_INSTANCE = '12a87cf3-edad-4057-ba96-8afada460c4d';

let directory = '';
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolvePrWorkflowRevisionDigest =
	gateInternals.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalResolvePrReviewDiffStatsAsync =
	gateInternals.resolvePrReviewDiffStatsAsync;

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-collect-identity-');
	await fs.mkdir(path.join(directory, '.git'), { recursive: true });
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => PR_ARTIFACT_HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	gateInternals.resolvePrWorkflowRevisionDigest = () => RECEIPT_REVISION_DIGEST;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrReviewDiffStatsAsync = async () => ({
		changedLines: 4,
		changedFiles: 1,
		hasSubmoduleChange: false,
	});
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	gateInternals.resolvePrWorkflowRevisionDigest =
		originalResolvePrWorkflowRevisionDigest;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	gateInternals.resolvePrReviewDiffStatsAsync =
		originalResolvePrReviewDiffStatsAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

interface FixtureRecord {
	jobId: string | null;
	mode: string;
	workflowGeneration?: number;
	parentSessionId: string;
	correlationId: string;
	subagentSessionId: string;
	callID: string;
	normalizedAgent: string;
	swarmPrefixedAgent: string;
	planTaskId: null;
	evidenceTaskId: null;
	batchId: string;
	laneId: string;
	workflowLane: string;
	ownedWorkflowLanes?: string[];
	workspace: Record<string, unknown>;
}

function baseRecord(overrides: Partial<FixtureRecord> = {}): FixtureRecord {
	return {
		jobId: encodePrReviewWorkflowBinding(WORKFLOW_INSTANCE),
		mode: 'swarm-pr-review:base',
		workflowGeneration: 5,
		parentSessionId: PR_ARTIFACT_SESSION_ID,
		correlationId: CHILD_SESSION,
		subagentSessionId: CHILD_SESSION,
		callID: `call-${CHILD_SESSION}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: BATCH_ID,
		laneId: LANE_ID,
		workflowLane: CREDITED_LANE,
		ownedWorkflowLanes: [CREDITED_LANE],
		status: 'completed' as const,
		generation: 1,
		workspace: {
			directory: '',
			gitHead: PR_ARTIFACT_HEAD_SHA,
			dirtyHash: null,
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			scope: null,
		},
		...overrides,
	};
}

function parentState(overrides: Record<string, unknown> = {}) {
	return {
		mode: 'PR_REVIEW',
		workflowInstanceId: WORKFLOW_INSTANCE,
		prReviewBaseSha: BASE_SHA,
		...overrides,
	};
}

describe('resolveCollectExpectedWorkflowIdentity (#2585 live-proof fix)', () => {
	test('derives the identity triple for a bound base lane against its live gate', () => {
		expect(
			dispatchInternals.resolveCollectExpectedWorkflowIdentity(
				baseRecord() as never,
				parentState(),
			),
		).toEqual({
			workflowInstanceId: WORKFLOW_INSTANCE,
			workflowRevision: 5,
			baseSha: BASE_SHA,
		});
	});

	test('returns undefined for non-discovery modes', () => {
		for (const mode of ['swarm-pr-review:reviewer', 'advisory']) {
			expect(
				dispatchInternals.resolveCollectExpectedWorkflowIdentity(
					baseRecord({ mode }) as never,
					parentState(),
				),
			).toBeUndefined();
		}
	});

	test('returns undefined when the record carries no workflow generation or binding', () => {
		expect(
			dispatchInternals.resolveCollectExpectedWorkflowIdentity(
				baseRecord({ workflowGeneration: undefined }) as never,
				parentState(),
			),
		).toBeUndefined();
		expect(
			dispatchInternals.resolveCollectExpectedWorkflowIdentity(
				baseRecord({ jobId: null }) as never,
				parentState(),
			),
		).toBeUndefined();
	});

	test('returns undefined when the parent gate is absent or not PR_REVIEW', () => {
		expect(
			dispatchInternals.resolveCollectExpectedWorkflowIdentity(
				baseRecord() as never,
				null,
			),
		).toBeUndefined();
		expect(
			dispatchInternals.resolveCollectExpectedWorkflowIdentity(
				baseRecord() as never,
				parentState({ mode: 'PR_FEEDBACK' }),
			),
		).toBeUndefined();
	});

	test('refuses a stale record whose instance no longer matches the live gate', () => {
		expect(
			dispatchInternals.resolveCollectExpectedWorkflowIdentity(
				baseRecord() as never,
				parentState({
					workflowInstanceId: 'aborted-and-reactivated-new-instance',
				}),
			),
		).toBeUndefined();
	});

	test('returns undefined when the live gate has no bound merge base', () => {
		expect(
			dispatchInternals.resolveCollectExpectedWorkflowIdentity(
				baseRecord() as never,
				parentState({ prReviewBaseSha: undefined }),
			),
		).toBeUndefined();
	});
});

describe('composed: collect-time settlement accepts an exact receipt only with the derived identity', () => {
	test('same receipt and gate: rejected without the identity (pre-fix shape), accepted with it', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		await bindPrReviewBase(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			baseRef: 'origin/main',
			baseSha: BASE_SHA,
		});
		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(state).not.toBeNull();
		expect(state!.workflowInstanceId).toBeDefined();
		expect(state!.prReviewBaseSha).toBe(BASE_SHA);

		// Record + receipt mirror the durable shapes observed in the live run
		// (delegation ledger record; child-submitted structured receipt).
		const record = baseRecord({
			jobId: encodePrReviewWorkflowBinding(state!.workflowInstanceId!),
			workflowGeneration: state!.revision,
			ownedWorkflowLanes: [CREDITED_LANE, UNRESOLVED_LANE],
		});
		const envelope = {
			schemaVersion: 1 as const,
			outcome: 'INCOMPLETE' as const,
			creditedLanes: [CREDITED_LANE],
			findings: [
				{
					id: 'R-1',
					workflowLane: CREDITED_LANE,
					severity: 'HIGH' as const,
					riskImpact: 'ORDINARY' as const,
					riskTags: [],
					title: 'Receipt-backed finding',
					body: 'Only the credited lane is settled.',
					evidence: 'Structured receipt preserves only this finding.',
					location: {
						kind: 'non_local' as const,
						label: 'receipt',
						detail: 'lane-settlement',
					},
				},
			],
			cleanAttestations: [],
			unresolved: [
				{
					workflowLane: 'security-trust',
					reason: 'RESOURCE_LIMIT' as const,
					detail: 'fixture-unresolved-lane',
				},
			],
		};
		const receipt = {
			schemaVersion: 1,
			mode: 'swarm-pr-review:base',
			workflowInstanceId: state!.workflowInstanceId!,
			workflowRevision: state!.revision,
			batchId: BATCH_ID,
			laneId: LANE_ID,
			workflowLane: CREDITED_LANE,
			ownedWorkflowLanes: [CREDITED_LANE, UNRESOLVED_LANE],
			baseSha: state!.prReviewBaseSha!,
			headSha: PR_ARTIFACT_HEAD_SHA,
			dispatchRevisionDigest: RECEIPT_REVISION_DIGEST,
			childSessionId: CHILD_SESSION,
			generation: 1,
			semanticEnvelopeDigest: prReviewLaneResultEnvelopeDigest(envelope),
			envelope,
		};
		const result = {
			text: 'lane transcript text',
			chars: 19,
			truncated: false,
			digest: '0'.repeat(64),
			// The collect path always carries the lane-output store ref written
			// by prepareLaneOutput; record-result integrity requires it present.
			outputRef: `lane-outputs/${BATCH_ID}/${LANE_ID}.json`,
			prReviewResultReceipt: receipt,
		};

		// Pre-fix shape: expected WITHOUT the identity triple → the live-failure
		// predicate fires even though the receipt correlates exactly.
		const preFix = validatePrReviewDiscoveryLaneCompletion({
			record: record as never,
			result: result as never,
			artifact: null,
			expected: {
				mode: 'swarm-pr-review:base',
				workflowLane: CREDITED_LANE,
				ownedWorkflowLanes: [CREDITED_LANE, UNRESOLVED_LANE],
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				gitHead: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: RECEIPT_REVISION_DIGEST,
				reviewScope: undefined,
			} as never,
		});
		expect(preFix.ok).toBe(false);

		// Fixed shape: the derived identity flows into expected → accepted.
		const identity = dispatchInternals.resolveCollectExpectedWorkflowIdentity(
			record as never,
			state,
		);
		expect(identity).toEqual({
			workflowInstanceId: state!.workflowInstanceId,
			workflowRevision: state!.revision,
			baseSha: state!.prReviewBaseSha,
		});
		const postFix = validatePrReviewDiscoveryLaneCompletion({
			record: record as never,
			result: result as never,
			artifact: null,
			expected: {
				mode: 'swarm-pr-review:base',
				workflowLane: CREDITED_LANE,
				ownedWorkflowLanes: [CREDITED_LANE, UNRESOLVED_LANE],
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				gitHead: PR_ARTIFACT_HEAD_SHA,
				revisionDigest: RECEIPT_REVISION_DIGEST,
				reviewScope: undefined,
				...(identity ?? {}),
			} as never,
		});
		expect(postFix.ok).toBe(true);
	});
});
