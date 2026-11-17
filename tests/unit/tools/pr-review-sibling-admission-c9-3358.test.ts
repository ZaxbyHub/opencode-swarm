// Issue #3358 (trace AC9, issue AC8) — role admission must be uniform across
// the sibling admission surfaces that require the same verdict-row contract.
//
// The PR_REVIEW council-phase admission loop is prefix-shaped
// (`!role.startsWith('council_')`), so ANY council-prefixed agent name —
// including user-defined roles the council factory never builds — is admitted.
// The factory council roles are exactly council_generalist, council_skeptic,
// and council_domain_expert; admission must accept exactly those three and
// reject every other council_-prefixed role with a BLOCKED invalid-role error.
//
// Pins (all driven through the real executeDispatchLanesAsync entry point over
// a temp git repository with stubbed head/clean/revision/merge-base reads and a
// mocked session-ops client, mirroring
// dispatch-lanes-critic-validator-rejection.test.ts):
//   1. (discriminating) 'council_impostor' (resolves to role
//      'council_impostor', passes today's prefix check) is rejected BY THE
//      INVALID-ROLE ADMISSION ERROR — not merely by the downstream generic
//      launchability net.
//   2. (preserving) the three factory council roles are each admitted past
//      role admission (never rejected with 'uses invalid role').
//   3. (preserving) PR_REVIEW critic phase still requires exactly 'critic'
//      (critic_finding_validator rejected with the invalid-role error).
//   4. (preserving) PR_FEEDBACK closeout-critic still requires exactly 'critic'
//      (critic_finding_validator rejected with the #3340 predicate message).
//
// RED at base, GREEN after the fix.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
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
	directory = canonicalMkdtemp('dispatch-sibling-admission-3358-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async (...args) =>
		dispatchInternals.resolvePrWorkflowRevisionDigest(...args);
	dispatchInternals.resolveExactMergeBase = () => 'def456';
	dispatchInternals.resolveExactMergeBaseAsync = async (...args) =>
		dispatchInternals.resolveExactMergeBase(...args);
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

function councilDispatch(agent: string, sessionID: string) {
	return executeDispatchLanesAsync(
		{
			mode: 'swarm-pr-review:council',
			pr_head_sha: 'abc123',
			base_sha: 'def456',
			base_ref: 'origin/main',
			lanes: [
				{
					id: 'council-lane-3358',
					agent,
					prompt: 'Deliberate on the bound reviewer verdicts.',
					workflow_lane: 'council-chunk-1',
					review_item_ids: ['c1'],
				},
			],
		},
		directory,
		{ sessionID },
	);
}

describe('PR_REVIEW council-phase admission (issue #3358 trace AC9)', () => {
	test("rejects a council_-prefixed non-factory role ('council_impostor') with the invalid-role admission error", async () => {
		// 'council_impostor' is neither a canonical role nor a registered
		// generated name, so resolveGeneratedAgentRole returns it unchanged —
		// the resolved role IS 'council_impostor', which passes today's
		// prefix-shaped check and must be rejected by the tightened admission.
		const result = await councilDispatch(
			'council_impostor',
			'council-impostor-3358-session',
		);
		expect(result.success).toBe(false);
		const message = String(result.message);
		expect(message).toContain('council_impostor');
		// The rejection must come from the invalid-ROLE admission rule. Today
		// the impostor sails past admission and is only caught by the generic
		// launchability net ('is not launchable on this host'), which is not a
		// role-admission rejection.
		expect(message).toContain('uses invalid role');
	});

	for (const factoryRole of [
		'council_generalist',
		'council_skeptic',
		'council_domain_expert',
	] as const) {
		test(`preserving: factory council role '${factoryRole}' is admitted past role admission`, async () => {
			const result = await councilDispatch(
				factoryRole,
				`council-${factoryRole}-3358-session`,
			);
			// The dispatch may still be blocked later on this fresh workflow
			// (missing reviewer-phase state, launchability, ...) — but never by
			// the role-admission rule, whose rejection text is 'uses invalid
			// role'.
			const message = String(result.message ?? '');
			expect(message).not.toContain('uses invalid role');
		});
	}
});

describe('sibling surfaces keep their exact-role predicates (issue #3358 trace AC9)', () => {
	test("preserving: PR_REVIEW critic phase still rejects 'critic_finding_validator' by role", async () => {
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:critic',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'critic-lane-3358',
						agent: 'critic_finding_validator',
						prompt: 'Challenge the assigned reviewer verdicts',
						workflow_lane: 'critic-chunk-1',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID: 'sibling-critic-3358-session' },
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain('uses invalid role');
	});

	test("preserving: PR_FEEDBACK closeout-critic still rejects 'critic_finding_validator' by role", async () => {
		const sessionID = 'sibling-closeout-3358-session';
		await activatePrWorkflow(directory, sessionID, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:closeout-critic',
				pr_head_sha: 'abc123',
				max_concurrent: 1,
				lanes: [
					{
						id: 'closeout-critic-lane-3358',
						agent: 'critic_finding_validator',
						prompt: 'Challenge the closeout evidence for FB-001.',
						workflow_lane: 'closeout-critic',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID },
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain(
			'BLOCKED: PR_FEEDBACK closeout-critic requires workflow_lane "closeout-critic" and role "critic"',
		);
	});
});
