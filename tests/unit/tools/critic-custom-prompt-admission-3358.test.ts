/**
 * Issue #3358 AC3 rider tests: PR critic-lane admission refuses a critic
 * agent registered with a custom prompt (critic.md replacement or
 * critic_append.md append), consulted through the registration-time
 * provenance record keyed by the lowercased registered name (the generated
 * registry matches case-insensitively, so the lookup must too).
 *
 * RED at base (no provenance surface existed), GREEN after the fix.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	clearCriticPromptProvenance,
	recordCriticPromptProvenance,
} from '../../../src/agents/critic.js';
import {
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { resetSwarmState, swarmState } from '../../../src/state.js';
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
const originalGateResolveRevision =
	gateInternals.resolvePrWorkflowRevisionDigest;
const originalGateResolveRevisionAsync =
	gateInternals.resolvePrWorkflowRevisionDigestAsync;
const originalResolveRevision =
	dispatchInternals.resolvePrWorkflowRevisionDigest;
const originalResolveRevisionAsync =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalResolveMergeBase = dispatchInternals.resolveExactMergeBase;
const originalResolveMergeBaseAsync =
	dispatchInternals.resolveExactMergeBaseAsync;

let directory = '';

async function resetHarness(): Promise<void> {
	resetSwarmState();
	swarmState.generatedAgentNames = ['critic', 'Local_Critic'];
	clearCriticPromptProvenance();
	recordCriticPromptProvenance('critic', { replaced: false, appended: false });
	recordCriticPromptProvenance('Local_Critic', {
		replaced: false,
		appended: false,
	});
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
	gateInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	gateInternals.resolvePrWorkflowRevisionDigestAsync = async (...a) =>
		gateInternals.resolvePrWorkflowRevisionDigest(...a);
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async (...a) =>
		dispatchInternals.resolvePrWorkflowRevisionDigest(...a);
	dispatchInternals.resolveExactMergeBase = () => 'def456';
	dispatchInternals.resolveExactMergeBaseAsync = async (...a) =>
		dispatchInternals.resolveExactMergeBase(...a);
	installLegacyPrReviewPolicy();
	dispatchInternals.getSessionOps = () => ({
		create: () => Promise.resolve({ data: { id: 'lane-session' } }),
		promptAsync: () => Promise.resolve({ data: undefined, error: undefined }),
		delete: () => Promise.resolve(undefined),
	});
}

function criticDispatch(agent: string) {
	return executeDispatchLanesAsync(
		{
			mode: 'swarm-pr-review:critic',
			pr_head_sha: 'abc123',
			base_sha: 'def456',
			base_ref: 'origin/main',
			lanes: [
				{
					id: 'critic-lane-c3r',
					agent,
					prompt: 'Challenge the assigned reviewer verdicts.',
					workflow_lane: 'critic-chunk-1',
					review_item_ids: ['c1'],
				},
			],
		},
		directory,
		{ sessionID: 'critic-provenance-3358' },
	) as Promise<{ success: boolean; message?: string }>;
}

describe('PR critic admission vs custom critic prompts (#3358 AC3)', () => {
	afterEach(async () => {
		gateInternals.resetTrackedStateCache();
		gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
		gateInternals.resolveCurrentGitHeadAsync =
			originalResolveCurrentGitHeadAsync;
		gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
		gateInternals.resolveIsWorkingTreeCleanAsync =
			originalResolveIsWorkingTreeCleanAsync;
		gateInternals.resolvePrReviewDiffStats = originalResolveDiffStats;
		// F-004: restore (never delete) the gate digest seams — deleting left
		// the shared module object missing two own members, and a later
		// same-process suite's gate-context creation threw on the restored
		// identity check (co-run probe: critic-preflight-single-composition
		// went 1/2 after this file ran in one bun process).
		gateInternals.resolvePrWorkflowRevisionDigest = originalGateResolveRevision;
		gateInternals.resolvePrWorkflowRevisionDigestAsync =
			originalGateResolveRevisionAsync;
		gateInternals.resolvePrReviewDiffStatsAsync = originalResolveDiffStatsAsync;
		// F-004 (second surface): the critic provenance registry is module
		// state shared across suites; its last test leaves 'critic' recorded
		// with replacement provenance, which BLOCKED the next file's critic
		// dispatch with "registered with a custom critic prompt". Clear it.
		clearCriticPromptProvenance();
		dispatchInternals.resolvePrWorkflowRevisionDigest = originalResolveRevision;
		dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
			originalResolveRevisionAsync;
		dispatchInternals.resolveExactMergeBase = originalResolveMergeBase;
		dispatchInternals.resolveExactMergeBaseAsync =
			originalResolveMergeBaseAsync;
		restorePrReviewPolicy();
		dispatchInternals.getSessionOps = originalGetSessionOps;
		resetSwarmState();
		safeRmRecursive(directory);
	});

	test('replacement provenance rejects the dispatch before activation, gate untouched', async () => {
		directory = canonicalMkdtemp('c3r-replaced-');
		await resetHarness();
		recordCriticPromptProvenance('critic', {
			replaced: true,
			appended: false,
		});
		const before = await readPrWorkflowGateState(
			directory,
			'critic-provenance-3358',
		);
		const result = await criticDispatch('critic');
		expect(result.success).toBe(false);
		expect(result.message ?? '').toContain('custom critic prompt');
		const after = await readPrWorkflowGateState(
			directory,
			'critic-provenance-3358',
		);
		expect(after).toStrictEqual(before);
	});

	test('append provenance is refused as well', async () => {
		directory = canonicalMkdtemp('c3r-appended-');
		await resetHarness();
		recordCriticPromptProvenance('critic', {
			replaced: false,
			appended: true,
		});
		const result = await criticDispatch('critic');
		expect(result.success).toBe(false);
		expect(result.message ?? '').toContain('critic_append.md');
	});

	test('case variants resolve to the same provenance record (CRITIC, mixed-case prefixed)', async () => {
		directory = canonicalMkdtemp('c3r-case-');
		await resetHarness();
		recordCriticPromptProvenance('Local_Critic', {
			replaced: true,
			appended: false,
		});
		// CRITIC resolves to the DEFAULT critic (no custom prompt): admission
		// must NOT refuse it — a later failure may come from unrelated
		// workflow preconditions (trigger evaluation), never the prompt rule.
		const upper = await criticDispatch('CRITIC');
		expect(upper.message ?? '').not.toContain('custom critic prompt');
		// Fresh harness: the first (admitted) dispatch mutates gate state that
		// would mask the admission outcome of the second.
		safeRmRecursive(directory);
		directory = canonicalMkdtemp('c3r-case2-');
		await resetHarness();
		recordCriticPromptProvenance('Local_Critic', {
			replaced: true,
			appended: false,
		});
		// The mixed-case prefixed spelling hits the replaced provenance record
		// through the same case-insensitive registry lookup.
		const prefixed = await criticDispatch('local_critic');
		expect(prefixed.success).toBe(false);
		expect(prefixed.message ?? '').toContain('custom critic prompt');
	});

	test('default provenance is admitted past the prompt rule', async () => {
		directory = canonicalMkdtemp('c3r-default-');
		await resetHarness();
		const result = await criticDispatch('critic');
		// Admission passes; a dispatch may still fail on unrelated workflow
		// preconditions (e.g. trigger evaluation), which is out of this rule's
		// scope — the assertion is that the custom-prompt refusal never fires.
		expect(result.message ?? '').not.toContain('custom critic prompt');
	});

	test('an already-activated and base-bound gate is untouched by a refused dispatch', async () => {
		directory = canonicalMkdtemp('c3r-bound-');
		await resetHarness();
		// Activate + bind first (the #3341 mid-workflow state).
		const gate = await import('../../../src/hooks/pr-workflow-gate.js');
		await gate.activatePrWorkflow(
			directory,
			'critic-provenance-3358',
			'PR_REVIEW',
		);
		await gate.bindPrReviewBase(directory, 'critic-provenance-3358', {
			prHeadSha: 'abc123',
			baseRef: 'origin/main',
			baseSha: 'def456',
		});
		gateInternals.resetTrackedStateCache();
		const before = await readPrWorkflowGateState(
			directory,
			'critic-provenance-3358',
		);
		expect(before?.mode).toBe('PR_REVIEW');
		recordCriticPromptProvenance('critic', {
			replaced: true,
			appended: false,
		});
		const result = await criticDispatch('critic');
		expect(result.success).toBe(false);
		expect(result.message ?? '').toContain('custom critic prompt');
		const after = await readPrWorkflowGateState(
			directory,
			'critic-provenance-3358',
		);
		expect(after).toStrictEqual(before);
	});

	test('provenance consults registration memory, not the prompts directory', async () => {
		directory = canonicalMkdtemp('c3r-memory-');
		await resetHarness();
		// Replace provenance after "registration", then clear the registry entry
		// the way a restart would NOT (provenance survives; the dispatch must
		// still refuse) — proving the lookup reads the recorded provenance.
		recordCriticPromptProvenance('critic', {
			replaced: true,
			appended: false,
		});
		swarmState.generatedAgentNames = ['critic'];
		const result = await criticDispatch('critic');
		expect(result.success).toBe(false);
	});
});
