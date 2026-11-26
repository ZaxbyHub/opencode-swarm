import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { _test_exports as stageBInternals } from '../../../src/background/stage-b-gates';
import {
	readTaskGateRequirementsReceiptsSync,
	routeEvidenceFromTaskGateRequirements,
} from '../../../src/evidence/task-gate-requirements';
import {
	_internals as gateEvidenceInternals,
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
	type ReviewRouteEvidence,
} from '../../../src/review/routing-enforcement';
import { isStageBRouteCompleteAtSettlement } from '../../../src/review/stage-b-route-settlement';
import {
	ensureAgentSession,
	getSettledStageBRouteEvidence,
	getStageBRouteEvidence,
	mergeStageBRouteEvidence,
	recordStageBRouteEvidence,
	reserveStageBRouteEvidence,
	resetSwarmState,
	stageBRouteEvidenceForSettlement,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SESSION = 'session-route-consensus';
const TASK = '1.30';
const originalReceiptAppend =
	gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded;

function binding(
	role: 'reviewer' | 'test_engineer',
	callId: string,
	generation = 1,
): ReviewRouteEvidence {
	const slot = role === 'reviewer' ? 'reviewer' : 'test_engineer';
	return {
		role,
		identity: `${TASK}:${slot}:1`,
		sessionId: SESSION,
		taskId: TASK,
		slotId: `${TASK}:${slot}:1`,
		callId,
		childSessionId: `child-${callId}`,
		generation,
	};
}

function assertCurrent(
	reservation: ReturnType<typeof reserveStageBRouteEvidence>,
): void {
	if (!reservation?.isCurrent()) throw new Error('STAGE_B_ROUTE_SUPERSEDED');
}

function resolveComplete(
	directory: string,
	session: NonNullable<ReturnType<typeof ensureAgentSession>>,
	current: ReviewRouteEvidence,
): boolean {
	return isStageBRouteCompleteAtSettlement({
		directory,
		session,
		sessionId: SESSION,
		taskId: TASK,
		current,
		legacyUnrouted: false,
		testEngineerExempt: false,
	});
}

describe('Stage-B durable/live route consensus (PR 3919 final critic)', () => {
	let directory: string;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

	beforeEach(async () => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		directory = canonicalMkdtemp('stage-b-route-consensus-');
		await mkdir(join(directory, '.git'), { recursive: true });
		await mkdir(join(directory, '.swarm'), { recursive: true });
		ensureAgentSession(SESSION);
		await transitionTaskWorkflowEvidence(directory, TASK, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'consensus-coder',
		});
		await transitionTaskWorkflowEvidence(directory, TASK, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'consensus-stage-a',
		});
		await persistReviewRouteReceipt({
			projectRoot: directory,
			receipt: buildReviewRouteReceipt({
				sessionId: SESSION,
				taskId: TASK,
				complexity: 'single',
				semanticRisk: 'Standard complexity: 2 files, 0 functions',
				requiredReviewers: [`${TASK}:reviewer:1`],
				requiredTestEngineers: [`${TASK}:test_engineer:1`],
			}),
		});
	});

	afterEach(async () => {
		gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
			originalReceiptAppend;
		resetSwarmState();
		await rm(directory, { recursive: true, force: true, maxRetries: 3 });
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	test('a superseded successful write is rejected before commit; durable and live winners agree', async () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const a = binding('reviewer', 'call-a', 2);
		const b = binding('reviewer', 'call-b', 3);
		const reservationA = reserveStageBRouteEvidence(session, TASK, a);
		const reservationB = reserveStageBRouteEvidence(session, TASK, b);
		expect(reservationA).not.toBeNull();
		expect(reservationB).not.toBeNull();

		await expect(
			recordGateEvidence(directory, TASK, 'reviewer', SESSION, false, {
				expectedGeneration: 1,
				transitionId: 'consensus-a',
				routeBinding: a,
				routeComplete: false,
				beforeCommit: () => assertCurrent(reservationA),
			}),
		).rejects.toThrow('STAGE_B_ROUTE_SUPERSEDED');

		await recordGateEvidence(directory, TASK, 'reviewer', SESSION, false, {
			expectedGeneration: 1,
			transitionId: 'consensus-b',
			routeBinding: b,
			routeComplete: false,
			beforeCommit: () => assertCurrent(reservationB),
		});
		reservationB?.settle();

		const durable = routeEvidenceFromTaskGateRequirements(
			readTaskGateRequirementsReceiptsSync(directory, TASK),
		);
		const live = getSettledStageBRouteEvidence(session, TASK);
		expect(durable).toEqual([b]);
		expect(live).toEqual([b]);
		expect(mergeStageBRouteEvidence(live, durable)).toEqual([b]);
	});

	test('a failed route-receipt append restores durable evidence before live rollback', async () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const before = await readTaskEvidence(directory, TASK);
		const beforeReceipts = readTaskGateRequirementsReceiptsSync(
			directory,
			TASK,
		);
		const current = binding('reviewer', 'append-failure');
		const reservation = reserveStageBRouteEvidence(session, TASK, current);
		expect(reservation).not.toBeNull();
		gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
			async () => {
				throw new Error('FORCED_RECEIPT_APPEND_FAILURE');
			};
		try {
			await expect(
				recordGateEvidence(directory, TASK, 'reviewer', SESSION, false, {
					expectedGeneration: 1,
					transitionId: 'append-failure',
					routeBinding: current,
					routeComplete: true,
					beforeCommit: () => assertCurrent(reservation),
				}),
			).rejects.toThrow('FORCED_RECEIPT_APPEND_FAILURE');
		} finally {
			gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
				originalReceiptAppend;
		}
		reservation?.();

		const after = await readTaskEvidence(directory, TASK);
		expect(after.workflow.state).toBe(before.workflow.state);
		expect(readTaskGateRequirementsReceiptsSync(directory, TASK)).toEqual(
			beforeReceipts,
		);
		expect(getStageBRouteEvidence(session, TASK)).toEqual([]);
	});

	test('a failed first receipt append removes the newly created evidence file', async () => {
		const taskId = '1.31';
		gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
			async () => {
				throw new Error('FORCED_FIRST_RECEIPT_APPEND_FAILURE');
			};
		try {
			await expect(
				transitionTaskWorkflowEvidence(directory, taskId, {
					type: 'accepted_mutation',
					agentType: 'coder',
					expectedGeneration: 0,
					transitionId: 'first-append-failure',
				}),
			).rejects.toThrow('FORCED_FIRST_RECEIPT_APPEND_FAILURE');
		} finally {
			gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
				originalReceiptAppend;
		}
		expect(await readTaskEvidence(directory, taskId)).toBeNull();
		expect(readTaskGateRequirementsReceiptsSync(directory, taskId)).toEqual([]);
	});

	test('the first post-restart live binding does not hide a durable sibling', async () => {
		const reviewer = binding('reviewer', 'durable-reviewer');
		const testEngineer = binding('test_engineer', 'durable-test-engineer');
		await recordGateEvidence(directory, TASK, 'reviewer', SESSION, false, {
			expectedGeneration: 1,
			transitionId: 'durable-reviewer',
			routeBinding: reviewer,
			routeComplete: false,
		});
		await recordGateEvidence(directory, TASK, 'test_engineer', SESSION, false, {
			expectedGeneration: 1,
			transitionId: 'durable-test-engineer',
			routeBinding: testEngineer,
			routeComplete: false,
		});

		resetSwarmState();
		ensureAgentSession(SESSION);
		const session = swarmState.agentSessions.get(SESSION)!;
		recordStageBRouteEvidence(session, TASK, reviewer);
		const resolved = stageBInternals.resolveBackgroundStageBRoute({
			directory,
			taskId: TASK,
			parentSessionId: SESSION,
			role: 'reviewer',
			callId: reviewer.callId!,
			childSessionId: reviewer.childSessionId!,
			generation: reviewer.generation!,
			session,
		});
		expect(resolved.prospective).toEqual([reviewer, testEngineer]);
	});

	test('lock-scoped completeness refresh advances two overlapping sibling writes', async () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const reviewer = binding('reviewer', 'overlap-reviewer');
		const testEngineer = binding('test_engineer', 'overlap-test-engineer');
		const reviewerReservation = reserveStageBRouteEvidence(
			session,
			TASK,
			reviewer,
		);
		const testEngineerReservation = reserveStageBRouteEvidence(
			session,
			TASK,
			testEngineer,
		);
		expect(reviewerReservation).not.toBeNull();
		expect(testEngineerReservation).not.toBeNull();

		await Promise.all([
			recordGateEvidence(directory, TASK, 'reviewer', SESSION, false, {
				expectedGeneration: 1,
				transitionId: 'overlap-reviewer',
				routeBinding: reviewer,
				// Deliberately stale: the lock-scoped resolver must replace this.
				routeComplete: false,
				resolveRouteComplete: () =>
					resolveComplete(directory, session, reviewer),
				beforeCommit: () => assertCurrent(reviewerReservation),
			}),
			recordGateEvidence(directory, TASK, 'test_engineer', SESSION, false, {
				expectedGeneration: 1,
				transitionId: 'overlap-test-engineer',
				routeBinding: testEngineer,
				routeComplete: false,
				resolveRouteComplete: () =>
					resolveComplete(directory, session, testEngineer),
				beforeCommit: () => assertCurrent(testEngineerReservation),
			}),
		]);
		reviewerReservation?.settle();
		testEngineerReservation?.settle();

		const evidence = await readTaskEvidence(directory, TASK);
		expect(evidence.workflow.state).toBe('tests_run');
		const durable = routeEvidenceFromTaskGateRequirements(
			readTaskGateRequirementsReceiptsSync(directory, TASK),
		);
		expect(durable).toEqual([reviewer, testEngineer]);
		expect(getSettledStageBRouteEvidence(session, TASK)).toEqual([
			reviewer,
			testEngineer,
		]);
	});

	test('the settlement view preserves durable siblings and replaces an old same-identity row', async () => {
		const oldReviewer = binding('reviewer', 'old-reviewer');
		const testEngineer = binding('test_engineer', 'durable-sibling');
		await recordGateEvidence(directory, TASK, 'reviewer', SESSION, false, {
			expectedGeneration: 1,
			transitionId: 'old-reviewer',
			routeBinding: oldReviewer,
			routeComplete: false,
		});
		await recordGateEvidence(directory, TASK, 'test_engineer', SESSION, false, {
			expectedGeneration: 1,
			transitionId: 'durable-sibling',
			routeBinding: testEngineer,
			routeComplete: false,
		});
		const durable = routeEvidenceFromTaskGateRequirements(
			readTaskGateRequirementsReceiptsSync(directory, TASK),
		);

		resetSwarmState();
		ensureAgentSession(SESSION);
		const session = swarmState.agentSessions.get(SESSION)!;
		recordStageBRouteEvidence(session, TASK, oldReviewer);
		const freshReviewer = binding('reviewer', 'fresh-reviewer', 2);
		const view = stageBRouteEvidenceForSettlement(
			session,
			TASK,
			durable,
			freshReviewer,
		);
		expect(view).toEqual([freshReviewer, testEngineer]);
	});
});
