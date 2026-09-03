import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	_test_exports,
	activatePrWorkflow,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	authorize_pr_review_reentry,
	executeAuthorizePrReviewReentry,
} from '../../../src/tools/authorize-pr-review-reentry.js';
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

beforeEach(() => {
	directory = canonicalMkdtemp('authorize-reentry-tool-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('authorize_pr_review_reentry tool (issue #2383)', () => {
	test('is registered with the canonical tool name and arg schema', () => {
		// The manifest/metadata coherence is enforced by check-tool-registration;
		// this pins the handler export and its createSwarmTool shape.
		expect(typeof executeAuthorizePrReviewReentry).toBe('function');
		expect(authorize_pr_review_reentry).toBeTruthy();
	});

	test('rejects malformed args', async () => {
		const raw = await executeAuthorizePrReviewReentry(
			{ pr_head_sha: PR_ARTIFACT_HEAD_SHA, role: 'architect' },
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(JSON.parse(raw).success).toBe(false);
	});

	test('rejects a valid-but-wrong abbreviated head SHA against the exact binding', async () => {
		const raw = await executeAuthorizePrReviewReentry(
			{ pr_head_sha: 'abcdef0', role: 'reviewer' },
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		const result = JSON.parse(raw) as { success: boolean; message?: string };
		expect(result.success).toBe(false);
		expect(result.message).toContain('active PR_REVIEW workflow');
	});

	test('rejects a missing sessionID', async () => {
		const raw = await executeAuthorizePrReviewReentry(
			{ pr_head_sha: PR_ARTIFACT_HEAD_SHA, role: 'reviewer' },
			directory,
			{},
		);
		expect(JSON.parse(raw).message).toContain('sessionID');
	});

	test('issues a one-use authorization bound to the active workflow', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		const raw = await executeAuthorizePrReviewReentry(
			{ pr_head_sha: PR_ARTIFACT_HEAD_SHA, role: 'reviewer' },
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		const result = JSON.parse(raw);
		expect(result.success).toBe(true);
		expect(result.role).toBe('reviewer');
		expect(result.pr_head_sha).toBe(PR_ARTIFACT_HEAD_SHA);
		expect(result.authorization_id).toBeTruthy();
		expect(result.expires_at).toBeTruthy();
		expect(result.instructions).toContain(
			'direct subagent_type Task call with role "reviewer"',
		);
	});

	test('fails when no active PR_REVIEW gate exists', async () => {
		const raw = await executeAuthorizePrReviewReentry(
			{ pr_head_sha: PR_ARTIFACT_HEAD_SHA, role: 'reviewer' },
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(JSON.parse(raw).success).toBe(false);
	});
});
