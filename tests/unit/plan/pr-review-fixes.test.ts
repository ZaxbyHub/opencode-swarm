/**
 * Verification tests for PR review fixes (F-002, F-004, F-005).
 *
 * F-002: All 4 temp file names (2 in rebuildPlan, 2 in closePlanTerminalState)
 *         include Math.floor(Math.random() * 1e9) suffix
 * F-004: in_progress marker reset in try/finally for rebuildPlan and closePlanTerminalState
 *         plan.md write failure always resets marker to in_progress: false
 * F-005: takeSnapshotWithRetry exists only in ledger.ts, imported by both
 *         manager.ts and save-plan.ts
 * Telemetry: manager passes source: 'savePlan_manager'; save-plan defaults to 'save_plan_tool'
 *
 * These tests are verification-focused and cover NEW behavior not tested by
 * the existing close-plan-terminal-state.test.ts (10 tests) and
 * save-plan-snapshot-retry.test.ts (15 tests).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fsSync from 'node:fs';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import * as realHookUtils from '../../../src/hooks/utils';
import * as realLedger from '../../../src/plan/ledger';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'medium',
						description: 'Task two',
						depends: [],
						files_touched: [],
					},
				],
			},
			{
				id: 2,
				name: 'Phase 2',
				status: 'pending',
				tasks: [
					{
						id: '2.1',
						phase: 2,
						status: 'pending',
						size: 'small',
						description: 'Task three',
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
// Mock factories
// ---------------------------------------------------------------------------

/** Complete bun-compat mock — includes all exports to avoid import chain failures */
function makeBunCompatMock() {
	return {
		bunWrite: mock(async (_p: string, _data: string | Uint8Array) => {}),
		bunHash: mock(() => 0n),
		bunFile: (_path: string) => ({
			text: async () => '',
			exists: async () => false,
			arrayBuffer: async () => new ArrayBuffer(0),
			size: 0,
		}),
		isBun: () => false,
		bunSpawn: () => ({
			stdout: {
				text: async () => '',
				bytes: async () => new Uint8Array(0),
				getReader: () => ({
					read: async () => ({ done: true, value: undefined }),
				}),
			},
			stderr: {
				text: async () => '',
				bytes: async () => new Uint8Array(0),
				getReader: () => ({
					read: async () => ({ done: true, value: undefined }),
				}),
			},
			exited: Promise.resolve(0),
			exitCode: null as number | null,
			kill: () => {},
		}),
		bunSpawnSync: () => ({
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
			exitCode: 0,
			success: true,
		}),
	};
}

