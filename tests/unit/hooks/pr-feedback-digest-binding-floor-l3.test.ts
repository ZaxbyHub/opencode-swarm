/**
 * Issue #3316 AC3 (L3 acceptance, PRESERVING): the revision-digest binding on
 * verification evidence is a floor. A settled verification at digest D0 never
 * authorizes ladder progress at D1: a Stage A re-record and a non-read shell
 * both reject after the digest changes, at base AND after the AC1 widening.
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
	_test_exports,
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	enforcePrWorkflowToolBefore,
	recordPrFeedbackStageA,
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'l3-digest-floor';
const HEAD_SHA = 'abc123';
const D0 = 'revision-1';
const D1 = 'revision-2';
const ITEM_ID = 'FB-001';

let directory = '';
let currentDigest = D0;
const seamSnapshot = { ..._test_exports };

beforeEach(() => {
	directory = canonicalMkdtemp('l3-digest-floor-');
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
	const correlationId = 'verify-1--verify';
	const text = `[FEEDBACK-VERIFIED] | ${ITEM_ID} | CONFIRMED | evidence`;
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
		batchId: 'verify-1',
		laneId: 'verify',
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verify',
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: D0,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId: 'verify-1',
		laneId: 'verify',
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verify',
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: D0,
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

describe('PR_FEEDBACK digest-binding floors (AC3)', () => {
	beforeEach(settleVerification);

	test('a Stage A re-record at a new digest requires re-settled verification', async () => {
		currentDigest = D1;
		await expect(
			recordPrFeedbackStageA(directory, SESSION_ID, D1, [
				{ category: 'build', command: ['build'], durationMs: 1 },
				{ category: 'typecheck', command: ['typecheck'], durationMs: 1 },
				{ category: 'lint', command: ['lint'], durationMs: 1 },
				{
					category: 'diff-check',
					command: ['git', 'diff', '--check'],
					durationMs: 1,
				},
				{
					category: 'reproduction',
					command: ['test', 'regression'],
					targets: ['regression'],
					feedbackTargets: [
						{
							feedbackItemId: ITEM_ID,
							target: 'regression',
							expectedBehavior: 'regression stays fixed',
						},
					],
					durationMs: 1,
				},
			]),
		).rejects.toThrow(/verification ownership is incomplete/i);
	});

	test('a non-read shell command still fails closed at the new digest', async () => {
		// Observed at base: the standalone-commit admission re-asserts the whole
		// verification ladder, so the digest flip rejects with the
		// verification-ownership text (the fix only appends a recovery hint).
		currentDigest = D1;
		await expect(
			enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
				command: 'git commit -a -m done',
			}),
		).rejects.toThrow(
			/BLOCKED: PR_FEEDBACK verification ownership is incomplete/,
		);
	});
});
