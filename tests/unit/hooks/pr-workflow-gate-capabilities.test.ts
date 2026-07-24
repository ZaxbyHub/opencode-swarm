import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

describe('PR workflow explicit capability contract', () => {
	beforeEach(() => {
		setupPrWorkflowGateFixtures();
		// This suite's RT-001 regression targets a distinct bound branch name
		// ("feature/pr-head") from the shared fixture default, so it layers its
		// own upstream-push-target override on top of the shared setup.
		_test_exports.resolveCurrentUpstreamPushTarget = () => ({
			remoteName: 'origin',
			remoteBranchRef: 'refs/heads/feature/pr-head',
			remoteTrackingRef: 'refs/remotes/origin/feature/pr-head',
		});
	});
	afterEach(teardownPrWorkflowGateFixtures);

	test('admits required PR_REVIEW observation and safe validation tools', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		for (const [toolName, args] of [
			['skill', { name: 'swarm-pr-review' }],
			['gh_evidence', { kind: 'pr', number: 123 }],
			['pr_workflow_status', {}],
			['gitingest', { repo: 'owner/repo' }],
			['retrieve_lane_output', { output_ref: 'lane-output-ref' }],
			['parse_lane_candidates', { output_ref: 'lane-output-ref' }],
			[
				'write_pr_review_artifact',
				{
					kind: 'findings',
					run_id: 'review-run',
					pr_head_sha: HEAD_SHA,
				},
			],
			['test_runner', { files: ['tests/focused.test.ts'] }],
			['lint', { mode: 'check' }],
		] as const) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, SESSION_ID, toolName, args),
			).resolves.toBeUndefined();
		}
	});

	test('keeps mutation-capable modes and mode-specific controllers fail-closed', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		await expect(
			enforcePrWorkflowToolBefore(tempDir, SESSION_ID, 'lint', {
				mode: 'fix',
			}),
		).rejects.toThrow(/read-only and fail-closed/i);
		await expect(
			enforcePrWorkflowToolBefore(
				tempDir,
				SESSION_ID,
				'prepare_pr_feedback_scope',
				{ task_id: '1.1', files: ['src/index.ts'] },
			),
		).rejects.toThrow(/read-only and fail-closed/i);
		await expect(
			enforcePrWorkflowToolBefore(
				tempDir,
				SESSION_ID,
				'mcp__github__get_pull_request',
				{ method: 'POST', body: { title: 'changed' } },
			),
		).rejects.toThrow(/read-only and fail-closed/i);
	});

	test('RT-001 regression: permits only the exact bound post-bind tracking fetch', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		await expect(
			enforcePrWorkflowToolBefore(tempDir, SESSION_ID, 'shell', {
				command: 'git fetch origin feature/pr-head',
			}),
		).resolves.toBeUndefined();
		for (const command of [
			'git fetch untrusted-remote feature/pr-head',
			'git fetch origin unrelated-branch',
			'git fetch --force origin feature/pr-head',
			'git fetch origin feature/pr-head:local-copy',
			'git fetch origin feature/pr-head && git checkout feature/pr-head',
			'git checkout feature/pr-head',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, SESSION_ID, 'shell', {
					command,
				}),
			).rejects.toThrow(/read-only and fail-closed/i);
		}
	});

	test('PWR-001 regression: blocks build_check because it can execute PR-controlled scripts', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		await expect(
			enforcePrWorkflowToolBefore(tempDir, SESSION_ID, 'build_check', {
				scope: 'all',
			}),
		).rejects.toThrow(/read-only and fail-closed/i);
	});

	test('admits the dedicated scope controller only in PR_FEEDBACK', async () => {
		const feedbackSessionId = `${SESSION_ID}-feedback`;
		await activatePrWorkflow(tempDir, feedbackSessionId, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		await expect(
			enforcePrWorkflowToolBefore(
				tempDir,
				feedbackSessionId,
				'prepare_pr_feedback_scope',
				{ task_id: '1.1', files: ['src/index.ts'] },
			),
		).rejects.toThrow(/verification/i);
		await expect(
			enforcePrWorkflowToolBefore(
				tempDir,
				feedbackSessionId,
				'write_pr_review_artifact',
				{ kind: 'findings' },
			),
		).rejects.toThrow(/unclassified plugin\/MCP tools/i);
	});
});
