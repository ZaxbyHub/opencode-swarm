/**
 * Issue #3316 AC21 (L3 acceptance, DISCRIMINATING): transport-recovery
 * validation must accept the "APPROVED" natural-language verdict for the
 * APPROVE-class PR_FEEDBACK gate phases, exactly like the settle path (AC20).
 * Base behavior demands the exact token "APPROVE" and reports the durable
 * artifact as missing its positive verdict row.
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
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	recordPrFeedbackGateBatch,
	recordPrFeedbackStageA,
	validatePrWorkflowTransportRecovery,
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'l3-vocab-recovery';
const HEAD_SHA = 'abc123';
const REVISION = 'revision-1';
const ITEM_ID = 'FB-001';

let directory = '';
const seamSnapshot = { ..._test_exports };

beforeEach(() => {
	directory = canonicalMkdtemp('l3-vocab-rec-');
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

describe('PR_FEEDBACK gate APPROVED vocabulary in transport recovery (AC21)', () => {
	test('an APPROVED stage-b-reviewer row validates for truncated-preview recovery', async () => {
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
		await recordPrFeedbackGateBatch(
			directory,
			SESSION_ID,
			'stage-b-reviewer',
			{ laneId: 'stage-b-reviewer', ownedItemIds: [ITEM_ID] },
			{ batchId: 'gate-review', prHeadSha: HEAD_SHA, revisionDigest: REVISION },
		);
		const artifactText = `[STAGE-B-REVIEW] | ${ITEM_ID} | APPROVED | evidence`;
		const stored = await persistLaneArtifact({
			batchId: 'gate-review',
			laneId: 'stage-b-reviewer',
			mode: 'swarm-pr-feedback:stage-b-reviewer',
			role: 'reviewer',
			text: artifactText,
		});

		const record = findByCorrelationId(
			directory,
			'gate-review--stage-b-reviewer',
		);
		expect(record).not.toBeNull();
		const artifact = readLaneOutput(directory, stored.ref)?.artifact ?? null;
		expect(artifact).not.toBeNull();

		const verdict = await validatePrWorkflowTransportRecovery({
			directory,
			record: record!,
			result: {
				text: artifactText.slice(0, 20),
				chars: stored.chars,
				truncated: true,
				digest: stored.digest,
				outputRef: stored.ref,
			},
			artifact,
			revisionDigest: REVISION,
		});
		expect(
			verdict.ok
				? 'recovery accepted APPROVED rows'
				: `recovery rejected: ${verdict.reason ?? '(no reason)'}`,
		).toBe('recovery accepted APPROVED rows');
	});
});
