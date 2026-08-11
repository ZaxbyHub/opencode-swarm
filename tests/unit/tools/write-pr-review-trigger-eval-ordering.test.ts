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

// Split from write-pr-review-trigger-eval.test.ts (500-line cap): regression
// coverage for FB item F-002. The writer now pairs frozen vs writer rows BY
// ARRAY INDEX (write-pr-review-trigger-eval.ts:161-168) and grafts provenance
// by index (:172-185). That is only safe because exactTriggerRows
// (pr-review-trigger-contract.ts:236-259) re-orders BOTH ledgers into
// canonical PR_REVIEW_REQUIRED_TRIGGER_IDS order before comparison. This test
// supplies writer rows in REVERSED order relative to the frozen ledger and
// asserts pairing is still correct per trigger_id, not per array position.

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
		evidence: `frozen distinct evidence for ${definition.id}`,
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
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('write_pr_review_trigger_eval — reversed writer-row ordering (F-002)', () => {
	test('pairs writer rows by trigger identity, not array index, when writer rows arrive reversed', async () => {
		const root = tempRoot();
		const frozenRows = rows();
		await establishBoundReviewGate(root, {
			triggerLedger: inlineRows(frozenRows),
		});

		// Build writer rows in REVERSED order relative to the frozen ledger.
		// Each writer row keeps its OWN trigger_id's source_batch_id/source_lane_id
		// (as a real caller would), so a naive index-based graft would transplant
		// provenance/evidence from the wrong trigger onto each row.
		const writerRows = [...frozenRows]
			.reverse()
			.map(({ evidence: _evidence, ...row }) => row);

		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-reversed',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: writerRows,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);

		expect(response.success).toBe(true);

		const outputPath = artifactPath(root, 'review-reversed');
		expect(existsSync(outputPath)).toBe(true);
		const artifact = JSON.parse(readFileSync(outputPath, 'utf-8'));
		expect(artifact.rows).toHaveLength(PR_REVIEW_TRIGGER_DEFINITIONS.length);

		const frozenById = new Map(frozenRows.map((row) => [row.trigger_id, row]));

		// Load-bearing: every persisted row must carry the evidence and
		// provenance frozen for ITS OWN trigger_id — not whatever landed at the
		// same array index after reversal. In a naive index-paired world this
		// would fail because reversing the writer rows shifts every index's
		// counterpart to a different trigger_id (except any accidental
		// palindromic midpoint), so a mismatch would surface across the set.
		for (const persistedRow of artifact.rows) {
			const expected = frozenById.get(persistedRow.trigger_id);
			expect(expected).toBeDefined();
			expect(persistedRow.evidence).toBe(expected?.evidence);
			expect(persistedRow.source_batch_id).toBe(expected?.source_batch_id);
			expect(persistedRow.source_lane_id).toBe(expected?.source_lane_id);
		}

		// Canonicalization is pinned: persisted rows follow
		// PR_REVIEW_REQUIRED_TRIGGER_IDS order regardless of writer input order.
		expect(
			artifact.rows.map((row: { trigger_id: string }) => row.trigger_id),
		).toEqual(PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) => definition.id));
	});
});
