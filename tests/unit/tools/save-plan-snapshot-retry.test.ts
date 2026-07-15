/**
 * Tests for snapshot retry helper in save-plan.ts (FR-004).
 *
 * Verifies bounded retry behavior, warning emission on exhaustion,
 * and non-fatal failure (snapshot failure does not block save).
 *
 * Uses _test_exports seam (Tier 0/1) for direct unit testing of the
 * private takeSnapshotWithRetry helper, avoiding full executeSavePlan setup.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import * as realLedger from '../../../src/plan/ledger';
import * as realTelemetry from '../../../src/telemetry';

// Mock the ledger module — only override takeSnapshotEvent, preserve all other exports
const mockTakeSnapshotEvent = mock(async (_dir: string, _plan: Plan) => {});
mock.module('../../../src/plan/ledger', () => ({
	...realLedger,
	takeSnapshotEvent: mockTakeSnapshotEvent,
}));

// Mock the telemetry emit — capture calls for assertion without touching real telemetry.
// Spread all real exports so mock.module() provides the complete surface (resetTelemetryForTesting,
// initTelemetry, addTelemetryListener, rotateTelemetryIfNeeded, telemetry, _internals, …),
// then override only emit.
const mockEmit = mock((_event: string, _data: Record<string, unknown>) => {});
mock.module('../../../src/telemetry', () => ({
	...realTelemetry,
	emit: mockEmit,
}));

/** Temp directory scoped to this test file — avoids hardcoded /tmp paths. */
const TEST_DIR = path.join(os.tmpdir(), 'save-plan-snapshot-retry-test');

import { _snapshot_test_exports as managerTestExports } from '../../../src/plan/manager';
import { _test_exports } from '../../../src/tools/save-plan';

const { takeSnapshotWithRetry } = _test_exports;

/** Minimal valid Plan object for test use. */
function makeTestPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'test-plan',
		swarm: 'test',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Test task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

