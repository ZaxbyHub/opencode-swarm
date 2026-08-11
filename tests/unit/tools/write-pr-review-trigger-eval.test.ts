import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import type { PrReviewInlineTriggerRow } from '../../../src/background/pr-review-trigger-contract';
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

function tempRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'trigger-eval-')));
	tempDirs.push(root);
	return root;
}

function artifactPath(root: string, runId: string): string {
	return join(root, '.swarm', 'pr-review', runId, 'trigger-eval.json');
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

function inlineRows(
	input: ReadonlyArray<PrReviewInlineTriggerRow> = rows(),
): PrReviewInlineTriggerRow[] {
	return input.map(({ trigger_id, result, evidence }) => ({
		trigger_id,
		result,
		evidence,
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
	options: {
		consolidatedMicro?: boolean;
		matchedMicroIds?: readonly string[];
		triggerLedger?: PrReviewInlineTriggerRow[];
	} = {},
): Promise<void> {
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolveMergeBase = () => 'def456';
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
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
		options.triggerLedger ?? inlineRows(),
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
		if (
			options.matchedMicroIds &&
			!options.matchedMicroIds.includes(workflowLane)
		) {
			continue;
		}
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
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('write_pr_review_trigger_eval', () => {
	test('writes the exact canonical trigger set atomically under .swarm', async () => {
		const root = tempRoot();
		const frozenRows = rows();
		await establishBoundReviewGate(root, {
			triggerLedger: inlineRows(frozenRows),
		});
		const writerRows = frozenRows.map(({ evidence: _evidence, ...row }) => row);
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-1805',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: writerRows,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response).toMatchObject({
			success: true,
			matched_count: PR_REVIEW_TRIGGER_DEFINITIONS.length,
			no_match_count: 0,
			dispatched_micro_lane_count: PR_REVIEW_TRIGGER_DEFINITIONS.length,
		});
		const outputPath = artifactPath(root, 'review-1805');
		expect(existsSync(outputPath)).toBe(true);
		const artifact = JSON.parse(readFileSync(outputPath, 'utf-8'));
		expect(artifact.rows).toHaveLength(PR_REVIEW_TRIGGER_DEFINITIONS.length);
		expect(artifact.rows[0]).toMatchObject({
			trigger_id: PR_REVIEW_TRIGGER_DEFINITIONS[0].id,
			scope: PR_REVIEW_TRIGGER_DEFINITIONS[0].scope,
			trigger_row: PR_REVIEW_TRIGGER_DEFINITIONS[0].trigger_row,
			micro_lane: PR_REVIEW_TRIGGER_DEFINITIONS[0].micro_lane,
			result: 'MATCHED',
			evidence: frozenRows[0].evidence,
		});
		expect(artifact).toMatchObject({
			base_ref: 'origin/main',
			base_sha: 'def456',
		});
	});

	test('persists inapplicable families as provenance-free NOT_TRIGGERED rows', async () => {
		const root = tempRoot();
		const mixedRows = rows().map((row, index) =>
			index < 3 || row.trigger_id === 'unclassified-risk'
				? row
				: {
						trigger_id: row.trigger_id,
						result: 'NOT_TRIGGERED' as const,
						evidence: `diff contains no ${row.trigger_id} surface`,
					},
		);
		await establishBoundReviewGate(root, {
			matchedMicroIds: mixedRows
				.filter((row) => row.result === 'MATCHED')
				.map((row) => row.trigger_id),
			triggerLedger: inlineRows(mixedRows),
		});
		const rewordedRows = mixedRows.map((row) => ({
			...row,
			evidence: `final summary reworded ${row.trigger_id}`,
		}));
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-2004-mixed',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: rewordedRows,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response).toMatchObject({
			success: true,
			matched_count: 4,
			not_triggered_count: 7,
			dispatched_micro_lane_count: 4,
		});
		const artifact = JSON.parse(
			readFileSync(artifactPath(root, 'review-2004-mixed'), 'utf-8'),
		);
		const notTriggered = artifact.rows.filter(
			(row: { result: string }) => row.result === 'NOT_TRIGGERED',
		);
		expect(notTriggered).toHaveLength(7);
		expect(
			artifact.rows.map((row: { evidence: string }) => row.evidence),
		).toEqual(mixedRows.map((row) => row.evidence));
		expect(
			notTriggered.every(
				(row: Record<string, unknown>) =>
					!('source_batch_id' in row) && !('source_lane_id' in row),
			),
		).toBe(true);
	});

	test('rejects a consolidated lane that owns a NOT_TRIGGERED family', async () => {
		const root = tempRoot();
		const matchedId = PR_REVIEW_REQUIRED_MICRO_LANE_IDS[0];
		const contradictoryRows = PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) =>
			definition.id === matchedId || definition.id === 'unclassified-risk'
				? {
						trigger_id: definition.id,
						result: 'MATCHED' as const,
						evidence: `matched ${definition.id}`,
						source_batch_id: 'micro-consolidated',
						source_lane_id: definition.id === matchedId ? 'sweep-a' : 'sweep-b',
					}
				: {
						trigger_id: definition.id,
						result: 'NOT_TRIGGERED' as const,
						evidence: `no ${definition.id} surface`,
					},
		);
		await establishBoundReviewGate(root, {
			consolidatedMicro: true,
			triggerLedger: inlineRows(contradictoryRows),
		});
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-2004-ownership-mismatch',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: contradictoryRows,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);

		expect(response.success).toBe(false);
		expect(response.message).toContain(
			'cited lane ownership must equal the MATCHED trigger set',
		);
	});

	test('rejects a claimed base SHA that is not the exact resolved merge base', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'merge-base-mismatch',
					pr_head_sha: HEAD_SHA,
					base_sha: 'bad999',
					base_ref: 'origin/main',
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response.success).toBe(false);
		expect(response.message).toContain('merge-base mismatch');
		expect(existsSync(artifactPath(root, 'merge-base-mismatch'))).toBe(false);
	});

	test('rejects a live merge base that contradicts the durably bound review scope', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		writerInternals.resolveMergeBase = () => 'feed00';
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'bound-base-mismatch',
					pr_head_sha: HEAD_SHA,
					base_sha: 'feed00',
					base_ref: 'origin/rebased-main',
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response.success).toBe(false);
		expect(response.message).toContain('scope mismatch');
		expect(existsSync(artifactPath(root, 'bound-base-mismatch'))).toBe(false);
	});

	for (const [name, establish, context] of [
		['without a current session', async (_root: string) => {}, {}],
		[
			'without an active gate',
			async (_root: string) => {},
			{ sessionID: SESSION_ID },
		],
		[
			'under PR_FEEDBACK',
			async (root: string) => {
				await activatePrWorkflow(root, SESSION_ID, 'PR_FEEDBACK');
			},
			{ sessionID: SESSION_ID },
		],
		[
			'under an unbound PR_REVIEW gate',
			async (root: string) => {
				await activatePrWorkflow(root, SESSION_ID, 'PR_REVIEW');
			},
			{ sessionID: SESSION_ID },
		],
	] as const) {
		test(`fails closed ${name} without writing an artifact`, async () => {
			const root = tempRoot();
			await establish(root);
			const response = JSON.parse(
				await executeWritePrReviewTriggerEval(
					{
						run_id: 'blocked-review',
						pr_head_sha: HEAD_SHA,
						base_sha: 'def456',
						rows: rows(),
					},
					root,
					context,
				),
			);
			expect(response.success).toBe(false);
			expect(response.message).toContain('active, bound PR_REVIEW gate');
			expect(existsSync(artifactPath(root, 'blocked-review'))).toBe(false);
		});
	}
});
