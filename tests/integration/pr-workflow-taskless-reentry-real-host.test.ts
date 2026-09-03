import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { PluginConfig } from '../../src/config';
import { createDelegationGateHook } from '../../src/hooks/delegation-gate.js';
import {
	_test_exports,
	activatePrWorkflow,
} from '../../src/hooks/pr-workflow-gate.js';
import { issuePrReviewReentryAuthorization } from '../../src/pr-review/authorization.js';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../src/state.js';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host.js';

const SESSION_ID = 'pr-workflow-taskless-reentry';
const HEAD_SHA = 'abc123';
const REVISION_DIGEST = 'revision-test';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;
const originalResolveCurrentUpstreamPushTarget =
	_test_exports.resolveCurrentUpstreamPushTarget;
const originalResolveCurrentUpstreamPushTargetAsync =
	_test_exports.resolveCurrentUpstreamPushTargetAsync;
const originalResolveRemoteRefsContainingHead =
	_test_exports.resolveRemoteRefsContainingHead;
const originalResolveRemoteRefsContainingHeadAsync =
	_test_exports.resolveRemoteRefsContainingHeadAsync;

describe('PR workflow taskless re-entry stays standalone-only', () => {
	let directory: string;
	let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;

	beforeEach(async () => {
		resetSwarmState();
		_test_exports.resetTrackedStateCache();
		directory = createKnowledgeProject();
		plugin = await bootKnowledgeHost(directory);
		_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
		_test_exports.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
		_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
		_test_exports.resolveIsWorkingTreeClean = () => true;
		_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
		_test_exports.resolveCurrentUpstreamPushTarget = () => ({
			remoteName: 'origin',
			remoteBranchRef: 'refs/heads/pr-head',
			remoteTrackingRef: 'refs/remotes/origin/pr-head',
		});
		_test_exports.resolveCurrentUpstreamPushTargetAsync = async () =>
			_test_exports.resolveCurrentUpstreamPushTarget(directory);
		_test_exports.resolveRemoteRefsContainingHead = () => [
			'refs/remotes/origin/pr-head',
		];
		_test_exports.resolveRemoteRefsContainingHeadAsync = async () => [
			'refs/remotes/origin/pr-head',
		];
	});

	afterEach(() => {
		_test_exports.resetTrackedStateCache();
		_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
		_test_exports.resolveCurrentGitHeadAsync =
			originalResolveCurrentGitHeadAsync;
		_test_exports.resolvePrWorkflowRevisionDigest =
			originalResolveRevisionDigest;
		_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
		_test_exports.resolveIsWorkingTreeCleanAsync =
			originalResolveIsWorkingTreeCleanAsync;
		_test_exports.resolveCurrentUpstreamPushTarget =
			originalResolveCurrentUpstreamPushTarget;
		_test_exports.resolveCurrentUpstreamPushTargetAsync =
			originalResolveCurrentUpstreamPushTargetAsync;
		_test_exports.resolveRemoteRefsContainingHead =
			originalResolveRemoteRefsContainingHead;
		_test_exports.resolveRemoteRefsContainingHeadAsync =
			originalResolveRemoteRefsContainingHeadAsync;
		resetSwarmState();
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Windows may briefly retain a plugin-init handle in the temp project.
		}
	});

	test('plan-free taskless re-entry completes without plan-task state', async () => {
		const standaloneSessionID = 'pr-workflow-standalone-reentry';
		const standaloneDirectory = createKnowledgeProject();
		try {
			await activatePrWorkflow(
				standaloneDirectory,
				standaloneSessionID,
				'PR_REVIEW',
				{ prHeadSha: HEAD_SHA },
			);
			const issued = await issuePrReviewReentryAuthorization(
				standaloneDirectory,
				standaloneSessionID,
				{ prHeadSha: HEAD_SHA, role: 'reviewer' },
			);
			expect(issued.role).toBe('reviewer');
			const standaloneHook = createDelegationGateHook(
				{ hooks: { delegation_gate: true } } as PluginConfig,
				standaloneDirectory,
			);
			resetSwarmState();
			await standaloneHook.toolBefore(
				{
					tool: 'Task',
					sessionID: standaloneSessionID,
					callID: 'standalone-reviewer',
				},
				{
					args: {
						subagent_type: 'reviewer',
						prompt:
							'Review the bound PR without a plan task.\nACCEPTANCE: report the review result.',
					},
				},
			);
			await standaloneHook.toolAfter(
				{
					tool: 'Task',
					sessionID: standaloneSessionID,
					callID: 'standalone-reviewer',
					args: { subagent_type: 'reviewer' },
				},
				{
					status: 'completed',
					text: '[REVIEWED] | task-1.1 | APPROVED | standalone',
				},
			);
			expect([
				...(swarmState.agentSessions.get(standaloneSessionID)
					?.taskWorkflowStates ?? []),
			]).toHaveLength(0);
		} finally {
			rmSync(standaloneDirectory, { recursive: true, force: true });
		}
	});

	test('taskless re-entry refuses to guess when task workflow state exists', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const session = ensureAgentSession(SESSION_ID, 'architect', directory);
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		session.taskWorkflowStates.set('1.2', 'coder_delegated');
		const issued = JSON.parse(
			String(
				await plugin.tool.authorize_pr_review_reentry.execute(
					{ pr_head_sha: HEAD_SHA, role: 'reviewer' },
					{ directory, sessionID: SESSION_ID },
				),
			),
		) as { success: boolean };
		expect(issued.success).toBe(true);
		await expect(
			plugin.hooks['tool.execute.before'](
				{ tool: 'Task', sessionID: SESSION_ID, callID: 'ambiguous-reviewer' },
				{
					args: {
						subagent_type: 'reviewer',
						prompt: 'Review the patch.\nACCEPTANCE: report the review result.',
					},
				},
			),
		).rejects.toThrow(/TASK_WORKFLOW_TASK_ID_REQUIRED/);
	});

	test('taskless re-entry refuses when a plan exists before task state is loaded', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const session = ensureAgentSession(SESSION_ID, 'architect', directory);
		// The real host may hydrate task state during plugin startup; clear it to
		// model a plan-backed session whose task state has not been loaded yet.
		session.taskWorkflowStates.clear();
		expect(session.taskWorkflowStates.size).toBe(0);
		const issued = JSON.parse(
			String(
				await plugin.tool.authorize_pr_review_reentry.execute(
					{ pr_head_sha: HEAD_SHA, role: 'reviewer' },
					{ directory, sessionID: SESSION_ID },
				),
			),
		) as { success: boolean };
		expect(issued.success).toBe(true);
		await expect(
			plugin.hooks['tool.execute.before'](
				{ tool: 'Task', sessionID: SESSION_ID, callID: 'plan-backed-reviewer' },
				{
					args: {
						subagent_type: 'reviewer',
						prompt: 'Review the patch.\nACCEPTANCE: report the review result.',
					},
				},
			),
		).rejects.toThrow(/TASK_WORKFLOW_TASK_ID_REQUIRED/);
	});

	test('taskless re-entry waits for pending durable state before allowing standalone review', async () => {
		const pendingSessionID = 'pr-workflow-pending-rehydration';
		const pendingDirectory = createKnowledgeProject();
		try {
			await activatePrWorkflow(
				pendingDirectory,
				pendingSessionID,
				'PR_REVIEW',
				{
					prHeadSha: HEAD_SHA,
				},
			);
			const issued = await issuePrReviewReentryAuthorization(
				pendingDirectory,
				pendingSessionID,
				{ prHeadSha: HEAD_SHA, role: 'reviewer' },
			);
			expect(issued.role).toBe('reviewer');
			const pendingHook = createDelegationGateHook(
				{ hooks: { delegation_gate: true } } as PluginConfig,
				pendingDirectory,
			);
			const pendingSession = ensureAgentSession(pendingSessionID, 'architect');
			let releasePending!: () => void;
			const pendingRehydration = new Promise<void>((resolve) => {
				releasePending = () => {
					pendingSession.taskWorkflowStates.set('1.1', 'coder_delegated');
					resolve();
				};
			});
			swarmState.pendingRehydrations.add(pendingRehydration);
			const dispatchPromise = pendingHook.toolBefore(
				{
					tool: 'Task',
					sessionID: pendingSessionID,
					callID: 'pending-reviewer',
				},
				{
					args: {
						subagent_type: 'reviewer',
						prompt: 'Review the patch.\nACCEPTANCE: report the review result.',
					},
				},
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			releasePending();
			await expect(dispatchPromise).rejects.toThrow(
				/TASK_WORKFLOW_TASK_ID_REQUIRED/,
			);
		} finally {
			swarmState.pendingRehydrations.clear();
			rmSync(pendingDirectory, { recursive: true, force: true });
		}
	});
});
