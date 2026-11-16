/**
 * Issue #3316 AC14 (L3 acceptance, DISCRIMINATING): an earlier verification
 * ownership declaration that never settled any coverage (no durable artifact)
 * must be superseded by a fresh declaration for the same inventory item. Base
 * behavior treats the stale declaration as a permanent exclusive claim and
 * deadlocks the item.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'l3-ownership-release';
const HEAD_SHA = 'abc123';
const ITEM_ID = 'FB-001';

let directory = '';
const seamSnapshot = { ..._test_exports };

beforeEach(() => {
	directory = canonicalMkdtemp('l3-owner-release-');
	mkdirSync(path.join(directory, '.git'), { recursive: true });
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => 'revision-1';
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

describe('PR_FEEDBACK unsettled verification ownership can be superseded (AC14)', () => {
	test('a new batch may claim an item whose earlier declaration settled zero coverage', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK');
		await declarePrFeedbackInventory(directory, SESSION_ID, [ITEM_ID], {
			prHeadSha: HEAD_SHA,
		});
		// The first declaration is recorded but NEVER settled: no durable
		// FEEDBACK-VERIFIED artifact exists for it (zero coverage).
		await enforcePrFeedbackVerificationOwnership(
			directory,
			SESSION_ID,
			[{ laneId: 'verify-old', ownedItemIds: [ITEM_ID] }],
			{ batchId: 'verify-old', prHeadSha: HEAD_SHA },
		);

		const reassignment = await enforcePrFeedbackVerificationOwnership(
			directory,
			SESSION_ID,
			[{ laneId: 'verify-new', ownedItemIds: [ITEM_ID] }],
			{ batchId: 'verify-new', prHeadSha: HEAD_SHA },
		).then(
			() => 'accepted',
			(error: unknown) => `rejected: ${(error as Error).message}`,
		);
		expect(reassignment).toBe('accepted');
	});
});
