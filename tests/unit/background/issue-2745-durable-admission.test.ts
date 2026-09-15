/**
 * Durable reservation identity regressions for issue #2745.
 *
 * The action queue and loop state are separate durable records. These tests
 * pin that a reservation owner is the workflow/PID pair, not a timestamp or a
 * stale whole-correlation snapshot.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	claimPrFeedbackMonitorEvents,
	readPrFeedbackMonitorQueue,
} from '../../../src/background/pr-feedback-event-queue.js';
import {
	cancelPrFeedbackLoop,
	claimAndProcessPrFeedbackEvent,
	_internals as loopInternals,
} from '../../../src/background/pr-feedback-loop.js';
import {
	acquireLoopInternals,
	CORRELATION,
	createCorrelation,
	enqueue,
	HEAD,
	installHappySeams,
	makeProject,
	readState,
	restoreProductionLoopInternals,
	SESSION,
	URL,
	writeState,
} from './issue-2745-state-safety-fixtures';

function putInFlight(
	directory: string,
	reservation: Record<string, unknown>,
): void {
	const state = readState(directory);
	state.correlations[CORRELATION].inFlight = reservation;
	writeState(directory, state);
}

let releaseLoopInternals!: () => void;
const ACTION_STARTED_AT = 1_700_000_000_000;

beforeEach(async () => {
	releaseLoopInternals = await acquireLoopInternals();
});

function reservation(overrides: Record<string, unknown> = {}) {
	return {
		dedupToken: 'foreign-token',
		workflowInstanceId: 'foreign-workflow',
		ownerPid: process.pid,
		actionClass: 'fix_ci',
		head: HEAD,
		performed: false,
		attempts: 0,
		claimedAt: new Date(0).toISOString(),
		actionStartedAt: ACTION_STARTED_AT,
		...overrides,
	};
}

test('a live cross-process reservation returns retryable busy and releases only its claim', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	putInFlight(directory, reservation());
	const seams = installHappySeams();
	await enqueue(directory, {
		dedupToken: 'busy-token',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);

	expect(result.reason).toMatch(/retryable.*busy/i);
	expect(seams.performer).not.toHaveBeenCalled();
	const queue = await readPrFeedbackMonitorQueue(directory, SESSION);
	expect(
		queue?.events.find((entry) => entry.dedupToken === 'busy-token')
			?.claimedWorkflowInstanceId,
	).toBeUndefined();
	expect(readState(directory).correlations[CORRELATION].inFlight).toMatchObject(
		{
			workflowInstanceId: 'foreign-workflow',
			ownerPid: process.pid,
		},
	);
});

test('does not resurrect historical in-memory correlation when final admission loses its durable key (FB-015)', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	const seams = installHappySeams();
	const productionReadState = loopInternals.readState;
	const productionWriteState = loopInternals.writeState;
	let removed = false;
	let writesAfterRemoval = 0;
	loopInternals.readState = async (stateDirectory) => {
		const state = await productionReadState(stateDirectory);
		// The oversight sequence is incremented immediately before final action
		// admission. This project already consumed sequence 1 while seeding the
		// historical correlation, so sequence 2 identifies the final read for the
		// new event. Model another durable writer removing the key at that boundary;
		// the stale local snapshot must not be written back.
		if (!removed && state.oversightSeq >= 2) {
			removed = true;
			const observed = JSON.parse(JSON.stringify(state)) as typeof state;
			delete observed.correlations[CORRELATION];
			return observed;
		}
		return state;
	};
	loopInternals.writeState = async (stateDirectory, state) => {
		if (removed) writesAfterRemoval += 1;
		await productionWriteState(stateDirectory, state);
	};
	await enqueue(directory, {
		dedupToken: 'missing-final-correlation',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);

	expect(result.reason).toMatch(/durable correlation disappeared/i);
	expect(seams.performer).not.toHaveBeenCalled();
	expect(writesAfterRemoval).toBe(0);
	expect(readState(directory).correlations[CORRELATION]?.inFlight).toBeNull();
	const queueAfter = await readPrFeedbackMonitorQueue(directory, SESSION);
	expect(
		queueAfter?.events.find(
			(event) => event.dedupToken === 'missing-final-correlation',
		)?.claimedWorkflowInstanceId,
	).toBeUndefined();
});

describe('FB-013 regression: missing correlation on the action-start reread', () => {
	test('does not resurrect it and releases only this worker’s exact queue claim', async () => {
		// Before this fix, refusal settlement recreated the deleted record from its
		// stale snapshot and stranded the exact queue claim despite reporting retryable.
		const directory = makeProject();
		await createCorrelation(directory);
		await enqueue(directory, { dedupToken: 'other-owner-event' });
		const competingWorkflow = 'competing-queue-owner';
		const competingPid = 42_425;
		const competingClaim = await claimPrFeedbackMonitorEvents(
			directory,
			SESSION,
			competingWorkflow,
			URL,
			['other-owner-event'],
			competingPid,
		);
		expect(competingClaim).toHaveLength(1);
		await enqueue(directory, {
			dedupToken: 'missing-action-start-correlation',
			type: 'pr.merge.conflict',
		});

		const seams = installHappySeams();
		const productionReadState = loopInternals.readState;
		const productionWriteState = loopInternals.writeState;
		let deletedAtActionStartRead = false;
		let writesAfterDeletion = 0;
		loopInternals.readState = async (stateDirectory) => {
			const state = await productionReadState(stateDirectory);
			const inFlight = state.correlations[CORRELATION]?.inFlight;
			if (
				!deletedAtActionStartRead &&
				stateDirectory === directory &&
				inFlight?.dedupToken === 'missing-action-start-correlation' &&
				inFlight.actionStartedAt === undefined
			) {
				// Final admission just persisted this exact pre-start reservation; this
				// is the next read, inside markExactReservationActionStarted.
				deletedAtActionStartRead = true;
				delete state.correlations[CORRELATION];
				await productionWriteState(stateDirectory, state);
			}
			return state;
		};
		loopInternals.writeState = async (stateDirectory, state) => {
			if (deletedAtActionStartRead && stateDirectory === directory)
				writesAfterDeletion += 1;
			await productionWriteState(stateDirectory, state);
		};

		const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);

		expect(deletedAtActionStartRead).toBe(true);
		expect(writesAfterDeletion).toBe(0);
		expect(readState(directory).correlations[CORRELATION]).toBeUndefined();
		expect(result.ran).toBe(false);
		expect(result.reason).toMatch(/correlation disappeared.*retryable/i);
		expect(seams.performer).not.toHaveBeenCalled();
		const queue = await readPrFeedbackMonitorQueue(directory, SESSION);
		expect(
			queue?.events.find(
				(event) => event.dedupToken === 'missing-action-start-correlation',
			)?.claimedWorkflowInstanceId,
		).toBeUndefined();
		expect(
			queue?.events.find((event) => event.dedupToken === 'other-owner-event'),
		).toMatchObject({
			claimedWorkflowInstanceId: competingWorkflow,
			claimedOwnerPid: competingPid,
		});
	});
});

test('final admission counts live reservations from every PR in the session budget', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			pr_monitor: { enabled: true, auto_pr_feedback: true },
			pr_feedback_loop: { enabled: true, max_session_actions: 2 },
		}),
		'utf8',
	);
	const state = readState(directory);
	state.correlations[`${SESSION}::example/repo::43`] = {
		revision: 1,
		sessionID: SESSION,
		repoFullName: 'example/repo',
		prNumber: 43,
		prActionsUsed: 0,
		processedDigests: [],
		circuit: { failures: 0, openUntil: 0, halfOpenProbes: 0 },
		inFlight: reservation({
			dedupToken: 'other-pr',
			workflowInstanceId: 'other-pr-worker',
			actionStartedAt: undefined,
		}),
		terminal: null,
	};
	writeState(directory, state);
	const seams = installHappySeams();
	await enqueue(directory, {
		dedupToken: 'session-capacity',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);
	expect(result.reason).toMatch(/retryable.*capacity/i);
	expect(seams.performer).not.toHaveBeenCalled();
	const queue = await readPrFeedbackMonitorQueue(directory, SESSION);
	expect(
		queue?.events.find((entry) => entry.dedupToken === 'session-capacity')
			?.claimedWorkflowInstanceId,
	).toBeUndefined();
});

test('a dead owner is recoverable only before the action-started marker', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	putInFlight(
		directory,
		reservation({
			workflowInstanceId: 'dead-before-start',
			ownerPid: 42_424,
			actionStartedAt: undefined,
		}),
	);
	const seams = installHappySeams();
	loopInternals.isProcessAlive = mock(() => false);
	await enqueue(directory, {
		dedupToken: 'recover-dead',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);

	expect(result.terminal?.state).toBe('completed');
	expect(seams.performer).toHaveBeenCalledTimes(1);
});

test('a dead owner after actionStartedAt remains counted and blocks recovery', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	putInFlight(
		directory,
		reservation({
			workflowInstanceId: 'dead-after-start',
			ownerPid: 42_424,
			actionStartedAt: ACTION_STARTED_AT,
		}),
	);
	const seams = installHappySeams();
	loopInternals.isProcessAlive = mock(() => false);
	await enqueue(directory, {
		dedupToken: 'dead-started',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);

	expect(result.reason).toMatch(/retryable.*busy/i);
	expect(seams.performer).not.toHaveBeenCalled();
	expect(readState(directory).correlations[CORRELATION].inFlight).toMatchObject(
		{
			workflowInstanceId: 'dead-after-start',
			ownerPid: 42_424,
		},
	);
});

test('F-BUDGET cancellation reclaims a started reservation whose owner is dead', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	putInFlight(
		directory,
		reservation({
			workflowInstanceId: 'cancelled-dead-owner',
			ownerPid: 42_424,
			actionStartedAt: ACTION_STARTED_AT,
		}),
	);
	loopInternals.isProcessAlive = mock(() => false);

	const stopped = await cancelPrFeedbackLoop(
		directory,
		SESSION,
		'operator stop reclaims stale action reservation',
	);

	expect(stopped.terminalState).toBe('cancelled');
	expect(readState(directory).correlations[CORRELATION].inFlight).toBeNull();
});

test('FB-018 regression: repeated cancel reclaims a started reservation after its owner exits', async () => {
	// Before the fix, repeat cancellation skipped an already-cancelled correlation
	// before checking owner liveness, leaving this started reservation busy forever.
	const directory = makeProject();
	await createCorrelation(directory);
	putInFlight(
		directory,
		reservation({
			workflowInstanceId: 'cancel-owner-exit',
			ownerPid: 42_424,
		}),
	);
	let ownerAlive = true;
	loopInternals.isProcessAlive = mock(() => ownerAlive);

	const firstStop = await cancelPrFeedbackLoop(
		directory,
		SESSION,
		'first explicit stop',
	);
	const firstState = readState(directory);
	expect(firstStop.terminalState).toBe('cancelled');
	expect(firstState.correlations[CORRELATION].terminal).toEqual({
		state: 'cancelled',
		reason: 'first explicit stop',
	});
	expect(firstState.correlations[CORRELATION].inFlight).toMatchObject({
		workflowInstanceId: 'cancel-owner-exit',
		ownerPid: 42_424,
		actionStartedAt: ACTION_STARTED_AT,
	});

	ownerAlive = false;
	const secondStop = await cancelPrFeedbackLoop(
		directory,
		SESSION,
		'retry cleanup after owner exit',
	);
	const finalState = readState(directory);
	expect(secondStop.terminalState).toBe('cancelled');
	expect(finalState.correlations[CORRELATION].terminal).toEqual({
		state: 'cancelled',
		reason: 'first explicit stop',
	});
	expect(finalState.correlations[CORRELATION].inFlight).toBeNull();
});

test('a late result cannot settle over a replacement reservation owner', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const seams = installHappySeams();
	let resolveActionStarted!: () => void;
	const actionStarted = new Promise<void>((resolve) => {
		resolveActionStarted = resolve;
	});
	loopInternals.performAuthorizedAction = mock(async () => {
		resolveActionStarted();
		await gate;
		return { performed: true };
	}) as unknown as typeof loopInternals.performAuthorizedAction;
	await enqueue(directory, {
		dedupToken: 'late-owner-result',
		type: 'pr.merge.conflict',
	});
	const processing = claimAndProcessPrFeedbackEvent(directory, SESSION);
	await actionStarted;
	expect(loopInternals.performAuthorizedAction).toHaveBeenCalledTimes(1);
	putInFlight(
		directory,
		reservation({
			workflowInstanceId: 'replacement-owner',
			ownerPid: 42_424,
			actionStartedAt: undefined,
		}),
	);
	release();

	const result = await processing;

	expect(result.action?.performed).toBe(true);
	expect(result.terminal?.state).toBe('paused_for_human');
	expect(result.terminal?.reason).toMatch(
		/lost its exact durable reservation owner/i,
	);
	expect(seams.performer).not.toHaveBeenCalled();
	expect(readState(directory).correlations[CORRELATION].inFlight).toMatchObject(
		{
			workflowInstanceId: 'replacement-owner',
			ownerPid: 42_424,
		},
	);
});

test('legacy ownerless inFlight state fails closed instead of using age recovery', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	putInFlight(
		directory,
		reservation({
			workflowInstanceId: undefined,
			ownerPid: undefined,
			actionStartedAt: undefined,
		}),
	);
	const seams = installHappySeams();
	await enqueue(directory, {
		dedupToken: 'legacy-ownerless',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);

	expect(result.reason).toMatch(/retryable.*busy/i);
	expect(seams.performer).not.toHaveBeenCalled();
});

test('correlation CAS revisions increase across durable cancellation and remain monotonic', async () => {
	const directory = makeProject();
	await createCorrelation(directory);
	const before = readState(directory).correlations[CORRELATION].revision;

	const stopped = await cancelPrFeedbackLoop(
		directory,
		SESSION,
		'revision stop',
	);

	const after = readState(directory).correlations[CORRELATION].revision;
	expect(stopped.terminalState).toBe('cancelled');
	expect(after).toBeGreaterThan(before);

	const stoppedAgain = await cancelPrFeedbackLoop(
		directory,
		SESSION,
		'another reason',
	);
	const finalRevision = readState(directory).correlations[CORRELATION].revision;
	expect(stoppedAgain.terminalState).toBe('cancelled');
	expect(finalRevision).toBeGreaterThanOrEqual(after);
});

afterEach(() => {
	try {
		restoreProductionLoopInternals();
	} finally {
		releaseLoopInternals();
	}
});
