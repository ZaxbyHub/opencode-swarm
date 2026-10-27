import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	admitPrReviewPartialBaseCoverage,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

// ACCEPTANCE CHECK AC12 (PRESERVING — GREEN at base and at head).
//
// Contract under test: the AC11 supersession path is keyed on the
// (dimension, terminalState, failureClass) TUPLE. When the re-run's tuple
// DIFFERS from the admitted disclosure — here the disclosed sixth dimension
// is FAILED/resource and the re-run settles FAILED/contract — re-admission
// must still throw
// 'BLOCKED: partial base coverage admission differs from the immutable
//  existing disclosure'
// with NO supersession: the durable disclosure file stays byte-identical and
// no `pr_review_coverage_disclosure_superseded` event is appended.
//
// This file is deliberately green at BOTH ends: at base the exact-JSON
// compare already refuses any difference; after the fix the tuple compare
// still refuses a terminalState/failureClass difference. It pins that the
// fix cannot widen admission into a class-changing (truth-changing) rewrite.

const RUN_ID = 'ac12-differs-run';
const ATTEMPT_1 = {
	batchId: 'differs-fail-1',
	laneId: 'differs-lane-1',
	terminalEventId: 'fixture-terminal-differs-sub-1',
};
const ATTEMPT_2 = {
	batchId: 'differs-fail-2',
	laneId: 'differs-lane-2',
	terminalEventId: 'fixture-terminal-differs-sub-2',
};

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
	directory = canonicalMkdtemp('ac12-differs-');
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

/** One typed terminal lane failure for the dimension (one attempt). */
async function settleTypedFailure(
	dimension: BaseDimension,
	attempt: { batchId: string; laneId: string; terminalEventId: string },
	failureClass: 'resource' | 'contract',
): Promise<void> {
	const lane = { laneId: attempt.laneId, workflowLane: dimension };
	await enforcePrReviewBaseDimensions(
		directory,
		PR_ARTIFACT_SESSION_ID,
		[lane],
		{
			batchId: attempt.batchId,
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
	await persistPrReviewBatch(
		directory,
		attempt.batchId,
		'swarm-pr-review:base',
		[lane],
		{
			status: 'error',
			workflowLaneFailureClass: failureClass,
			subagentSessionId: attempt.terminalEventId.replace(
				'fixture-terminal-',
				'',
			),
		},
	);
}

/** Five covered dimensions plus a resource-class FAILED sixth (attempt 1). */
async function establishFivePlusOneResource(): Promise<{
	missingDimension: BaseDimension;
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
	await settleTypedFailure(missingDimension, ATTEMPT_1, 'resource');
	return { missingDimension };
}

describe('AC12: a tuple-differing re-admission is refused and the disclosure stays immutable', () => {
	test('re-run settles FAILED/contract while the disclosure says FAILED/resource: refusal, byte-identical file, no supersession event', async () => {
		const { missingDimension } = await establishFivePlusOneResource();
		await admitPrReviewPartialBaseCoverage(
			directory,
			PR_ARTIFACT_SESSION_ID,
			RUN_ID,
			[missingDimension],
		);
		const disclosurePath = path.join(
			directory,
			'.swarm',
			'pr-review',
			RUN_ID,
			'coverage-disclosure.json',
		);
		const before = await fs.readFile(disclosurePath, 'utf8');
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');

		// The re-run changes the derived tuple for the dimension:
		// FAILED/resource -> FAILED/contract.
		await settleTypedFailure(missingDimension, ATTEMPT_2, 'contract');
		await expect(
			admitPrReviewPartialBaseCoverage(
				directory,
				PR_ARTIFACT_SESSION_ID,
				RUN_ID,
				[missingDimension],
			),
		).rejects.toThrow('differs from the immutable existing disclosure');

		// No supersession happened: the durable file is byte-identical and no
		// supersession audit event was appended. The events log may not exist
		// at all in this fixture (nothing in it appended core events yet) —
		// absence is the strongest form of "no supersession event".
		const after = await fs.readFile(disclosurePath, 'utf8');
		expect(after).toBe(before);
		if (await fs.exists(eventsPath)) {
			const eventsAfter = await fs.readFile(eventsPath, 'utf8');
			expect(eventsAfter).not.toContain(
				'pr_review_coverage_disclosure_superseded',
			);
		}
	});
});
