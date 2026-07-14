/**
 * Adversarial tests for snapshot retry helper (Task 1.3 / FR-004).
 *
 * Attack vectors only: malformed inputs, oversized payloads, injection
 * attempts, boundary violations, edge cases that could break the retry helper.
 *
 * Tests BOTH save-plan.ts and manager.ts takeSnapshotWithRetry via their
 * respective _test_exports seams.
 *
 * NOTE: log() throwing is NOT wrapped in try/catch (unlike the emit
 * call), making it the primary attack surface for denial-of-service.
 *
 * NOTE: console.warn was migrated to log() (debug-gated). Tests use
 * OPENCODE_SWARM_DEBUG=1 + spyOn(console, 'log') per Pattern A.
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
const mockTakeSnapshotEvent = mock(async (_dir: string, _plan: Plan) => {
	throw new Error(
		'not mocked — use mockResolvedValue/mockRejectedValue in tests',
	);
});
mock.module('../../../src/plan/ledger', () => ({
	...realLedger,
	takeSnapshotEvent: mockTakeSnapshotEvent,
}));

// Mock the telemetry emit — capture calls for assertion
const mockEmit = mock((_event: string, _data: Record<string, unknown>) => {});
mock.module('../../../src/telemetry', () => ({
	...realTelemetry,
	emit: mockEmit,
}));

/** Temp directory scoped to this test file */
const TEST_DIR = path.join(
	os.tmpdir(),
	'save-plan-snapshot-retry-adversarial-test',
);

import { _snapshot_test_exports as managerTestExports } from '../../../src/plan/manager';
import { _test_exports } from '../../../src/tools/save-plan';

const { takeSnapshotWithRetry } = _test_exports;

