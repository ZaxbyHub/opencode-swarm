/**
 * Issue #2131 criterion C — swarm-pr-feedback terminal and history model.
 *
 * C1: a fully verified no-change inventory (every item DISPROVED /
 *     PRE_EXISTING / NEEDS_MORE_EVIDENCE / NEEDS_USER_DECISION) completes via
 *     a `verified-no-change` terminal WITHOUT requiring an empty commit.
 * C2: a controlled base-sync/rebind transition moves the immutable intake head
 *     to a new verified PR head after merge/rebase repair and invalidates every
 *     ancestry-bound receipt so the mechanical ladder re-runs.
 * C4: Stage A reproduction mappings carry a typed proof_kind.
 *
 * Fixture pattern mirrors pr-workflow-gate-completion.test.ts (DI stubs via
 * _test_exports; no mock.module).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_test_exports,
	activatePrWorkflow,
	assertPrFeedbackVerificationSettled,
	completePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	readPrWorkflowGateState,
	rebindPrFeedbackHead,
	recordPrFeedbackGateBatch,
	recordPrFeedbackStageA,
} from '../../../src/hooks/pr-workflow-gate.js';

const SESSION_ID = 'feedback-no-change';
const HEAD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const REVISION = 'revision-1';
let directory = '';
let currentHead = HEAD_SHA;
let settleRun = 0;
let commitCountSince = 0;

const snapshot = { ..._test_exports };
beforeEach(() => {
	directory = canonicalMkdtemp('pr-gate-no-change-');
	currentHead = HEAD_SHA;
	commitCountSince = 0;
	settleRun += 1;
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => currentHead;
	_test_exports.resolveCurrentGitHeadAsync = async () => currentHead;
	_test_exports.resolveCommitCountSince = () => commitCountSince;
	_test_exports.resolveCommitCountSinceAsync = async () => commitCountSince;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
	_test_exports.resolveIsExactSingleChildCommit = () => true;
	_test_exports.resolveIsExactSingleChildCommitAsync = async () => true;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION;
	_test_exports.resolveCurrentUpstreamRemoteRef = () =>
		'refs/remotes/origin/pr-head';
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
	_test_exports.resolveRemoteRefsContainingHead = (
		_dir: string,
		sha: string,
	) =>
		sha === HEAD_SHA || sha === NEW_SHA ? ['refs/remotes/origin/pr-head'] : [];
	_test_exports.resolveRemoteRefsContainingHeadAsync = async (
		_dir: string,
		sha: string,
	) =>
		sha === HEAD_SHA || sha === NEW_SHA ? ['refs/remotes/origin/pr-head'] : [];
});

afterEach(async () => {
	Object.assign(_test_exports, snapshot);
	_test_exports.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

async function persistLaneArtifact(
	batchId: string,
	laneId: string,
	mode: string,
	role: string,
	text: string,
): Promise<void> {
	const correlationId = `${batchId}-lane`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: batchId,
		normalizedAgent: role,
		swarmPrefixedAgent: role,
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
		mode,
		workflowLane: laneId,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: REVISION,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId,
		laneId,
		agent: role,
		role,
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode,
		workflowLane: laneId,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION,
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

/** Fabricate a fully settled PR_FEEDBACK gate for [FB-001] with the given
 * verification classification and a typed Stage A reproduction mapping. */
async function settleFeedbackWorkflow(classification: string): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK');
	await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-001'], {
		prHeadSha: HEAD_SHA,
	});
	await enforcePrFeedbackVerificationOwnership(
		directory,
		SESSION_ID,
		[{ laneId: 'verify', ownedItemIds: ['FB-001'] }],
		{ batchId: `verify-complete-${settleRun}`, prHeadSha: HEAD_SHA },
	);
	await persistLaneArtifact(
		`verify-complete-${settleRun}`,
		'verify',
		'swarm-pr-feedback:verification',
		'reviewer',
		`[FEEDBACK-VERIFIED] | FB-001 | ${classification} | evidence text here`,
	);
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
					feedbackItemId: 'FB-001',
					target: 'regression',
					expectedBehavior: 'regression remains unfixed (disproved)',
					proofKind: 'defect',
				},
			],
			durationMs: 1,
		},
	]);
	const phases = [
		[
			'stage-b-reviewer',
			'stage-b-reviewer',
			'reviewer',
			'[STAGE-B-REVIEW] | FB-001 | APPROVE | evidence',
		],
		[
			'stage-b-test',
			'stage-b-test',
			'test_engineer',
			'[STAGE-B-TEST] | FB-001 | PASS | evidence',
		],
		[
			'closeout-reviewer',
			'closeout-reviewer',
			'reviewer',
			'[CLOSEOUT-REVIEW] | FB-001 | APPROVE | evidence',
		],
		[
			'closeout-critic',
			'closeout-critic',
			'critic_oversight',
			'[CLOSEOUT-CRITIC] | FB-001 | APPROVE | evidence',
		],
	] as const;
	for (const [phase, laneId, role, text] of phases) {
		await recordPrFeedbackGateBatch(
			directory,
			SESSION_ID,
			phase,
			{ laneId, ownedItemIds: ['FB-001'] },
			{
				batchId: `batch-${phase}-${settleRun}`,
				prHeadSha: HEAD_SHA,
				revisionDigest: REVISION,
			},
		);
		await persistLaneArtifact(
			`batch-${phase}-${settleRun}`,
			laneId,
			`swarm-pr-feedback:${phase}`,
			role,
			text,
		);
	}
}

