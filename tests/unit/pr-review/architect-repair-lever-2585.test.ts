/**
 * Issue #2585 (Roadmap H8, AC13) — the architect-PARENT repair lever for the
 * strict child-only PR-review receipt contract.
 *
 * When a lane's child dies before submitting (cancelled lane, stale-swept
 * lane, or a typed liveness-error lane — the #2615 producers), the lane's
 * dispatching parent session (the gate owner) may land exactly one truthful
 * receipt for that lane. The receipt stays CHILD-bound and carries architect
 * provenance; every other session keeps the frozen closed-door refusal.
 *
 * Base sentinel (frozen acceptance regex):
 *   AC13 architect repair lever absent.*expected one exact child delegation
 *
 * No mock.module; gate git seams are stubbed through the gate's `_test_exports`
 * and restored in afterEach (registered-path-matrix precedent). Terminal lane
 * shapes are produced through the production settle/transition writers, never
 * by hand-writing ledger rows.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { settleDelegationTerminal } from '../../../src/background/delegation-lifecycle.js';
import {
	appendDelegationTransition,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	encodePrReviewWorkflowBinding,
	type PrReviewLaneResultEnvelope,
} from '../../../src/background/pr-review-contract.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
	submitPrReviewResult,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeCompletePrWorkflow } from '../../../src/tools/complete-pr-workflow.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const SESSION_ID = 'ses_arch_parent';
const CHILD_SESSION_ID = 'ses_dead_child';
/** A sibling architect from another swarm (the #2609 multi-swarm shape). */
const SIBLING_SESSION_ID = 'ses_sibling_architect';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const BATCH_ID = 'repair-base-batch';
const LANE_ID = 'repair-base-lane';
const DIMENSION = PR_REVIEW_BASE_DIMENSION_IDS[0]!;
const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');
const FIXED_NOW = 1_800_000_000_000;

const originals = {
	head: _test_exports.resolveCurrentGitHead,
	headAsync: _test_exports.resolveCurrentGitHeadAsync,
	revision: _test_exports.resolvePrWorkflowRevisionDigest,
	clean: _test_exports.resolveIsWorkingTreeClean,
	cleanAsync: _test_exports.resolveIsWorkingTreeCleanAsync,
	diffStats: _test_exports.resolvePrReviewDiffStats,
	diffStatsAsync: _test_exports.resolvePrReviewDiffStatsAsync,
};

let directory = '';
let restoreClock: (() => void) | null = null;

function cleanEnvelope(): PrReviewLaneResultEnvelope {
	return {
		schemaVersion: 1,
		outcome: 'CLEAN',
		creditedLanes: [DIMENSION],
		findings: [],
		cleanAttestations: [
			{
				workflowLane: DIMENSION,
				coverageScope: `Complete ${DIMENSION} surface on the bound diff.`,
				evidence:
					'The architect parent attests no actionable defect on the repaired lane.',
			},
		],
		unresolved: [],
	};
}

function incompleteEnvelope(): PrReviewLaneResultEnvelope {
	return {
		schemaVersion: 1,
		outcome: 'INCOMPLETE',
		creditedLanes: [],
		findings: [],
		cleanAttestations: [],
		unresolved: [
			{
				workflowLane: DIMENSION,
				reason: 'NOT_EXECUTED',
				detail:
					'Child died before submitting; the architect parent records the truthful unresolved-terminal state.',
			},
		],
	};
}

/** Activate + bind + admit one singleton base lane; returns the dispatch binding. */
async function establishRun(): Promise<{
	workflowInstanceId: string;
	generation: number;
}> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
		prHeadSha: HEAD_SHA,
	});
	await bindPrReviewBase(directory, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: BASE_SHA,
	});
	const state = await enforcePrReviewBaseDimensions(
		directory,
		SESSION_ID,
		[{ laneId: LANE_ID, workflowLane: DIMENSION }],
		{
			batchId: BATCH_ID,
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		},
	);
	if (!state.workflowInstanceId) throw new Error('missing workflow instance');
	return {
		workflowInstanceId: state.workflowInstanceId,
		generation: state.revision,
	};
}

