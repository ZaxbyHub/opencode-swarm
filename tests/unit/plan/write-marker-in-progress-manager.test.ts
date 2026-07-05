import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fsSync from 'node:fs';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	closePlanTerminalState,
	rebuildPlan,
	savePlan,
} from '../../../src/plan/manager';

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
						status: 'pending',
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
// savePlan marker tests
// ---------------------------------------------------------------------------

describe('savePlan write-marker in_progress', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'saveplan-marker-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		mock.restore();
	});

	test('1. savePlan writes intermediate marker with in_progress: true DURING execution', async () => {
		const bunWriteCalls: Array<{ path: string; content: string }> = [];

		// Mock bunWrite to capture all write calls
		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mock(async (path: string, content: string) => {
				bunWriteCalls.push({ path, content });
			}),
			bunHash: mock(() => 0n),
		}));

		// Mock fs for renameSync
		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
			existsSync: mock(() => true),
			readdirSync: () => [],
		}));

		// Mock ledger functions to avoid actual I/O
		mock.module('../../../src/plan/ledger', () => ({
			ledgerExists: mock(async () => false),
			initLedger: mock(async () => {}),
			appendLedgerEvent: mock(async () => ({})),
			computePlanHash: mock(() => 'hash'),
			computeCurrentPlanHash: mock(() => 'hash'),
			readLedgerEvents: mock(async () => []),
			getLatestLedgerSeq: mock(async () => 0),
			takeSnapshotEvent: mock(async () => {}),
		}));

		const testPlan = createTestPlan();

		// Call savePlan - it will use our mocked bunWrite
		await savePlan(tempDir, testPlan);

		// Find the bunWrite calls that wrote to .plan-write-marker
		const markerCalls = bunWriteCalls.filter(
			(call) =>
				call.path.includes('.plan-write-marker') &&
				call.path.includes('.swarm'),
		);

		// We expect at least 2 marker writes: one with in_progress: true, one with false
		expect(markerCalls.length).toBeGreaterThanOrEqual(2);

		// First marker call (intermediate) should have in_progress: true
		const firstMarker = JSON.parse(markerCalls[0].content);
		expect(firstMarker.in_progress).toBe(true);
		expect(firstMarker.source).toBe('plan_manager');

		// Last marker call (final) should have in_progress: false
		const lastMarker = JSON.parse(markerCalls[markerCalls.length - 1].content);
		expect(lastMarker.in_progress).toBe(false);
		expect(lastMarker.source).toBe('plan_manager');
	});

	test('2. savePlan final marker has in_progress: false (verified via mock)', async () => {
		const bunWriteCalls: Array<{ path: string; content: string }> = [];

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mock(async (path: string, content: string) => {
				bunWriteCalls.push({ path, content });
			}),
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
			existsSync: mock(() => true),
			readdirSync: () => [],
		}));

		mock.module('../../../src/plan/ledger', () => ({
			ledgerExists: mock(async () => false),
			initLedger: mock(async () => {}),
			appendLedgerEvent: mock(async () => ({})),
			computePlanHash: mock(() => 'hash'),
			computeCurrentPlanHash: mock(() => 'hash'),
			readLedgerEvents: mock(async () => []),
			getLatestLedgerSeq: mock(async () => 0),
			takeSnapshotEvent: mock(async () => {}),
		}));

		const testPlan = createTestPlan();
		await savePlan(tempDir, testPlan);

		// Find the final marker write
		const markerCalls = bunWriteCalls.filter(
			(call) =>
				call.path.includes('.plan-write-marker') &&
				call.path.includes('.swarm'),
		);

		const lastMarker = JSON.parse(markerCalls[markerCalls.length - 1].content);
		expect(lastMarker.in_progress).toBe(false);
		expect(lastMarker.source).toBe('plan_manager');
		expect(lastMarker.phases_count).toBe(2);
		expect(lastMarker.tasks_count).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// rebuildPlan marker tests
// ---------------------------------------------------------------------------

describe('rebuildPlan write-marker in_progress', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'rebuildplan-marker-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		mock.restore();
	});

	test('3. rebuildPlan writes marker with in_progress: false', async () => {
		const bunWriteCalls: Array<{ path: string; content: string }> = [];
		const testPlan = createTestPlan();

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mock(async (path: string, content: string) => {
				bunWriteCalls.push({ path, content });
			}),
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
		}));

		mock.module('../../../src/plan/ledger', () => ({
			replayFromLedger: mock(async () => testPlan),
			appendLedgerEvent: mock(async () => ({})),
			computePlanHash: mock(() => 'hash'),
			takeSnapshotEvent: mock(async () => {}),
		}));

		await rebuildPlan(tempDir);

		// Find the marker write
		const markerCalls = bunWriteCalls.filter(
			(call) =>
				call.path.includes('.plan-write-marker') &&
				call.path.includes('.swarm'),
		);

		expect(markerCalls.length).toBe(2);
		const marker = JSON.parse(markerCalls[1].content);
		expect(marker.in_progress).toBe(false);
		expect(marker.source).toBe('plan_manager');
		expect(marker.phases_count).toBe(2);
		expect(marker.tasks_count).toBe(3);
	});

	test('4. rebuildPlan with explicit plan arg writes marker with in_progress: false', async () => {
		const bunWriteCalls: Array<{ path: string; content: string }> = [];
		const testPlan = createTestPlan({ title: 'Explicit Plan Test' });

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mock(async (path: string, content: string) => {
				bunWriteCalls.push({ path, content });
			}),
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
		}));

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mock(async () => ({})),
			computePlanHash: mock(() => 'hash'),
			takeSnapshotEvent: mock(async () => {}),
		}));

		await rebuildPlan(tempDir, testPlan, { reason: 'test' });

		// Find the marker write
		const markerCalls = bunWriteCalls.filter(
			(call) =>
				call.path.includes('.plan-write-marker') &&
				call.path.includes('.swarm'),
		);

		expect(markerCalls.length).toBe(2);
		const marker = JSON.parse(markerCalls[1].content);
		expect(marker.in_progress).toBe(false);
		expect(marker.source).toBe('plan_manager');
	});
});

// ---------------------------------------------------------------------------
// closePlanTerminalState marker tests
// ---------------------------------------------------------------------------

describe('closePlanTerminalState write-marker in_progress', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'closeplan-marker-'));
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		mock.restore();
	});

	test('5. closePlanTerminalState writes marker with in_progress: false', async () => {
		const bunWriteCalls: Array<{ path: string; content: string }> = [];
		const testPlan = createTestPlan();

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mock(async () => ({})),
			takeSnapshotEvent: mock(async () => {}),
		}));

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mock(async (path: string, content: string) => {
				bunWriteCalls.push({ path, content });
			}),
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
		}));

		await closePlanTerminalState(tempDir, testPlan, {
			closedPhaseIds: [],
			closedTaskIds: [],
		});

		// Find the marker write
		const markerCalls = bunWriteCalls.filter(
			(call) =>
				call.path.includes('.plan-write-marker') &&
				call.path.includes('.swarm'),
		);

		expect(markerCalls.length).toBe(2);
		const marker = JSON.parse(markerCalls[1].content);
		expect(marker.in_progress).toBe(false);
		expect(marker.source).toBe('plan_manager_close');
		expect(marker.phases_count).toBe(2);
		expect(marker.tasks_count).toBe(3);
	});
});