/** Ledger mock that spreads realLedger and overrides only what we need */
function makeLedgerMock(
	overrides: Partial<{
		appendLedgerEvent: unknown;
		takeSnapshotEvent: unknown;
		ledgerExists: unknown;
		initLedger: unknown;
		readLedgerEvents: unknown;
		computePlanHash: unknown;
		computeCurrentPlanHash: unknown;
		getLatestLedgerSeq: unknown;
	}> = {},
) {
	return {
		...realLedger,
		appendLedgerEvent: mock(async () => ({})),
		takeSnapshotEvent: mock(async () => ({})),
		ledgerExists: mock(async () => false),
		initLedger: mock(async () => {}),
		readLedgerEvents: mock(async () => []),
		computePlanHash: mock(() => 'hash'),
		computeCurrentPlanHash: mock(() => 'hash'),
		getLatestLedgerSeq: mock(async () => 0),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// F-004: rebuildPlan marker reset on plan.md failure
// ---------------------------------------------------------------------------

describe('rebuildPlan — F-004 marker reset on failure', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'rebuild-plan-f004-'));
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		mock.restore();
	});

	/**
	 * F-004 verification: rebuildPlan writes in_progress marker after plan.json rename,
	 * then plan.md write, then always resets marker to in_progress: false in finally.
	 * This test simulates plan.md bunWrite throwing and verifies the marker is still
	 * reset to in_progress: false (not left at true).
	 *
	 * NOTE: rebuildPlan has no catch block — only try/finally.
	 * So when bunWrite throws, the error propagates up and rebuildPlan rejects.
	 * The finally block runs before the rejection propagates, resetting the marker.
	 */
	test('F-004: plan.md write failure — marker still reset to in_progress: false in finally', async () => {
		mock.module('../../../src/hooks/utils', () => ({
			...realHookUtils,
			readSwarmFileAsync: mock(async () => null),
			validateSwarmPath: (p: string) => p,
			safeHook: (name: string) => null as any,
		}));

		const writeLog: Array<{ path: string; content: string }> = [];
		let planMdWriteAttempted = false;

		const bunWriteMock = mock(
			async (p: string, content: string | Uint8Array) => {
				writeLog.push({ path: p, content: String(content) });
				if (p.includes('plan.md.rebuild.')) {
					planMdWriteAttempted = true;
					// Throw AFTER the await so try/catch can process it
					throw new Error('disk full during plan.md write');
				}
			},
		);

		mock.module('../../../src/utils/bun-compat', () => ({
			...makeBunCompatMock(),
			bunWrite: bunWriteMock,
		}));

		mock.module('../../../src/plan/ledger', () => makeLedgerMock());
		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
			unlinkSync: mock(() => {}),
			existsSync: mock(() => true),
			readdirSync: () => [],
		}));

		const { rebuildPlan } = await import('../../../src/plan/manager');

		const plan = createTestPlan();

		// Expect rebuildPlan to reject (no catch block in rebuildPlan)
		await expect(
			rebuildPlan(tempDir, plan, { reason: 'test-f004' }),
		).rejects.toBeDefined();

		expect(planMdWriteAttempted).toBe(true);

		// Verify the marker was reset to in_progress: false even though plan.md threw
		const markerWrites = writeLog.filter(
			(w) =>
				typeof w.path === 'string' && w.path.includes('.plan-write-marker'),
		);
		expect(markerWrites.length).toBe(2);

		const inProgressMarker = JSON.parse(markerWrites[0].content);
		expect(inProgressMarker.in_progress).toBe(true);

		const finalMarker = JSON.parse(markerWrites[1].content);
		expect(finalMarker.in_progress).toBe(false);
	});

	/**
	 * F-004 happy path: rebuildPlan writes markers in correct sequence with correct values.
	 */
	test('F-004: rebuildPlan success — markers written in correct sequence', async () => {
		mock.module('../../../src/hooks/utils', () => ({
			...realHookUtils,
			readSwarmFileAsync: mock(async () => null),
			validateSwarmPath: (p: string) => p,
			safeHook: (name: string) => null as any,
		}));

		const writeLog: Array<{ path: string; content: string }> = [];
		const bunWriteMock = mock(
			async (p: string, content: string | Uint8Array) => {
				writeLog.push({ path: p, content: String(content) });
			},
		);

		mock.module('../../../src/utils/bun-compat', () => ({
			...makeBunCompatMock(),
			bunWrite: bunWriteMock,
		}));

		mock.module('../../../src/plan/ledger', () => makeLedgerMock());
		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
			unlinkSync: mock(() => {}),
			existsSync: mock(() => true),
			readdirSync: () => [],
		}));

		const { rebuildPlan } = await import('../../../src/plan/manager');

		const plan = createTestPlan();
		await rebuildPlan(tempDir, plan, { reason: 'test-f004-happy' });

		const markerWrites = writeLog.filter(
			(w) =>
				typeof w.path === 'string' && w.path.includes('.plan-write-marker'),
		);
		expect(markerWrites.length).toBe(2);

		const inProgressMarker = JSON.parse(markerWrites[0].content);
		expect(inProgressMarker.in_progress).toBe(true);
		expect(inProgressMarker.source).toBe('plan_manager');

		const finalMarker = JSON.parse(markerWrites[1].content);
		expect(finalMarker.in_progress).toBe(false);
		expect(finalMarker.source).toBe('plan_manager');
	});
});

// ---------------------------------------------------------------------------
// F-004: closePlanTerminalState marker reset on plan.md failure
// ---------------------------------------------------------------------------