/** Seed the lane's delegation record exactly as dispatch_lanes_async writes it. */
async function seedLane(options: {
	workflowInstanceId: string;
	generation: number;
	childSessionId?: string;
	parentSessionId?: string;
}): Promise<string> {
	const childSessionId = options.childSessionId ?? CHILD_SESSION_ID;
	await recordPendingDelegation(directory, {
		correlationId: childSessionId,
		jobId: encodePrReviewWorkflowBinding(options.workflowInstanceId),
		subagentSessionId: childSessionId,
		parentSessionId: options.parentSessionId ?? SESSION_ID,
		callID: `call-${childSessionId}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: BATCH_ID,
		laneId: LANE_ID,
		mode: 'swarm-pr-review:base',
		workflowLane: DIMENSION,
		workflowGeneration: options.generation,
		generation: 1,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	return childSessionId;
}

/** Flip the seeded lane terminal through the production #2615 producers. */
async function flipTerminal(
	childSessionId: string,
	shape: 'cancelled' | 'stale' | 'error',
): Promise<void> {
	if (shape === 'cancelled') {
		// The collect-path cancel settle (dispatch-lanes cancel_pending).
		const record = findByCorrelationId(directory, childSessionId);
		if (!record) throw new Error('missing seeded lane');
		const outcome = await settleDelegationTerminal(directory, record, {
			status: 'cancelled',
			result: {
				error: 'lane cancelled via collect_lane_results cancel_pending',
				chars: 0,
				truncated: false,
				digest: EMPTY_DIGEST,
				workflowLaneFailureClass: 'liveness',
			},
		});
		expect(outcome?.kind).toBe('claimed');
		return;
	}
	// The stale-sweep / Task-side liveness flip shape (pending-delegations sweep,
	// dispatch-lanes idle-stale flip): terminal status + typed liveness class.
	const reason = `lane presumed ${shape} without an observed host terminal event`;
	const flipped = await appendDelegationTransition(directory, childSessionId, {
		status: shape,
		result: {
			error: reason,
			chars: reason.length,
			truncated: false,
			digest: createHash('sha256').update(reason).digest('hex'),
			workflowLaneFailureClass: 'liveness',
		},
	});
	expect(flipped?.status).toBe(shape);
}

function submitRepair(
	invokerSessionId: string,
	envelope: PrReviewLaneResultEnvelope,
): Promise<ReturnType<typeof submitPrReviewResult>> {
	return submitPrReviewResult(directory, invokerSessionId, {
		batchId: BATCH_ID,
		laneId: LANE_ID,
		revisionDigest: REVISION_DIGEST,
		result: envelope,
	});
}

function recordedReceipt(
	childSessionId: string,
): ReturnType<typeof findByCorrelationId>['result'] {
	const record = findByCorrelationId(directory, childSessionId);
	return record?.result;
}

/** Windows EBUSY-safe teardown: bounded rm retry (4 attempts, 20ms apart). */
async function removeTempDir(): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt >= 4 || (error as NodeJS.ErrnoException).code !== 'EBUSY')
				throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

beforeEach(async () => {
	restoreClock = freezeClock({ fixedNow: FIXED_NOW });
	directory = canonicalMkdtemp('pr-review-architect-repair-');
	await initializeGitRepository(directory);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
	_test_exports.resolvePrReviewDiffStats = () => ({
		changedLines: 40,
		changedFiles: 4,
		hasSubmoduleChange: false,
	});
	_test_exports.resolvePrReviewDiffStatsAsync = async (...args) =>
		_test_exports.resolvePrReviewDiffStats(...args);
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originals.head;
	_test_exports.resolveCurrentGitHeadAsync = originals.headAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originals.revision;
	_test_exports.resolveIsWorkingTreeClean = originals.clean;
	_test_exports.resolveIsWorkingTreeCleanAsync = originals.cleanAsync;
	_test_exports.resolvePrReviewDiffStats = originals.diffStats;
	_test_exports.resolvePrReviewDiffStatsAsync = originals.diffStatsAsync;
	closeAllProjectDbs();
	await removeTempDir();
	restoreClock?.();
});

describe('architect-parent repair lever — submitPrReviewResult (issue #2585 AC13)', () => {
	test('cancelled lane: the dispatching parent lands a provenance-stamped child-bound receipt (base sentinel)', async () => {
		const run = await establishRun();
		await seedLane(run);
		await flipTerminal(CHILD_SESSION_ID, 'cancelled');

		const outcome = await submitRepair(SESSION_ID, incompleteEnvelope());
		if (outcome.status === 'rejected') {
			throw new Error(`AC13 architect repair lever absent: ${outcome.reason}`);
		}
		expect(outcome.status).toBe('recorded');
		const receipt = recordedReceipt(CHILD_SESSION_ID)?.prReviewResultReceipt;
		expect(receipt?.submittedBy).toBe('workflow_parent');
		expect(receipt?.submittedByParentSessionId).toBe(SESSION_ID);
		expect(receipt?.laneTerminalStateAtSubmission).toBe('cancelled');
		// The receipt stays bound to the DEAD CHILD, never to the invoker.
		expect(receipt?.childSessionId).toBe(CHILD_SESSION_ID);
	});

	test.each([
		'stale',
		'error',
	] as const)('%s lane: the dispatching parent lands a provenance-stamped receipt', async (shape) => {
		const run = await establishRun();
		await seedLane(run);
		await flipTerminal(CHILD_SESSION_ID, shape);

		const outcome = await submitRepair(SESSION_ID, incompleteEnvelope());
		if (outcome.status === 'rejected') {
			throw new Error(`AC13 architect repair lever absent: ${outcome.reason}`);
		}
		expect(outcome.status).toBe('recorded');
		const receipt = recordedReceipt(CHILD_SESSION_ID)?.prReviewResultReceipt;
		expect(receipt?.submittedBy).toBe('workflow_parent');
		expect(receipt?.submittedByParentSessionId).toBe(SESSION_ID);
		expect(receipt?.laneTerminalStateAtSubmission).toBe(shape);
		expect(receipt?.childSessionId).toBe(CHILD_SESSION_ID);
	});

	test('multi-swarm closed door: a sibling architect session keeps the frozen exact-child refusal', async () => {
		const run = await establishRun();
		await seedLane(run);
		await flipTerminal(CHILD_SESSION_ID, 'cancelled');

		// Full-message pin: the frozen acceptance sentinel must stay byte-exact.
		expect(await submitRepair(SIBLING_SESSION_ID, cleanEnvelope())).toEqual({
			status: 'rejected',
			reason: 'expected one exact child delegation, found 0',
		});
	});

	test('alive-but-slow child: the lever never fires while the lane is non-terminal', async () => {
		const run = await establishRun();
		await seedLane(run);
		const running = await appendDelegationTransition(
			directory,
			CHILD_SESSION_ID,
			{ status: 'running' },
		);
		expect(running?.status).toBe('running');

		expect(await submitRepair(SESSION_ID, cleanEnvelope())).toEqual({
			status: 'rejected',
			reason: 'expected one exact child delegation, found 0',
		});
	});

	test('stale workflow binding (instance only): a repaired lane from a superseded instance is refused', async () => {
		const run = await establishRun();
		// Instance differs, generation EQUAL: isolates the instance-binding leg.
		await seedLane({
			workflowInstanceId: 'wf-superseded-instance',
			generation: run.generation,
		});
		await flipTerminal(CHILD_SESSION_ID, 'cancelled');

		const outcome = await submitRepair(SESSION_ID, incompleteEnvelope());
		expect(outcome).toEqual({
			status: 'rejected',
			reason: 'stale workflow instance binding',
		});
	});

	test('stale workflow binding (generation only): a same-instance superseded-generation lane is refused with a typed reason', async () => {
		const run = await establishRun();
		// Instance EQUAL, generation differs: isolates the generation-binding
		// leg (the abort + reactivate shape within one workflow instance).
		await seedLane({
			workflowInstanceId: run.workflowInstanceId,
			generation: run.generation + 3,
		});
		await flipTerminal(CHILD_SESSION_ID, 'cancelled');

		const outcome = await submitRepair(SESSION_ID, incompleteEnvelope());
		expect(outcome.status).toBe('rejected');
		if (outcome.status === 'rejected') {
			expect(outcome.reason).toContain(
				'superseded workflow generation binding',
			);
			expect(outcome.reason).toContain(`${run.generation + 3}`);
			expect(outcome.reason).toContain(`${run.generation}`);
		}
	});

	test('outcome gate: a CLEAN repair envelope is refused — repair may only record INCOMPLETE', async () => {
		const run = await establishRun();
		await seedLane(run);
		await flipTerminal(CHILD_SESSION_ID, 'cancelled');

		// The dead child never produced coverage, so a CLEAN attestation via the
		// repair lever would be untruthful; the gate must refuse it.
		expect(await submitRepair(SESSION_ID, cleanEnvelope())).toEqual({
			status: 'rejected',
			reason:
				'architect-parent repair may only record an unresolved-terminal (INCOMPLETE) outcome',
		});
		expect(recordedReceipt(CHILD_SESSION_ID)?.prReviewResultReceipt).toBe(
			undefined,
		);
	});

	test('truthful completion: the repaired lane completes as disclosed unresolved-terminal (INCOMPLETE)', async () => {
		const run = await establishRun();
		await seedLane(run);
		await flipTerminal(CHILD_SESSION_ID, 'cancelled');
		const repair = await submitRepair(SESSION_ID, incompleteEnvelope());
		if (repair.status === 'rejected') {
			throw new Error(`AC13 architect repair lever absent: ${repair.reason}`);
		}

		const completion = JSON.parse(
			await executeCompletePrWorkflow(
				{
					mode: 'PR_REVIEW',
					pr_head_sha: HEAD_SHA,
					report_verdict: 'INCOMPLETE',
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		) as {
			success: boolean;
			status: string;
			gate_cleared: boolean;
			terminal_report?: {
				kind: string;
				unresolved_dimensions: Array<{ dimension: string }>;
			};
		};
		expect(completion.success).toBe(true);
		expect(completion.status).toBe('completed');
		expect(completion.gate_cleared).toBe(true);
		expect(completion.terminal_report?.kind).toBe('NO_COVERAGE');
		expect(
			completion.terminal_report?.unresolved_dimensions.some(
				(entry) => entry.dimension === DIMENSION,
			),
		).toBe(true);
		// The repaired lane's provenance-stamped receipt survives the clear.
		expect(
			recordedReceipt(CHILD_SESSION_ID)?.prReviewResultReceipt?.submittedBy,
		).toBe('workflow_parent');
	});
});
