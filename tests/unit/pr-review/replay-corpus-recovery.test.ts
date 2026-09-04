import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	_test_exports,
	activatePrWorkflow,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeAbortPrWorkflow } from '../../../src/tools/abort-pr-workflow.js';
import { executeAuthorizePrReviewReentry } from '../../../src/tools/authorize-pr-review-reentry.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2385 replay corpus — historical failure shapes 7-8 from tracker
 * #2380, replayed through REGISTERED tool paths:
 *
 *  7. armed publication recovery shape (pre-#2383): an armed workflow
 *     refused abort before force recovery was considered, wedging the
 *     project with no legal exit; recovery is now an explicit, exact-bound
 *     transition.
 *  8. direct Task reviewer re-entry shape (pre-#2383): re-entry bypassed
 *     via `MODE: PR_REVIEW` prompt inspection; it is now a one-use,
 *     exact-bound authorization issued by the controller tool.
 */

let directory = '';
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;

const ARMED_DIGEST = 'c'.repeat(64);

beforeEach(() => {
	directory = canonicalMkdtemp('pr-review-corpus-recovery-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
	_test_exports.resolvePrWorkflowRevisionDigest = () => ARMED_DIGEST;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveWorkingTreeCleanAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	await fs.rm(directory, { recursive: true, force: true });
});

async function armWorkflow(): Promise<{ generation: number; id: string }> {
	const state = await activatePrWorkflow(
		directory,
		PR_ARTIFACT_SESSION_ID,
		'PR_FEEDBACK',
		{ prHeadSha: PR_ARTIFACT_HEAD_SHA },
	);
	const armed = {
		...state,
		prFeedbackReadyToPublish: {
			revisionDigest: ARMED_DIGEST,
			localHead: PR_ARTIFACT_HEAD_SHA,
			remoteName: 'origin',
			remoteBranchRef: 'refs/heads/main',
			remoteRef: 'refs/remotes/origin/main',
			validatedAt: '2026-01-01T00:00:00.000Z',
		},
	};
	await writeAuthoritativePrWorkflowState(directory, armed);
	_test_exports.resetTrackedStateCache();
	return { generation: armed.revision, id: armed.workflowInstanceId ?? '' };
}

describe('replay corpus: armed publication recovery (#2380 shape 7)', () => {
	test('exact-binding armed recovery invalidates authorization and preserves the gate', async () => {
		const { generation, id } = await armWorkflow();
		const raw = await executeAbortPrWorkflow(
			{
				kind: 'armed_recovery',
				reason: 'revision diverged after arming',
				armed_recovery: {
					pr_head_sha: PR_ARTIFACT_HEAD_SHA,
					revision_digest: ARMED_DIGEST,
					generation,
					workflow_instance_id: id || undefined,
				},
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(JSON.parse(raw)).toMatchObject({
			success: true,
			armed_recovery: true,
			publication_authorization_invalidated: true,
			gate_preserved: true,
		});
	});

	test('a stale generation fails closed with the BLOCKED message', async () => {
		const { generation } = await armWorkflow();
		const raw = await executeAbortPrWorkflow(
			{
				kind: 'armed_recovery',
				reason: 'stale binding attempt',
				armed_recovery: {
					pr_head_sha: PR_ARTIFACT_HEAD_SHA,
					revision_digest: ARMED_DIGEST,
					generation: generation + 3,
				},
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		const result = JSON.parse(raw);
		expect(result.success).toBe(false);
		expect(result.message).toContain('generation mismatch');
	});

	test('ordinary recovery still refuses while armed (no accidental bypass)', async () => {
		await armWorkflow();
		const raw = await executeAbortPrWorkflow(
			{ kind: 'recovery', reason: 'ordinary recovery while armed' },
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		const result = JSON.parse(raw);
		expect(result.success).toBe(false);
		expect(result.message).toContain('armed for publication');
	});
});

describe('replay corpus: reviewer re-entry authorization (#2380 shape 8)', () => {
	test('a wrong-head issuance request fails closed (no prompt-text bypass exists)', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		const raw = await executeAuthorizePrReviewReentry(
			{ pr_head_sha: 'deadbeef99', role: 'reviewer' },
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		const result = JSON.parse(raw);
		expect(result.success).toBe(false);
		// The refusal names the ACTIVE binding — authorization derives from
		// bound state, never from prompt text.
		expect(result.message).toContain('active PR_REVIEW workflow');
	});
});