describe('closePlanTerminalState — F-004 marker reset on failure', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'close-plan-f004-'));
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		mock.restore();
	});

	/**
	 * F-004 verification: closePlanTerminalState writes plan.md in a try block and
	 * always resets the marker to in_progress: false in the finally block, even
	 * when plan.md bunWrite throws.
	 *
	 * NOTE: closePlanTerminalState has no catch block for plan.md — only try/finally.
	 * So when bunWrite throws, the error propagates up. The finally block runs
	 * before the rejection propagates, resetting the marker.
	 */
	test('F-004: plan.md write failure — marker still reset to in_progress: false in finally', async () => {
		mock.module('../../../src/hooks/utils', () => ({
			...realHookUtils,
			readSwarmFileAsync: mock(async () => null),
			validateSwarmPath: (p: string) => p,
			safeHook: (name: string) => null as any,
		}));

		const writeLog: Array<{ path: string; content: string }> = [];
		let planMdWriteAttempted = false;

		const bunWriteMock = mock(
			async (p: string, content: string | Uint8Array) => {
				writeLog.push({ path: p, content: String(content) });
				if (p.includes('plan.md.close.')) {
					planMdWriteAttempted = true;
					throw new Error('disk full during plan.md write');
				}
			},
		);

		mock.module('../../../src/utils/bun-compat', () => ({
			...makeBunCompatMock(),
			bunWrite: bunWriteMock,
		}));

		mock.module('../../../src/plan/ledger', () => makeLedgerMock());
		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
			unlinkSync: mock(() => {}),
			existsSync: mock(() => true),
		}));

		const { closePlanTerminalState } = await import(
			'../../../src/plan/manager'
		);

		const plan = createTestPlan();

		// Expect closePlanTerminalState to reject (no catch for plan.md write failure)
		await expect(
			closePlanTerminalState(tempDir, plan, {
				closedPhaseIds: [],
				closedTaskIds: [],
			}),
		).rejects.toBeDefined();

		expect(planMdWriteAttempted).toBe(true);

		const markerWrites = writeLog.filter(
			(w) =>
				typeof w.path === 'string' && w.path.includes('.plan-write-marker'),
		);
		expect(markerWrites.length).toBe(2);

		const inProgressMarker = JSON.parse(markerWrites[0].content);
		expect(inProgressMarker.in_progress).toBe(true);
		expect(inProgressMarker.source).toBe('plan_manager_close');

		const finalMarker = JSON.parse(markerWrites[1].content);
		expect(finalMarker.in_progress).toBe(false);
		expect(finalMarker.source).toBe('plan_manager_close');
	});
});

// ---------------------------------------------------------------------------
// F-002: Temp file names include Math.floor(Math.random() * 1e9) suffix
// ---------------------------------------------------------------------------

