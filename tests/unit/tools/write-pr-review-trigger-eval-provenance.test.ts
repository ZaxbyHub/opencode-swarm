import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	bindPrReviewTriggerLedger,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval';

// Split from write-pr-review-trigger-eval.test.ts (FR-006): tests specifically
// about a cited lane's provenance/ownership relationship to the trigger rows
// it backs — consolidated-ownership acceptance/rejection, cross-batch
// ownership disjointness, and trigger-ID namespace diagnostics.

const tempDirs: string[] = [];
const SESSION_ID = 'trigger-eval-session';
const HEAD_SHA = 'abc123';
const REVISION_DIGEST = 'review-revision';
const REVIEW_SCOPE = `complete PR diff def456...${HEAD_SHA}`;
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalGateRevisionDigest =
	gateInternals.resolvePrWorkflowRevisionDigest;
const originalResolveRevisionDigest =
	writerInternals.resolvePrWorkflowRevisionDigest;
const originalResolveMergeBase = writerInternals.resolveMergeBase;
const originalResolveDiffStats = gateInternals.resolvePrReviewDiffStats;
const originalResolveDiffStatsAsync =
	gateInternals.resolvePrReviewDiffStatsAsync;

// Deterministic diff-stat fixtures for the controller depth tier. Without an
// override the real numstat resolver runs against a git-less temp dir and fails
// strict to tier L; the micro-lane floor (issue #1936) is tier-sensitive, so the
// consolidated-ownership cases pin an explicit tier.
const DIFF_STATS_BY_TIER = {
	S: { changedLines: 10, changedFiles: 1, hasSubmoduleChange: false },
	M: { changedLines: 300, changedFiles: 12, hasSubmoduleChange: false },
	L: null,
} as const;

function tempRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'trigger-eval-')));
	tempDirs.push(root);
	return root;
}

function rows() {
	return PR_REVIEW_TRIGGER_DEFINITIONS.map((definition, index) => ({
		trigger_id: definition.id,
		result: 'MATCHED' as const,
		evidence: `mandatory review focus for ${definition.id}`,
		source_batch_id: `micro-batch-${Math.floor(index / 8)}`,
		source_lane_id: `lane-${index}`,
	}));
}

