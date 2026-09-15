/**
 * Issue #2745 activation-safety regressions for durable probes and locks.
 *
 * These tests use real bounded project state plus the loop's DI seam. They pin
 * restart recovery and cross-process interleavings that happy-path tests miss.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import {
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
	loopStateLockPath,
	makeProject,
	NOW,
	prime,
	readState,
	restoreProductionLoopInternals,
	SESSION,
	setExpiredProbe,
	writeLiveLock,
	writeState,
} from './issue-2745-state-safety-fixtures';

let releaseLoopInternals!: () => void;

beforeEach(async () => {
	releaseLoopInternals = await acquireLoopInternals();
});

test('a fresh persisted marker refuses the second oversight and action', async () => {
	const dir = makeProject();
	await createCorrelation(dir);
	setExpiredProbe(dir, 'fresh');
	const seams = installHappySeams();
	loopInternals.now = () => NOW;
	await enqueue(dir, { dedupToken: 'fresh-second', type: 'pr.merge.conflict' });

	const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

	expect(result.authorization?.reason).toMatch(/half-open probe already/i);
	expect(result.terminal?.state).toBe('degraded');
	expect(loopInternals.dispatchOversight).not.toHaveBeenCalled();
	expect(seams.performer).not.toHaveBeenCalled();
});

test.each([
	['stale timestamp', 'stale' as const],
	['legacy marker without timestamp', 'legacy' as const],
])('%s is reclaimed for one new probe', async (_label, marker) => {
	const dir = makeProject();
	await createCorrelation(dir);
	setExpiredProbe(dir, marker);
	const seams = installHappySeams();
	loopInternals.now = () => NOW;
	await enqueue(dir, {
		dedupToken: `recover-${marker}`,
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

	expect(result.terminal?.state).toBe('completed');
	expect(seams.performer).toHaveBeenCalledTimes(1);
	expect(readState(dir).correlations[CORRELATION].circuit).toMatchObject({
		openUntil: 0,
		halfOpenProbes: 0,
	});
});

test('the first probe marker is durable before oversight dispatch and external seams see no lock', async () => {
	const dir = makeProject();
	await createCorrelation(dir);
	setExpiredProbe(dir, 'none');
	loopInternals.now = () => NOW;
	const observations: Array<{ seam: string; marker: unknown; lock: boolean }> =
		[];
	loopInternals.dispatchOversight = mock(async () => {
		const state = readState(dir).correlations[CORRELATION];
		observations.push({
			seam: 'oversight',
			marker: state.circuit.halfOpenProbeStartedAt,
			lock: fs.existsSync(loopStateLockPath(dir)),
		});
		return { dispatched: true, decision: 'allow' };
	}) as unknown as typeof loopInternals.dispatchOversight;
	loopInternals.performAuthorizedAction = mock(async () => {
		observations.push({
			seam: 'action',
			marker:
				readState(dir).correlations[CORRELATION].circuit.halfOpenProbeStartedAt,
			lock: fs.existsSync(loopStateLockPath(dir)),
		});
		return { performed: true };
	}) as unknown as typeof loopInternals.performAuthorizedAction;
	loopInternals.evaluateCurrentHead = mock(async () => {
		observations.push({
			seam: 'head',
			marker: null,
			lock: fs.existsSync(loopStateLockPath(dir)),
		});
		return HEAD;
	}) as unknown as typeof loopInternals.evaluateCurrentHead;
	await enqueue(dir, {
		dedupToken: 'durable-before-oversight',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

	expect(result.terminal?.state).toBe('completed');
	expect(observations).toHaveLength(3);
	expect(observations.every((observation) => observation.lock === false)).toBe(
		true,
	);
	expect(
		observations.find((observation) => observation.seam === 'oversight')
			?.marker,
	).toBe(NOW);
});

test('F-CORE releases an admitted probe when cancellation lands before oversight', async () => {
	const dir = makeProject();
	await createCorrelation(dir);
	setExpiredProbe(dir, 'stale');
	const seams = installHappySeams();
	loopInternals.now = () => NOW;
	const productionWriteState = loopInternals.writeState;
	let cancellationWritten = false;
	loopInternals.writeState = async (directory, state) => {
		await productionWriteState(directory, state);
		if (
			!cancellationWritten &&
			state.correlations[CORRELATION]?.circuit.halfOpenProbes
		) {
			cancellationWritten = true;
			const latest = readState(dir);
			latest.sessionTerminals[SESSION] = {
				state: 'cancelled',
				reason: 'operator stop during probe admission',
			};
			writeState(dir, latest);
		}
	};
	await enqueue(dir, {
		dedupToken: 'cancel-before-oversight',
		type: 'pr.merge.conflict',
	});

	const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);
	const circuit = readState(dir).correlations[CORRELATION].circuit;

	expect(result.terminal?.state).toBe('cancelled');
	expect(circuit.halfOpenProbes).toBe(0);
	expect(circuit.halfOpenProbeOwnerToken).toBeUndefined();
	expect(circuit.halfOpenProbeOwnerPid).toBeUndefined();
	expect(seams.performer).not.toHaveBeenCalled();
	expect(loopInternals.dispatchOversight).not.toHaveBeenCalled();
});

test.each([
	['oversight denial', 'deny' as const],
	['permanent action failure', 'fail' as const],
])('%s clears the marker and reopens the cooldown', async (_label, outcome) => {
	const dir = makeProject();
	await createCorrelation(dir);
	setExpiredProbe(dir, 'stale');
	installHappySeams();
	loopInternals.now = () => NOW;
	if (outcome === 'deny') {
		loopInternals.dispatchOversight = mock(async () => ({
			dispatched: true,
			decision: 'deny',
		})) as unknown as typeof loopInternals.dispatchOversight;
	} else {
		loopInternals.performAuthorizedAction = mock(async () => ({
			performed: false,
			permanent: true,
			error: 'permanent failure',
		})) as unknown as typeof loopInternals.performAuthorizedAction;
	}
	await enqueue(dir, {
		dedupToken: `reopen-${outcome}`,
		type: 'pr.merge.conflict',
	});

	await claimAndProcessPrFeedbackEvent(dir, SESSION);
	const circuit = readState(dir).correlations[CORRELATION].circuit;

	expect(circuit.openUntil).toBeGreaterThan(NOW);
	expect(circuit.halfOpenProbes).toBe(0);
	expect(circuit.halfOpenProbeStartedAt).toBeUndefined();
});

describe('issue #2745 denial recovery — regression (FB-041/M1)', () => {
	test('releases the exact half-open probe after denial recovery write failure', async () => {
		// Before the fix, a failed finishHalfOpenProbe(false) write skipped the
		// release path, leaving the durable probe marker claimed and blocking
		// subsequent half-open attempts after an oversight denial.
		const dir = makeProject();
		await createCorrelation(dir);
		setExpiredProbe(dir, 'stale');
		const seams = installHappySeams();
		loopInternals.now = () => NOW;
		loopInternals.dispatchOversight = mock(async () => ({
			dispatched: true,
			decision: 'deny',
		})) as unknown as typeof loopInternals.dispatchOversight;
		const productionWriteState = loopInternals.writeState;
		let injectedFinishFailure = false;
		loopInternals.writeState = async (directory, state) => {
			const circuit = state.correlations[CORRELATION]?.circuit;
			if (
				!injectedFinishFailure &&
				circuit !== undefined &&
				circuit.openUntil > NOW &&
				circuit.halfOpenProbes === 0
			) {
				injectedFinishFailure = true;
				throw new Error('injected finishHalfOpenProbe write failure');
			}
			await productionWriteState(directory, state);
		};
		await enqueue(dir, {
			dedupToken: 'denial-recovery-write-failure',
			type: 'pr.merge.conflict',
		});

		const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);
		const circuit = readState(dir).correlations[CORRELATION].circuit;

		expect(injectedFinishFailure).toBe(true);
		expect(result.terminal?.state).toBe('paused_for_human');
		expect(circuit.halfOpenProbes).toBe(0);
		expect(circuit.halfOpenProbeOwnerToken).toBeUndefined();
		expect(circuit.halfOpenProbeOwnerPid).toBeUndefined();
		expect(seams.performer).not.toHaveBeenCalled();
	});
});

test('a live state lock fails closed before head, oversight, or action', async () => {
	const dir = makeProject();
	await prime(dir);
	await enqueue(dir);
	writeLiveLock(dir);
	loopInternals.isProcessAlive = () => true;
	const head = mock(async () => HEAD);
	const oversight = mock(async () => ({ dispatched: true, decision: 'allow' }));
	const action = mock(async () => ({ performed: true }));
	loopInternals.evaluateCurrentHead =
		head as unknown as typeof loopInternals.evaluateCurrentHead;
	loopInternals.dispatchOversight =
		oversight as unknown as typeof loopInternals.dispatchOversight;
	loopInternals.performAuthorizedAction =
		action as unknown as typeof loopInternals.performAuthorizedAction;

	const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

	expect(result.reason).toBe('claim-not-acquired');
	expect(head).not.toHaveBeenCalled();
	expect(oversight).not.toHaveBeenCalled();
	expect(action).not.toHaveBeenCalled();
	expect(fs.existsSync(loopStateLockPath(dir))).toBe(true);
});

test('a dead-owner state lock is reclaimed and normal admission proceeds', async () => {
	const dir = makeProject();
	await prime(dir);
	writeLiveLock(dir);
	loopInternals.isProcessAlive = () => false;
	const seams = installHappySeams();
	await enqueue(dir);

	const result = await claimAndProcessPrFeedbackEvent(dir, SESSION);

	expect(result.terminal?.state).toBe('completed');
	expect(seams.performer).toHaveBeenCalledTimes(1);
	expect(fs.existsSync(loopStateLockPath(dir))).toBe(false);
});

test('durable cancellation written during a gated performer wins the post-action merge', async () => {
	const dir = makeProject();
	await prime(dir);
	const started = mock(async () => ({ performed: true }));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let resolveActionStarted!: () => void;
	const actionStarted = new Promise<void>((resolve) => {
		resolveActionStarted = resolve;
	});
	loopInternals.evaluateCurrentHead = mock(
		async () => HEAD,
	) as unknown as typeof loopInternals.evaluateCurrentHead;
	loopInternals.dispatchOversight = mock(async () => ({
		dispatched: true,
		decision: 'allow',
	})) as unknown as typeof loopInternals.dispatchOversight;
	loopInternals.performAuthorizedAction = mock(async () => {
		resolveActionStarted();
		await gate;
		return started();
	}) as unknown as typeof loopInternals.performAuthorizedAction;
	await enqueue(dir);

	const processing = claimAndProcessPrFeedbackEvent(dir, SESSION);
	await actionStarted;
	expect(loopInternals.performAuthorizedAction).toHaveBeenCalledTimes(1);
	const state = readState(dir);
	state.sessionTerminals[SESSION] = {
		state: 'cancelled',
		reason: 'durable stop from another process',
	};
	writeState(dir, state);
	release();

	const result = await processing;

	expect(result.action?.performed).toBe(true);
	expect(result.terminal?.state).toBe('cancelled');
	expect(readState(dir).correlations[CORRELATION].terminal).toEqual({
		state: 'cancelled',
		reason: 'durable stop from another process',
	});
});

afterEach(() => {
	try {
		restoreProductionLoopInternals();
	} finally {
		releaseLoopInternals();
	}
});
