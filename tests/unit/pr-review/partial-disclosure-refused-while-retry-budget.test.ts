import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
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

// ACCEPTANCE CHECK AC10 (DISCRIMINATING — RED at base, GREEN after the fix).
//
// Contract under test: `admitPrReviewPartialBaseCoverage` (the partial-base-
// coverage disclosure admission boundary) REFUSES to admit a disclosure while
// a CONTRACT-class FAILED dimension still has unconsumed retry budget —
// legacy policy: the dimension is not in
// `state.prReviewContractRetryDimensions`. The refusal names the dimension
// and tells the operator to re-dispatch via dispatch_lanes_async first.
// Resource-class and operator_cancelled dimensions are NOT refused by this
// check (they are not legacy-auto-retryable), so their admissions keep
// succeeding — the two control tests below pin that non-regression.
//
// RED at base: admission has no retry-budget check at all, so the
// contract-class admission RESOLVES and the expected-refusal assertion fails.
// GREEN after the fix: the admission rejects with the new BLOCKED message
// naming the dimension, while both non-contract controls still admit.

const RUN_ID = 'ac10-refusal-run';

type BaseDimension = (typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];
type TerminalFailureClass = 'contract' | 'resource' | 'operator_cancelled';

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
	directory = canonicalMkdtemp('ac10-refusal-');
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

/**
 * Five covered base dimensions plus a sixth settled terminally with the
 * requested typed failure class (the five-plus-one shape shared with
 * tests/unit/pr-review/cancel-completion-gate.test.ts). Legacy policy
 * everywhere; no retry budget is ever consumed, and
 * `prReviewContractRetryDimensions` stays unset.
 */
async function establishFivePlusOne(
	unresolvedClass: TerminalFailureClass,
): Promise<{ missingDimension: BaseDimension }> {
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
	const batchId = `base-failed-${unresolvedClass}`;
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
	// status 'error' settles the lane terminally FAILED with the typed class;
	// status 'cancelled' + operator_cancelled is the abandonment shape the
	// settlement suite already admits (issue #2971 fixtures).
	await persistPrReviewBatch(
		directory,
		batchId,
		'swarm-pr-review:base',
		[unresolvedLane],
		{
			status: unresolvedClass === 'operator_cancelled' ? 'cancelled' : 'error',
			workflowLaneFailureClass: unresolvedClass,
		},
	);
	return { missingDimension };
}

describe('AC10: partial-coverage admission refused while contract retry budget remains', () => {
	test('contract-class FAILED dimension with unconsumed legacy retry budget: admission rejects naming the dimension', async () => {
		const { missingDimension } = await establishFivePlusOne('contract');
		// Legacy budget: the dimension is NOT in prReviewContractRetryDimensions
		// (never seeded), so the single legacy contract retry is unconsumed.
		let refusal: Error | undefined;
		try {
			await admitPrReviewPartialBaseCoverage(
				directory,
				PR_ARTIFACT_SESSION_ID,
				RUN_ID,
				[missingDimension],
			);
		} catch (error) {
			refusal = error instanceof Error ? error : new Error(String(error));
		}
		expect(
			refusal,
			'admission must refuse while the contract retry budget is unconsumed (at base it resolves, which is the RED signature)',
		).toBeInstanceOf(Error);
		expect(refusal?.message).toMatch(
			/partial base coverage disclosure refused while contract retry budget remains/,
		);
		expect(refusal?.message).toContain(missingDimension);
		expect(refusal?.message).toContain('dispatch_lanes_async');
	});

	test('control: a resource-class FAILED dimension is never refused by the retry-budget check', async () => {
		const { missingDimension } = await establishFivePlusOne('resource');
		// Resolves both at base (no admission budget check) and after the fix
		// (resource is not legacy-auto-retryable, so no budget applies).
		await admitPrReviewPartialBaseCoverage(
			directory,
			PR_ARTIFACT_SESSION_ID,
			RUN_ID,
			[missingDimension],
		);
	});

	test('control: an operator_cancelled dimension is never refused by the retry-budget check', async () => {
		const { missingDimension } =
			await establishFivePlusOne('operator_cancelled');
		await admitPrReviewPartialBaseCoverage(
			directory,
			PR_ARTIFACT_SESSION_ID,
			RUN_ID,
			[missingDimension],
		);
	});
});