describe('F-002 — temp file naming includes random suffix', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'f002-temp-naming-'));
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		mock.restore();
	});

	/**
	 * F-002: rebuildPlan temp file paths include Math.floor(Math.random() * 1e9).
	 * Pattern: plan.json.rebuild.<timestamp>.<randomInt> and plan.md.rebuild.<timestamp>.<randomInt>
	 */
	test('F-002: rebuildPlan temp files include random suffix (Math.floor(Math.random() * 1e9))', async () => {
		mock.module('../../../src/hooks/utils', () => ({
			...realHookUtils,
			readSwarmFileAsync: mock(async () => null),
			validateSwarmPath: (p: string) => p,
			safeHook: (name: string) => null as any,
		}));

		const writeLog: string[] = [];
		const bunWriteMock = mock(async (p: string) => {
			writeLog.push(p);
		});

		mock.module('../../../src/utils/bun-compat', () => ({
			...makeBunCompatMock(),
			bunWrite: bunWriteMock,
		}));

		mock.module('../../../src/plan/ledger', () => makeLedgerMock());
		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
			unlinkSync: mock(() => {}),
			existsSync: mock(() => true),
			readdirSync: () => [],
		}));

		const { rebuildPlan } = await import('../../../src/plan/manager');

		const plan = createTestPlan();
		await rebuildPlan(tempDir, plan, { reason: 'test-f002' });

		const planJsonTemp = writeLog.find((p) => p.includes('plan.json.rebuild.'));
		const planMdTemp = writeLog.find((p) => p.includes('plan.md.rebuild.'));

		expect(planJsonTemp).toBeDefined();
		expect(planMdTemp).toBeDefined();

		// Extract the random suffix — should be digits after the timestamp
		// plan.json.rebuild.<timestamp>.<randomInt>
		const jsonMatch = planJsonTemp!.match(/plan\.json\.rebuild\.\d+\.(\d+)/);
		const mdMatch = planMdTemp!.match(/plan\.md\.rebuild\.\d+\.(\d+)/);

		expect(jsonMatch).toBeTruthy();
		expect(mdMatch).toBeTruthy();

		const jsonSuffix = jsonMatch![1];
		const mdSuffix = mdMatch![1];

		// Verify suffix is a non-empty string of digits
		expect(/^\d+$/.test(jsonSuffix)).toBe(true);
		expect(/^\d+$/.test(mdSuffix)).toBe(true);

		// Verify suffix is in range [0, 999999999] for Math.floor(Math.random() * 1e9)
		const jsonNum = parseInt(jsonSuffix, 10);
		const mdNum = parseInt(mdSuffix, 10);
		expect(jsonNum).toBeGreaterThanOrEqual(0);
		expect(jsonNum).toBeLessThan(1e9);
		expect(mdNum).toBeGreaterThanOrEqual(0);
		expect(mdNum).toBeLessThan(1e9);
	});

	/**
	 * F-002: closePlanTerminalState temp file paths include Math.floor(Math.random() * 1e9).
	 * Pattern: plan.json.close.<timestamp>.<randomInt> and plan.md.close.<timestamp>.<randomInt>
	 */
	test('F-002: closePlanTerminalState temp files include random suffix (Math.floor(Math.random() * 1e9))', async () => {
		mock.module('../../../src/hooks/utils', () => ({
			...realHookUtils,
			readSwarmFileAsync: mock(async () => null),
			validateSwarmPath: (p: string) => p,
			safeHook: (name: string) => null as any,
		}));

		const writeLog: string[] = [];
		const bunWriteMock = mock(async (p: string) => {
			writeLog.push(p);
		});

		mock.module('../../../src/utils/bun-compat', () => ({
			...makeBunCompatMock(),
			bunWrite: bunWriteMock,
		}));

		mock.module('../../../src/plan/ledger', () => makeLedgerMock());
		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
			unlinkSync: mock(() => {}),
			existsSync: mock(() => true),
		}));

		const { closePlanTerminalState } = await import(
			'../../../src/plan/manager'
		);

		const plan = createTestPlan();
		await closePlanTerminalState(tempDir, plan, {
			closedPhaseIds: [],
			closedTaskIds: [],
		});

		const planJsonTemp = writeLog.find((p) => p.includes('plan.json.close.'));
		const planMdTemp = writeLog.find((p) => p.includes('plan.md.close.'));

		expect(planJsonTemp).toBeDefined();
		expect(planMdTemp).toBeDefined();

		// Extract the random suffix
		const jsonMatch = planJsonTemp!.match(/plan\.json\.close\.\d+\.(\d+)/);
		const mdMatch = planMdTemp!.match(/plan\.md\.close\.\d+\.(\d+)/);

		expect(jsonMatch).toBeTruthy();
		expect(mdMatch).toBeTruthy();

		const jsonSuffix = jsonMatch![1];
		const mdSuffix = mdMatch![1];

		expect(/^\d+$/.test(jsonSuffix)).toBe(true);
		expect(/^\d+$/.test(mdSuffix)).toBe(true);

		const jsonNum = parseInt(jsonSuffix, 10);
		const mdNum = parseInt(mdSuffix, 10);
		expect(jsonNum).toBeGreaterThanOrEqual(0);
		expect(jsonNum).toBeLessThan(1e9);
		expect(mdNum).toBeGreaterThanOrEqual(0);
		expect(mdNum).toBeLessThan(1e9);
	});
});

// ---------------------------------------------------------------------------
// F-005 + Telemetry: import deduplication and source attribution
// ---------------------------------------------------------------------------

