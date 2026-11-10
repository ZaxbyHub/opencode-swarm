// Issue #3341 — the state-free request-shape checks (unknown swarm-pr-review:*
// suffixes, the contract-retry exclusion, and the wave-stage/attempt pairing)
// are validated in validatePrWorkflowLaneAdmission BEFORE activation, so each
// rejection leaves no gate state on a fresh session. This suite uses the same
// end-to-end harness as dispatch-lanes-critic-validator-rejection.test.ts: the
// real executeDispatchLanesAsync entry point over a real temp git repository
// with stubbed head/clean/revision reads and a mocked session ops client.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';
import {
	installLegacyPrReviewPolicy,
	restorePrReviewPolicy,
} from './dispatch-lanes-pr-workflow-gate.test-fixtures.js';

let directory = '';
const originalGetSessionOps = dispatchInternals.getSessionOps;
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalResolveDiffStats = gateInternals.resolvePrReviewDiffStats;
const originalResolveDiffStatsAsync =
	gateInternals.resolvePrReviewDiffStatsAsync;
const originalResolveRevision =
	dispatchInternals.resolvePrWorkflowRevisionDigest;
const originalResolveRevisionAsync =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalResolveMergeBase = dispatchInternals.resolveExactMergeBase;
const originalResolveMergeBaseAsync =
	dispatchInternals.resolveExactMergeBaseAsync;

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-state-free-admission-3341-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolvePrReviewDiffStatsAsync = async (...a) =>
		gateInternals.resolvePrReviewDiffStats(...a);
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async (...a) =>
		dispatchInternals.resolvePrWorkflowRevisionDigest(...a);
	dispatchInternals.resolveExactMergeBase = () => 'def456';
	dispatchInternals.resolveExactMergeBaseAsync = async (...a) =>
		dispatchInternals.resolveExactMergeBase(...a);
	installLegacyPrReviewPolicy();
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({ data: { id: 'lane-session' } })),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	gateInternals.resolvePrReviewDiffStats = originalResolveDiffStats;
	gateInternals.resolvePrReviewDiffStatsAsync = originalResolveDiffStatsAsync;
	dispatchInternals.resolvePrWorkflowRevisionDigest = originalResolveRevision;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originalResolveRevisionAsync;
	dispatchInternals.resolveExactMergeBase = originalResolveMergeBase;
	dispatchInternals.resolveExactMergeBaseAsync = originalResolveMergeBaseAsync;
	restorePrReviewPolicy();
	dispatchInternals.getSessionOps = originalGetSessionOps;
	safeRmRecursive(directory);
});

describe('state-free request-shape rejection before activation (issue #3341)', () => {
	test('an unknown swarm-pr-review:* suffix leaves NO gate state', async () => {
		const session = 'unknown-suffix-3341';
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:typo',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'typo-lane-3341',
						agent: 'explorer',
						prompt: 'Explore',
						workflow_lane: 'intent-architecture',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain(
			'requires a structured base, micro, council, reviewer, or critic mode',
		);
		expect(await readPrWorkflowGateState(directory, session)).toBeNull();
	});

	test('a contract retry combined with a wave stage leaves NO gate state', async () => {
		const session = 'contract-retry-waves-3341';
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_contract_retry: true,
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				lanes: [
					{
						id: 'retry-waves-3341',
						agent: 'explorer',
						prompt: 'Explore',
						workflow_lane: 'intent-architecture',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain(
			'contract retry is mutually exclusive with pr_review_wave_stage and pr_review_wave_attempt',
		);
		expect(await readPrWorkflowGateState(directory, session)).toBeNull();
	});

	test('a contract retry combined with a wave stage alone (no attempt) leaves NO gate state', async () => {
		const session = 'retry-stage-only-3341';
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_contract_retry: true,
				pr_review_wave_stage: 'canary',
				lanes: [
					{
						id: 'retry-stage-only-lane-3341',
						agent: 'explorer',
						prompt: 'Explore',
						workflow_lane: 'intent-architecture',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain(
			'contract retry is mutually exclusive with pr_review_wave_stage and pr_review_wave_attempt',
		);
		expect(await readPrWorkflowGateState(directory, session)).toBeNull();
	});

	test('a non-explorer swarm-pr-review:base dispatch into an active PR_FEEDBACK session is not rejected by the #3341 role check', async () => {
		const session = 'active-feedback-guard-3341';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const before = await readPrWorkflowGateState(directory, session);
		expect(before).not.toBeNull();
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'active-feedback-guard-lane-3341',
						agent: 'critic',
						prompt: 'Challenge',
						workflow_lane: 'intent-architecture',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		// The hoisted checks are scoped to requests that reach admission for a
		// PR_REVIEW (or absent) gate. For a session already owned by PR_FEEDBACK
		// the explorer-role rejection must not fire, and the gate must be unchanged.
		expect(String(result.message)).not.toContain('must use the explorer role');
		expect(await readPrWorkflowGateState(directory, session)).toEqual(before);
	});

	test('a wave stage without a wave attempt leaves NO gate state', async () => {
		const session = 'wave-pair-3341';
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				lanes: [
					{
						id: 'wave-pair-lane-3341',
						agent: 'explorer',
						prompt: 'Explore',
						workflow_lane: 'intent-architecture',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain(
			'requires both pr_review_wave_stage and pr_review_wave_attempt together',
		);
		expect(await readPrWorkflowGateState(directory, session)).toBeNull();
	});
});