describe('takeSnapshotWithRetry (FR-004)', () => {
	beforeEach(() => {
		mockTakeSnapshotEvent.mockReset();
		mockEmit.mockReset();
	});

	afterEach(() => {
		mock.restore();
	});

	test('succeeds on first attempt — no retry, no warning, no telemetry', async () => {
		mockTakeSnapshotEvent.mockResolvedValueOnce(undefined as never);

		const warnSpy = spyOn(console, 'warn');

		await takeSnapshotWithRetry(TEST_DIR, makeTestPlan());

		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
		expect(warnSpy).not.toHaveBeenCalled();
		expect(mockEmit).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('succeeds on second attempt after one failure — no warning, no telemetry', async () => {
		// Fail once, succeed on second
		mockTakeSnapshotEvent
			.mockRejectedValueOnce(new Error('disk full'))
			.mockResolvedValueOnce(undefined as never);

		const warnSpy = spyOn(console, 'warn');

		await takeSnapshotWithRetry(TEST_DIR, makeTestPlan());

		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(2);
		expect(warnSpy).not.toHaveBeenCalled();
		expect(mockEmit).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('succeeds on third attempt after two failures — no warning, no telemetry', async () => {
		// Fail twice, succeed on third
		mockTakeSnapshotEvent
			.mockRejectedValueOnce(new Error('disk full'))
			.mockRejectedValueOnce(new Error('disk full'))
			.mockResolvedValueOnce(undefined as never);

		const warnSpy = spyOn(console, 'warn');

		await takeSnapshotWithRetry(TEST_DIR, makeTestPlan());

		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(3);
		expect(warnSpy).not.toHaveBeenCalled();
		expect(mockEmit).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('succeeds on the third retry (4th attempt)', async () => {
		// Fail 3 times, succeed on 4th attempt
		mockTakeSnapshotEvent
			.mockRejectedValueOnce(new Error('transient error'))
			.mockRejectedValueOnce(new Error('transient error'))
			.mockRejectedValueOnce(new Error('transient error'))
			.mockResolvedValueOnce(undefined as never);

		const warnSpy = spyOn(console, 'warn');

		await takeSnapshotWithRetry(TEST_DIR, makeTestPlan());

		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(4);
		expect(warnSpy).not.toHaveBeenCalled();
		expect(mockEmit).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('all retries exhausted — warns with error message and emits snapshot_failed telemetry', async () => {
		const error = new Error('ENOSPC: no space left on device');
		mockTakeSnapshotEvent.mockRejectedValue(error);

		const warnSpy = spyOn(console, 'warn');

		await takeSnapshotWithRetry(TEST_DIR, makeTestPlan());

		// Initial attempt + 3 retries = 4 total attempts
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(4);
		// Should have logged a visible warning
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const warnMsg = warnSpy.mock.calls[0][0] as string;
		expect(warnMsg).toContain('Snapshot failed after 3 retries');
		expect(warnMsg).toContain('4 attempts');
		expect(warnMsg).toContain('ENOSPC');
		// Should have emitted snapshot_failed telemetry
		expect(mockEmit).toHaveBeenCalledTimes(1);
		expect(mockEmit).toHaveBeenCalledWith('snapshot_failed', {
			error: 'ENOSPC: no space left on device',
			retries: 3,
			source: 'save_plan_tool',
		});
		warnSpy.mockRestore();
	});

	test('non-fatal — function resolves (does not throw) even when all retries fail', async () => {
		mockTakeSnapshotEvent.mockRejectedValue(new Error('ledger unavailable'));

		const warnSpy = spyOn(console, 'warn');

		// Must NOT throw — the failure is non-fatal
		await expect(
			takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
		).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		warnSpy.mockRestore();
	});

	test('warning is visible regardless of OPENCODE_SWARM_DEBUG (uses console.warn directly)', async () => {
		// Ensure the flag is NOT set — the warning must still fire
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		delete process.env.OPENCODE_SWARM_DEBUG;

		mockTakeSnapshotEvent.mockRejectedValue(new Error('test failure'));

		const warnSpy = spyOn(console, 'warn');

		await takeSnapshotWithRetry(TEST_DIR, makeTestPlan());

		// Warning must fire even without DEBUG flag
		expect(warnSpy).toHaveBeenCalledTimes(1);

		// Restore
		warnSpy.mockRestore();
		if (originalDebug !== undefined) {
			process.env.OPENCODE_SWARM_DEBUG = originalDebug;
		} else {
			delete process.env.OPENCODE_SWARM_DEBUG;
		}
	});

	test('emits snapshot_failed telemetry with correct payload after all retries exhausted', async () => {
		const error = new Error('disk full');
		mockTakeSnapshotEvent.mockRejectedValue(error);

		await takeSnapshotWithRetry(TEST_DIR, makeTestPlan());

		expect(mockEmit).toHaveBeenCalledTimes(1);
		expect(mockEmit).toHaveBeenCalledWith('snapshot_failed', {
			error: 'disk full',
			retries: 3,
			source: 'save_plan_tool',
		});
	});

	test('uses exponential backoff between retries', async () => {
		mockTakeSnapshotEvent.mockRejectedValue(new Error('transient'));

		// Spy on setTimeout to capture delays
		const delays: number[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
			(fn: (...args: unknown[]) => void, ms?: number) => {
				if (typeof ms === 'number' && ms > 0) delays.push(ms);
				return originalSetTimeout.call(
					globalThis,
					fn,
					ms,
				) as unknown as ReturnType<typeof setTimeout>;
			},
		);

		await takeSnapshotWithRetry(TEST_DIR, makeTestPlan());

		// 3 retries between 4 attempts → delays: 10, 20, 40 (exponential)
		expect(delays).toEqual([10, 20, 40]);
		setTimeoutSpy.mockRestore();
	});

	test('telemetry emit does not throw — failure is non-fatal', async () => {
		const error = new Error('EIO: I/O error');
		mockTakeSnapshotEvent.mockRejectedValue(error);
		// Make emit throw to verify it is caught internally
		mockEmit.mockImplementation(() => {
			throw new Error('telemetry unavailable');
		});

		// Must NOT throw even when telemetry emit fails
		await expect(
			takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
		).resolves.toBeUndefined();

		// console.warn should still fire (telemetry failure is non-fatal)
		expect(mockEmit).toHaveBeenCalledTimes(1);
	});
});

describe('manager.ts takeSnapshotWithRetry (FR-004)', () => {
	const { takeSnapshotWithRetry: managerRetry } = managerTestExports;

	beforeEach(() => {
		mockTakeSnapshotEvent.mockReset();
		mockEmit.mockReset();
	});

	afterEach(() => {
		mock.restore();
	});

	test('succeeds on first attempt — no retry, no warning, no telemetry', async () => {
		mockTakeSnapshotEvent.mockResolvedValueOnce(undefined as never);

		const warnSpy = spyOn(console, 'warn');

		await managerRetry(TEST_DIR, makeTestPlan());

		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
		expect(warnSpy).not.toHaveBeenCalled();
		expect(mockEmit).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('retries with exponential backoff — 4 total calls on exhaustion', async () => {
		const error = new Error('ENOSPC: no space left on device');
		mockTakeSnapshotEvent.mockRejectedValue(error);

		const warnSpy = spyOn(console, 'warn');

		// Spy on setTimeout to capture delays
		const delays: number[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
			(fn: (...args: unknown[]) => void, ms?: number) => {
				if (typeof ms === 'number' && ms > 0) delays.push(ms);
				return originalSetTimeout.call(
					globalThis,
					fn,
					ms,
				) as unknown as ReturnType<typeof setTimeout>;
			},
		);

		await managerRetry(TEST_DIR, makeTestPlan());

		// Initial attempt + 3 retries = 4 total attempts
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(4);
		expect(delays).toEqual([10, 20, 40]);
		expect(warnSpy).toHaveBeenCalledTimes(1);

		setTimeoutSpy.mockRestore();
		warnSpy.mockRestore();
	});

	test('emits snapshot_failed telemetry with source savePlan_manager', async () => {
		const error = new Error('disk full');
		mockTakeSnapshotEvent.mockRejectedValue(error);

		await managerRetry(TEST_DIR, makeTestPlan(), {
			source: 'savePlan_manager',
		});

		expect(mockEmit).toHaveBeenCalledTimes(1);
		expect(mockEmit).toHaveBeenCalledWith('snapshot_failed', {
			error: 'disk full',
			retries: 3,
			source: 'savePlan_manager',
		});
	});

	test('warning is visible without debug flags', async () => {
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		delete process.env.OPENCODE_SWARM_DEBUG;

		mockTakeSnapshotEvent.mockRejectedValue(new Error('test failure'));

		const warnSpy = spyOn(console, 'warn');

		await managerRetry(TEST_DIR, makeTestPlan());

		// Warning must fire even without DEBUG flag
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const warnMsg = warnSpy.mock.calls[0][0] as string;
		expect(warnMsg).toContain('Snapshot failed after 3 retries');
		expect(warnMsg).toContain('4 attempts');
		expect(warnMsg).toContain('test failure');

		warnSpy.mockRestore();
		if (originalDebug !== undefined) {
			process.env.OPENCODE_SWARM_DEBUG = originalDebug;
		} else {
			delete process.env.OPENCODE_SWARM_DEBUG;
		}
	});

	test('non-fatal — does not throw even when all retries fail', async () => {
		mockTakeSnapshotEvent.mockRejectedValue(new Error('ledger unavailable'));

		const warnSpy = spyOn(console, 'warn');

		await expect(
			managerRetry(TEST_DIR, makeTestPlan()),
		).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		warnSpy.mockRestore();
	});
});