describe('verified-no-change terminal (issue #2131 C1)', () => {
	test('zero commits + fully disproved inventory completes without an empty commit', async () => {
		await settleFeedbackWorkflow('DISPROVED');
		const status = await completePrWorkflow(
			directory,
			SESSION_ID,
			'PR_FEEDBACK',
			HEAD_SHA,
		);
		expect(status).toBe('verified-no-change');
		// The gate is cleared (terminal) — nothing to publish.
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();
		// Audit trail.
		const events = await fs.readFile(
			path.join(directory, '.swarm', 'events.jsonl'),
			'utf-8',
		);
		expect(events).toContain('pr_feedback_verified_no_change');
	});

	test.each([
		'PRE_EXISTING',
		'NEEDS_MORE_EVIDENCE',
		'NEEDS_USER_DECISION',
	])('%s also qualifies for the no-change terminal', async (classification) => {
		// Each parameterized case runs in its own beforeEach-created directory.
		await settleFeedbackWorkflow(classification);
		const status = await completePrWorkflow(
			directory,
			SESSION_ID,
			'PR_FEEDBACK',
			HEAD_SHA,
		);
		expect(status).toBe('verified-no-change');
	});

	test('zero commits with a CONFIRMED item still fails closed', async () => {
		await settleFeedbackWorkflow('CONFIRMED');
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow(/no-change outcome.*FB-001/);
		// Gate survives the refusal.
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).not.toBeNull();
	});

	test('zero commits with a diverged HEAD (not the intake head) fails closed', async () => {
		await settleFeedbackWorkflow('DISPROVED');
		currentHead = NEW_SHA; // 0 commits since intake, but HEAD ≠ intake head
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow(/diverged/);
	});

	test('zero commits with a dirty tree fails closed', async () => {
		await settleFeedbackWorkflow('DISPROVED');
		_test_exports.resolveIsWorkingTreeClean = () => false;
		_test_exports.resolveIsWorkingTreeCleanAsync = async () => false;
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow(/clean index and working tree/);
	});
});

describe('rebindPrFeedbackHead (issue #2131 C2)', () => {
	test('rebinds to a new head and invalidates every ancestry-bound receipt', async () => {
		await settleFeedbackWorkflow('CONFIRMED');
		currentHead = NEW_SHA; // checked out at the repaired (merged/rebased) head
		const state = await rebindPrFeedbackHead(directory, SESSION_ID, NEW_SHA);
		expect(state.prHeadSha).toBe(NEW_SHA);
		expect(state.prFeedbackRebindCount).toBe(1);
		// Stale receipts invalidated: Stage A and every gate batch are gone, so
		// the verification assertion demands a full re-run on the new ancestry.
		expect(state.prFeedbackStageA).toBeUndefined();
		expect(state.prFeedbackGateBatches).toBeUndefined();
		expect(state.prFeedbackVerifications).toBeUndefined();
		// The immutable inventory survives (item-set continuity).
		expect(state.prFeedbackInventory).toEqual(['FB-001']);
		await expect(
			assertPrFeedbackVerificationSettled(directory, SESSION_ID),
		).rejects.toThrow();
		// Audit trail.
		const events = await fs.readFile(
			path.join(directory, '.swarm', 'events.jsonl'),
			'utf-8',
		);
		expect(events).toContain('pr_feedback_rebound');
	});

	test('refuses a no-op rebind to the current intake head', async () => {
		await settleFeedbackWorkflow('CONFIRMED');
		await expect(
			rebindPrFeedbackHead(directory, SESSION_ID, HEAD_SHA),
		).rejects.toThrow(/no-op/);
	});

	test('refuses rebind while publication is armed', async () => {
		await settleFeedbackWorkflow('CONFIRMED');
		commitCountSince = 1;
		currentHead = 'c'.repeat(40); // the one reviewed commit
		await completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA);
		await expect(
			rebindPrFeedbackHead(directory, SESSION_ID, NEW_SHA),
		).rejects.toThrow(/armed/);
	});

	test('refuses rebind when the checkout is not at the new head', async () => {
		await settleFeedbackWorkflow('CONFIRMED');
		// currentHead stays HEAD_SHA while rebinding to NEW_SHA.
		await expect(
			rebindPrFeedbackHead(directory, SESSION_ID, NEW_SHA),
		).rejects.toThrow();
	});
});
