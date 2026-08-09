import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { storeLaneOutput } from '../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../src/background/pending-delegations.js';
import { getPendingCoderScope } from '../../src/hooks/delegation-gate.js';
import {
	_test_exports,
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
} from '../../src/hooks/pr-workflow-gate.js';
import { getScopeBindingForParentDispatch } from '../../src/scope/scope-binding.js';
import { resetSwarmState, swarmState } from '../../src/state.js';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host.js';

const SESSION_ID = 'pr-workflow-hook-precedence';
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

describe('PR workflow gate has authoritative real-host Task precedence', () => {
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

	function reviewerTask(callID: string) {
		return plugin.hooks['tool.execute.before'](
			{ tool: 'Task', sessionID: SESSION_ID, callID },
			{ args: { subagent_type: 'reviewer', prompt: 'Review the patch.' } },
		);
	}

	async function settleFeedbackVerification(): Promise<void> {
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-001'], {
			prHeadSha: HEAD_SHA,
		});
		await enforcePrFeedbackVerificationOwnership(
			directory,
			SESSION_ID,
			[{ laneId: 'verify-coder', ownedItemIds: ['FB-001'] }],
			{ batchId: 'feedback-coder-ready', prHeadSha: HEAD_SHA },
		);
		const text = '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence';
		await recordPendingDelegation(directory, {
			correlationId: 'feedback-coder-ready-0',
			jobId: null,
			subagentSessionId: 'feedback-coder-ready-0',
			parentSessionId: SESSION_ID,
			callID: 'feedback-verify-call',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'feedback-coder-ready',
			laneId: 'verify-coder',
			mode: 'swarm-pr-feedback:verification',
			workflowLane: 'verify-coder',
			workspace: {
				directory,
				gitHead: HEAD_SHA,
				dirtyHash: null,
				prHeadSha: HEAD_SHA,
				scope: null,
			},
		});
		const stored = storeLaneOutput(directory, {
			batchId: 'feedback-coder-ready',
			laneId: 'verify-coder',
			agent: 'reviewer',
			role: 'reviewer',
			sessionId: 'feedback-coder-ready-0',
			parentSessionId: SESSION_ID,
			mode: 'swarm-pr-feedback:verification',
			workflowLane: 'verify-coder',
			prHeadSha: HEAD_SHA,
			gitHead: HEAD_SHA,
			revisionDigest: REVISION_DIGEST,
			source: 'collect_lane_results',
			text,
		});
		await appendDelegationTransition(directory, 'feedback-coder-ready-0', {
			status: 'completed',
			result: {
				text,
				chars: stored.chars,
				truncated: false,
				digest: stored.digest,
				...(stored.ref ? { outputRef: stored.ref } : {}),
			},
		});
	}

	function expectNoDelegationArtifacts(
		sessionID: string,
		callID: string,
	): void {
		const session = swarmState.agentSessions.get(sessionID);
		expect(session?.delegationActive ?? false).toBeFalse();
		expect(session?.currentTaskId ?? null).toBeNull();
		expect(
			[...(session?.taskWorkflowStates.values() ?? [])].every(
				(status) => status === 'idle',
			),
		).toBeTrue();
		expect(session?.reviewerCallCount.size ?? 0).toBe(0);
		expect(swarmState.delegationChains.get(sessionID) ?? []).toEqual([]);
		expect(getPendingCoderScope(directory, '1.1')).toBeNull();
		expect(
			getScopeBindingForParentDispatch({
				parentSessionId: sessionID,
				dispatchCallId: callID,
			}),
		).toBeNull();
		expect(findByCorrelationId(directory, callID)).toBeNull();
	}

	test('active PR_REVIEW rejects a direct reviewer at the workflow boundary before acceptance or delegation state', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

		await expect(reviewerTask('review-call')).rejects.toThrow(
			/PR_REVIEW is read-only.*structured dispatch_lanes_async/i,
		);

		expectNoDelegationArtifacts(SESSION_ID, 'review-call');
		expect(
			existsSync(
				path.join(directory, '.swarm', 'background-delegations.jsonl'),
			),
		).toBeFalse();
	});

	test('inactive workflows preserve the reviewer acceptance contract', async () => {
		await expect(reviewerTask('inactive-review-call')).rejects.toThrow(
			/ACCEPTANCE_FIELD_REQUIRED/,
		);
	});

	test('PR_FEEDBACK coder Tasks still reach acceptance and scope preflight', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK');
		await settleFeedbackVerification();
		const before = plugin.hooks['tool.execute.before'];

		await expect(
			before(
				{ tool: 'Task', sessionID: SESSION_ID, callID: 'coder-missing' },
				{
					args: {
						subagent_type: 'coder',
						task_id: '1.1',
						prompt: 'Implement the approved fix.',
					},
				},
			),
		).rejects.toThrow(/ACCEPTANCE_FIELD_REQUIRED/);

		await expect(
			before(
				{ tool: 'Task', sessionID: SESSION_ID, callID: 'coder-approved' },
				{
					args: {
						subagent_type: 'coder',
						task_id: '1.1',
						prompt:
							'Implement the approved fix.\nACCEPTANCE: src/index.ts is updated and verified.',
					},
				},
			),
		).resolves.toBeUndefined();
		expect(
			getScopeBindingForParentDispatch({
				parentSessionId: SESSION_ID,
				dispatchCallId: 'coder-approved',
			}),
		).not.toBeNull();
	});

	test('child sessions inherit the controller PR_REVIEW precedence', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		await plugin.hooks.event({
			event: {
				type: 'session.created',
				properties: {
					info: { id: 'reviewer-child', parentID: SESSION_ID },
				},
			},
		});

		await expect(
			plugin.hooks['tool.execute.before'](
				{ tool: 'Task', sessionID: 'reviewer-child', callID: 'child-call' },
				{ args: { subagent_type: 'reviewer', prompt: 'Review the patch.' } },
			),
		).rejects.toThrow(
			/PR_REVIEW is read-only.*structured dispatch_lanes_async/i,
		);
		expectNoDelegationArtifacts('reviewer-child', 'child-call');
	});
});
