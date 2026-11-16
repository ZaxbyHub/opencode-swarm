// Issue #3310 AC15 — the critic dispatch phase must not admit the
// critic_finding_validator agent.
//
// The dispatch handler's critic role check accepts any role starting with
// 'critic', so 'critic_finding_validator' — a different QA agent with its own
// tool surface — silently rides a swarm-pr-review:critic lane and the batch is
// recorded against the wrong protocol.
//
// RED at base, GREEN after the fix: dispatching mode 'swarm-pr-review:critic'
// with agent 'critic_finding_validator' is rejected with an error that names
// the agent to use instead (the base 'critic' agent). This suite mirrors the
// end-to-end harness of dispatch-lanes-pr-workflow-gate.test.ts (the 'rejects
// owned_workflow_lanes outside PR_REVIEW discovery lanes' shape): the real
// executeDispatchLanesAsync entry point over a real temp git repository with
// stubbed head/clean/revision reads and a mocked session ops client.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
	recordPrReviewValidationBatch,
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
	directory = canonicalMkdtemp('dispatch-critic-validator-3310-');
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

describe('dispatch_lanes critic agent admission (issue #3310 AC15)', () => {
	test("rejects a critic lane whose agent is 'critic_finding_validator' and names the agent to use instead", async () => {
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:critic',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'critic-lane-3310',
						agent: 'critic_finding_validator',
						prompt: 'Challenge the assigned reviewer verdicts',
						workflow_lane: 'critic-chunk-1',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID: 'critic-validator-3310-session' },
		);
		expect(result.success).toBe(false);
		const message = String(result.message);
		// The rejection names the offending agent...
		expect(message).toContain('critic_finding_validator');
		// ...and the clause naming the agent to use instead. Asserted by its
		// own wording: 'critic' alone is a prefix substring of the rejected
		// agent's name, so it would hold for any message that merely echoes
		// the rejected agent.
		expect(message).toContain('must use the critic agent');
	});

	test("the base 'critic' agent is not swept into the rejection", async () => {
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:critic',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'critic-lane-3310',
						agent: 'critic',
						prompt: 'Challenge the assigned reviewer verdicts',
						workflow_lane: 'critic-chunk-1',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID: 'critic-base-3310-session' },
		);
		// Still blocked later (no completed trigger evaluation on this fresh
		// workflow) — but never by an agent-role rejection, and the validator
		// agent is never named.
		expect(result.success).toBe(false);
		const message = String(result.message);
		expect(message).not.toContain('critic_finding_validator');
		expect(message).not.toContain('uses invalid role');
	});
});

// ---------------------------------------------------------------------------
// Issue #3340 — the critic-role rule moves from the dispatch call site into
// the boundaries that persist and settle verdicts, and the PR_FEEDBACK
// closeout-critic predicate is aligned with it.
// ---------------------------------------------------------------------------
describe('critic admission at the gate boundary (issue #3340)', () => {
	test('AC1 (gate-level, bypasses dispatch): recordPrReviewValidationBatch rejects a critic lane whose agent is critic_finding_validator', async () => {
		// The role assertion runs before any state access, so a bare repository
		// with no workflow bound is enough to prove the gate itself rejects.
		await expect(
			recordPrReviewValidationBatch(
				directory,
				'gate-level-critic-3340',
				'critic',
				[
					{
						laneId: 'gate-critic-lane',
						workflowLane: 'gate-critic-lane',
						reviewItemIds: ['c1'],
						agent: 'critic_finding_validator',
					},
				],
				{ batchId: 'gate-critic-batch', prHeadSha: 'abc123' },
			),
		).rejects.toThrow(/must use the critic agent/);
	});

	test('AC1 (gate-level, bypasses dispatch): a critic lane with no declared agent fails closed', async () => {
		await expect(
			recordPrReviewValidationBatch(
				directory,
				'gate-level-critic-3340',
				'critic',
				[
					{
						laneId: 'gate-critic-lane',
						workflowLane: 'gate-critic-lane',
						reviewItemIds: ['c1'],
					},
				],
				{ batchId: 'gate-critic-batch', prHeadSha: 'abc123' },
			),
		).rejects.toThrow(/must declare its agent/);
	});
});

describe('PR_FEEDBACK closeout-critic role predicate (issue #3340 AC2)', () => {
	const SESSION = 'feedback-critic-predicate-3340';

	test("rejects a closeout-critic lane whose agent is 'critic_finding_validator'", async () => {
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:closeout-critic',
				pr_head_sha: 'abc123',
				max_concurrent: 1,
				lanes: [
					{
						id: 'closeout-critic-lane',
						agent: 'critic_finding_validator',
						prompt: 'Challenge the closeout evidence for FB-001.',
						workflow_lane: 'closeout-critic',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: SESSION },
		);
		expect(result.success).toBe(false);
		const message = String(result.message);
		expect(message).toContain(
			'BLOCKED: PR_FEEDBACK closeout-critic requires workflow_lane "closeout-critic" and role "critic"',
		);
	});

	test("the base 'critic' agent is not swept into the rejection", async () => {
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:closeout-critic',
				pr_head_sha: 'abc123',
				max_concurrent: 1,
				lanes: [
					{
						id: 'closeout-critic-lane',
						agent: 'critic',
						prompt: 'Challenge the closeout evidence for FB-001.',
						workflow_lane: 'closeout-critic',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: SESSION },
		);
		// Blocked later by the missing feedback inventory / Stage A state on
		// this fresh workflow — never by the role predicate.
		expect(result.success).toBe(false);
		const message = String(result.message);
		expect(message).not.toContain('requires workflow_lane');
	});
});

