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
	rollbackPrReviewBaseAdmissionIfUnlaunched,
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
	directory = canonicalMkdtemp('pr-artifact-partial-base-adversarial-');
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

async function establishFivePlusOne(
	options: { typedFailure?: boolean; successfulCount?: number } = {},
): Promise<{
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
	const successfulDimensions = PR_REVIEW_BASE_DIMENSION_IDS.slice(
		0,
		options.successfulCount ?? 5,
	);
	const failedDimensions = PR_REVIEW_BASE_DIMENSION_IDS.slice(
		successfulDimensions.length,
	);
	const missingDimension = failedDimensions[0]!;
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
	for (const [index, workflowLane] of failedDimensions.entries()) {
		const batchId = `base-failed-${index}`;
		const failedLanes = [{ laneId: `failed-${workflowLane}`, workflowLane }];
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			failedLanes,
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
			failedLanes,
			options.typedFailure === false
				? { status: 'error' }
				: { status: 'error', workflowLaneFailureClass: 'contract' },
		);
	}
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

describe('write_pr_review_artifact partial base coverage adversarial cases (#2350)', () => {
	test('rolls back an unlaunched contract retry so it can be admitted again', async () => {
		const { missingDimension } = await establishFivePlusOne();
		const retry = { laneId: 'contract-retry', workflowLane: missingDimension };
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			[retry],
			{
				batchId: 'contract-unlaunched',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewContractRetry: true,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		expect(
			await rollbackPrReviewBaseAdmissionIfUnlaunched(
				directory,
				PR_ARTIFACT_SESSION_ID,
				'contract-unlaunched',
				true,
			),
		).toBe(true);
		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(state?.prReviewContractRetryDimensions).toBeUndefined();
		await expect(
			enforcePrReviewBaseDimensions(
				directory,
				PR_ARTIFACT_SESSION_ID,
				[retry],
				{
					batchId: 'contract-retry-again',
					prHeadSha: PR_ARTIFACT_HEAD_SHA,
					prReviewContractRetry: true,
					prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
				},
			),
		).resolves.toBeDefined();
	});

	test('rejects partial admission while the missing dimension is still in flight', async () => {
		const { missingDimension, records } = await establishFivePlusOne();
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			[{ laneId: 'retry-in-flight', workflowLane: missingDimension }],
			{
				batchId: 'retry-in-flight',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewContractRetry: true,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			'retry-in-flight',
			'swarm-pr-review:base',
			[{ laneId: 'retry-in-flight', workflowLane: missingDimension }],
			{ status: 'running' },
		);
		const result = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'in-flight-run',
					pr_head_sha: PR_ARTIFACT_HEAD_SHA,
					boundary: 'post_explorer',
					records,
					partial_base_coverage: { missing_dimension: missingDimension },
				},
				directory,
				{ sessionID: PR_ARTIFACT_SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('still has an in-flight lane');
	});

	test('rejects partial admission without a typed terminal failure', async () => {
		const { missingDimension, records } = await establishFivePlusOne({
			typedFailure: false,
		});
		const result = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'untyped-run',
					pr_head_sha: PR_ARTIFACT_HEAD_SHA,
					boundary: 'post_explorer',
					records,
					partial_base_coverage: { missing_dimension: missingDimension },
				},
				directory,
				{ sessionID: PR_ARTIFACT_SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('lacks a typed terminal failure');
	});

	test('fails closed when an admitted disclosure is tampered with', async () => {
		const { missingDimension, records } = await establishFivePlusOne();
		await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: 'tamper-run',
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				boundary: 'post_explorer',
				records,
				partial_base_coverage: { missing_dimension: missingDimension },
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		const disclosurePath = path.join(
			directory,
			'.swarm',
			'pr-review',
			'tamper-run',
			'coverage-disclosure.json',
		);
		const disclosure = JSON.parse(await fs.readFile(disclosurePath, 'utf8'));
		disclosure.failureClass = 'resource';
		await fs.writeFile(disclosurePath, JSON.stringify(disclosure, null, 2));
		await expect(
			assertPrReviewBaseCoverageSettled(directory, PR_ARTIFACT_SESSION_ID),
		).rejects.toThrow('disclosure digest does not match durable state');
	});

	test('rejects four-of-six coverage even when a missing dimension is named', async () => {
		const { missingDimension, records } = await establishFivePlusOne({
			successfulCount: 4,
		});
		const result = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'four-of-six-run',
					pr_head_sha: PR_ARTIFACT_HEAD_SHA,
					boundary: 'post_explorer',
					records,
					partial_base_coverage: { missing_dimension: missingDimension },
				},
				directory,
				{ sessionID: PR_ARTIFACT_SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('exactly five successful dimensions');
		expect(result.message).toContain('actual missing:');
	});

	test('rejects a colliding disclosure path instead of overwriting it', async () => {
		const { missingDimension, records } = await establishFivePlusOne();
		const collisionPath = path.join(
			directory,
			'.swarm',
			'pr-review',
			'collision-run',
			'coverage-disclosure.json',
		);
		await fs.mkdir(path.dirname(collisionPath), { recursive: true });
		await fs.writeFile(collisionPath, '{"foreign":true}', 'utf8');
		const result = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'collision-run',
					pr_head_sha: PR_ARTIFACT_HEAD_SHA,
					boundary: 'post_explorer',
					records,
					partial_base_coverage: { missing_dimension: missingDimension },
				},
				directory,
				{ sessionID: PR_ARTIFACT_SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('path already contains different content');
	});
});