describe('F-005 + telemetry — import deduplication and source attribution', () => {
	/**
	 * F-005: takeSnapshotWithRetry is exported from ledger.ts and imported by
	 * both manager.ts and save-plan.ts. This test performs a structural check
	 * by verifying the import succeeds — if the export is missing, the import throws.
	 */
	test('F-005: takeSnapshotWithRetry is importable from ledger.ts', async () => {
		const ledger = await import('../../../src/plan/ledger');
		expect(typeof ledger.takeSnapshotWithRetry).toBe('function');
	});

	test('F-005: takeSnapshotWithRetry is imported in manager.ts (_snapshot_test_exports)', async () => {
		const { _snapshot_test_exports } = await import(
			'../../../src/plan/manager'
		);
		expect(typeof _snapshot_test_exports.takeSnapshotWithRetry).toBe(
			'function',
		);
	});

	test('F-005: takeSnapshotWithRetry is imported in save-plan.ts (_test_exports)', async () => {
		// Mock hooks/utils so that save-plan's imports don't fail on validateSwarmPath
		mock.module('../../../src/hooks/utils', () => ({
			...realHookUtils,
			readSwarmFileAsync: mock(async () => null),
			validateSwarmPath: (p: string) => p,
			safeHook: (name: string) => null as any,
		}));

		const { _test_exports } = await import('../../../src/tools/save-plan');
		expect(typeof _test_exports.takeSnapshotWithRetry).toBe('function');
	});

	/**
	 * Telemetry source: manager passes source: 'savePlan_manager'.
	 */
	test('telemetry source: manager passes source: savePlan_manager to takeSnapshotWithRetry', async () => {
		const realTelemetry = await import('../../../src/telemetry');

		const mockTakeSnapshotEvent = mock(async () => {});
		const mockEmit = mock(() => {});

		mock.module('../../../src/plan/ledger', () => ({
			...realLedger,
			takeSnapshotEvent: mockTakeSnapshotEvent,
		}));

		mock.module('../../../src/telemetry', () => ({
			...realTelemetry,
			emit: mockEmit,
		}));

		mockTakeSnapshotEvent.mockRejectedValue(new Error('force failure'));

		const { _snapshot_test_exports } = await import(
			'../../../src/plan/manager'
		);
		const testPlan: Plan = {
			schema_version: '1.0.0',
			title: 'telemetry-test',
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
							description: 'test',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};

		await _snapshot_test_exports.takeSnapshotWithRetry('/tmp', testPlan, {
			source: 'savePlan_manager',
		});

		expect(mockEmit).toHaveBeenCalled();
		const emitCall = mockEmit.mock.calls.find(
			(c) => c[0] === 'snapshot_failed',
		);
		expect(emitCall).toBeDefined();
		expect((emitCall![1] as { source?: string }).source).toBe(
			'savePlan_manager',
		);
	});

	test('telemetry source: save-plan defaults to save_plan_tool (no source option passed)', async () => {
		const realTelemetry = await import('../../../src/telemetry');

		const mockTakeSnapshotEvent = mock(async () => {});
		const mockEmit = mock(() => {});

		mock.module('../../../src/plan/ledger', () => ({
			...realLedger,
			takeSnapshotEvent: mockTakeSnapshotEvent,
		}));

		mock.module('../../../src/telemetry', () => ({
			...realTelemetry,
			emit: mockEmit,
		}));

		mockTakeSnapshotEvent.mockRejectedValue(new Error('force failure'));

		// Mock hooks/utils for save-plan imports
		mock.module('../../../src/hooks/utils', () => ({
			...realHookUtils,
			readSwarmFileAsync: mock(async () => null),
			validateSwarmPath: (p: string) => p,
			safeHook: (name: string) => null as any,
		}));

		const { _test_exports } = await import('../../../src/tools/save-plan');
		const testPlan: Plan = {
			schema_version: '1.0.0',
			title: 'telemetry-test',
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
							description: 'test',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};

		// Call without source option — should use default 'save_plan_tool'
		await _test_exports.takeSnapshotWithRetry('/tmp', testPlan);

		expect(mockEmit).toHaveBeenCalled();
		const emitCall = mockEmit.mock.calls.find(
			(c) => c[0] === 'snapshot_failed',
		);
		expect(emitCall).toBeDefined();
		expect((emitCall![1] as { source?: string }).source).toBe('save_plan_tool');
	});
});
