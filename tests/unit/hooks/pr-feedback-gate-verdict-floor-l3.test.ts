/**
 * Issue #3316 AC22 (L3 acceptance, PRESERVING): whatever vocabulary widening
 * AC20/AC21 admit, malformed verdict rows never settle a phase and never
 * validate for transport recovery — wrong verdict token, APPROVED on a
 * PASS-only phase, duplicate rows, unassigned item ids, and case-mangled
 * verdicts all keep rejecting at base AND after the fix.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
	readLaneOutput,
	storeLaneOutput,
} from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	findByCorrelationId,
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
	validatePrWorkflowTransportRecovery,
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'l3-verdict-floor';
const HEAD_SHA = 'abc123';
const REVISION = 'revision-1';
const ITEM_ID = 'FB-001';

const PHASES: Readonly<
	Record<
		PrFeedbackGatePhase,
		{ mode: string; role: string; marker: string; verdict: string }
	>
> = {
	'stage-b-reviewer': {
		mode: 'swarm-pr-feedback:stage-b-reviewer',
		role: 'reviewer',
		marker: '[STAGE-B-REVIEW]',
		verdict: 'APPROVE',
	},
	'stage-b-test': {
		mode: 'swarm-pr-feedback:stage-b-test',
		role: 'test_engineer',
		marker: '[STAGE-B-TEST]',
		verdict: 'PASS',
	},
	'closeout-reviewer': {
		mode: 'swarm-pr-feedback:closeout-reviewer',
		role: 'reviewer',
		marker: '[CLOSEOUT-REVIEW]',
		verdict: 'APPROVE',
	},
	'closeout-critic': {
		mode: 'swarm-pr-feedback:closeout-critic',
		// Issue #3340: closeout-critic requires exactly the `critic` role
		// (aligned with the PR_REVIEW critic rule).
		role: 'critic',
		marker: '[CLOSEOUT-CRITIC]',
		verdict: 'APPROVE',
	},
};
const LADDER: readonly PrFeedbackGatePhase[] = [
	'stage-b-reviewer',
	'stage-b-test',
	'closeout-reviewer',
	'closeout-critic',
];

let directory = '';
const seamSnapshot = { ..._test_exports };

beforeEach(() => {
	directory = canonicalMkdtemp('l3-verdict-floor-');
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
}): Promise<{ ref: string; digest: string; chars: number }> {
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
	return { ref: stored.ref, digest: stored.digest, chars: stored.chars };
}

/** Full ladder setup: inventory, verification, Stage A. */
async function settleThroughStageA(): Promise<void> {
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

/** Record + settle every phase strictly before `target`. */
async function settlePhasesBefore(target: PrFeedbackGatePhase): Promise<void> {
	for (const phase of LADDER.slice(0, LADDER.indexOf(target))) {
		const info = PHASES[phase];
		const batchId = `gate-${phase}`;
		await recordPrFeedbackGateBatch(
			directory,
			SESSION_ID,
			phase,
			{ laneId: phase, ownedItemIds: [ITEM_ID] },
			{ batchId, prHeadSha: HEAD_SHA, revisionDigest: REVISION },
		);
		await persistLaneArtifact({
			batchId,
			laneId: phase,
			mode: info.mode,
			role: info.role,
			text: `${info.marker} | ${ITEM_ID} | ${info.verdict} | evidence`,
		});
	}
}

interface FloorLeg {
	name: string;
	phase: PrFeedbackGatePhase;
	rows: string;
}

const FLOOR_LEGS: readonly FloorLeg[] = [
	{
		name: 'SKIPPED on stage-b-test',
		phase: 'stage-b-test',
		rows: `[STAGE-B-TEST] | ${ITEM_ID} | SKIPPED | evidence`,
	},
	{
		name: 'SKIPPED on stage-b-reviewer (never a positive verdict)',
		phase: 'stage-b-reviewer',
		rows: `[STAGE-B-REVIEW] | ${ITEM_ID} | SKIPPED | evidence`,
	},
	{
		name: 'SKIPPED on closeout-critic (never a positive verdict)',
		phase: 'closeout-critic',
		rows: `[CLOSEOUT-CRITIC] | ${ITEM_ID} | SKIPPED | evidence`,
	},
	{
		name: 'non-verdict prose on stage-b-reviewer',
		phase: 'stage-b-reviewer',
		rows: `[STAGE-B-REVIEW] | ${ITEM_ID} | not APPROVE yet | evidence`,
	},
	{
		name: 'duplicate APPROVE rows on closeout-critic',
		phase: 'closeout-critic',
		rows: `[CLOSEOUT-CRITIC] | ${ITEM_ID} | APPROVE | first\n[CLOSEOUT-CRITIC] | ${ITEM_ID} | APPROVE | second`,
	},
	{
		name: 'a row for an unassigned item id',
		phase: 'stage-b-reviewer',
		rows: `[STAGE-B-REVIEW] | FB-002 | APPROVE | evidence`,
	},
	{
		name: 'APPROVED does not satisfy the PASS-only stage-b-test phase',
		phase: 'stage-b-test',
		rows: `[STAGE-B-TEST] | ${ITEM_ID} | APPROVED | evidence`,
	},
	{
		name: 'case-mangled verdict on closeout-reviewer',
		phase: 'closeout-reviewer',
		rows: `[CLOSEOUT-REVIEW] | ${ITEM_ID} | approve | evidence`,
	},
];

describe('PR_FEEDBACK gate verdict floors (AC22)', () => {
	for (const leg of FLOOR_LEGS) {
		test(`${leg.name} never settles and never validates for recovery`, async () => {
			await settleThroughStageA();
			await settlePhasesBefore(leg.phase);
			const info = PHASES[leg.phase];
			const batchId = `gate-${leg.phase}`;
			await recordPrFeedbackGateBatch(
				directory,
				SESSION_ID,
				leg.phase,
				{ laneId: leg.phase, ownedItemIds: [ITEM_ID] },
				{ batchId, prHeadSha: HEAD_SHA, revisionDigest: REVISION },
			);
			const stored = await persistLaneArtifact({
				batchId,
				laneId: leg.phase,
				mode: info.mode,
				role: info.role,
				text: leg.rows,
			});

			// Settle entry: the phase refuses the malformed artifact.
			await expect(
				assertPrFeedbackGatePhaseSettled(directory, SESSION_ID, leg.phase),
			).rejects.toThrow(/positive verdict row per inventory item/);

			// Recovery entry: truncated-preview transport recovery refuses the
			// same durable artifact.
			const record = findByCorrelationId(directory, `${batchId}--${leg.phase}`);
			expect(record).not.toBeNull();
			const artifact = readLaneOutput(directory, stored.ref)?.artifact ?? null;
			expect(artifact).not.toBeNull();
			const verdict = await validatePrWorkflowTransportRecovery({
				directory,
				record: record!,
				result: {
					text: leg.rows.slice(0, 20),
					chars: stored.chars,
					truncated: true,
					digest: stored.digest,
					outputRef: stored.ref,
				},
				artifact,
				revisionDigest: REVISION,
			});
			expect(verdict.ok).toBe(false);
		});
	}
});
