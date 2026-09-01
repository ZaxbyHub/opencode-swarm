import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Split from write-pr-review-trigger-eval-provenance.test.ts (FR-006): the
// recorded-degradation path. A MATCHED family whose cited micro lane is
// provenance-valid but coverage-degraded (failed status, degraded output, or
// no covered row) must no longer dead-end the whole review — the run proceeds
// with the degradation disclosed on the durable receipt. Provenance failures
// (wrong lane, wrong mode, wrong head) still fail closed.

const tempDirs: string[] = [];
const SESSION_ID = 'trigger-eval-degraded-session';
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

function tempRoot(): string {
	const root = canonicalMkdtemp('trigger-eval-degraded-');
	mkdirSync(join(root, '.git'), { recursive: true });
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

async function recordLane(
	root: string,
	input: {
		batchId: string;
		laneId: string;
		workflowLane: string;
		mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro';
		status?: 'completed' | 'error' | 'cancelled';
		emptyOutput?: boolean;
		resultOverrides?: Record<string, unknown>;
	},
): Promise<void> {
	const status = input.status ?? 'completed';
	const correlationId = `${input.batchId}-${input.laneId}-session`;
	const header =
		input.mode === 'swarm-pr-review:base'
			? '[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags'
			: '[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
	const text = input.emptyOutput
		? 'the lane produced no usable protocol rows at all'
		: `${header}\n[CLEAN] | ${input.workflowLane} | exact reviewed diff | no candidate survived the focused review`;
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
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: input.workflowLane,
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
		status,
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
			...input.resultOverrides,
		},
	});
}

async function establishBoundReviewGate(
	root: string,
	options: { degradedMicroIndex?: number } = {},
): Promise<void> {
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 10,
		changedFiles: 1,
		hasSubmoduleChange: false,
	});
	writerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolveMergeBase = () => 'def456';
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
		await recordLane(root, {
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
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		if (index === options.degradedMicroIndex) continue;
		await recordLane(root, {
			batchId: `micro-batch-${Math.floor(index / 8)}`,
			laneId: `lane-${index}`,
			workflowLane,
			mode: 'swarm-pr-review:micro',
			prReviewLegacyTranscriptCompatibility: true,
		});
	}
}

function receiptPath(root: string, runId: string): string {
	// validateSwarmPath resolves every runtime artifact under <root>/.swarm/.
	return join(root, '.swarm', 'pr-review', runId, 'trigger-eval.json');
}

