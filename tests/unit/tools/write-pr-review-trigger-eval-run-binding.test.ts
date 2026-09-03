import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
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
import { writeStateWhileLocked } from '../../../src/pr-review/persistence';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const tempDirs: Array<() => void> = [];
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
const originalMarkTriggerEvaluationComplete =
	writerInternals.markPrReviewTriggerEvaluationComplete;

function tempRoot(): string {
	const { dir, cleanup } = createSafeTestDir('trigger-eval-bind-');
	mkdirSync(join(dir, '.git'), { recursive: true });
	tempDirs.push(cleanup);
	return dir;
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
			? '[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags'
			: '[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
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
		prReviewLegacyTranscriptCompatibility: true,
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
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
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
	writerInternals.markPrReviewTriggerEvaluationComplete =
		originalMarkTriggerEvaluationComplete;
	for (const cleanup of tempDirs.splice(0)) {
		cleanup();
	}
});

async function bindFindingsRun(root: string, runId: string): Promise<void> {
	const state = await readPrWorkflowGateState(root, SESSION_ID);
	if (!state) {
		throw new Error('expected bound PR_REVIEW state');
	}
	await writeStateWhileLocked(root, {
		...state,
		prReviewArtifactRunId: runId,
	});
}

async function writeTriggerEval(
	root: string,
	runId: string,
): Promise<{ success: boolean; message: string; replayed?: boolean }> {
	const raw = await executeWritePrReviewTriggerEval(writerArgs(runId), root, {
		sessionID: SESSION_ID,
	});
	try {
		const parsed = JSON.parse(raw);
		return {
			success: parsed.success === true,
			message: parsed.message ?? '',
			replayed: parsed.replayed,
		};
	} catch {
		return { success: false, message: raw };
	}
}

describe('write_pr_review_trigger_eval — run_id binding + fail-closed receipt (#2124)', () => {
	test('omitted run_id is inferred, reserved once, and returned to the caller', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);

		const raw = await executeWritePrReviewTriggerEval(
			{
				pr_head_sha: HEAD_SHA,
				base_ref: 'origin/main',
				base_sha: 'def456',
				rows: rows(),
			},
			root,
			{ sessionID: SESSION_ID },
		);
		const parsed = JSON.parse(raw) as {
			success: boolean;
			path?: string;
			message?: string;
		};
		expect(parsed.success).toBe(true);
		expect(parsed.path).toMatch(
			/^pr-review\/pr-review-\d{17}(?:-[A-Za-z0-9_-]+)?\/trigger-eval\.json$/,
		);
		const state = await readPrWorkflowGateState(root, SESSION_ID);
		expect(state?.prReviewTriggerEvalPath).toBe(parsed.path);
		expect(state?.prReviewTriggerEvalRunId).toMatch(
			/^pr-review-\d{17}(?:-[A-Za-z0-9_-]+)?$/,
		);
	});

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
		expect(second.message).toContain(
			'field run_id expected "run-A", got "run-B"',
		);
		expect(second.message).toContain('run-A');

		expect(existsSync(artifactPath(root, 'run-B'))).toBe(false);
		const afterSecond = await readPrWorkflowGateState(root, SESSION_ID);
		expect(afterSecond?.prReviewTriggerEvalRunId).toBe('run-A');
		expect(afterSecond?.prReviewTriggerEvalPath).toBe(
			'pr-review/run-A/trigger-eval.json',
		);
	});

	test('a response-loss retry repairs the gate receipt without replacing the trigger artifact', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);

		writerInternals.markPrReviewTriggerEvaluationComplete = async () => {
			throw new Error('injected crash after artifact publication');
		};
		const first = await writeTriggerEval(root, 'run-same');
		expect(first.success).toBe(false);
		expect(first.message).toContain(
			'injected crash after artifact publication',
		);
		const receiptPath = artifactPath(root, 'run-same');
		const originalContent = readFileSync(receiptPath, 'utf-8');
		const originalMtime = statMtimeMs(receiptPath);
		expect(
			(await readPrWorkflowGateState(root, SESSION_ID))
				?.prReviewTriggerEvalPath,
		).toBeUndefined();

		writerInternals.markPrReviewTriggerEvaluationComplete =
			originalMarkTriggerEvaluationComplete;
		const second = await writeTriggerEval(root, 'run-same');
		expect(second.success).toBe(true);
		expect(second.replayed).toBe(true);

		expect(readFileSync(receiptPath, 'utf-8')).toBe(originalContent);
		expect(statMtimeMs(receiptPath)).toBe(originalMtime);
		expect(
			(await readPrWorkflowGateState(root, SESSION_ID))
				?.prReviewTriggerEvalPath,
		).toBe('pr-review/run-same/trigger-eval.json');

		const tampered = JSON.parse(originalContent);
		tampered.rows[0].evidence = 'schema-valid conflicting evidence';
		writeFileSync(
			receiptPath,
			`${JSON.stringify(tampered, null, 2)}\n`,
			'utf8',
		);
		const conflict = await writeTriggerEval(root, 'run-same');
		expect(conflict.success).toBe(false);
		expect(conflict.message).toContain('conflicting content');
	});

	test('cross-consistency: a trigger-eval write is rejected when the findings artifact is bound to a different run', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);

		await bindFindingsRun(root, 'findings-run');
		gateInternals.resetTrackedStateCache();

		const result = await writeTriggerEval(root, 'trigger-run');
		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'field run_id expected "findings-run", got "trigger-run"',
		);
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

		const afterReject = await readPrWorkflowGateState(root, SESSION_ID);
		expect(afterReject?.prReviewTriggerEvalRunId).toBe('gate-run-A');
	});

	test('forward-compat: a state persisted without prReviewTriggerEvalRunId reads cleanly and the first mark binds the run', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);

		const stateRel = gateInternals.workflowGateStateRelativePath(SESSION_ID);
		const stateAbs = join(root, '.swarm', stateRel);
		const state = JSON.parse(readFileSync(stateAbs, 'utf-8'));
		delete state.prReviewTriggerEvalRunId;
		writeFileSync(stateAbs, JSON.stringify(state));
		gateInternals.resetTrackedStateCache();

		const reloaded = await readPrWorkflowGateState(root, SESSION_ID);
		expect(reloaded?.prReviewTriggerEvalRunId).toBeUndefined();

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

		await markPrReviewTriggerEvaluationComplete(
			root,
			SESSION_ID,
			'boundary-run-A',
			'pr-review/boundary-run-A/trigger-eval.json',
		);

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

		await bindFindingsRun(root, 'findings-bound-run');
		gateInternals.resetTrackedStateCache();

		await expect(
			markPrReviewTriggerEvaluationComplete(
				root,
				SESSION_ID,
				'trigger-run',
				'pr-review/trigger-run/trigger-eval.json',
			),
		).rejects.toThrow('must match the findings artifact run');

		const after = await readPrWorkflowGateState(root, SESSION_ID);
		expect(after?.prReviewTriggerEvalRunId).toBeUndefined();
		expect(after?.prReviewTriggerEvalPath).toBeUndefined();
	});
});

function statMtimeMs(p: string): number {
	return statSync(p).mtimeMs;
}
