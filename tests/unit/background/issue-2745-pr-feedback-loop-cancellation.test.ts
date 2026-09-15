/**
 * Late-window cancellation regressions for issue #2745.
 *
 * These tests pin that cancellation immediately before an external action
 * clears its exact durable reservation and never invokes the performer.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readPrFeedbackMonitorQueue } from '../../../src/background/pr-feedback-event-queue.js';
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
	NOW,
	readState,
	restoreProductionLoopInternals,
	SESSION,
	writeState,
} from './issue-2745-state-safety-fixtures';

let releaseLoopInternals!: () => void;

beforeEach(async () => {
	releaseLoopInternals = await acquireLoopInternals();
});

describe('FB-013 regression: cancellation in the late local window', () => {
	test('does not perform, leaves no inFlight reservation, and clears the queue', async () => {
		// Before the fix, final admission persisted actionStartedAt before the
		// synchronous late-cancellation check. Cancellation therefore retained a
		// reservation for an external action whose performer was never called.
		const directory = makeProject();
		await createCorrelation(directory);
		const seams = installHappySeams();
		const productionWriteState = loopInternals.writeState;
		let cancellation: ReturnType<typeof cancelPrFeedbackLoop> | undefined;
		let injected = false;
		loopInternals.writeState = async (stateDirectory, state) => {
			const inFlight = state.correlations[CORRELATION]?.inFlight;
			if (
				!injected &&
				stateDirectory === directory &&
				inFlight?.dedupToken === 'late-local-cancellation'
			) {
				injected = true;
				cancellation = cancelPrFeedbackLoop(
					stateDirectory,
					SESSION,
					'late local cancellation regression',
				);
			}
			await productionWriteState(stateDirectory, state);
		};
		await enqueue(directory, {
			dedupToken: 'late-local-cancellation',
			type: 'pr.merge.conflict',
		});

		const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);
		if (!cancellation) throw new Error('late cancellation was not injected');
		const stopped = await cancellation;

		expect(injected).toBe(true);
		expect(seams.performer).not.toHaveBeenCalled();
		expect(result.terminal?.state).toBe('cancelled');
		expect(stopped.terminalState).toBe('cancelled');
		const persisted = readState(directory);
		expect(persisted.correlations[CORRELATION].inFlight).toBeNull();
		expect(persisted.sessionTerminals[SESSION].state).toBe('cancelled');
		const queue = await readPrFeedbackMonitorQueue(directory, SESSION);
		expect(queue?.events ?? []).toHaveLength(0);
	});

	test('a stop arriving during the durable marker write removes the exact pre-performer reservation', async () => {
		const directory = makeProject();
		await createCorrelation(directory);
		const seams = installHappySeams();
		const productionWriteState = loopInternals.writeState;
		let cancellation: ReturnType<typeof cancelPrFeedbackLoop> | undefined;
		let injected = false;
		const writeObservations: string[] = [];
		loopInternals.writeState = async (stateDirectory, state) => {
			const inFlight = state.correlations[CORRELATION]?.inFlight;
			if (inFlight?.dedupToken === 'cancel-during-marker-write') {
				writeObservations.push(
					inFlight.actionStartedAt === undefined ? 'no-marker' : 'marker',
				);
			} else if (injected) {
				writeObservations.push('no-inFlight');
			}
			if (
				!injected &&
				stateDirectory === directory &&
				inFlight?.dedupToken === 'cancel-during-marker-write' &&
				inFlight.actionStartedAt !== undefined
			) {
				injected = true;
				cancellation = cancelPrFeedbackLoop(
					stateDirectory,
					SESSION,
					'cancel while marker write awaits',
				);
			}
			await productionWriteState(stateDirectory, state);
		};
		await enqueue(directory, {
			dedupToken: 'cancel-during-marker-write',
			type: 'pr.merge.conflict',
		});

		const result = await claimAndProcessPrFeedbackEvent(directory, SESSION);
		if (!cancellation)
			throw new Error('marker-write cancellation was not injected');
		const stopped = await cancellation;

		expect(injected).toBe(true);
		expect(writeObservations).toContain('marker');
		expect(writeObservations).toContain('no-inFlight');
		expect(seams.performer).not.toHaveBeenCalled();
		expect(result.terminal?.state).toBe('cancelled');
		expect(stopped.terminalState).toBe('cancelled');
		const persisted = readState(directory);
		expect(persisted.correlations[CORRELATION].inFlight).toBeNull();
		expect(persisted.sessionTerminals[SESSION].state).toBe('cancelled');
		const queue = await readPrFeedbackMonitorQueue(directory, SESSION);
		expect(queue?.events ?? []).toHaveLength(0);
	});
});

test('FB-018 / Stage-B regression: repeated cancellation preserves the first session reason', async () => {
	// Before the fix, the second durable cancel replaced session reason A with B,
	// which a live owner's later settlement could copy to the correlation terminal.
	// A delayed claim performer cannot let cancellation persist while holding the
	// same session settlement lock, so seed the exact durable owner through the
	// real state writer and exercise the public cancel path deterministically.
	const directory = makeProject();
	await createCorrelation(directory);
	const state = readState(directory);
	state.correlations[CORRELATION].inFlight = {
		dedupToken: 'repeat-cancel-preserves-first-reason',
		workflowInstanceId: 'cancel-reason-owner',
		ownerPid: process.pid,
		actionClass: 'fix_ci',
		head: HEAD,
		performed: false,
		attempts: 0,
		claimedAt: new Date(0).toISOString(),
		actionStartedAt: NOW,
	};
	writeState(directory, state);
	loopInternals.isProcessAlive = mock(() => true);

	await cancelPrFeedbackLoop(directory, SESSION, 'first cancellation reason');
	await cancelPrFeedbackLoop(
		directory,
		SESSION,
		'replacement cancellation reason',
	);
	const repeatedState = readState(directory);
	expect(repeatedState.sessionTerminals[SESSION]).toEqual({
		state: 'cancelled',
		reason: 'first cancellation reason',
	});
	expect(repeatedState.correlations[CORRELATION].terminal).toEqual({
		state: 'cancelled',
		reason: 'first cancellation reason',
	});
	expect(repeatedState.correlations[CORRELATION].inFlight).toMatchObject({
		workflowInstanceId: 'cancel-reason-owner',
		ownerPid: process.pid,
		actionStartedAt: NOW,
	});

	loopInternals.isProcessAlive = mock(() => false);
	await cancelPrFeedbackLoop(directory, SESSION, 'cleanup after owner exit');
	const finalState = readState(directory);
	expect(finalState.sessionTerminals[SESSION]).toEqual({
		state: 'cancelled',
		reason: 'first cancellation reason',
	});
	expect(finalState.correlations[CORRELATION].terminal).toEqual({
		state: 'cancelled',
		reason: 'first cancellation reason',
	});
	expect(finalState.correlations[CORRELATION].inFlight).toBeNull();
});

afterEach(() => {
	try {
		restoreProductionLoopInternals();
	} finally {
		releaseLoopInternals();
	}
});
