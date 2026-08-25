/**
 * Issue #2280 Part A — the base-only `post_explorer` checkpoint.
 *
 * The bundled skill promises a durable findings recovery point right after
 * base lanes settle, BEFORE the micro wave; until this issue the gate refused
 * every findings write until `trigger-eval.json` existed, so the promised
 * recovery window was structurally closed. These tests pin the widened
 * contract: the early write is admissible exactly at base settlement, covers
 * EXACTLY the base-derived inventory, and every later boundary keeps the
 * trigger-eval prerequisite and the full (base+micro) inventory.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrReviewBaseDimensions,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	artifactRecord,
	establishPrReviewPrerequisites,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
	rejectionMessage,
	reviewedRow,
	settleReviewerPhase,
	writePrReviewFindings,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { writeRawPrWorkflowGateState } from '../../helpers/pr-workflow-lane-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);
const MICRO_CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence';

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(() => {
	directory = canonicalMkdtemp('pr-base-only-checkpoint-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveCurrentGitHeadAsync = async (dir) =>
		_test_exports.resolveCurrentGitHead(dir);
	_test_exports.resolveIsWorkingTreeCleanAsync = async (dir) =>
		_test_exports.resolveIsWorkingTreeClean(dir);
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

/** Activate + enforce + settle the six base lanes, nothing else. */
async function settleBaseWaves(
	options: { zeroCandidates?: boolean } = {},
): Promise<void> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: HEAD_SHA,
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(
		directory,
		PR_ARTIFACT_SESSION_ID,
		baseLanes,
		{
			batchId: 'base-all',
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
	await persistPrReviewBatch(
		directory,
		'base-all',
		'swarm-pr-review:base',
		baseLanes,
		{ cleanPerLane: options.zeroCandidates },
	);
}

/**
 * Dispatch the micro wave (micro lane 0 contributes candidate M-0, the rest
 * are clean) and complete trigger evaluation — the "micro arrival" step that
 * extends the inventory after an early checkpoint.
 */
async function completeTriggerEvaluation(runId: string): Promise<void> {
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		await persistPrReviewBatch(
			directory,
			`micro-${index}`,
			'swarm-pr-review:micro',
			[{ laneId: `micro-lane-${index}`, workflowLane }],
			{
				textOverride:
					index === 0
						? `${MICRO_CANDIDATE_HEADER}\nM-0 | ${workflowLane} | HIGH | correctness | file.ts:2 | claim | invariant | evidence | HIGH`
						: `${MICRO_CANDIDATE_HEADER}\n[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
			},
		);
	}
	const rows = PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((workflowLane, index) => ({
		trigger_id: workflowLane,
		result: 'MATCHED',
		evidence: `base-only checkpoint fixture evidence for ${workflowLane}`,
		source_batch_id: `micro-${index}`,
		source_lane_id: `micro-lane-${index}`,
	}));
	const relative = path.join('pr-review', runId, 'trigger-eval.json');
	const absolute = path.join(directory, '.swarm', relative);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(absolute, JSON.stringify({ rows }), 'utf-8');
	await markPrReviewTriggerEvaluationComplete(
		directory,
		PR_ARTIFACT_SESSION_ID,
		runId,
		relative,
	);
}

function pendingRecords(ids: readonly string[], severity = 'HIGH') {
	return ids.map((id) =>
		artifactRecord(id, 'PENDING', 'route_to_reviewer', severity),
	);
}

describe('base-only post_explorer checkpoint (issue #2280 Part A)', () => {
	test('succeeds after base settlement with no micro wave, and the ledger reloads from disk', async () => {
		await settleBaseWaves();

		const result = await writePrReviewFindings(
			directory,
			'run-e2e',
			'post_explorer',
			pendingRecords(candidateIds),
		);
		expect(result).toContain('"success": true');
		expect(result).toContain('"boundary": "post_explorer"');

		// Simulated mid-run context loss: reconstruct the ledger purely from
		// disk (the SKILL resume procedure — latest record wins).
		const text = await fs.readFile(
			path.join(directory, '.swarm', 'pr-review', 'run-e2e', 'findings.jsonl'),
			'utf-8',
		);
		const persisted = text
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(persisted).toHaveLength(6);
		const latest = new Map(
			persisted.map((record) => [record.finding_id, record]),
		);
		expect([...latest.keys()].sort()).toEqual([...candidateIds].sort());
		for (const record of latest.values()) {
			expect(record.status).toBe('PENDING');
			expect(record.next_action).toBe('route_to_reviewer');
			expect(record.severity).toBe('HIGH');
			expect(record.boundary).toBe('post_explorer');
		}
	});

	test('rejects ids outside the base-derived inventory (exact inventory)', async () => {
		await settleBaseWaves();

		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'run-extra', 'post_explorer', [
				...pendingRecords(candidateIds.slice(0, 5)),
				artifactRecord('M-0', 'PENDING', 'route_to_reviewer', 'HIGH'),
			]),
		);
		expect(message).toContain(
			'BLOCKED: PR_REVIEW post_explorer findings must exactly cover',
		);
		expect(message).toContain('missing: C-5');
		expect(message).toContain('extra: M-0');
	});

	test('is refused while base coverage is incomplete', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
			laneId: workflowLane,
			workflowLane,
		}));
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			baseLanes,
			{
				batchId: 'base-all',
				prHeadSha: HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		// Only three of six dimensions ever succeeded.
		await persistPrReviewBatch(
			directory,
			'base-all',
			'swarm-pr-review:base',
			baseLanes.slice(0, 3),
		);

		const message = await rejectionMessage(
			writePrReviewFindings(
				directory,
				'run-incomplete',
				'post_explorer',
				pendingRecords(candidateIds),
			),
		);
		expect(message).toContain('PR_REVIEW base coverage is incomplete');
	});

	test('post_reviewer is still refused before trigger evaluation, even with the early checkpoint persisted', async () => {
		await settleBaseWaves();
		await writePrReviewFindings(
			directory,
			'run-order',
			'post_explorer',
			pendingRecords(candidateIds),
		);

		const message = await rejectionMessage(
			writePrReviewFindings(
				directory,
				'run-order',
				'post_reviewer',
				pendingRecords(candidateIds),
			),
		);
		expect(message).toBe(
			'BLOCKED: PR_REVIEW findings persistence requires the trigger evaluation artifact (write_pr_review_trigger_eval must complete first)',
		);
	});

	test('council batches without a receipt cannot widen the base-only inventory', async () => {
		await settleBaseWaves();
		// A reconstructed/hand-modified state can carry a settled council batch
		// without a trigger-eval receipt; the early checkpoint's inventory must
		// stay structurally base-only (plan-critic finding 1).
		await persistPrReviewBatch(
			directory,
			'council-b1',
			'swarm-pr-review:council',
			[{ laneId: 'council-lane', workflowLane: 'trigger-x' }],
			{
				textOverride: `${MICRO_CANDIDATE_HEADER}\nX-COUNCIL | trigger-x | HIGH | correctness | file.ts:1 | claim | invariant | evidence | HIGH`,
			},
		);
		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		await writeRawPrWorkflowGateState(directory, PR_ARTIFACT_SESSION_ID, {
			...state,
			prReviewValidationBatches: [
				{
					batchId: 'council-b1',
					phase: 'council',
					lanes: [{ laneId: 'council-lane', workflowLane: 'trigger-x' }],
					validatedAt: '2026-08-01T00:00:00.000Z',
				},
			],
		});
		_test_exports.resetTrackedStateCache();

		await expect(
			_test_exports.derivePrReviewCandidateInventory(
				directory,
				PR_ARTIFACT_SESSION_ID,
			),
		).resolves.toEqual([...candidateIds]);

		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'run-council', 'post_explorer', [
				...pendingRecords(candidateIds),
				artifactRecord('X-COUNCIL', 'PENDING', 'route_to_reviewer', 'HIGH'),
			]),
		);
		expect(message).toContain('extra: X-COUNCIL');
	});

	test('control: the same council artifact DOES contribute to the inventory once a receipt exists', async () => {
		// Proves the previous test is a pin on the gating, not on artifact
		// parsing: with trigger evaluation complete, the identical council
		// batch's candidate lands in the full inventory.
		await establishPrReviewPrerequisites(directory, 'run-council-ctl');
		await persistPrReviewBatch(
			directory,
			'council-b1',
			'swarm-pr-review:council',
			[{ laneId: 'council-lane', workflowLane: 'trigger-x' }],
			{
				textOverride: `${MICRO_CANDIDATE_HEADER}\nX-COUNCIL | trigger-x | HIGH | correctness | file.ts:1 | claim | invariant | evidence | HIGH`,
			},
		);
		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		await writeRawPrWorkflowGateState(directory, PR_ARTIFACT_SESSION_ID, {
			...state,
			prReviewValidationBatches: [
				...(state.prReviewValidationBatches ?? []),
				{
					batchId: 'council-b1',
					phase: 'council',
					lanes: [{ laneId: 'council-lane', workflowLane: 'trigger-x' }],
					validatedAt: '2026-08-01T00:00:00.000Z',
				},
			],
		});
		_test_exports.resetTrackedStateCache();

		await expect(
			_test_exports.derivePrReviewCandidateInventory(
				directory,
				PR_ARTIFACT_SESSION_ID,
			),
		).resolves.toEqual([...candidateIds, 'X-COUNCIL'].sort());
	});

	test('after micro arrival, post_reviewer requires the FULL inventory and the receipt', async () => {
		await settleBaseWaves();
		await writePrReviewFindings(
			directory,
			'run-full',
			'post_explorer',
			pendingRecords(candidateIds),
		);
		await completeTriggerEvaluation('run-full');
		await expect(
			_test_exports.derivePrReviewCandidateInventory(
				directory,
				PR_ARTIFACT_SESSION_ID,
			),
		).resolves.toEqual([...candidateIds, 'M-0'].sort());

		await settleReviewerPhase(
			directory,
			'run-full',
			[...candidateIds, 'M-0'].map((id) =>
				reviewedRow(id, 'CONFIRMED', 'HIGH'),
			),
			[...candidateIds, 'M-0'],
		);

		const message = await rejectionMessage(
			writePrReviewFindings(
				directory,
				'run-full',
				'post_reviewer',
				candidateIds.map((id) =>
					artifactRecord(id, 'CONFIRMED', 'route_to_critic', 'HIGH'),
				),
			),
		);
		expect(message).toContain(
			'must exactly cover the discovered candidate inventory',
		);
		expect(message).toContain('missing: M-0');

		const result = await writePrReviewFindings(
			directory,
			'run-full',
			'post_reviewer',
			[...candidateIds, 'M-0'].map((id) =>
				artifactRecord(id, 'CONFIRMED', 'route_to_critic', 'HIGH'),
			),
		);
		expect(result).toContain('"success": true');
	});

	test('a post-trigger-eval post_explorer re-write must cover the full inventory', async () => {
		await settleBaseWaves();
		await completeTriggerEvaluation('run-rewrite');

		const message = await rejectionMessage(
			writePrReviewFindings(
				directory,
				'run-rewrite',
				'post_explorer',
				pendingRecords(candidateIds),
			),
		);
		expect(message).toContain('missing: M-0');

		const result = await writePrReviewFindings(
			directory,
			'run-rewrite',
			'post_explorer',
			pendingRecords([...candidateIds, 'M-0']),
		);
		expect(result).toContain('"success": true');
	});

	test('a clean base wave persists the CLEAN-REVIEW sentinel early', async () => {
		await settleBaseWaves({ zeroCandidates: true });

		const result = await writePrReviewFindings(
			directory,
			'run-clean',
			'post_explorer',
			[artifactRecord('CLEAN-REVIEW', 'PENDING', 'route_to_reviewer', 'NONE')],
		);
		expect(result).toContain('"success": true');
	});

	test('severity mismatches in the early write keep the #2277 one-round-trip shape', async () => {
		await settleBaseWaves();

		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'run-sev', 'post_explorer', [
				...pendingRecords(candidateIds.slice(0, 5)),
				artifactRecord('C-5', 'PENDING', 'route_to_reviewer', 'LOW'),
			]),
		);
		expect(message).toContain(
			'BLOCKED: PR_REVIEW post_explorer artifact invalid — 1 violation(s):',
		);
		expect(message).toContain('C-5: severity expected "HIGH", got "LOW"');
	});
});
