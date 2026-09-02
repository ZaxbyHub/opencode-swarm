import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import type { PrReviewInlineTriggerRow } from '../../../src/background/pr-review-trigger-contract.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	bindPrReviewTriggerLedger,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const tempDirs: string[] = [];
const SESSION_ID = 'run-id-inference-session';
const OTHER_SESSION_ID = 'run-id-inference-other-session';
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
const RealDate = Date;

function tempRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-id-inference-')));
	tempDirs.push(root);
	return root;
}

async function withFrozenGlobalDate<T>(
	isoTimestamp: string,
	callback: () => Promise<T>,
): Promise<T> {
	const frozen = new RealDate(isoTimestamp);
	class FrozenDate extends RealDate {
		constructor(value?: string | number | Date) {
			super(value ?? frozen.toISOString());
		}

		static override now(): number {
			return frozen.getTime();
		}
	}
	globalThis.Date = FrozenDate as DateConstructor;
	try {
		return await callback();
	} finally {
		globalThis.Date = RealDate;
	}
}

function rows(sessionID = SESSION_ID) {
	return PR_REVIEW_TRIGGER_DEFINITIONS.map((definition, index) => ({
		trigger_id: definition.id,
		result: 'MATCHED' as const,
		evidence: `mandatory review focus for ${definition.id}`,
		source_batch_id: `${sessionID}-micro-batch-${Math.floor(index / 8)}`,
		source_lane_id: `${sessionID}-lane-${index}`,
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
		parentSessionId: string;
		batchId: string;
		laneId: string;
		workflowLane: string;
		mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro';
	},
): Promise<void> {
	const correlationId = `${input.batchId}-${input.laneId}-session`;
	const header =
		input.mode === 'swarm-pr-review:base'
			? '[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags'
			: '[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
	const text =
		input.mode === 'swarm-pr-review:base'
			? `${header}\nC-${input.laneId} | ${input.workflowLane} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH | ORDINARY | `
			: `${header}\n[CLEAN] | ${input.workflowLane} | exact reviewed diff | no candidate survived the focused review`;
	await recordPendingDelegation(root, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: input.parentSessionId,
		callID: `${input.batchId}-call`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: input.batchId,
		laneId: input.laneId,
		mode: input.mode,
		workflowLane: input.workflowLane,
		prReviewLegacyTranscriptCompatibility: true,
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
		parentSessionId: input.parentSessionId,
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

async function establishBoundReviewGate(root: string, sessionID = SESSION_ID) {
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolveMergeBase = () => 'def456';
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	await activatePrWorkflow(root, sessionID, 'PR_REVIEW');
	await bindPrReviewBase(root, sessionID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: 'def456',
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(root, sessionID, baseLanes, {
		batchId: `${sessionID}-base-all`,
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	for (const lane of baseLanes) {
		await recordCompletedLane(root, {
			parentSessionId: sessionID,
			batchId: `${sessionID}-base-all`,
			laneId: lane.laneId,
			workflowLane: lane.workflowLane,
			mode: 'swarm-pr-review:base',
		});
	}
	await bindPrReviewTriggerLedger(root, sessionID, inlineRows(rows(sessionID)));
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		await recordCompletedLane(root, {
			parentSessionId: sessionID,
			batchId: `${sessionID}-micro-batch-${Math.floor(index / 8)}`,
			laneId: `${sessionID}-lane-${index}`,
			workflowLane,
			mode: 'swarm-pr-review:micro',
		});
	}
}

afterEach(() => {
	gateInternals.resetTrackedStateCache();
	globalThis.Date = RealDate;
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

describe('PR review run_id inference and reservation (#2333)', () => {
	test('trigger evaluation auto-reserves a run_id when omitted', async () => {
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
			run_id?: string;
			path?: string;
			message?: string;
		};
		expect(parsed.success).toBe(true);
		expect(parsed.run_id).toMatch(/^pr-review-\d{17}(?:-\d+)?$/);
		expect(parsed.path).toBe(`pr-review/${parsed.run_id}/trigger-eval.json`);
		expect(
			existsSync(
				join(root, '.swarm', 'pr-review', parsed.run_id!, 'trigger-eval.json'),
			),
		).toBe(true);
		const state = await readPrWorkflowGateState(root, SESSION_ID);
		expect(state?.prReviewTriggerEvalRunId).toBe(parsed.run_id);
	});

	test('an omitted run_id recovers a reservation left before the state binding persisted', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		gateInternals.beforeAtomicTempWrite = async () => {
			gateInternals.beforeAtomicTempWrite = undefined;
			throw new Error('injected state-persist crash');
		};
		const input = {
			pr_head_sha: HEAD_SHA,
			base_ref: 'origin/main',
			base_sha: 'def456',
			rows: rows(),
		};
		const failed = JSON.parse(
			await executeWritePrReviewTriggerEval(input, root, {
				sessionID: SESSION_ID,
			}),
		) as { success: boolean };
		expect(failed.success).toBe(false);

		const runRoot = join(root, '.swarm', 'pr-review');
		const reservations = readdirSync(runRoot).filter((entry) =>
			existsSync(join(runRoot, entry, 'run-reservation.json')),
		);
		expect(reservations).toHaveLength(1);
		gateInternals.resetTrackedStateCache();

		const retried = JSON.parse(
			await executeWritePrReviewTriggerEval(input, root, {
				sessionID: SESSION_ID,
			}),
		) as { success: boolean; run_id?: string };
		expect(retried.success).toBe(true);
		expect(retried.run_id).toBe(reservations[0]);
		expect(readdirSync(runRoot)).toEqual(reservations);
	});

	test('findings infer the unique active run_id after trigger binding and after cache reset', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		await expect(
			executeWritePrReviewTriggerEval(
				{
					run_id: 'seed-run',
					pr_head_sha: HEAD_SHA,
					base_ref: 'origin/main',
					base_sha: 'def456',
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');

		gateInternals.resetTrackedStateCache();

		const raw = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				pr_head_sha: HEAD_SHA,
				boundary: 'post_explorer',
				records: PR_REVIEW_BASE_DIMENSION_IDS.map((lane) => ({
					finding_id: `C-${lane}`,
					status: 'PENDING' as const,
					file_line: 'src/index.ts:1',
					evidence: 'inferred run write',
					next_action: 'route_to_reviewer' as const,
					severity: 'HIGH' as const,
				})),
			},
			root,
			{ sessionID: SESSION_ID },
		);
		const parsed = JSON.parse(raw) as {
			success: boolean;
			path?: string;
			run_id?: string;
		};
		expect(parsed.success).toBe(true);
		expect(parsed.run_id).toBe('seed-run');
		expect(parsed.path).toBe('pr-review/seed-run/findings.jsonl');
	});

	test('cross-session explicit collisions reject the occupied run reservation', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, SESSION_ID);
		await establishBoundReviewGate(root, OTHER_SESSION_ID);
		await expect(
			executeWritePrReviewTriggerEval(
				{
					run_id: 'session-a-run',
					pr_head_sha: HEAD_SHA,
					base_ref: 'origin/main',
					base_sha: 'def456',
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');

		const raw = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: 'session-a-run',
				pr_head_sha: HEAD_SHA,
				boundary: 'post_explorer',
				records: PR_REVIEW_BASE_DIMENSION_IDS.map((lane) => ({
					finding_id: `C-${lane}`,
					status: 'PENDING' as const,
					file_line: 'src/index.ts:1',
					evidence: 'other session must not reuse the same reservation',
					next_action: 'route_to_reviewer' as const,
					severity: 'HIGH' as const,
				})),
			},
			root,
			{ sessionID: OTHER_SESSION_ID },
		);
		const parsed = JSON.parse(raw) as { success: boolean; message?: string };
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('run_id');
		expect(parsed.message).toContain('already occupied');
	});

	test('explicit run_id writes skip oversized reservation recovery scans', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const reviewRoot = join(root, '.swarm', 'pr-review');
		for (let index = 0; index <= 1024; index += 1) {
			const dir = join(reviewRoot, `noise-${index}`);
			mkdirSync(dir, { recursive: true });
		}

		const raw = await executeWritePrReviewTriggerEval(
			{
				run_id: 'explicit-run',
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
			run_id?: string;
			message?: string;
		};
		expect(parsed.success).toBe(true);
		expect(parsed.run_id).toBe('explicit-run');
	});

	test('omitted run_id fails closed after a bounded number of occupied suffix attempts', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		await withFrozenGlobalDate('2026-08-25T12:34:56.789Z', async () => {
			const reviewRoot = join(root, '.swarm', 'pr-review');
			const base = 'pr-review-20260825123456789';
			for (let suffix = 0; suffix < 64; suffix += 1) {
				const runId = suffix === 0 ? base : `${base}-${suffix}`;
				const runDir = join(reviewRoot, runId);
				mkdirSync(runDir, { recursive: true });
				writeFileSync(
					join(runDir, 'run-reservation.json'),
					JSON.stringify(
						{
							schema_version: 1,
							session_id: 'other-session',
							workflow_instance_id: 'other-workflow',
							run_id: runId,
							reserved_at: '2026-08-25T12:34:56.789Z',
						},
						null,
						2,
					),
				);
			}

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
			const parsed = JSON.parse(raw) as { success: boolean; message?: string };
			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('exhausted 64 reservation attempts');
		});
	});
});
