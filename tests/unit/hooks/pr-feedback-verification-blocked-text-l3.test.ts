/**
 * Issue #3316 AC4 (L3 acceptance, DISCRIMINATING): when a PR_FEEDBACK direct
 * write is refused because the digest-bound verification went stale, the
 * refusal must carry the actionable recovery directive — re-dispatch the
 * verification mode. Base message names only the missing items, leaving the
 * operator without the next step.
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
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'l3-blocked-text';
const HEAD_SHA = 'abc123';
const D0 = 'revision-1';
const D1 = 'revision-2';
const ITEM_ID = 'FB-001';

let directory = '';
let currentDigest = D0;
const seamSnapshot = { ..._test_exports };

beforeEach(() => {
	directory = canonicalMkdtemp('l3-blocked-text-');
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

describe('PR_FEEDBACK stale-verification refusal carries the recovery directive (AC4)', () => {
	test('an out-of-scope direct write after the digest change names the re-dispatch command', async () => {
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

		currentDigest = D1;

		let blocked: Error | undefined;
		try {
			await enforcePrWorkflowToolBefore(
				directory,
				SESSION_ID,
				'edit',
				{ path: 'src/outside.ts' },
				[],
				'call-recovery-text',
			);
		} catch (error) {
			blocked = error as Error;
		}
		expect(blocked).toBeInstanceOf(Error);
		expect(blocked?.message).toContain(
			're-dispatch swarm-pr-feedback:verification',
		);
	});
});
