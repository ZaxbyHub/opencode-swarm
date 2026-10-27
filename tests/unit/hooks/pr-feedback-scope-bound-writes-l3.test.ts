/**
 * Issue #3316 AC1 (L3 acceptance, DISCRIMINATING): once a PR_FEEDBACK coder
 * scope has been prepared AND consumed by an authorized coder Task dispatch,
 * the bound files stay writable across a revision-digest change caused by the
 * coder's own edits. Base behavior: every direct write re-asserts
 * digest-bound verification settlement and rejects after the coder dirties the
 * tree, wedging the loop the scope was created to authorize.
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
import { createScopeGuardHook } from '../../../src/hooks/scope-guard.js';
import { clearScopeBindings } from '../../../src/scope/scope-binding.js';
import { ensureAgentSession, resetSwarmState } from '../../../src/state.js';
import { executePreparePrFeedbackScope } from '../../../src/tools/prepare-pr-feedback-scope.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { makeConfig } from './_delegation-gate-helpers.js';

const SESSION_ID = 'l3-scope-writes';
const CODER_CHILD = 'l3-scope-coder-child';
const HEAD_SHA = 'abc123';
const D0 = 'revision-1';
const D1 = 'revision-2';
const ITEM_ID = 'FB-001';

let directory = '';
let currentDigest = D0;
const seamSnapshot = { ..._test_exports };

beforeEach(() => {
	directory = canonicalMkdtemp('l3-scope-writes-');
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
	await persistLaneArtifact({
		batchId: 'verify-1',
		laneId: 'verify',
		mode: 'swarm-pr-feedback:verification',
		role: 'reviewer',
		text: `[FEEDBACK-VERIFIED] | ${ITEM_ID} | CONFIRMED | evidence`,
		revisionDigest: D0,
	});
}

/** Prepare and consume the one planless coder scope for task 1.1. */
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
		{ tool: 'Task', sessionID: SESSION_ID, callID: 'l3-coder-call' },
		{
			args: {
				subagent_type: 'coder',
				task_id: '1.1',
				prompt: 'TASK: 1.1\nFILE: src/index.ts\nACCEPTANCE: close FB-001',
			},
		},
	);
	await delegation.taskMetadata({
		callID: 'l3-coder-call',
		parentSessionID: SESSION_ID,
		childSessionID: CODER_CHILD,
	});
}

describe('PR_FEEDBACK scope-bound writes survive the coder revision change (AC1)', () => {
	test('a consumed coder scope keeps authorizing its bound files after the digest changes', async () => {
		await settleVerification();
		await consumeCoderScope();

		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				SESSION_ID,
				'edit',
				{ path: 'src/index.ts' },
				[],
				'call-w1',
			),
		).resolves.toBeUndefined();

		currentDigest = D1;

		const secondWrite = await enforcePrWorkflowToolBefore(
			directory,
			SESSION_ID,
			'edit',
			{ path: 'src/index.ts' },
			[],
			'call-w2',
		).then(
			() => 'admitted',
			(error: unknown) => `rejected: ${(error as Error).message}`,
		);
		expect(secondWrite).toBe('admitted');
	});

	test('the consumed coder child session keeps writing its bound file after the digest changes', async () => {
		await settleVerification();
		await consumeCoderScope();
		currentDigest = D1;

		const scopeGuard = createScopeGuardHook(
			{ enabled: true },
			directory,
			() => undefined,
		);
		const childWrite = await scopeGuard
			.toolBefore(
				{ tool: 'edit', sessionID: CODER_CHILD, callID: 'l3-child-edit' },
				{ args: { path: 'src/index.ts' } },
			)
			.then(
				() => 'admitted',
				(error: unknown) => `rejected: ${(error as Error).message}`,
			);
		expect(childWrite).toBe('admitted');
	});

	test('a directory scope entry keeps admitting a nested file after the digest changes (containment order)', async () => {
		await settleVerification();
		const prepared = JSON.parse(
			await executePreparePrFeedbackScope(
				{ task_id: '1.2', files: ['src'] },
				directory,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean };
		expect(prepared.success).toBe(true);
		const delegation = createDelegationGateHook(makeConfig(), directory);
		await delegation.toolBefore(
			{ tool: 'Task', sessionID: SESSION_ID, callID: 'l3-dir-scope-call' },
			{
				args: {
					subagent_type: 'coder',
					task_id: '1.2',
					prompt: 'TASK: 1.2\nFILE: src/nested.ts\nACCEPTANCE: close FB-001',
				},
			},
		);
		await delegation.taskMetadata({
			callID: 'l3-dir-scope-call',
			parentSessionID: SESSION_ID,
			childSessionID: 'l3-dir-coder-child',
		});
		currentDigest = D1;

		// A nested file inside a directory entry stays admitted — pinning the
		// containment argument order (swapped isPathIdentityWithin arguments
		// would refuse it; mutant SWAP2 goes red here).
		const nestedWrite = await enforcePrWorkflowToolBefore(
			directory,
			SESSION_ID,
			'edit',
			{ path: 'src/nested.ts' },
			[],
			'call-nested',
		).then(
			() => 'admitted',
			(error: unknown) => `rejected: ${(error as Error).message}`,
		);
		expect(nestedWrite).toBe('admitted');
	});
});
