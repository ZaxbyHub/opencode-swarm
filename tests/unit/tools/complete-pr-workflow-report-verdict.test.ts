import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	_test_exports,
	activatePrWorkflow,
	allowedPrReviewReportVerdicts,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeCompletePrWorkflow } from '../../../src/tools/complete-pr-workflow.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(() => {
	directory = canonicalMkdtemp('complete-verdict-tool-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveWorkingTreeCleanAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

const args = (reportVerdict?: string) => ({
	mode: 'PR_REVIEW' as const,
	pr_head_sha: PR_ARTIFACT_HEAD_SHA,
	...(reportVerdict ? { report_verdict: reportVerdict } : {}),
});

describe('complete_pr_workflow tool report_verdict (issue #2383)', () => {
	test('schema: PR_REVIEW completion without report_verdict is rejected', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		const raw = await executeCompletePrWorkflow(args(), directory, {
			sessionID: PR_ARTIFACT_SESSION_ID,
		});
		const result = JSON.parse(raw);
		expect(result.success).toBe(false);
		expect(result.message).toContain('report_verdict');
	});

	test('schema: an out-of-vocabulary verdict is rejected', async () => {
		const raw = await executeCompletePrWorkflow(
			args('SHIP_IT') as unknown as Record<string, unknown>,
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(JSON.parse(raw).success).toBe(false);
	});

	test('NO_COVERAGE with INCOMPLETE succeeds and carries the truthful terminal_report', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		const raw = await executeCompletePrWorkflow(args('INCOMPLETE'), directory, {
			sessionID: PR_ARTIFACT_SESSION_ID,
		});
		const result = JSON.parse(raw);
		expect(result.success).toBe(true);
		expect(result.status).toBe('completed');
		expect(result.terminal_report).toMatchObject({
			kind: 'NO_COVERAGE',
			covered_dimensions: [],
			report_verdict: 'INCOMPLETE',
		});
		expect(result.terminal_report.unresolved_dimensions).toHaveLength(6);
		expect(result.terminal_report.allowed_verdicts).toEqual([
			...allowedPrReviewReportVerdicts('NO_COVERAGE'),
		]);
	});

	test('NO_COVERAGE with APPROVE is blocked by the gate rule', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		const raw = await executeCompletePrWorkflow(args('APPROVE'), directory, {
			sessionID: PR_ARTIFACT_SESSION_ID,
		});
		const result = JSON.parse(raw);
		expect(result.success).toBe(false);
		expect(result.message).toContain('must report verdict INCOMPLETE');
	});

	test('PR_FEEDBACK mode ignores report_verdict entirely', async () => {
		const raw = await executeCompletePrWorkflow(
			{
				mode: 'PR_FEEDBACK',
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		// Reaches the gate (fails on state, not on schema): the schema accepted
		// the PR_FEEDBACK call without report_verdict.
		const result = JSON.parse(raw);
		expect(result.success).toBe(false);
		expect(result.message).not.toContain('report_verdict');
	});
});
