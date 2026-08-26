import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	assertPrReviewBaseCoverageSettled,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
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
	directory = canonicalMkdtemp('pr-artifact-partial-base-');
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

async function establishFivePlusOne(): Promise<{
	missingDimension: (typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];
	records: Array<{
		finding_id: string;
		status: 'PENDING';
		file_line: string;
		evidence: string;
		next_action: 'route_to_reviewer';
		severity: 'HIGH';
	}>;
}> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
	});
	const successfulDimensions = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 5);
	const missingDimension = PR_REVIEW_BASE_DIMENSION_IDS[5];
	const successfulLanes = successfulDimensions.map((workflowLane) => ({
		laneId: `ok-${workflowLane}`,
		workflowLane,
	}));
	const failedLanes = [
		{ laneId: `failed-${missingDimension}`, workflowLane: missingDimension },
	];
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
	await enforcePrReviewBaseDimensions(
		directory,
		PR_ARTIFACT_SESSION_ID,
		failedLanes,
		{
			batchId: 'base-failed-one',
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
	await persistPrReviewBatch(
		directory,
		'base-failed-one',
		'swarm-pr-review:base',
		failedLanes,
		{ status: 'error', workflowLaneFailureClass: 'contract' },
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

describe('write_pr_review_artifact partial base coverage (#2350)', () => {
	test('admits one contract-only retry without consuming staged attempts', async () => {
		const { missingDimension } = await establishFivePlusOne();
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			[{ laneId: 'contract-retry', workflowLane: missingDimension }],
			{
				batchId: 'contract-retry',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewContractRetry: true,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(state?.prReviewContractRetryDimensions).toEqual([missingDimension]);
		expect(state?.prReviewResilience?.attempts ?? []).toHaveLength(0);
		await expect(
			enforcePrReviewBaseDimensions(
				directory,
				PR_ARTIFACT_SESSION_ID,
				[{ laneId: 'duplicate-retry', workflowLane: missingDimension }],
				{
					batchId: 'duplicate-contract-retry',
					prHeadSha: PR_ARTIFACT_HEAD_SHA,
					prReviewContractRetry: true,
					prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
				},
			),
		).rejects.toThrow('was already admitted');
	});

	test('admits five-of-six at post_explorer and persists an immutable disclosure', async () => {
		const { missingDimension, records } = await establishFivePlusOne();
		await expect(
			assertPrReviewBaseCoverageSettled(directory, PR_ARTIFACT_SESSION_ID),
		).rejects.toThrow(`missing dimensions: ${missingDimension}`);

		const raw = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: 'partial-run',
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				boundary: 'post_explorer',
				records,
				partial_base_coverage: { missing_dimension: missingDimension },
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		const result = JSON.parse(raw);
		expect(result).toMatchObject({
			success: true,
			partial_base_coverage: {
				missing_dimension: missingDimension,
				failure_class: 'contract',
				path: 'pr-review/partial-run/coverage-disclosure.json',
				digest: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		});
		await expect(
			assertPrReviewBaseCoverageSettled(directory, PR_ARTIFACT_SESSION_ID),
		).resolves.toMatchObject({ prHeadSha: PR_ARTIFACT_HEAD_SHA });

		_test_exports.resetTrackedStateCache();
		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(state?.prReviewPartialBaseCoverage).toMatchObject({
			runId: 'partial-run',
			missingDimension,
			failureClass: 'contract',
		});
		const disclosurePath = path.join(
			directory,
			'.swarm',
			'pr-review',
			'partial-run',
			'coverage-disclosure.json',
		);
		expect(JSON.parse(await fs.readFile(disclosurePath, 'utf8'))).toEqual(
			state?.prReviewPartialBaseCoverage,
		);

		const replay = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'partial-run',
					pr_head_sha: PR_ARTIFACT_HEAD_SHA,
					boundary: 'post_explorer',
					records,
					partial_base_coverage: { missing_dimension: missingDimension },
				},
				directory,
				{ sessionID: PR_ARTIFACT_SESSION_ID },
			),
		);
		expect(replay).toMatchObject({ success: true, replayed: true });
	});

	test('rejects a mismatched missing dimension and non-post-explorer use', async () => {
		const { records } = await establishFivePlusOne();
		const wrong = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: 'wrong-dimension',
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				boundary: 'post_explorer',
				records,
				partial_base_coverage: {
					missing_dimension: PR_REVIEW_BASE_DIMENSION_IDS[0],
				},
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(wrong).toContain('actual missing');

		const wrongBoundary = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: 'wrong-boundary',
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				boundary: 'post_reviewer',
				records,
				partial_base_coverage: {
					missing_dimension: PR_REVIEW_BASE_DIMENSION_IDS[5],
				},
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(wrongBoundary).toContain(
			'is valid only for the post_explorer boundary',
		);
	});

	test('does not persist admission when later artifact predicates reject the write', async () => {
		const { missingDimension, records } = await establishFivePlusOne();
		const rejected = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: 'rejected-partial',
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				boundary: 'post_explorer',
				records: [
					{ ...records[0]!, finding_id: 'FOREIGN' },
					...records.slice(1),
				],
				partial_base_coverage: { missing_dimension: missingDimension },
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(JSON.parse(rejected).success).toBe(false);
		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(state?.prReviewPartialBaseCoverage).toBeUndefined();
		await expect(
			fs.stat(
				path.join(
					directory,
					'.swarm',
					'pr-review',
					'rejected-partial',
					'coverage-disclosure.json',
				),
			),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
