import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
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
	assertPrReviewArtifactBoundary,
	bindPrReviewBase,
	bindPrReviewTriggerLedger,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval';

// Issue #2124: the trigger-evaluation receipt must be immutable after
// consumption — run_id is bound to the gate state (mirroring
// prReviewArtifactRunId) and the destination write is fail-closed (no clobber).
// This file covers: (A) a second write under a different run_id is rejected,
// (B) a repeat write under the same run_id is rejected and the receipt is not
// replaced, (C) cross-consistency with the findings artifact run_id, (D) the
// gate-level binding throw via a direct mark call, and (E) forward-compat: an
// older state without prReviewTriggerEvalRunId reads cleanly and the first
// consumption binds the run.

const tempDirs: string[] = [];
const SESSION_ID = 'trigger-eval-run-binding';
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
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'trigger-eval-bind-')));
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

function writerArgs(runId: string) {
	return {
		run_id: runId,
		pr_head_sha: HEAD_SHA,
		base_ref: 'origin/main',
		base_sha: 'def456',
		rows: rows(),
	};
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

async function establishBoundReviewGate(root: string): Promise<void> {
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
	await bindPrReviewTriggerLedger(root, SESSION_ID, inlineRows());
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

async function writeTriggerEval(
	root: string,
	runId: string,
): Promise<{ success: boolean; message: string }> {
	const raw = await executeWritePrReviewTriggerEval(writerArgs(runId), root, {
		sessionID: SESSION_ID,
	});
	try {
		const parsed = JSON.parse(raw);
		return { success: parsed.success === true, message: parsed.message ?? '' };
	} catch {
		return { success: false, message: raw };
	}
}

describe('write_pr_review_trigger_eval — run_id binding + fail-closed receipt (#2124)', () => {
	test('a second write under a different run_id is rejected and the bound run/path are unchanged', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);

		const before = await readPrWorkflowGateState(root, SESSION_ID);
		expect(before?.prReviewTriggerEvalRunId).toBeUndefined();
		expect(before?.prReviewTriggerEvalPath).toBeUndefined();

		const first = await writeTriggerEval(root, 'run-A');
		expect(first.success).toBe(true);
		expect(existsSync(artifactPath(root, 'run-A'))).toBe(true);

		const afterFirst = await readPrWorkflowGateState(root, SESSION_ID);
		expect(afterFirst?.prReviewTriggerEvalRunId).toBe('run-A');
		expect(afterFirst?.prReviewTriggerEvalPath).toBe(
			'pr-review/run-A/trigger-eval.json',
		);

		const second = await writeTriggerEval(root, 'run-B');
		expect(second.success).toBe(false);
		expect(second.message).toContain('already bound to run');
		expect(second.message).toContain('run-A');

		// The rejected write must not have created a run-B receipt or changed state.
		expect(existsSync(artifactPath(root, 'run-B'))).toBe(false);
		const afterSecond = await readPrWorkflowGateState(root, SESSION_ID);
		expect(afterSecond?.prReviewTriggerEvalRunId).toBe('run-A');
		expect(afterSecond?.prReviewTriggerEvalPath).toBe(
			'pr-review/run-A/trigger-eval.json',
		);
	});

	test('a repeat write under the same run_id is rejected fail-closed and the receipt is not replaced', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);

		const first = await writeTriggerEval(root, 'run-same');
		expect(first.success).toBe(true);
		const receiptPath = artifactPath(root, 'run-same');
		const originalContent = readFileSync(receiptPath, 'utf-8');
		const originalMtime = statMtimeMs(receiptPath);

		const second = await writeTriggerEval(root, 'run-same');
		expect(second.success).toBe(false);
		expect(second.message).toContain('already exists for run');

		// The receipt on disk is byte-identical and was not rewritten.
		expect(readFileSync(receiptPath, 'utf-8')).toBe(originalContent);
		expect(statMtimeMs(receiptPath)).toBe(originalMtime);
	});

	test('cross-consistency: a trigger-eval write is rejected when the findings artifact is bound to a different run', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);

		// Simulate the findings artifact having already bound a different run_id
		// by editing the durable state directly (the findings persistence path
		// is too heavy to drive here; the state field is what the guard reads).
		const stateRel = gateInternals.workflowGateStateRelativePath(SESSION_ID);
		const stateAbs = join(root, '.swarm', stateRel);
		const state = JSON.parse(readFileSync(stateAbs, 'utf-8'));
		state.prReviewArtifactRunId = 'findings-run';
		writeFileSync(stateAbs, JSON.stringify(state));
		gateInternals.resetTrackedStateCache();

		const result = await writeTriggerEval(root, 'trigger-run');
		expect(result.success).toBe(false);
		expect(result.message).toContain('findings artifact run');
		expect(result.message).toContain('findings-run');
		expect(existsSync(artifactPath(root, 'trigger-run'))).toBe(false);
	});
});

