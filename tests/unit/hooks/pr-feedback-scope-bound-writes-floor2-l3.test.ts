/**
 * Issue #3316 PR-review PRR-001/PRR-015 floor2: canonical containment.
 * The consumed-scope admission resolves EXISTING path components through the
 * filesystem, so (1) a junction/symlinked directory inside the declared scope
 * cannot redirect a write outside it, and (2) an absolute out-of-scope target
 * is refused. Both legs are PRESERVING: refused at base (lexical check also
 * refuses) and refused at head (canonical check refuses for the right reason).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_test_exports,
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'l3-scope-floor2';
const CODER_CHILD = 'l3-floor2-coder-child';
const HEAD_SHA = 'abc123';
const D0 = 'revision-1';
const D1 = 'revision-2';
const ITEM_ID = 'FB-001';

let directory = '';
let currentDigest = D0;
const seamSnapshot = { ..._test_exports };

beforeEach(() => {
	directory = canonicalMkdtemp('l3-scope-floor2-');
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
});

afterEach(async () => {
	Object.assign(_test_exports, seamSnapshot);
	_test_exports.resetTrackedStateCache();
	safeRmRecursive(directory);
});

async function persistLaneArtifact(options: {
	batchId: string;
	laneId: string;
	text: string;
}): Promise<void> {
	const correlationId = `${options.batchId}--${options.laneId}`;
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
		batchId: options.batchId,
		laneId: options.laneId,
		mode: 'swarm-pr-feedback:verification',
		workflowLane: options.laneId,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: D0,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId: options.batchId,
		laneId: options.laneId,
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-feedback:verification',
		workflowLane: options.laneId,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: D0,
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

async function settleAndConsume(files: readonly string[]): Promise<void> {
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
		text: `[FEEDBACK-VERIFIED] | ${ITEM_ID} | CONFIRMED | evidence`,
	});
	const { executePreparePrFeedbackScope } = await import(
		'../../../src/tools/prepare-pr-feedback-scope.js'
	);
	const prepared = JSON.parse(
		await executePreparePrFeedbackScope(
			{ task_id: '2.1', files: [...files] },
			directory,
			{ sessionID: SESSION_ID },
		),
	) as { success: boolean };
	expect(prepared.success).toBe(true);
	const { createDelegationGateHook } = await import(
		'../../../src/hooks/delegation-gate.js'
	);
	const delegation = createDelegationGateHook({ swarm: {} }, directory);
	await delegation.toolBefore(
		{ tool: 'Task', sessionID: SESSION_ID, callID: 'l3-floor2-call' },
		{
			args: {
				subagent_type: 'coder',
				task_id: '2.1',
				prompt: `TASK: 2.1\nFILE: ${files[0]}\nACCEPTANCE: close FB-001`,
			},
		},
	);
	await delegation.taskMetadata({
		callID: 'l3-floor2-call',
		parentSessionID: SESSION_ID,
		childSessionID: CODER_CHILD,
	});
}

async function attemptEdit(target: string): Promise<'admitted' | string> {
	return enforcePrWorkflowToolBefore(
		directory,
		SESSION_ID,
		'edit',
		{ path: target },
		[],
		`call-${target.replace(/[^a-z0-9]/gi, '-')}`,
	).then(
		() => 'admitted',
		(error: unknown) => `rejected: ${(error as Error).message}`,
	);
}

describe('PR_FEEDBACK consumed-scope canonical containment floor2', () => {
	test('a junctioned directory inside the scope cannot redirect a write outside it', async () => {
		const srcDir = path.join(directory, 'src');
		const outsideDir = path.join(directory, 'outside-real');
		mkdirSync(srcDir, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
		const linked = path.join(srcDir, 'linked');
		symlinkSync(
			outsideDir,
			linked,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		await settleAndConsume(['src']);
		currentDigest = D1;

		const outcome = await attemptEdit('src/linked/escaped.ts');
		expect(outcome).toContain('rejected:');
		expect(outcome).toContain('verification ownership is incomplete');
	});

	test('an absolute out-of-scope target is refused at the moved digest', async () => {
		const srcDir = path.join(directory, 'src');
		mkdirSync(srcDir, { recursive: true });
		await settleAndConsume(['src']);
		currentDigest = D1;

		const outsideAbsolute = path.join(directory, 'outside-abs.txt');
		const outcome = await attemptEdit(outsideAbsolute);
		expect(outcome).toContain('rejected:');
		expect(outcome).toContain('verification ownership is incomplete');
	});
});