async function recordCompletedLane(
	root: string,
	input: {
		batchId: string;
		laneId: string;
		workflowLane: string;
		mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro';
		ownedWorkflowLanes?: string[];
	},
): Promise<void> {
	const correlationId = `${input.batchId}-${input.laneId}-session`;
	const header =
		input.mode === 'swarm-pr-review:base'
			? '[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence'
			: '[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence';
	const cleanRows = (input.ownedWorkflowLanes ?? [input.workflowLane])
		.map(
			(family) =>
				`[CLEAN] | ${family} | exact reviewed diff | no candidate survived the focused review`,
		)
		.join('\n');
	const text = `${header}\n${cleanRows}`;
	await recordPendingDelegation(root, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${input.batchId}-call`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: input.batchId,
		laneId: input.laneId,
		mode: input.mode,
		workflowLane: input.workflowLane,
		ownedWorkflowLanes: input.ownedWorkflowLanes,
		workspace: {
			directory: root,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: REVIEW_SCOPE,
		},
	});
	const stored = storeLaneOutput(root, {
		batchId: input.batchId,
		laneId: input.laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: input.mode,
		workflowLane: input.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: REVIEW_SCOPE,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(root, correlationId, {
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

async function establishBoundReviewGate(
	root: string,
	options: { consolidatedMicro?: boolean; depthTier?: 'S' | 'M' | 'L' } = {},
): Promise<void> {
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	if (options.depthTier) {
		const stats = DIFF_STATS_BY_TIER[options.depthTier];
		gateInternals.resolvePrReviewDiffStats = () => stats;
	}
	writerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolveMergeBase = () => 'def456';
	// Gate bind/verify resolves Git off the blocking spawn; route the async
	// resolvers through the sync stubs above.
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolvePrReviewDiffStatsAsync = async (dir, base, head) =>
		gateInternals.resolvePrReviewDiffStats(dir, base, head);
	await activatePrWorkflow(root, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(root, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: 'def456',
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(root, SESSION_ID, baseLanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
	});
	for (const lane of baseLanes) {
		await recordCompletedLane(root, {
			batchId: 'base-all',
			laneId: lane.laneId,
			workflowLane: lane.workflowLane,
			mode: 'swarm-pr-review:base',
		});
	}
	await bindPrReviewTriggerLedger(
		root,
		SESSION_ID,
		rows().map(({ trigger_id, result, evidence }) => ({
			trigger_id,
			result,
			evidence,
		})),
	);
	if (options.consolidatedMicro) {
		const sweepA = [...PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(0, 6)];
		const sweepB = [...PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(6)];
		await recordCompletedLane(root, {
			batchId: 'micro-consolidated',
			laneId: 'sweep-a',
			workflowLane: sweepA[0],
			ownedWorkflowLanes: sweepA,
			mode: 'swarm-pr-review:micro',
		});
		await recordCompletedLane(root, {
			batchId: 'micro-consolidated',
			laneId: 'sweep-b',
			workflowLane: sweepB[0],
			ownedWorkflowLanes: sweepB,
			mode: 'swarm-pr-review:micro',
		});
		return;
	}
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		await recordCompletedLane(root, {
			batchId: `micro-batch-${Math.floor(index / 8)}`,
			laneId: `lane-${index}`,
			workflowLane,
			mode: 'swarm-pr-review:micro',
		});
	}
}

afterEach(() => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originalGateRevisionDigest;
	writerInternals.resolvePrWorkflowRevisionDigest =
		originalResolveRevisionDigest;
	writerInternals.resolveMergeBase = originalResolveMergeBase;
	gateInternals.resolvePrReviewDiffStats = originalResolveDiffStats;
	gateInternals.resolvePrReviewDiffStatsAsync = originalResolveDiffStatsAsync;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('write_pr_review_trigger_eval provenance and ownership', () => {
	test('unknown-trigger-IDs error lists valid IDs and namespace boundaries (issue #1931)', async () => {
		// The reporter of #1931 fed the validator mode strings and base-lane
		// IDs. The error must surface the 11 valid micro-lane IDs and call
		// out the three namespaces so the next call succeeds.
		const confusedRows = [
			...rows().slice(0, 10),
			{
				trigger_id: 'swarm-pr-review:base',
				result: 'MATCHED' as const,
				evidence: 'confused mode string for trigger_id',
				source_batch_id: 'confused-batch',
				source_lane_id: 'confused-lane',
			},
		];
		const result = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-1931',
					pr_head_sha: 'abc123',
					rows: confusedRows,
				},
				tempRoot(),
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('unknown trigger IDs');
		// Must list ALL 11 valid IDs (issue #1931 reviewer item: a regression
		// that drops any ID from the error must fail this test).
		for (const validId of [
			'auth-identity-secrets',
			'untrusted-input-boundaries',
			'subprocess-platform',
			'concurrency-state',
			'dependencies-build-release',
			'api-schema-migrations',
			'test-infrastructure',
			'ui-accessibility-i18n',
			'privacy-observability',
			'generated-provenance',
			'unclassified-risk',
		]) {
			expect(result.message).toContain(validId);
		}
		// Must call out that base-lane IDs and mode strings are not trigger IDs.
		expect(result.message).toMatch(/base-lane IDs/i);
		expect(result.message).toMatch(/mode strings/i);
		expect(result.message).toMatch(/swarm-pr-review:base/);
	});

	test('rejects a shared dispatch tuple whose lane never declared consolidated ownership', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const duplicate = rows();
		duplicate[1] = {
			...duplicate[0],
			trigger_id: duplicate[1].trigger_id,
			evidence: duplicate[1].evidence,
		};
		const duplicateResult = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-1805',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: duplicate,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(duplicateResult.success).toBe(false);
		expect(duplicateResult.message).toContain(
			'does not reference a completed non-degraded micro-lane artifact',
		);
	});

	test('accepts consolidated micro lanes that declared and attested every owned family (tier S — floor does not bind)', async () => {
		const root = tempRoot();
		// Tier S: the micro-lane floor (issue #1936) is 1, so a two-lane
		// consolidation of all eleven families is legal on the smallest PRs.
		await establishBoundReviewGate(root, {
			consolidatedMicro: true,
			depthTier: 'S',
		});
		const sweepAFamilies = PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(0, 6);
		const consolidated = rows().map((row) => ({
			...row,
			source_batch_id: 'micro-consolidated',
			source_lane_id: (sweepAFamilies as readonly string[]).includes(
				row.trigger_id,
			)
				? 'sweep-a'
				: 'sweep-b',
		}));
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-consolidated',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: consolidated,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response).toMatchObject({
			success: true,
			matched_count: PR_REVIEW_TRIGGER_DEFINITIONS.length,
			no_match_count: 0,
			dispatched_micro_lane_count: 2,
		});
	});

	test('rejects a below-floor consolidated micro attestation at tier M (issue #1936 aggregate floor)', async () => {
		const root = tempRoot();
		// Tier M: the floor is 6. A durable attestation attributing all eleven
		// families to only two dispatch lanes under-consolidates the record and
		// must be rejected — including split-batch dodges of the dispatch floor.
		await establishBoundReviewGate(root, {
			consolidatedMicro: true,
			depthTier: 'M',
		});
		const sweepAFamilies = PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(0, 6);
		const consolidated = rows().map((row) => ({
			...row,
			source_batch_id: 'micro-consolidated',
			source_lane_id: (sweepAFamilies as readonly string[]).includes(
				row.trigger_id,
			)
				? 'sweep-a'
				: 'sweep-b',
		}));
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-consolidated-m',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: consolidated,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response.success).toBe(false);
		expect(response.message).toContain('micro lane floor unmet');
		expect(response.message).toContain('depth tier M');
	});

	test('rejects a consolidated tuple citing a family outside its declared ownership', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, { consolidatedMicro: true });
		const consolidated = rows().map((row) => ({
			...row,
			source_batch_id: 'micro-consolidated',
			source_lane_id: 'sweep-a',
		}));
		const result = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-overreach',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: consolidated,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'does not reference a completed non-degraded micro-lane artifact',
		);
	});

	test('rejects two cited lanes whose declared ownership overlaps (cross-batch disjointness)', async () => {
		// Regression for the cross-batch overlap gap: two SEPARATELY dispatched
		// micro batches whose owned_workflow_lanes overlap on one family must
		// never both be legitimately cited, even though each individually
		// attests its own owned set correctly. Without the disjointness check
		// this used to pass, letting the same family's content be extracted
		// from two different artifacts.
		const root = tempRoot();
		await establishBoundReviewGate(root, { consolidatedMicro: false });
		const overlappingFamilies = [
			...PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(0, 6),
		];
		const otherFamilies = [...PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(5)];
		await recordCompletedLane(root, {
			batchId: 'overlap-batch-a',
			laneId: 'overlap-lane-a',
			workflowLane: overlappingFamilies[0],
			ownedWorkflowLanes: overlappingFamilies,
			mode: 'swarm-pr-review:micro',
		});
		await recordCompletedLane(root, {
			batchId: 'overlap-batch-b',
			laneId: 'overlap-lane-b',
			workflowLane: otherFamilies[0],
			ownedWorkflowLanes: otherFamilies,
			mode: 'swarm-pr-review:micro',
		});
		const overlapping = rows().map((row, index) => ({
			...row,
			source_batch_id:
				index < overlappingFamilies.length
					? 'overlap-batch-a'
					: 'overlap-batch-b',
			source_lane_id:
				index < overlappingFamilies.length
					? 'overlap-lane-a'
					: 'overlap-lane-b',
		}));
		const result = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-overlap',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: overlapping,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('overlapping ownership');
	});
});