// ---------------------------------------------------------------------------
// Issue #3341 — admission rejections are side-effect-free: validatePrWorkflow
// LaneAdmission runs BEFORE activatePrWorkflow/bindPrReviewBase, so a rejected
// request creates no durable workflow state and preserves any pre-existing
// state structurally (deep equality of the parsed state).
// ---------------------------------------------------------------------------
describe('side-effect-free admission rejection (issue #3341)', () => {
	const rejectedCriticDispatch = (sessionID: string, agent: string) =>
		executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:critic',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'critic-lane-3341',
						agent,
						prompt: 'Challenge the assigned reviewer verdicts',
						workflow_lane: 'critic-chunk-1',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID },
		);

	test('a rejected critic-role dispatch leaves NO gate state on a fresh session', async () => {
		const result = await rejectedCriticDispatch(
			'stateful-critic-3341',
			'critic_finding_validator',
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain('must use the critic agent');
		const state = await readPrWorkflowGateState(
			directory,
			'stateful-critic-3341',
		);
		// Exact absence, not merely a different mode: the request consumed no
		// workflow identity at all.
		expect(state).toBeNull();
	});

	test.each([
		'reviewer',
		'council',
	] as const)('a rejected %s-role dispatch leaves NO gate state on a fresh session', async (phase) => {
		const session = `stateful-${phase}-3341`;
		const result = await executeDispatchLanesAsync(
			{
				mode: `swarm-pr-review:${phase}`,
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: `${phase}-lane-3341`,
						agent: 'critic',
						prompt: 'Challenge',
						workflow_lane: `${phase}-lane`,
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain('uses invalid role');
		expect(await readPrWorkflowGateState(directory, session)).toBeNull();
	});

	// Regression pin (green at base 25a201430): a rejected re-bind of an
	// already-active session with the same head is idempotent, so this case cannot
	// tell the old check ordering from the new one. The #3341 discriminator is
	// dispatch-lanes-state-free-admission-3341.test.ts (its fresh-session cases fail against the PR
	// head f3d60da7e source; its PR_FEEDBACK case is a guard pin).
	test('a rejected dispatch against an ALREADY-ACTIVE session preserves the prior state', async () => {
		const session = 'preexisting-state-3341';
		// The gate-side revision digest must resolve so the request reaches
		// admission; otherwise the critic preflight rejects with a digest error
		// before the role check and the case proves nothing about admission.
		const originalGateDigest = gateInternals.resolvePrWorkflowRevisionDigest;
		gateInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
		try {
			await activatePrWorkflow(directory, session, 'PR_REVIEW', {
				requireCheckoutPreflight: false,
			});
			await bindPrReviewBase(directory, session, {
				prHeadSha: 'abc123',
				baseRef: 'origin/main',
				baseSha: 'def456',
			});
			const before = await readPrWorkflowGateState(directory, session);
			expect(before?.mode).toBe('PR_REVIEW');
			const result = await rejectedCriticDispatch(session, 'explorer');
			expect(result.success).toBe(false);
			// The rejection is the admission role check, not a digest or preflight error.
			expect(String(result.message)).toContain('uses invalid role');
			expect(String(result.message)).not.toContain('could not compute');
			const after = await readPrWorkflowGateState(directory, session);
			// Structural preservation (deep equality of the parsed state): the
			// rejection mutated nothing.
			expect(after).toEqual(before);
		} finally {
			gateInternals.resolvePrWorkflowRevisionDigest = originalGateDigest;
		}
	});

	test('mixed-invalid phase lanes report the owned-workflow-lanes error first (precedence pin)', async () => {
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:critic',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'mixed-lane-3341',
						agent: 'critic_finding_validator',
						prompt: 'Challenge',
						workflow_lane: 'critic-chunk-1',
						review_item_ids: ['c1'],
						owned_workflow_lanes: ['base-dimension-1'],
					},
				],
			},
			directory,
			{ sessionID: 'mixed-invalid-3341' },
		);
		expect(result.success).toBe(false);
		const message = String(result.message);
		expect(message).toContain('must not declare owned_workflow_lanes');
		expect(message).not.toContain('uses invalid role');
	});

	test.each([
		['swarm-pr-review:base', 'base'],
		['swarm-pr-review:micro', 'micro'],
	] as const)('a rejected %s explorer-role dispatch leaves NO gate state', async (mode, kind) => {
		const session = `stateful-${kind}-3341`;
		const result = await executeDispatchLanesAsync(
			{
				mode,
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				batch_id: `${kind}-batch-3341`,
				lanes: [
					{
						id: `${kind}-lane-3341`,
						agent: 'critic',
						prompt: 'Explore',
						workflow_lane:
							kind === 'base' ? 'intent-architecture' : 'auth-identity-secrets',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain(`must use the explorer role`);
		expect(await readPrWorkflowGateState(directory, session)).toBeNull();
	});
});