describe('markPrReviewTriggerEvaluationComplete — run binding (#2124)', () => {
	test('a direct second mark call under a different run_id throws and leaves the bound run intact', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);

		await markPrReviewTriggerEvaluationComplete(
			root,
			SESSION_ID,
			'gate-run-A',
			'pr-review/gate-run-A/trigger-eval.json',
		);
		const afterFirst = await readPrWorkflowGateState(root, SESSION_ID);
		expect(afterFirst?.prReviewTriggerEvalRunId).toBe('gate-run-A');

		await expect(
			markPrReviewTriggerEvaluationComplete(
				root,
				SESSION_ID,
				'gate-run-B',
				'pr-review/gate-run-B/trigger-eval.json',
			),
		).rejects.toThrow('already bound to run');

		// Forward-compat: an older state shape (field absent) is the first-write
		// branch; re-reading confirms the bound run survived the rejected call.
		const afterReject = await readPrWorkflowGateState(root, SESSION_ID);
		expect(afterReject?.prReviewTriggerEvalRunId).toBe('gate-run-A');
	});

	test('forward-compat: a state persisted without prReviewTriggerEvalRunId reads cleanly and the first mark binds the run', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);

		// Strip the field to emulate an older state written before this fix.
		const stateRel = gateInternals.workflowGateStateRelativePath(SESSION_ID);
		const stateAbs = join(root, '.swarm', stateRel);
		const state = JSON.parse(readFileSync(stateAbs, 'utf-8'));
		delete state.prReviewTriggerEvalRunId;
		writeFileSync(stateAbs, JSON.stringify(state));
		gateInternals.resetTrackedStateCache();

		const reloaded = await readPrWorkflowGateState(root, SESSION_ID);
		expect(reloaded?.prReviewTriggerEvalRunId).toBeUndefined();

		// First consumption must NOT throw (field unset → first-write branch).
		await markPrReviewTriggerEvaluationComplete(
			root,
			SESSION_ID,
			'compat-run',
			'pr-review/compat-run/trigger-eval.json',
		);
		const after = await readPrWorkflowGateState(root, SESSION_ID);
		expect(after?.prReviewTriggerEvalRunId).toBe('compat-run');
	});

	test('findings-side cross-consistency: assertPrReviewArtifactBoundary rejects a different run once the trigger-eval run is bound', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);

		// Bind the trigger-eval run first (the normal production order).
		await markPrReviewTriggerEvaluationComplete(
			root,
			SESSION_ID,
			'boundary-run-A',
			'pr-review/boundary-run-A/trigger-eval.json',
		);

		// A findings boundary check under a DIFFERENT run must fail closed
		// before the candidate-inventory derivation runs.
		await expect(
			assertPrReviewArtifactBoundary(
				root,
				SESSION_ID,
				'boundary-run-B',
				'post_explorer',
				[],
			),
		).rejects.toThrow(
			'findings must use the same run as the trigger evaluation',
		);

		// The matching run passes the cross-check: it is rejected by a LATER gate
		// (the artifact/inventory reader), never by the run-mismatch check, which
		// proves the cross-check is what rejected the other run and does not
		// over-fire on the matching run.
		const matchingError = await assertPrReviewArtifactBoundary(
			root,
			SESSION_ID,
			'boundary-run-A',
			'post_explorer',
			[],
		).catch((error: unknown) => (error instanceof Error ? error.message : ''));
		expect(matchingError).not.toContain('same run as the trigger evaluation');
	});

	test('mark rejects when the findings artifact run_id is already bound to a different run', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);

		// Simulate the findings artifact having already bound a different run_id.
		const stateRel = gateInternals.workflowGateStateRelativePath(SESSION_ID);
		const stateAbs = join(root, '.swarm', stateRel);
		const state = JSON.parse(readFileSync(stateAbs, 'utf-8'));
		state.prReviewArtifactRunId = 'findings-bound-run';
		writeFileSync(stateAbs, JSON.stringify(state));
		gateInternals.resetTrackedStateCache();

		// A direct mark call under a mismatched run must throw the cross-consistency
		// error (the mark-level guard, distinct from the writer pre-check).
		await expect(
			markPrReviewTriggerEvaluationComplete(
				root,
				SESSION_ID,
				'trigger-run',
				'pr-review/trigger-run/trigger-eval.json',
			),
		).rejects.toThrow('must match the findings artifact run');

		// The rejected call must not have bound the trigger-eval run or path.
		const after = await readPrWorkflowGateState(root, SESSION_ID);
		expect(after?.prReviewTriggerEvalRunId).toBeUndefined();
		expect(after?.prReviewTriggerEvalPath).toBeUndefined();
	});
});

function statMtimeMs(p: string): number {
	return statSync(p).mtimeMs;
}