/** Minimal valid Plan object for test use. */
function makeTestPlan(overrides?: Partial<Plan>): Plan {
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
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Helper: fully reset all mocks before each test
// ---------------------------------------------------------------------------
function resetMocks(): void {
	mockTakeSnapshotEvent.mockReset();
	mockEmit.mockReset();
}

// ---------------------------------------------------------------------------
// Attack Vector 1: takeSnapshotEvent throws non-Error values
// The code uses: lastError = err instanceof Error ? err : new Error(String(err))
// This must not crash — even string/number/undefined/null throws must be handled.
// ---------------------------------------------------------------------------
describe('AV1: non-Error thrown values', () => {
	beforeEach(resetMocks);
	afterEach(() => mock.restore());

	test('save-plan: throws string — still retries and eventually warns', async () => {
		mockTakeSnapshotEvent.mockRejectedValue(
			'error string not an Error' as never,
		);
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			// Must not throw — the string is converted to Error via String(err)
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(logSpy.mock.calls[0][0] as string).toContain(
				'error string not an Error',
			);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('save-plan: throws number — still retries and eventually warns', async () => {
		mockTakeSnapshotEvent.mockRejectedValue(-1 as never);
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
			// String(-1) → '-1'
			expect(logSpy.mock.calls[0][0] as string).toContain('-1');
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('save-plan: throws undefined — still retries and eventually warns', async () => {
		mockTakeSnapshotEvent.mockRejectedValue(undefined as never);
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
			// String(undefined) → 'undefined'
			expect(logSpy.mock.calls[0][0] as string).toContain('undefined');
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('save-plan: throws null — still retries and eventually warns', async () => {
		mockTakeSnapshotEvent.mockRejectedValue(null as never);
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
			// String(null) → 'null'
			expect(logSpy.mock.calls[0][0] as string).toContain('null');
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('save-plan: throws plain object — still retries and eventually warns', async () => {
		mockTakeSnapshotEvent.mockRejectedValue({ reason: 'disk full' } as never);
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
			// String({...}) → '[object Object]'
			expect(logSpy.mock.calls[0][0] as string).toContain('[object Object]');
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('save-plan: throws Error-like object without message — still retries and eventually warns', async () => {
		// An object with a 'message' property that is not an Error instance
		mockTakeSnapshotEvent.mockRejectedValue({ message: '' } as never);
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
			// String({message: ''}) → '[object Object]'
			expect(logSpy.mock.calls[0][0] as string).toContain('[object Object]');
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('manager: throws string — still retries and eventually warns', async () => {
		const { takeSnapshotWithRetry: managerRetry } = managerTestExports;
		mockTakeSnapshotEvent.mockRejectedValue('manager error string' as never);
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				managerRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(logSpy.mock.calls[0][0] as string).toContain(
				'manager error string',
			);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('manager: throws undefined — still retries and eventually warns', async () => {
		const { takeSnapshotWithRetry: managerRetry } = managerTestExports;
		mockTakeSnapshotEvent.mockRejectedValue(undefined as never);
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				managerRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 2: takeSnapshotEvent resolves with undefined/null
// The function should treat void/undefined returns as success.
// ---------------------------------------------------------------------------
describe('AV2: takeSnapshotEvent resolves with undefined/null (void)', () => {
	beforeEach(resetMocks);
	afterEach(() => mock.restore());

	test('save-plan: resolves with undefined — treated as success, no warning', async () => {
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// log() is suppressed when OPENCODE_SWARM_DEBUG is not set — no warning fires
		await expect(
			takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
	});

	test('save-plan: resolves with null — treated as success, no warning', async () => {
		mockTakeSnapshotEvent.mockResolvedValue(null);
		// log() is suppressed when OPENCODE_SWARM_DEBUG is not set — no warning fires
		await expect(
			takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
	});

	test('manager: resolves with undefined — treated as success', async () => {
		const { takeSnapshotWithRetry: managerRetry } = managerTestExports;
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// log() is suppressed when OPENCODE_SWARM_DEBUG is not set — no warning fires
		await expect(
			managerRetry(TEST_DIR, makeTestPlan()),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 3: log() throws
// The log() call is NOT wrapped in try/catch (unlike emit),
// making it a denial-of-service attack surface.
// ---------------------------------------------------------------------------
describe('AV3: log() throws — unhandled, propagates', () => {
	beforeEach(resetMocks);
	afterEach(() => mock.restore());

	test('save-plan: log() throws — error propagates out of takeSnapshotWithRetry', async () => {
		mockTakeSnapshotEvent.mockRejectedValue(new Error('underlying failure'));

		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		// log() calls console.log when debug is enabled
		const logSpy = spyOn(console, 'log').mockImplementation(() => {
			throw new Error('console.log blocked');
		});
		try {
			// log() throwing is NOT caught — it propagates
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).rejects.toThrow('console.log blocked');
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('manager: log() throws — error propagates out of takeSnapshotWithRetry', async () => {
		const { takeSnapshotWithRetry: managerRetry } = managerTestExports;
		mockTakeSnapshotEvent.mockRejectedValue(new Error('underlying failure'));

		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {
			throw new Error('console.log unavailable');
		});
		try {
			// log() throwing is NOT caught — it propagates
			await expect(managerRetry(TEST_DIR, makeTestPlan())).rejects.toThrow(
				'console.log unavailable',
			);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('save-plan: log() throws after all retries exhausted — emit is never called', async () => {
		mockTakeSnapshotEvent.mockRejectedValue(new Error('underlying'));

		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {
			throw new Error('log blocked');
		});
		try {
			// log() runs AFTER the retry loop, OUTSIDE the emit try/catch.
			// When log throws, emit is never reached.
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).rejects.toThrow('log blocked');
			// emit is never called because log throws before emit is reached
			expect(mockEmit).toHaveBeenCalledTimes(0);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 4: Malformed plan shape (missing title, undefined swarm)
// takeSnapshotEvent is called with the plan — verify it receives the shape.
// ---------------------------------------------------------------------------
describe('AV4: malformed plan shape', () => {
	beforeEach(resetMocks);
	afterEach(() => mock.restore());

	test('save-plan: plan with empty string title — passed to takeSnapshotEvent without crash', async () => {
		const plan = makeTestPlan({ title: '' });
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// Should not throw — the helper just passes the plan through
		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(
			takeSnapshotWithRetry(TEST_DIR, plan),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
		expect(mockTakeSnapshotEvent.mock.calls[0][1]).toMatchObject({ title: '' });
	});

	test('save-plan: plan with undefined swarm — passed to takeSnapshotEvent without crash', async () => {
		const plan = makeTestPlan({ swarm: 'test' }); // swarm is required min(1)
		// Override to undefined after construction (schema would reject but helper doesn't validate)
		const planWithUndefinedSwarm = plan as Plan;
		planWithUndefinedSwarm.swarm = undefined as never;
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// Should not throw — the helper just passes the plan through
		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(
			takeSnapshotWithRetry(TEST_DIR, planWithUndefinedSwarm),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
	});

	test('save-plan: plan with missing phases array — passed to takeSnapshotEvent without crash', async () => {
		const plan = {
			schema_version: '1.0.0',
			title: 'test',
			swarm: 'test',
			// phases intentionally missing
		} as Plan;
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(
			takeSnapshotWithRetry(TEST_DIR, plan),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
	});

	test('save-plan: plan with null phases — passed to takeSnapshotEvent without crash', async () => {
		const plan = {
			schema_version: '1.0.0',
			title: 'test',
			swarm: 'test',
			phases: null as never,
		} as Plan;
		mockTakeSnapshotEvent.mockRejectedValue(new Error('ledger failure'));
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			// Should not throw — retry helper does not validate plan shape
			await expect(
				takeSnapshotWithRetry(TEST_DIR, plan),
			).resolves.toBeUndefined();
			expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(4); // 1 + 3 retries
			expect(logSpy).toHaveBeenCalledTimes(1);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('manager: plan with empty string title — passed without crash', async () => {
		const { takeSnapshotWithRetry: managerRetry } = managerTestExports;
		const plan = makeTestPlan({ title: '' });
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(managerRetry(TEST_DIR, plan)).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 5: Empty string or relative path for directory
// The directory is passed directly to takeSnapshotEvent — verify it flows
// through without the retry helper crashing.
// ---------------------------------------------------------------------------
describe('AV5: empty string / relative path for directory', () => {
	beforeEach(resetMocks);
	afterEach(() => mock.restore());

	test('save-plan: empty string directory — passed to takeSnapshotEvent without crash', async () => {
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(
			takeSnapshotWithRetry('', makeTestPlan()),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
		expect(mockTakeSnapshotEvent.mock.calls[0][0]).toBe('');
	});

	test('save-plan: relative path directory — passed to takeSnapshotEvent without crash', async () => {
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(
			takeSnapshotWithRetry('./.swarm', makeTestPlan()),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
		expect(mockTakeSnapshotEvent.mock.calls[0][0]).toBe('./.swarm');
	});

	test('save-plan: directory with path traversal — passed to takeSnapshotEvent without crash', async () => {
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(
			takeSnapshotWithRetry('../../../etc/passwd', makeTestPlan()),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
		expect(mockTakeSnapshotEvent.mock.calls[0][0]).toBe('../../../etc/passwd');
	});

	test('manager: empty string directory — passed without crash', async () => {
		const { takeSnapshotWithRetry: managerRetry } = managerTestExports;
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(managerRetry('', makeTestPlan())).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 6: takeSnapshotEvent alternates between resolve and reject
// The retry loop should handle alternating success/failure correctly.
// ---------------------------------------------------------------------------
describe('AV6: alternating resolve/reject in takeSnapshotEvent', () => {
	beforeEach(resetMocks);
	afterEach(() => mock.restore());

	test('save-plan: fails then succeeds then fails again — stops after first success', async () => {
		// Fail, then succeed — the loop should stop and not call again
		mockTakeSnapshotEvent
			.mockRejectedValueOnce(new Error('first failure'))
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('should not be called'));

		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(
			takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
		).resolves.toBeUndefined();
		// Stopped after success on second attempt
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(2);
	});

	test('save-plan: succeeds then fails then succeeds — stops after first success', async () => {
		mockTakeSnapshotEvent
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('should not be called'))
			.mockResolvedValueOnce(undefined);

		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(
			takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
	});

	test('save-plan: all retries fail, lastError is the LAST error not the first', async () => {
		mockTakeSnapshotEvent
			.mockRejectedValueOnce(new Error('first error'))
			.mockRejectedValueOnce(new Error('second error'))
			.mockRejectedValueOnce(new Error('third error'))
			.mockRejectedValueOnce(new Error('final error — all retries exhausted'));

		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(4);
			expect(logSpy).toHaveBeenCalledTimes(1);
			// lastError is the LAST error encountered
			expect(logSpy.mock.calls[0][0] as string).toContain('final error');
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('manager: all retries fail, lastError is the LAST error', async () => {
		const { takeSnapshotWithRetry: managerRetry } = managerTestExports;
		mockTakeSnapshotEvent
			.mockRejectedValueOnce(new Error('error 1'))
			.mockRejectedValueOnce(new Error('error 2'))
			.mockRejectedValueOnce(new Error('error 3'))
			.mockRejectedValueOnce(new Error('error 4 — final'));

		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				managerRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(logSpy.mock.calls[0][0] as string).toContain('error 4');
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 7: MAX_RETRIES boundary — TOTAL_ATTEMPTS = 1 (0 retries)
// Note: MAX_RETRIES is a local const; cannot be changed from tests.
// The behavior when TOTAL_ATTEMPTS = 1 (no retries) is still tested
// by observing that only 1 call is made on immediate success.
// ---------------------------------------------------------------------------
describe('AV7: MAX_RETRIES boundary behavior (observable via call count)', () => {
	beforeEach(resetMocks);
	afterEach(() => mock.restore());

	test('save-plan: immediate success = only 1 call (0 retries needed)', async () => {
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(
			takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
		).resolves.toBeUndefined();
		// With MAX_RETRIES=3, TOTAL_ATTEMPTS=4. But on first success, only 1 call.
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
	});

	test('save-plan: all 4 attempts fail when every call rejects', async () => {
		mockTakeSnapshotEvent.mockRejectedValue(new Error('always fails'));
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			// 1 initial + 3 retries = 4 total attempts
			expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(4);
			expect(logSpy).toHaveBeenCalledTimes(1);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('manager: all 4 attempts fail when every call rejects', async () => {
		const { takeSnapshotWithRetry: managerRetry } = managerTestExports;
		mockTakeSnapshotEvent.mockRejectedValue(new Error('always fails'));
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				managerRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(4);
			expect(logSpy).toHaveBeenCalledTimes(1);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 8: Very long error message strings (oversized payload)
// The String(err) conversion and warn message construction must not crash.
// ---------------------------------------------------------------------------
describe('AV8: oversized error message strings', () => {
	beforeEach(resetMocks);
	afterEach(() => mock.restore());

	test('save-plan: very long error message — converted to string without crash', async () => {
		const longMessage = 'x'.repeat(100_000);
		mockTakeSnapshotEvent.mockRejectedValue(new Error(longMessage));
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
			// The long message should appear in the log output
			expect((logSpy.mock.calls[0][0] as string).length).toBeGreaterThan(
				100_000,
			);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('save-plan: error message with Unicode — converted to string without crash', async () => {
		const unicodeMessage = '💣'.repeat(10_000);
		mockTakeSnapshotEvent.mockRejectedValue(new Error(unicodeMessage));
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('save-plan: error message with null bytes — String() conversion', async () => {
		const nullBytes = 'a\x00b\x00c';
		mockTakeSnapshotEvent.mockRejectedValue(new Error(nullBytes));
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 9: Injection attempts in plan fields (title, swarm)
// While the helper doesn't execute plan fields, verify no code injection
// through warn message interpolation.
// ---------------------------------------------------------------------------
describe('AV9: injection attempts in plan fields', () => {
	beforeEach(resetMocks);
	afterEach(() => mock.restore());

	test('save-plan: plan title with template literal injection — passed safely to takeSnapshotEvent', async () => {
		// Use a string that looks like a template literal but is NOT evaluated
		const plan = makeTestPlan({ title: '$' + '{process.exit(1)}' });
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(
			takeSnapshotWithRetry(TEST_DIR, plan),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
		expect((mockTakeSnapshotEvent.mock.calls[0][1] as Plan).title).toBe(
			'${process.exit(1)}',
		);
	});

	test('save-plan: plan swarm with shell injection characters — passed safely', async () => {
		const plan = makeTestPlan({ swarm: 'test; rm -rf /' });
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(
			takeSnapshotWithRetry(TEST_DIR, plan),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
		expect((mockTakeSnapshotEvent.mock.calls[0][1] as Plan).swarm).toBe(
			'test; rm -rf /',
		);
	});

	test('save-plan: plan title with HTML/script injection — passed safely to takeSnapshotEvent', async () => {
		const plan = makeTestPlan({ title: '<script>alert(1)</script>' });
		mockTakeSnapshotEvent.mockResolvedValue(undefined);
		// log() is suppressed without OPENCODE_SWARM_DEBUG — no warning fires
		await expect(
			takeSnapshotWithRetry(TEST_DIR, plan),
		).resolves.toBeUndefined();
		expect(mockTakeSnapshotEvent).toHaveBeenCalledTimes(1);
	});

	test('save-plan: error message with newlines — warn message still readable', async () => {
		const multilineError = 'line1\nline2\nline3';
		mockTakeSnapshotEvent.mockRejectedValue(new Error(multilineError));
		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
			const logMsg = logSpy.mock.calls[0][0] as string;
			// Newlines are preserved in the message
			expect(logMsg).toContain('line1');
			expect(logMsg).toContain('line2');
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 10: Retry delay overflow/edge cases
// The exponential backoff formula: 10 * 2 ** (attempt - 1)
// For attempt=Infinity this would be Infinity, but attempt is always bounded.
// We test with a spy to verify the actual delay values.
// ---------------------------------------------------------------------------
describe('AV10: exponential backoff delay values', () => {
	beforeEach(resetMocks);
	afterEach(() => mock.restore());

	test('save-plan: delays are 10, 20, 40 ms for the 3 retry intervals', async () => {
		mockTakeSnapshotEvent.mockRejectedValue(new Error('transient'));

		const delays: number[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
			(fn: (...args: unknown[]) => void, ms?: number) => {
				if (typeof ms === 'number') delays.push(ms);
				return originalSetTimeout.call(
					globalThis,
					fn,
					ms,
				) as unknown as ReturnType<typeof setTimeout>;
			},
		);

		await expect(
			takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
		).resolves.toBeUndefined();

		// 3 retry intervals: 10*2^0=10, 10*2^1=20, 10*2^2=40
		expect(delays).toEqual([10, 20, 40]);
		setTimeoutSpy.mockRestore();
	});

	test('manager: delays are 10, 20, 40 ms for the 3 retry intervals', async () => {
		const { takeSnapshotWithRetry: managerRetry } = managerTestExports;
		mockTakeSnapshotEvent.mockRejectedValue(new Error('transient'));

		const delays: number[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
			(fn: (...args: unknown[]) => void, ms?: number) => {
				if (typeof ms === 'number') delays.push(ms);
				return originalSetTimeout.call(
					globalThis,
					fn,
					ms,
				) as unknown as ReturnType<typeof setTimeout>;
			},
		);

		await expect(
			managerRetry(TEST_DIR, makeTestPlan()),
		).resolves.toBeUndefined();

		expect(delays).toEqual([10, 20, 40]);
		setTimeoutSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// Attack Vector 11: emit itself throws with full force (not just a callback error)
// The emit call is wrapped in try/catch, but verify it stays non-fatal.
// ---------------------------------------------------------------------------
describe('AV11: emit throws — non-fatal, warn still fires', () => {
	beforeEach(resetMocks);
	afterEach(() => mock.restore());

	test('save-plan: emit throws — takeSnapshotWithRetry still resolves, warn still fires', async () => {
		mockTakeSnapshotEvent.mockRejectedValue(new Error('underlying'));

		// Make emit throw before the try block even completes
		mockEmit.mockImplementation(() => {
			throw new Error('telemetry write failed');
		});

		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				takeSnapshotWithRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			// The emit threw but was caught — log should still fire
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(mockEmit).toHaveBeenCalledTimes(1);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});

	test('manager: emit throws — takeSnapshotWithRetry still resolves, warn still fires', async () => {
		const { takeSnapshotWithRetry: managerRetry } = managerTestExports;
		mockTakeSnapshotEvent.mockRejectedValue(new Error('underlying'));

		mockEmit.mockImplementation(() => {
			throw new Error('telemetry write failed');
		});

		const originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const logSpy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await expect(
				managerRetry(TEST_DIR, makeTestPlan()),
			).resolves.toBeUndefined();
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(mockEmit).toHaveBeenCalledTimes(1);
		} finally {
			logSpy.mockRestore();
			if (originalDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = originalDebug;
			}
		}
	});
});
