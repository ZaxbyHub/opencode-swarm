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
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
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
	settleDispatchedBaseLanes,
	uniqueSessionOps,
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

	test('an unknown swarm-pr-review:* suffix into an active PR_FEEDBACK session is not pre-rejected by the hoisted checks', async () => {
		const session = 'unknown-suffix-feedback-guard-3341';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const before = await readPrWorkflowGateState(directory, session);
		expect(before).not.toBeNull();
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:typo',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'unknown-suffix-feedback-lane-3341',
						agent: 'explorer',
						prompt: 'Probe',
						workflow_lane: 'intent-architecture',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		// The reachability argument is `!gateState || gateState.mode ===
		// 'PR_REVIEW'`, so a session owned by PR_FEEDBACK leaves the hoisted
		// checks short-circuited: the unknown-suffix rejection must NOT fire
		// here (it fires only for a PR_REVIEW or absent gate), and the
		// pre-existing gate must survive unchanged. This is the guard a
		// post-merge review asked us to pin — the hoist must not widen the
		// rejected-request set for foreign-mode sessions.
		expect(String(result.message)).not.toContain(
			'requires a structured base, micro, council, reviewer, or critic mode',
		);
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

describe('pre-activation agent launchability for base and critic lanes (issue #3644 AC2)', () => {
	// #3644 AC2: on a prefixed-only multi-swarm host (only mega_explorer and
	// mega_critic registered) a bare "explorer" lane agent resolves to its
	// canonical ROLE, so the base/micro admission arms — which check the
	// explorer role only — wave an otherwise-VALID request through. The #2614
	// registry check inside validateLaneAgent ("not registered on this host")
	// then runs only inside launchAsyncLane, AFTER activation, base binding,
	// and the base/micro batch recording consumed durable gate state. Both
	// discovery legs below are otherwise-valid requests that provably REACH
	// that launch-time refusal at base, and pin the fix's contract: the probe
	// rejects pre-activation with the "is not launchable on this host"
	// phrasing the council/reviewer/critic phases already use.
	const originalGetGeneratedAgentNames =
		dispatchInternals.getGeneratedAgentNames;
	const originalGateResolveRevisionDigest =
		gateInternals.resolvePrWorkflowRevisionDigest;

	beforeEach(() => {
		// Keep the gate's own digest seam on the dispatch's stubbed digest so
		// the seeded-base settlement derivation stays accurate.
		gateInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	});

	afterEach(() => {
		dispatchInternals.getGeneratedAgentNames = originalGetGeneratedAgentNames;
		gateInternals.resolvePrWorkflowRevisionDigest =
			originalGateResolveRevisionDigest;
	});

	function stubPrefixedOnlyRegistry(): void {
		dispatchInternals.getGeneratedAgentNames = () => [
			'mega_explorer',
			'mega_critic',
		];
	}

	// The async lane-rejection return shape carries no top-level message —
	// the raw launch-time refusal text lives in lane_results[].error. Post-fix
	// the rejection moves into admission, which DOES set message; reading
	// message first keeps the reachability control meaningful at base.
	function dispatchMessageText(result: {
		message?: string;
		lane_results?: Array<{ error?: string }>;
	}): string {
		return String(
			result.message ??
				(result.lane_results ?? []).map((lane) => lane.error ?? '').join('; '),
		);
	}

	const baseDimensionLanes = (prefix: string) =>
		PR_REVIEW_BASE_DIMENSION_IDS.map((dimension) => ({
			id: `${prefix}-${dimension}`,
			agent: 'explorer',
			prompt: `Explore ${dimension}`,
			workflow_lane: dimension,
		}));

	test('an otherwise-valid tier-L base dispatch with an unregistered agent is refused BEFORE activation', async () => {
		stubPrefixedOnlyRegistry();
		const session = 'base-unlaunchable-3644';
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: baseDimensionLanes('base-unlaunchable-3644'),
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		// Reachability control: PASSES at base — the raw launch-time refusal
		// proves the valid request reached launchAsyncLane.
		expect(dispatchMessageText(result)).toContain(
			'not registered on this host',
		);
		// Discriminating (RED at base): the refusal must arrive as a
		// pre-activation admission rejection wrapping the registry error.
		expect(dispatchMessageText(result)).toContain(
			'is not launchable on this host',
		);
		expect(await readPrWorkflowGateState(directory, session)).toBeNull();
	}, 60_000);

	test('an otherwise-valid micro dispatch with an unregistered agent leaves the gate state unchanged', async () => {
		const session = 'micro-unlaunchable-3644';
		// Seed an established tier-L base via a real dispatch. The seed uses
		// the REAL (empty-in-tests) agent registry with bare 'explorer' — the
		// admission ROLE check reads swarmState directly (not the _internals
		// seam), so a prefixed name like 'mega_explorer' would fail it — and
		// unique session ids so all six lanes can launch.
		uniqueSessionOps();
		const seedConfig = dispatchInternals.loadPluginConfig;
		dispatchInternals.loadPluginConfig = (dir: string) => ({
			...seedConfig(dir),
			pr_review_legacy_transcript_compatibility: true,
		});
		const seed = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: baseDimensionLanes('micro-seed-3644'),
			},
			directory,
			{ sessionID: session },
		);
		dispatchInternals.loadPluginConfig = seedConfig;
		expect(seed.success).toBe(true);
		await settleDispatchedBaseLanes(directory, String(seed.batch_id), session, {
			expectedLaneCount: 6,
			revisionDigest: 'revision-1',
			scope: 'complete PR diff def456...abc123',
		});
		// NOW stub the registry: the bare 'explorer' micro lane agent passes
		// the admission ROLE check but must be refused as unlaunchable without
		// consuming any further state.
		stubPrefixedOnlyRegistry();
		const before = await readPrWorkflowGateState(directory, session);
		expect(before).not.toBeNull();
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:micro',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 1,
				trigger_evaluation: PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map(
					(triggerId) => ({
						trigger_id: triggerId,
						result:
							// 'unclassified-risk' (the fallback family) must stay MATCHED.
							triggerId === 'test-infrastructure' ||
							triggerId === 'unclassified-risk'
								? ('MATCHED' as const)
								: ('NOT_TRIGGERED' as const),
						evidence: `Focused diff evaluation for ${triggerId}`,
					}),
				),
				lanes: [
					{
						id: 'micro-unlaunchable-3644',
						agent: 'explorer',
						prompt: 'Review the exact PR diff for this risk family.',
						// Schema: micro workflow_lane must be a micro trigger id.
						workflow_lane: 'test-infrastructure',
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		// At base this snapshot comparison is the leg's frozen failure
		// signature: the launch-time refusal runs only AFTER the trigger-ledger
		// bind and micro family-dispatch recording have mutated the state.
		expect(await readPrWorkflowGateState(directory, session)).toEqual(before);
		expect(dispatchMessageText(result)).toContain(
			'is not launchable on this host',
		);
	}, 60_000);

	test('a swarm-pr-review:critic lane agent unregistered on a prefixed-only host is already refused pre-activation (ABSORB pin)', async () => {
		// Preserving leg: the critic phase already probes launchability inside
		// assertPrReviewPhaseLaneAdmission BEFORE activation (#3358 AC8/AC11),
		// so this leg is GREEN at base — it pins that ordering so the #3644
		// fix cannot regress it while extending the probe to base/micro.
		stubPrefixedOnlyRegistry();
		const session = 'critic-unlaunchable-3644';
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:critic',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'critic-unlaunchable-3644',
						agent: 'critic',
						prompt: 'Challenge the assigned reviewer verdicts',
						workflow_lane: 'critic-chunk-1',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain('is not launchable on this host');
		expect(await readPrWorkflowGateState(directory, session)).toBeNull();
	}, 60_000);
});
