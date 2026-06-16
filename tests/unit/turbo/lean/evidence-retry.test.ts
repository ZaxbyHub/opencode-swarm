/**
 * Tests for _writeLaneEvidenceSafely retry logic (Issue #5).
 *
 * Verifies that transient disk errors (EBUSY, ENOENT, ENOSPC, etc.) are retried
 * with exponential backoff, while permanent errors fail immediately without retry.
 * Uses _internals injection to control writeLaneEvidence and loadLeanTurboRunState.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import type { LeanTurboLane } from '../../../../src/turbo/lean/state';

const SESSION_ID = 'sess-evidence-retry-test';

let tmpDir: string;
const savedWriteLaneEvidence = LeanTurboRunner._internals.writeLaneEvidence;
const savedLoadLeanTurboRunState =
	LeanTurboRunner._internals.loadLeanTurboRunState;

function makeLane(laneId = 'lane-0'): LeanTurboLane {
	return {
		laneId,
		taskIds: ['1.1'],
		files: ['src/a.ts'],
		status: 'completed',
		completedAt: new Date().toISOString(),
	};
}

function makeTransientError(code: string): Error {
	const err = new Error(`${code}: simulated`);
	(err as NodeJS.ErrnoException).code = code;
	return err;
}

type WriteLaneEvidenceSafely = (
	lane: LeanTurboLane,
	status: 'completed' | 'failed' | 'running' | 'pending' | 'blocked',
	extras: Record<string, unknown>,
) => Promise<void>;

function callWriteLaneEvidenceSafely(
	runner: LeanTurboRunner,
	lane: LeanTurboLane,
	status: 'completed' | 'failed' = 'completed',
): Promise<void> {
	return (
		runner as unknown as { _writeLaneEvidenceSafely: WriteLaneEvidenceSafely }
	)._writeLaneEvidenceSafely(lane, status, {});
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-retry-test-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });

	// Provide a minimal run state so phase is known
	LeanTurboRunner._internals.loadLeanTurboRunState = mock(() => ({
		sessionID: SESSION_ID,
		status: 'running' as const,
		strategy: 'lean' as const,
		phase: 1,
		maxParallelCoders: 2,
		lanes: [],
		serializedTasks: [],
		degradedTasks: [],
		counters: {
			lanesPlanned: 0,
			lanesStarted: 0,
			lanesCompleted: 0,
			lanesFailed: 0,
			tasksSerialized: 0,
			tasksDegraded: 0,
		},
	}));
});

afterEach(() => {
	LeanTurboRunner._internals.writeLaneEvidence = savedWriteLaneEvidence;
	LeanTurboRunner._internals.loadLeanTurboRunState = savedLoadLeanTurboRunState;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('_writeLaneEvidenceSafely transient error retry', () => {
	test('succeeds on second attempt when first throws EBUSY', async () => {
		const calls: string[] = [];
		let attempt = 0;
		LeanTurboRunner._internals.writeLaneEvidence = mock(async () => {
			attempt++;
			calls.push(`attempt-${attempt}`);
			if (attempt === 1) throw makeTransientError('EBUSY');
			// second attempt succeeds
		});

		const runner = new LeanTurboRunner({
			directory: tmpDir,
			sessionID: SESSION_ID,
		});
		await callWriteLaneEvidenceSafely(runner, makeLane());

		expect(calls).toEqual(['attempt-1', 'attempt-2']);
	});

	test('retries on ENOENT and ENOSPC, gives up after maxAttempts', async () => {
		const codes = ['ENOENT', 'ENOSPC', 'EBUSY'];
		let callCount = 0;
		LeanTurboRunner._internals.writeLaneEvidence = mock(async () => {
			const code = codes[callCount] ?? 'EBUSY';
			callCount++;
			throw makeTransientError(code);
		});

		const runner = new LeanTurboRunner({
			directory: tmpDir,
			sessionID: SESSION_ID,
		});
		// Should not throw — permanent failure is non-fatal (just logs)
		await expect(
			callWriteLaneEvidenceSafely(runner, makeLane()),
		).resolves.toBeUndefined();

		// maxAttempts is 3
		expect(callCount).toBe(3);
	});

	test('does NOT retry on non-transient error (EEXIST)', async () => {
		let callCount = 0;
		LeanTurboRunner._internals.writeLaneEvidence = mock(async () => {
			callCount++;
			throw makeTransientError('EEXIST');
		});

		const runner = new LeanTurboRunner({
			directory: tmpDir,
			sessionID: SESSION_ID,
		});
		await expect(
			callWriteLaneEvidenceSafely(runner, makeLane()),
		).resolves.toBeUndefined();

		// No retry — permanent error on first attempt
		expect(callCount).toBe(1);
	});

	test('does NOT retry when error has no .code (non-ErrnoException)', async () => {
		let callCount = 0;
		LeanTurboRunner._internals.writeLaneEvidence = mock(async () => {
			callCount++;
			throw new Error('unexpected failure without error code');
		});

		const runner = new LeanTurboRunner({
			directory: tmpDir,
			sessionID: SESSION_ID,
		});
		await expect(
			callWriteLaneEvidenceSafely(runner, makeLane()),
		).resolves.toBeUndefined();

		expect(callCount).toBe(1);
	});

	test('succeeds immediately when no error is thrown', async () => {
		let callCount = 0;
		LeanTurboRunner._internals.writeLaneEvidence = mock(async () => {
			callCount++;
		});

		const runner = new LeanTurboRunner({
			directory: tmpDir,
			sessionID: SESSION_ID,
		});
		await callWriteLaneEvidenceSafely(runner, makeLane());

		expect(callCount).toBe(1);
	});

	test('skips write and does not retry when phase is undefined in run state', async () => {
		// phase === undefined is a configuration error, not a transient disk issue.
		// The function should return immediately with a warn and never call writeLaneEvidence.
		LeanTurboRunner._internals.loadLeanTurboRunState = mock(() => ({
			sessionID: SESSION_ID,
			status: 'running' as const,
			strategy: 'lean' as const,
			phase: undefined, // ← no phase set
			maxParallelCoders: 2,
			lanes: [],
			serializedTasks: [],
			degradedTasks: [],
			counters: {
				lanesPlanned: 0,
				lanesStarted: 0,
				lanesCompleted: 0,
				lanesFailed: 0,
				tasksSerialized: 0,
				tasksDegraded: 0,
			},
		}));

		let writeCallCount = 0;
		LeanTurboRunner._internals.writeLaneEvidence = mock(async () => {
			writeCallCount++;
		});

		const runner = new LeanTurboRunner({
			directory: tmpDir,
			sessionID: SESSION_ID,
		});
		await expect(
			callWriteLaneEvidenceSafely(runner, makeLane()),
		).resolves.toBeUndefined();

		// writeLaneEvidence must never be called — phase missing is not retried
		expect(writeCallCount).toBe(0);
	});

	test('skips write when loadLeanTurboRunState returns null', async () => {
		LeanTurboRunner._internals.loadLeanTurboRunState = mock(() => null);

		let writeCallCount = 0;
		LeanTurboRunner._internals.writeLaneEvidence = mock(async () => {
			writeCallCount++;
		});

		const runner = new LeanTurboRunner({
			directory: tmpDir,
			sessionID: SESSION_ID,
		});
		await expect(
			callWriteLaneEvidenceSafely(runner, makeLane()),
		).resolves.toBeUndefined();

		expect(writeCallCount).toBe(0);
	});
});
