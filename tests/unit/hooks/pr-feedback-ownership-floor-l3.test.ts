/**
 * Issue #3316 AC15 (L3 acceptance, PRESERVING): an ownership declaration that
 * DID settle coverage (a durable FEEDBACK-VERIFIED artifact at the current
 * digest) stays an exclusive claim — a second batch claiming the same item is
 * refused at base AND after the AC14 widening.
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
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'l3-ownership-floor';
const HEAD_SHA = 'abc123';
const ITEM_ID = 'FB-001';
const REVISION = 'revision-1';

let directory = '';
const seamSnapshot = { ..._test_exports };

beforeEach(() => {
	directory = canonicalMkdtemp('l3-owner-floor-');
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

describe('PR_FEEDBACK settled verification ownership stays exclusive (AC15)', () => {
	test('a settled declaration refuses a second batch claiming the same item', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK');
		await declarePrFeedbackInventory(directory, SESSION_ID, [ITEM_ID], {
			prHeadSha: HEAD_SHA,
		});
		await enforcePrFeedbackVerificationOwnership(
			directory,
			SESSION_ID,
			[{ laneId: 'verify-old', ownedItemIds: [ITEM_ID] }],
			{ batchId: 'verify-old', prHeadSha: HEAD_SHA },
		);
		// Settle the declaration: a durable FEEDBACK-VERIFIED artifact at the
		// current digest.
		const correlationId = 'verify-old--verify-old';
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
			batchId: 'verify-old',
			laneId: 'verify-old',
			mode: 'swarm-pr-feedback:verification',
			workflowLane: 'verify-old',
			workspace: {
				directory,
				gitHead: HEAD_SHA,
				dirtyHash: REVISION,
				prHeadSha: HEAD_SHA,
				scope: null,
			},
		});
		const stored = storeLaneOutput(directory, {
			batchId: 'verify-old',
			laneId: 'verify-old',
			agent: 'reviewer',
			role: 'reviewer',
			sessionId: correlationId,
			parentSessionId: SESSION_ID,
			mode: 'swarm-pr-feedback:verification',
			workflowLane: 'verify-old',
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

		await expect(
			enforcePrFeedbackVerificationOwnership(
				directory,
				SESSION_ID,
				[{ laneId: 'verify-new', ownedItemIds: [ITEM_ID] }],
				{ batchId: 'verify-new', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow(/owned by both/);
	});
});
