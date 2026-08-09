import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import { TOOL_NAMES } from '../../../src/tools/tool-metadata.js';
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
			// retrieve_summary carries prWorkflow {modes:[PR_REVIEW,PR_FEEDBACK],
			// capability:'observe'}. Without that tag the fallback name classifier
			// rejects it — the name splits on `_` into `retrieve` and `summary`,
			// and neither is a recognized read verb — which would silently break
			// the recovery path that summarized outputs point at.
			['retrieve_summary', { id: 'S1' }],
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
		// retrieve_summary declares BOTH modes, so the PR_FEEDBACK arm needs its
		// own assertion — the PR_REVIEW admit table above cannot cover it.
		await expect(
			enforcePrWorkflowToolBefore(
				tempDir,
				feedbackSessionId,
				'retrieve_summary',
				{ id: 'S1' },
			),
		).resolves.toBeUndefined();
	});

	test('names the PR_FEEDBACK controller surface on the unclassified-tool throw', async () => {
		const feedbackSessionId = `${SESSION_ID}-feedback-surface`;
		await activatePrWorkflow(tempDir, feedbackSessionId, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		// describePrWorkflowControllerToolNames takes a mode, but its only call
		// site sat inside the PR_REVIEW branch, leaving the PR_FEEDBACK arm of
		// its ternary unreachable while this throw named bare categories. The
		// mode-specific string is the guard: a hardcoded 'PR_REVIEW' argument at
		// the new call site would render the wrong mode name and fail here.
		const message = await enforcePrWorkflowToolBefore(
			tempDir,
			feedbackSessionId,
			'write_pr_review_artifact',
			{ kind: 'findings' },
		).then(
			() => 'ALLOWED',
			(error: unknown) =>
				error instanceof Error ? error.message : String(error),
		);
		expect(message).toContain('unclassified plugin/MCP tools');
		expect(message).toContain('Allowed controller tools for PR_FEEDBACK:');
		expect(message).toContain('pr_workflow_status');
	});

	// Parity guard, same principle as the hint/classifier test in
	// pr-workflow-gate-shell-wrappers.test.ts: a recovery hint that advertises a
	// tool which does not exist is worse than no hint, because a blocked agent
	// follows it, gets unknown-tool, and burns a turn. `get_async_result` and
	// `get_async_status` were exactly that — members of the controller set with
	// no registration, harmless while the set was internal and model-visible the
	// moment these messages started enumerating it.
	test('every advertised controller tool is a really registered tool', async () => {
		for (const mode of ['PR_REVIEW', 'PR_FEEDBACK'] as const) {
			const sessionId = `${SESSION_ID}-${mode}-surface`;
			await activatePrWorkflow(tempDir, sessionId, mode, {
				prHeadSha: HEAD_SHA,
			});
			const message = await enforcePrWorkflowToolBefore(
				tempDir,
				sessionId,
				'definitely_not_a_real_tool',
				{},
			).then(
				() => 'ALLOWED',
				(error: unknown) =>
					error instanceof Error ? error.message : String(error),
			);
			const advertised = message
				.slice(message.indexOf(`Allowed controller tools for ${mode}:`))
				.replace(`Allowed controller tools for ${mode}:`, '')
				.split('.')[0]
				.split(',')
				.map((name) => name.trim())
				.filter(Boolean);
			expect(advertised.length).toBeGreaterThan(0);
			for (const name of advertised) {
				expect(TOOL_NAMES).toContain(name);
			}
		}
	});
});
