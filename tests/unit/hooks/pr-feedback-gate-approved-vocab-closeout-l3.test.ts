/**
 * Issue #3316 PR-review PRR-015: positive `APPROVED` rows must settle the
 * CLOSEOUT phases too, not only stage-b-reviewer — the alias is wired through
 * the single shared comparison, but the shipped coverage only exercised the
 * stage-b marker. One ladder per closeout phase, ordered after the full
 * stage-b pair as production requires.
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
	assertPrFeedbackGatePhaseSettled,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	recordPrFeedbackGateBatch,
	recordPrFeedbackStageA,
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'l3-vocab-closeout';
const HEAD_SHA = 'abc123';
const REVISION = 'revision-1';
const ITEM_ID = 'FB-001';

let directory = '';
const seamSnapshot = { ..._test_exports };

beforeEach(() => {
	directory = canonicalMkdtemp('l3-vocab-closeout-');
	mkdirSync(path.join(directory, '.git'), { recursive: true });
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION;
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
	mode: string;
	role: string;
	text: string;
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
			dirtyHash: REVISION,
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
		revisionDigest: REVISION,
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

async function settleVerificationAndStageA(): Promise<void> {
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
	});
	await recordPrFeedbackStageA(directory, SESSION_ID, REVISION, [
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
					expectedBehavior: 'regression remains fixed',
				},
			],
			durationMs: 1,
		},
	]);
}

async function settleGatePhase(
	phase:
		| 'stage-b-reviewer'
		| 'stage-b-test'
		| 'closeout-reviewer'
		| 'closeout-critic',
	verdict: string,
): Promise<void> {
	const marker =
		phase === 'stage-b-reviewer'
			? '[STAGE-B-REVIEW]'
			: phase === 'stage-b-test'
				? '[STAGE-B-TEST]'
				: phase === 'closeout-reviewer'
					? '[CLOSEOUT-REVIEW]'
					: '[CLOSEOUT-CRITIC]';
	const mode = `swarm-pr-feedback:${phase}`;
	await recordPrFeedbackGateBatch(
		directory,
		SESSION_ID,
		phase,
		{ laneId: phase, ownedItemIds: [ITEM_ID] },
		{ batchId: `gate-${phase}`, prHeadSha: HEAD_SHA, revisionDigest: REVISION },
	);
	await persistLaneArtifact({
		batchId: `gate-${phase}`,
		laneId: phase,
		mode,
		role:
			phase === 'stage-b-test'
				? 'test_engineer'
				: phase === 'closeout-critic'
					? 'critic'
					: 'reviewer',
		text: `${marker} | ${ITEM_ID} | ${verdict} | evidence`,
	});
	await assertPrFeedbackGatePhaseSettled(directory, SESSION_ID, phase);
}

describe('PR_FEEDBACK closeout phases accept APPROVED rows (PRR-015)', () => {
	test('an APPROVED closeout-reviewer row settles the phase', async () => {
		await settleVerificationAndStageA();
		await settleGatePhase('stage-b-reviewer', 'APPROVED');
		await settleGatePhase('stage-b-test', 'PASS');
		await settleGatePhase('closeout-reviewer', 'APPROVED');
	});

	test('an APPROVED closeout-critic row settles the phase', async () => {
		await settleVerificationAndStageA();
		await settleGatePhase('stage-b-reviewer', 'APPROVED');
		await settleGatePhase('stage-b-test', 'PASS');
		await settleGatePhase('closeout-reviewer', 'APPROVED');
		await settleGatePhase('closeout-critic', 'APPROVED');
	});
});
