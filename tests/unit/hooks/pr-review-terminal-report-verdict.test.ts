import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	_test_exports,
	activatePrWorkflow,
	allowedPrReviewReportVerdicts,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
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
const originalResolveWorkingTreeClean = _test_exports.resolveIsWorkingTreeClean;
const originalResolveWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(() => {
	directory = canonicalMkdtemp('pr-terminal-verdict-');
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
	await fs.rm(directory, { recursive: true, force: true });
});

async function establishFullCoverage(): Promise<void> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
	});
	const lanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: `ok-${workflowLane}`,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(
		directory,
		PR_ARTIFACT_SESSION_ID,
		lanes,
		{
			batchId: 'base-all',
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
	await persistPrReviewBatch(
		directory,
		'base-all',
		'swarm-pr-review:base',
		lanes,
	);
}

async function establishZeroCoverage(): Promise<void> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
	});
	for (const [index, workflowLane] of PR_REVIEW_BASE_DIMENSION_IDS.entries()) {
		const batchId = `base-failed-${index}`;
		const lanes = [{ laneId: `failed-${workflowLane}`, workflowLane }];
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			lanes,
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
			lanes,
			{ status: 'error', workflowLaneFailureClass: 'contract' },
		);
	}
}

async function establishPartialCoverage(): Promise<void> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
	});
	const successful = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 4);
	const lanes = successful.map((workflowLane) => ({
		laneId: `ok-${workflowLane}`,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(
		directory,
		PR_ARTIFACT_SESSION_ID,
		lanes,
		{
			batchId: 'base-partial',
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
	await persistPrReviewBatch(
		directory,
		'base-partial',
		'swarm-pr-review:base',
		lanes,
	);
}

describe('terminal report verdict enforcement (issue #2383)', () => {
	test('allowedPrReviewReportVerdicts matches the coverage-kind matrix', () => {
		expect([...allowedPrReviewReportVerdicts('COMPLETE')]).toEqual([
			'APPROVE',
			'REQUEST_CHANGES',
			'INCOMPLETE',
		]);
		expect([...allowedPrReviewReportVerdicts('PARTIAL')]).toEqual([
			'REQUEST_CHANGES',
			'INCOMPLETE',
		]);
		expect([...allowedPrReviewReportVerdicts('NO_COVERAGE')]).toEqual([
			'INCOMPLETE',
		]);
	});

	test('PR_REVIEW completion requires a report_verdict', async () => {
		await establishFullCoverage();
		await expect(
			completePrWorkflow(
				directory,
				PR_ARTIFACT_SESSION_ID,
				'PR_REVIEW',
				PR_ARTIFACT_HEAD_SHA,
			),
		).rejects.toThrow('requires a terminal report_verdict');
	});

	test('NO_COVERAGE completion is forced INCOMPLETE and completes without the findings ladder', async () => {
		await establishZeroCoverage();
		await expect(
			completePrWorkflow(
				directory,
				PR_ARTIFACT_SESSION_ID,
				'PR_REVIEW',
				PR_ARTIFACT_HEAD_SHA,
				{
					reportVerdict: 'APPROVE',
				},
			),
		).rejects.toThrow('must report verdict INCOMPLETE');
		await expect(
			completePrWorkflow(
				directory,
				PR_ARTIFACT_SESSION_ID,
				'PR_REVIEW',
				PR_ARTIFACT_HEAD_SHA,
				{
					reportVerdict: 'REQUEST_CHANGES',
				},
			),
		).rejects.toThrow('must report verdict INCOMPLETE');
		const status = await completePrWorkflow(
			directory,
			PR_ARTIFACT_SESSION_ID,
			'PR_REVIEW',
			PR_ARTIFACT_HEAD_SHA,
			{ reportVerdict: 'INCOMPLETE' },
		);
		expect(status).toBe('completed');
		// The gate cleared (terminal NO_COVERAGE report) and one bounded audit
		// event was appended.
		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(state).toBeNull();
		const events = await fs.readFile(
			`${directory}/.swarm/events.jsonl`,
			'utf8',
		);
		expect(events).toContain('"pr_review_no_coverage_terminal"');
		// The durable v2 settlement disclosure was persisted before the clear
		// (reviewer finding: the NO_COVERAGE kind must be provable from the
		// immutable artifact, not only the audit line).
		const eventLine = events
			.split('\n')
			.find((line) => line.includes('pr_review_no_coverage_terminal'));
		expect(eventLine).toBeTruthy();
		const { disclosureRunId } = JSON.parse(eventLine!) as {
			disclosureRunId: string;
		};
		const disclosure = JSON.parse(
			await fs.readFile(
				`${directory}/.swarm/pr-review/${disclosureRunId}/coverage-disclosure.json`,
				'utf8',
			),
		) as { schemaVersion: number; unresolvedDimensions: unknown[] };
		expect(disclosure.schemaVersion).toBe(2);
		expect(disclosure.unresolvedDimensions).toHaveLength(6);
	});

	test('PARTIAL completion rejects APPROVE before the terminal ladder', async () => {
		await establishPartialCoverage();
		await expect(
			completePrWorkflow(
				directory,
				PR_ARTIFACT_SESSION_ID,
				'PR_REVIEW',
				PR_ARTIFACT_HEAD_SHA,
				{
					reportVerdict: 'APPROVE',
				},
			),
		).rejects.toThrow(
			/PARTIAL completion allows report_verdict REQUEST_CHANGES \| INCOMPLETE/,
		);
	});
});
