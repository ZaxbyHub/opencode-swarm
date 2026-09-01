import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { executeSubmitPrReviewResult } from '../../../src/tools/submit-pr-review-result.js';
import { executeAuthorizePrReviewReentry } from '../../../src/tools/authorize-pr-review-reentry.js';
import { executeAbortPrWorkflow } from '../../../src/tools/abort-pr-workflow.js';
import {
	_test_exports,
	activatePrWorkflow,
	bindPrReviewBase,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

/**
 * Issue #2385 registered-path matrix (unit-level rows; PR-visible CI). Every
 * row drives a REGISTERED tool execute path rather than reducer internals.
 *
 * Companion rows live in the replay corpus and the dedicated suites:
 * - review depth S/M/L: dispatch-lanes-pr-review-tier-l* suites + prompt
 *   budget suites;
 * - COMPLETE/PARTIAL/NO_COVERAGE: replay-corpus-coverage.test.ts;
 * - circuit open/half-open/recovery: replay-corpus-circuit.test.ts and the
 *   dispatch-lanes-pr-review-resilience-v2-probe suite;
 * - structured capability present/absent: dispatch-lanes-structured-adapter
 *   .test.ts (adapter absent → child submit baseline; unsupported error →
 *   fallback; provider failure after start → no double dispatch).
 * - observer transport rows: replay-corpus-observer.test.ts.
 *
 * This file covers: submit baseline validation, re-entry authorization
 * issuance/consumption boundaries, and the armed-recovery abort path.
 */

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveWorkingTreeClean = _test_exports.resolveIsWorkingTreeClean;
const originalResolveWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-matrix-');
	await initializeGitRepository(directory);
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

function validSubmitArgs(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		batchId: 'matrix-batch',
		laneId: 'matrix-lane',
		revisionDigest: 'd'.repeat(64),
		result: {
			schemaVersion: 1,
			outcome: 'CLEAN',
			creditedLanes: ['intent-architecture'],
			findings: [],
			cleanAttestations: [
				{
					workflowLane: 'intent-architecture',
					coverageScope: 'Reviewed the complete changed architecture surface.',
					evidence:
						'No reachable architecture defect remains in the bound diff.',
				},
			],
			unresolved: [],
		},
	};
}

describe('registered-path matrix: submit baseline (submit_pr_review_result)', () => {
	test('a structurally valid submission without an exact child delegation fails closed (no state published)', async () => {
		const result = JSON.parse(
			await executeSubmitPrReviewResult(validSubmitArgs(), directory, {
				sessionID: 'matrix-child-session',
			}),
		) as { success: boolean; reason?: string };
		expect(result.success).toBe(false);
		expect(result.reason).toContain('exact child delegation');
		const state = await readPrWorkflowGateState(
			directory,
			'matrix-child-session',
		);
		expect(state).toBeNull();
	});

	test('malformed risk metadata is rejected before durable submission', async () => {
		const args = validSubmitArgs();
		args.result = {
			...(args.result as Record<string, unknown>),
			outcome: 'FINDINGS',
			findings: [
				{
					id: 'matrix-finding',
					workflowLane: 'intent-architecture',
					severity: 'MEDIUM',
					riskImpact: 'ORDINARY',
					riskTags: ['NOT_A_TAG'],
					title: 'Unknown tag',
					body: 'Rejected at the public validation boundary.',
					evidence: 'The closed risk-tag vocabulary rejects this.',
					location: { kind: 'local', file: 'src/x.ts', line: 1 },
				},
			],
		};
		const result = JSON.parse(
			await executeSubmitPrReviewResult(args, directory, {
				sessionID: 'matrix-child-session',
			}),
		) as { success: boolean; message?: string };
		expect(result.success).toBe(false);
	});
});

describe('registered-path matrix: re-entry authorization (authorize_pr_review_reentry)', () => {
	test('issuance requires an active PR_REVIEW workflow bound to the declared head', async () => {
		const result = JSON.parse(
			await executeAuthorizePrReviewReentry(
				{
					pr_head_sha: PR_ARTIFACT_HEAD_SHA,
					role: 'reviewer',
				},
				directory,
				{ sessionID: PR_ARTIFACT_SESSION_ID },
			),
		) as { success: boolean; message?: string };
		expect(result.success).toBe(false);
	});

	test('with an active bound workflow, issuance succeeds and is one-use bounded', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		await bindPrReviewBase(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			baseRef: 'origin/main',
			baseSha: 'def456',
		});
		const first = JSON.parse(
			await executeAuthorizePrReviewReentry(
				{ pr_head_sha: PR_ARTIFACT_HEAD_SHA, role: 'reviewer' },
				directory,
				{ sessionID: PR_ARTIFACT_SESSION_ID },
			),
		) as { success: boolean; message?: string; authorization_id?: string };
		expect(first.success).toBe(true);

		// No stockpiling: a second unconsumed authorization for the same role
		// and generation is refused.
		const second = JSON.parse(
			await executeAuthorizePrReviewReentry(
				{ pr_head_sha: PR_ARTIFACT_HEAD_SHA, role: 'reviewer' },
				directory,
				{ sessionID: PR_ARTIFACT_SESSION_ID },
			),
		) as { success: boolean; message?: string };
		expect(second.success).toBe(false);
	});
});

describe('registered-path matrix: abort path (abort_pr_workflow)', () => {
	test('abort of an inactive session reports no active workflow without inventing state', async () => {
		const result = JSON.parse(
			await executeAbortPrWorkflow({ mode: 'PR_REVIEW' }, directory, {
				sessionID: 'matrix-no-active',
			}),
		) as { success: boolean; message?: string };
		expect(result.success).toBe(false);
		const state = await readPrWorkflowGateState(directory, 'matrix-no-active');
		expect(state).toBeNull();
	});
});
