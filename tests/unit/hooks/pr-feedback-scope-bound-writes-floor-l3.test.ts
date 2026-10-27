/**
 * Issue #3316 AC2 (L3 acceptance, PRESERVING): the scope-bound write admission
 * from AC1 is a NARROW widening. These legs must keep rejecting at base AND
 * after the fix — an out-of-scope file never inherits the consumed scope's
 * authority, and a write with no consumed scope at all still falls to the
 * digest-bound verification assert.
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
} from '../../../src/hooks/pr-workflow-gate.js';
import { clearScopeBindings } from '../../../src/scope/scope-binding.js';
import { ensureAgentSession, resetSwarmState } from '../../../src/state.js';
import { executePreparePrFeedbackScope } from '../../../src/tools/prepare-pr-feedback-scope.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { makeConfig } from './_delegation-gate-helpers.js';

const SESSION_ID = 'l3-scope-floor';
const HEAD_SHA = 'abc123';
const D0 = 'revision-1';
const D1 = 'revision-2';
const ITEM_ID = 'FB-001';

let directory = '';
let currentDigest = D0;
const seamSnapshot = { ..._test_exports };

beforeEach(() => {
	directory = canonicalMkdtemp('l3-scope-floor-');
	mkdirSync(path.join(directory, '.git'), { recursive: true });
	currentDigest = D0;
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
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

async function persistVerifiedLane(batchId: string, revisionDigest: string) {
	const correlationId = `${batchId}--verify`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `call-${correlationId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId: 'verify',
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verify',
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: revisionDigest,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const text = `[FEEDBACK-VERIFIED] | ${ITEM_ID} | CONFIRMED | evidence`;
	const stored = storeLaneOutput(directory, {
		batchId,
		laneId: 'verify',
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verify',
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(directory, correlationId, {
		status: 'completed',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

async function settleVerification(): Promise<void> {
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
	await persistVerifiedLane('verify-1', D0);
}

async function consumeCoderScope(): Promise<void> {
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
		{ tool: 'Task', sessionID: SESSION_ID, callID: 'l3-floor-coder-call' },
		{
			args: {
				subagent_type: 'coder',
				task_id: '1.1',
				prompt: 'TASK: 1.1\nFILE: src/index.ts\nACCEPTANCE: close FB-001',
			},
		},
	);
	await delegation.taskMetadata({
		callID: 'l3-floor-coder-call',
		parentSessionID: SESSION_ID,
		childSessionID: 'l3-floor-coder-child',
	});
}

describe('PR_FEEDBACK scope-bound write floors (AC2)', () => {
	test('an out-of-scope file never inherits the consumed scope authority after the digest change', async () => {
		await settleVerification();
		await consumeCoderScope();
		currentDigest = D1;

		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				SESSION_ID,
				'edit',
				{ path: 'src/outside.ts' },
				[],
				'call-outside',
			),
		).rejects.toThrow(/verification ownership is incomplete/i);
	});

	test('a write with no consumed scope still falls to the digest-bound verification assert', async () => {
		await settleVerification();
		currentDigest = D1;

		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				SESSION_ID,
				'edit',
				{ path: 'src/index.ts' },
				[],
				'call-noscope',
			),
		).rejects.toThrow(/verification ownership is incomplete/i);
	});

	test('a ..-traversal target that prefix-matches the scope file resolves outside it and is refused (review round 1)', async () => {
		await settleVerification();
		await consumeCoderScope();
		currentDigest = D1;

		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				SESSION_ID,
				'edit',
				{ path: 'src/index.ts/../../outside.ts' },
				[],
				'call-traversal',
			),
		).rejects.toThrow(/verification ownership is incomplete/i);
	});
});