function writeTriggerEval(root: string, runId: string) {
	return executeWritePrReviewTriggerEval(
		{
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			base_sha: 'def456',
			base_ref: 'origin/main',
			rows: rows(),
		},
		root,
		{ sessionID: SESSION_ID },
	);
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

describe('write_pr_review_trigger_eval recorded degradation path', () => {
	test('a failed micro lane no longer aborts: the receipt records the degradation', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, { degradedMicroIndex: 2 });
		// Lane 2 exhausted its retries and ended failed, but retained a valid,
		// identity-checked artifact.
		await recordLane(root, {
			batchId: 'micro-batch-0',
			laneId: 'lane-2',
			workflowLane: PR_REVIEW_REQUIRED_MICRO_LANE_IDS[2],
			mode: 'swarm-pr-review:micro',
			status: 'error', // delegation-record terminal status for a lane that failed validation but retained its artifact
		});
		const result = JSON.parse(
			await writeTriggerEval(root, 'review-degraded-1'),
		);
		expect(result.success).toBe(true);
		expect(result.coverage_degradation_count).toBeGreaterThan(0);
		const receiptFile = receiptPath(root, 'review-degraded-1');
		expect(existsSync(receiptFile)).toBe(true);
		const receipt = JSON.parse(readFileSync(receiptFile, 'utf-8'));
		expect(Array.isArray(receipt.coverage_degradations)).toBe(true);
		expect(receipt.coverage_degradations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					trigger_id: PR_REVIEW_REQUIRED_MICRO_LANE_IDS[2],
					reason: expect.stringContaining('lane status error'),
				}),
			]),
		);
	});

	test('a degraded-output micro lane is disclosed, not fatal', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, { degradedMicroIndex: 2 });
		await recordLane(root, {
			batchId: 'micro-batch-0',
			laneId: 'lane-2',
			workflowLane: PR_REVIEW_REQUIRED_MICRO_LANE_IDS[2],
			mode: 'swarm-pr-review:micro',
			resultOverrides: { outputDegraded: true },
		});
		const result = JSON.parse(
			await writeTriggerEval(root, 'review-degraded-2'),
		);
		expect(result.success).toBe(true);
		const receipt = JSON.parse(
			readFileSync(receiptPath(root, 'review-degraded-2'), 'utf-8'),
		);
		expect(receipt.coverage_degradations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: 'output degraded' }),
			]),
		);
	});

	test('a lane with no covered row is disclosed via the uncovered-family reason', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, { degradedMicroIndex: 2 });
		await recordLane(root, {
			batchId: 'micro-batch-0',
			laneId: 'lane-2',
			workflowLane: PR_REVIEW_REQUIRED_MICRO_LANE_IDS[2],
			mode: 'swarm-pr-review:micro',
			emptyOutput: true,
		});
		const result = JSON.parse(
			await writeTriggerEval(root, 'review-degraded-3'),
		);
		expect(result.success).toBe(true);
		const receipt = JSON.parse(
			readFileSync(receiptPath(root, 'review-degraded-3'), 'utf-8'),
		);
		expect(receipt.coverage_degradations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: expect.stringContaining('no covered candidate or clean row'),
				}),
			]),
		);
	});

	test('a provenance failure still fails closed', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		// Cite a lane tuple that was never dispatched at all.
		const forged = rows();
		forged[2] = {
			...forged[2],
			source_batch_id: 'never-dispatched-batch',
			source_lane_id: 'ghost-lane',
		};
		const result = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-forged',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: forged,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'does not reference a verifiable micro-lane provenance chain',
		);
	});

	test('a healthy attestation writes no degradation entries', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const result = JSON.parse(await writeTriggerEval(root, 'review-clean'));
		expect(result.success).toBe(true);
		expect(result.coverage_degradation_count).toBe(0);
		const receipt = JSON.parse(
			readFileSync(receiptPath(root, 'review-clean'), 'utf-8'),
		);
		expect(receipt.coverage_degradations).toEqual([]);
	});

	test('consolidated partial coverage stamps only the uncovered family', async () => {
		// A consolidated lane owning families 0 and 1 whose artifact covers
		// family 0 but not family 1: family 1's row gets the uncovered-family
		// degradation, family 0's row gets NONE. Lane-wide stamping would
		// misattribute the degradation to the covered family — the exact
		// consolidated shape that motivated the recoverability path.
		const root = tempRoot();
		await establishBoundReviewGate(root, { degradedMicroIndex: 0 });
		// Build the consolidated lane owning families 0 and 1 and point BOTH
		// family rows at it (family 1's singleton record stays uncited — harmless).
		const [family0, family1] = PR_REVIEW_REQUIRED_MICRO_LANE_IDS;
		const consolidatedHeader =
			'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
		const text = `${consolidatedHeader}\n[CLEAN] | ${family0} | exact reviewed diff for family zero | no candidate survived the focused review`;
		await recordPendingDelegation(root, {
			correlationId: 'consol-session',
			jobId: null,
			subagentSessionId: 'consol-session',
			parentSessionId: SESSION_ID,
			callID: 'consol-call',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'micro-consol',
			laneId: 'sweep-ab',
			mode: 'swarm-pr-review:micro',
			workflowLane: family0,
			ownedWorkflowLanes: [family0, family1],
			workspace: {
				directory: root,
				gitHead: HEAD_SHA,
				dirtyHash: null,
				prHeadSha: HEAD_SHA,
				scope: REVIEW_SCOPE,
			},
		});
		const stored = storeLaneOutput(root, {
			batchId: 'micro-consol',
			laneId: 'sweep-ab',
			agent: 'explorer',
			role: 'explorer',
			sessionId: 'consol-session',
			parentSessionId: SESSION_ID,
			mode: 'swarm-pr-review:micro',
			workflowLane: family0,
			prHeadSha: HEAD_SHA,
			gitHead: HEAD_SHA,
			revisionDigest: REVISION_DIGEST,
			scope: REVIEW_SCOPE,
			source: 'collect_lane_results',
			text,
		});
		await appendDelegationTransition(root, 'consol-session', {
			status: 'completed',
			result: {
				text,
				chars: stored.chars,
				truncated: false,
				digest: stored.digest,
				outputRef: stored.ref,
			},
		});
		const consolRows = rows();
		consolRows[0] = {
			...consolRows[0],
			source_batch_id: 'micro-consol',
			source_lane_id: 'sweep-ab',
		};
		consolRows[1] = {
			...consolRows[1],
			source_batch_id: 'micro-consol',
			source_lane_id: 'sweep-ab',
		};
		const result = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-consol-partial',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: consolRows,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(result.success).toBe(true);
		// Exactly one degradation entry total: the uncovered family only.
		expect(result.coverage_degradation_count).toBe(1);
		const receipt = JSON.parse(
			readFileSync(receiptPath(root, 'review-consol-partial'), 'utf-8'),
		);
		const uncoveredEntries = receipt.coverage_degradations.filter(
			(entry: { reason: string }) =>
				entry.reason.includes('no covered candidate or clean row'),
		);
		expect(uncoveredEntries).toEqual([
			expect.objectContaining({
				trigger_id: family1,
				reason: `no covered candidate or clean row for: ${family1}`,
			}),
		]);
	});
});
