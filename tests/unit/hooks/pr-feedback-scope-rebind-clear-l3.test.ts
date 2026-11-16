/**
 * Issue #3316 plan-critic pinning leg (frozen check C24, PRESERVING): a
 * consumed PR-feedback scope must NOT authorize writes after the intake head
 * is rebound. `rebindPrFeedbackHead` clears `prFeedbackScopes` (mirroring
 * invalidation), so on the unverified rebound ancestry both the controller
 * direct write and the coder child binding write are refused. If the clear is
 * ever dropped, the consumed-declaration relaxation (issue #3316 D5) would
 * re-admit the child write — this leg exists to fail in exactly that case.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	createDelegationGateHook,
	_internals as delegationInternals,
} from '../../../src/hooks/delegation-gate.js';
import {
	_test_exports,
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	enforcePrWorkflowToolBefore,
	rebindPrFeedbackHead,
} from '../../../src/hooks/pr-workflow-gate.js';
import { createScopeGuardHook } from '../../../src/hooks/scope-guard.js';
import { clearScopeBindings } from '../../../src/scope/scope-binding.js';
import { ensureAgentSession, resetSwarmState } from '../../../src/state.js';
import { executePreparePrFeedbackScope } from '../../../src/tools/prepare-pr-feedback-scope.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { makeConfig } from './_delegation-gate-helpers.js';

const SESSION_ID = 'l3-scope-rebind-clear';
const CODER_CHILD = 'l3-rebind-coder-child';
const HEAD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const D0 = 'revision-1';
const ITEM_ID = 'FB-001';

let directory = '';
let currentHead = HEAD_SHA;
let currentDigest = D0;
const seamSnapshot = { ..._test_exports };

beforeEach(() => {
	directory = canonicalMkdtemp('l3-scope-rebind-');
	mkdirSync(path.join(directory, '.git'), { recursive: true });
	currentHead = HEAD_SHA;
	currentDigest = D0;
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => currentHead;
	_test_exports.resolveCurrentGitHeadAsync = async () => currentHead;
	_test_exports.resolvePrWorkflowRevisionDigest = () => currentDigest;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
	_test_exports.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-head',
		remoteTrackingRef: 'refs/remotes/origin/pr-head',
	});
	_test_exports.resolveCurrentUpstreamPushTargetAsync = async () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-head',
		remoteTrackingRef: 'refs/remotes/origin/pr-head',
	});
	_test_exports.resolveRemoteRefsContainingHead = () => [
		'refs/remotes/origin/pr-head',
	];
	_test_exports.resolveRemoteRefsContainingHeadAsync = async () => [
		'refs/remotes/origin/pr-head',
	];
	resetSwarmState();
	ensureAgentSession(SESSION_ID, 'architect', directory);
});

afterEach(async () => {
	delegationInternals.beforePrFeedbackScopeConsume = undefined;
	clearScopeBindings();
	resetSwarmState();
	Object.assign(_test_exports, seamSnapshot);
	_test_exports.resetTrackedStateCache();
	safeRmRecursive(directory);
});

async function persistLaneArtifact(options: {
	batchId: string;
	laneId: string;
	mode: string;
	role: string;
	text: string;
	revisionDigest: string;
}): Promise<void> {
	const correlationId = `${options.batchId}--${options.laneId}`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `call-${correlationId}`,
		normalizedAgent: options.role,
		swarmPrefixedAgent: options.role,
		planTaskId: null,
		evidenceTaskId: null,
		batchId: options.batchId,
		laneId: options.laneId,
		mode: options.mode,
		workflowLane: options.laneId,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: options.revisionDigest,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId: options.batchId,
		laneId: options.laneId,
		agent: options.role,
		role: options.role,
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: options.mode,
		workflowLane: options.laneId,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: options.revisionDigest,
		source: 'collect_lane_results',
		text: options.text,
	});
	await appendDelegationTransition(directory, correlationId, {
		status: 'completed',
		result: {
			text: options.text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

async function settleAndConsumeScope(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK');
	await declarePrFeedbackInventory(directory, SESSION_ID, [ITEM_ID], {
		prHeadSha: HEAD_SHA,
	});
	await enforcePrFeedbackVerificationOwnership(
		directory,
		SESSION_ID,
		[{ laneId: 'verify', ownedItemIds: [ITEM_ID] }],
		{ batchId: 'verify-1', prHeadSha: HEAD_SHA },
	);
	await persistLaneArtifact({
		batchId: 'verify-1',
		laneId: 'verify',
		mode: 'swarm-pr-feedback:verification',
		role: 'reviewer',
		text: `[FEEDBACK-VERIFIED] | ${ITEM_ID} | CONFIRMED | evidence`,
		revisionDigest: D0,
	});
	const prepared = JSON.parse(
		await executePreparePrFeedbackScope(
			{ task_id: '1.1', files: ['src/index.ts'] },
			directory,
			{ sessionID: SESSION_ID },
		),
	) as { success: boolean };
	expect(prepared.success).toBe(true);
	const delegation = createDelegationGateHook(makeConfig(), directory);
	await delegation.toolBefore(
		{ tool: 'Task', sessionID: SESSION_ID, callID: 'l3-rebind-coder-call' },
		{
			args: {
				subagent_type: 'coder',
				task_id: '1.1',
				prompt: 'TASK: 1.1\nFILE: src/index.ts\nACCEPTANCE: close FB-001',
			},
		},
	);
	await delegation.taskMetadata({
		callID: 'l3-rebind-coder-call',
		parentSessionID: SESSION_ID,
		childSessionID: CODER_CHILD,
	});
}

describe('PR_FEEDBACK consumed scope does not survive a head rebind (C24)', () => {
	test('after rebindPrFeedbackHead, neither the controller write nor the coder child write is authorized', async () => {
		await settleAndConsumeScope();
		currentHead = NEW_SHA;
		const state = await rebindPrFeedbackHead(directory, SESSION_ID, NEW_SHA);
		expect(state.prFeedbackRebindCount).toBe(1);

		const directWrite = await enforcePrWorkflowToolBefore(
			directory,
			SESSION_ID,
			'edit',
			{ path: 'src/index.ts' },
			[],
			'l3-post-rebind-write',
		).then(
			() => 'admitted',
			(error: unknown) => `rejected: ${(error as Error).message}`,
		);
		expect(directWrite).toMatch(/^rejected: BLOCKED: PR_FEEDBACK/);

		ensureAgentSession(CODER_CHILD, 'coder', directory);
		const scopeGuard = createScopeGuardHook(
			{ enabled: true },
			directory,
			() => undefined,
		);
		const childWrite = await scopeGuard
			.toolBefore(
				{
					tool: 'edit',
					sessionID: CODER_CHILD,
					callID: 'l3-rebind-coder-call',
				},
				{ args: { path: 'src/index.ts' } },
			)
			.then(
				() => 'admitted',
				(error: unknown) => `rejected: ${(error as Error).message}`,
			);
		expect(childWrite).toMatch(/^rejected: /);
	});
});
