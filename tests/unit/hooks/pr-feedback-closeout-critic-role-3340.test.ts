// Issue #3340 AC2 (recorded decision) — the PR_FEEDBACK closeout-critic gate
// requires EXACTLY the `critic` role, aligned with the PR_REVIEW critic rule
// (#3310). A closeout child session that ran a critic-family role other than
// `critic` is NOT accepted: the closeout gate settles on one [CLOSEOUT-CRITIC]
// verdict row per feedback item, the same row-emission contract the other
// critic-family agents cannot produce. RED at base:
// `assertIndependentFeedbackGateSessions` admitted any `critic_`-prefixed role.
// Mirrors the ladder harness of pr-feedback-gate-verdict-floor-l3.test.ts.
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
	type PrFeedbackGatePhase,
	recordPrFeedbackGateBatch,
	recordPrFeedbackStageA,
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'feedback-critic-role-3340';
const FEEDBACK_HEAD_SHA = 'abc123';
const REVISION = 'revision-1';
const ITEM_ID = 'FB-001';
let directory = '';
const seamSnapshot = { ..._test_exports };

const LADDER: readonly PrFeedbackGatePhase[] = [
	'stage-b-reviewer',
	'stage-b-test',
	'closeout-reviewer',
	'closeout-critic',
];

const PHASE_ARTIFACT: Readonly<
	Record<PrFeedbackGatePhase, { mode: string; role: string; text: string }>
> = {
	'stage-b-reviewer': {
		mode: 'swarm-pr-feedback:stage-b-reviewer',
		role: 'reviewer',
		text: `[STAGE-B-REVIEW] | ${ITEM_ID} | APPROVE | evidence`,
	},
	'stage-b-test': {
		mode: 'swarm-pr-feedback:stage-b-test',
		role: 'test_engineer',
		text: `[STAGE-B-TEST] | ${ITEM_ID} | PASS | evidence`,
	},
	'closeout-reviewer': {
		mode: 'swarm-pr-feedback:closeout-reviewer',
		role: 'reviewer',
		text: `[CLOSEOUT-REVIEW] | ${ITEM_ID} | APPROVE | evidence`,
	},
	'closeout-critic': {
		mode: 'swarm-pr-feedback:closeout-critic',
		role: 'critic',
		text: `[CLOSEOUT-CRITIC] | ${ITEM_ID} | APPROVE | evidence`,
	},
};

async function persistFeedbackLaneArtifact(options: {
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
			gitHead: FEEDBACK_HEAD_SHA,
			dirtyHash: REVISION,
			prHeadSha: FEEDBACK_HEAD_SHA,
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
		prHeadSha: FEEDBACK_HEAD_SHA,
		gitHead: FEEDBACK_HEAD_SHA,
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

async function settleThroughStageA(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK');
	await declarePrFeedbackInventory(directory, SESSION_ID, [ITEM_ID], {
		prHeadSha: FEEDBACK_HEAD_SHA,
	});
	await enforcePrFeedbackVerificationOwnership(
		directory,
		SESSION_ID,
		[{ laneId: 'verify', ownedItemIds: [ITEM_ID] }],
		{ batchId: 'verify-1', prHeadSha: FEEDBACK_HEAD_SHA },
	);
	await persistFeedbackLaneArtifact({
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

async function recordGateBatch(
	phase: PrFeedbackGatePhase,
	role: string,
): Promise<void> {
	const info = PHASE_ARTIFACT[phase];
	const batchId = `gate-${phase}`;
	await recordPrFeedbackGateBatch(
		directory,
		SESSION_ID,
		phase,
		{ laneId: phase, ownedItemIds: [ITEM_ID] },
		{ batchId, prHeadSha: FEEDBACK_HEAD_SHA, revisionDigest: REVISION },
	);
	await persistFeedbackLaneArtifact({
		batchId,
		laneId: phase,
		mode: info.mode,
		role,
		text: info.text,
	});
}

describe('issue #3340 AC2: PR_FEEDBACK closeout-critic requires exactly the critic role', () => {
	beforeEach(() => {
		directory = canonicalMkdtemp('feedback-critic-role-3340-');
		mkdirSync(path.join(directory, '.git'), { recursive: true });
		_test_exports.resetTrackedStateCache();
		_test_exports.resolveCurrentGitHead = () => FEEDBACK_HEAD_SHA;
		_test_exports.resolveCurrentGitHeadAsync = async () => FEEDBACK_HEAD_SHA;
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

	test('a critic_finding_validator closeout child session is refused at the settle gate', async () => {
		await settleThroughStageA();
		for (const phase of LADDER.slice(0, LADDER.indexOf('closeout-critic'))) {
			await recordGateBatch(phase, PHASE_ARTIFACT[phase].role);
		}
		// The closeout-critic batch records, but its child session ran
		// critic_finding_validator — a critic-family role other than `critic`.
		// Decision (issue #3340): NOT accepted.
		await recordGateBatch('closeout-critic', 'critic_finding_validator');
		await expect(
			assertPrFeedbackGatePhaseSettled(
				directory,
				SESSION_ID,
				'closeout-critic',
			),
		).rejects.toThrow(
			/requires role critic, received critic_finding_validator/,
		);
	});

	test("a closeout child session that ran exactly 'critic' settles", async () => {
		await settleThroughStageA();
		for (const phase of LADDER) {
			await recordGateBatch(phase, PHASE_ARTIFACT[phase].role);
		}
		await expect(
			assertPrFeedbackGatePhaseSettled(
				directory,
				SESSION_ID,
				'closeout-critic',
			),
		).resolves.toBeDefined();
	});
});
