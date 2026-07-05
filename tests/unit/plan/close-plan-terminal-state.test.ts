import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fsSync from 'node:fs';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closePlanTerminalState } from '../../../src/plan/manager';

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
// Test suite
// ---------------------------------------------------------------------------

describe('closePlanTerminalState', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'close-plan-terminal-'));
		// Ensure .swarm directory exists (closePlanTerminalState does not create it)
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		mock.restore();
	});

	// -------------------------------------------------------------------------
	// Test 1 & 2: task_status_changed ledger events
	// -------------------------------------------------------------------------
	test('1. appends task_status_changed for each closed task with correct from_status and planHashAfter', async () => {
		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
			_internals: {
				appendLedgerEvent: mockAppendLedgerEvent,
			},
		}));

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mock(async () => {}),
			bunHash: mock(() => 0n),
		}));

		// Mock renameSync in node:fs
		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
		}));

		const managerModule = await import('../../../src/plan/manager');

		const plan = createTestPlan();

		await closePlanTerminalState(tempDir, plan, {
			closedPhaseIds: [],
			closedTaskIds: ['1.1', '1.2'],
			originalStatuses: new Map([
				['1.1', 'in_progress'],
				['1.2', 'blocked'],
			]),
		});

		// Should have 2 task_status_changed calls via appendLedgerEvent
		const taskCalls = mockAppendLedgerEvent.mock.calls.filter(
			(call) =>
				(call[1] as { event_type?: string }).event_type ===
				'task_status_changed',
		);
		expect(taskCalls.length).toBe(2);

		// Verify each task's ledger event carries planHashAfter
		for (const call of taskCalls) {
			const opts = call[2] as { planHashAfter?: string } | undefined;
			expect(opts).toBeDefined();
			expect(typeof opts!.planHashAfter).toBe('string');
			expect(opts!.planHashAfter!.length).toBeGreaterThan(0);
		}

		// Verify each task's ledger event fields
		const call1 = taskCalls.find(
			(call) => (call[1] as { task_id?: string }).task_id === '1.1',
		);
		expect(call1).toBeDefined();
		expect((call1![1] as { from_status?: string }).from_status).toBe(
			'in_progress',
		);
		expect((call1![1] as { to_status?: string }).to_status).toBe('closed');
		expect((call1![1] as { source?: string }).source).toBe('close_terminal');

		const call2 = taskCalls.find(
			(call) => (call[1] as { task_id?: string }).task_id === '1.2',
		);
		expect(call2).toBeDefined();
		expect((call2![1] as { from_status?: string }).from_status).toBe('blocked');
		expect((call2![1] as { to_status?: string }).to_status).toBe('closed');
	});

	test('2. defaults from_status to in_progress when originalStatuses not provided', async () => {
		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
		}));

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mock(async () => {}),
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
		}));

		const plan = createTestPlan();

		await closePlanTerminalState(tempDir, plan, {
			closedPhaseIds: [],
			closedTaskIds: ['1.1'],
			// Note: originalStatuses NOT provided
		});

		const taskCall = mockAppendLedgerEvent.mock.calls.find(
			(call) => (call[1] as { task_id?: string }).task_id === '1.1',
		);
		expect(taskCall).toBeDefined();
		expect((taskCall![1] as { from_status?: string }).from_status).toBe(
			'in_progress',
		);
	});

	// -------------------------------------------------------------------------
	// Test 3: phase_completed ledger events
	// -------------------------------------------------------------------------
	test('3. appends phase_completed for each closed phase with planHashAfter', async () => {
		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
		}));

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mock(async () => {}),
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
		}));

		const plan = createTestPlan();

		await closePlanTerminalState(tempDir, plan, {
			closedPhaseIds: [1, 2],
			closedTaskIds: [],
		});

		const phaseCalls = mockAppendLedgerEvent.mock.calls.filter(
			(call) =>
				(call[1] as { event_type?: string }).event_type === 'phase_completed',
		);
		expect(phaseCalls.length).toBe(2);

		// Verify planHashAfter on phase events
		for (const call of phaseCalls) {
			const opts = call[2] as { planHashAfter?: string } | undefined;
			expect(opts).toBeDefined();
			expect(typeof opts!.planHashAfter).toBe('string');
		}

		const phase1Call = phaseCalls.find(
			(call) => (call[1] as { phase_id?: number }).phase_id === 1,
		);
		expect(phase1Call).toBeDefined();
		expect((phase1Call![1] as { source?: string }).source).toBe(
			'close_terminal',
		);

		const phase2Call = phaseCalls.find(
			(call) => (call[1] as { phase_id?: number }).phase_id === 2,
		);
		expect(phase2Call).toBeDefined();
	});

	// -------------------------------------------------------------------------
	// Test 4: PlanSchema validation BEFORE ledger events
	// -------------------------------------------------------------------------
	test('4. rejects invalid plan via PlanSchema.parse() without appending any ledger events', async () => {
		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));
		const mockBunWrite = mock(async () => {});
		const mockRenameSync = mock(() => {});

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
		}));

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mockBunWrite,
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mockRenameSync,
		}));

		// Invalid plan: missing required fields
		const invalidPlan = { title: 'Invalid' } as unknown as Plan;

		await expect(
			closePlanTerminalState(tempDir, invalidPlan, {
				closedPhaseIds: [],
				closedTaskIds: [],
			}),
		).rejects.toThrow();

		// No ledger events should have been appended
		expect(mockAppendLedgerEvent.mock.calls.length).toBe(0);
		// No snapshot should have been taken
		expect(mockTakeSnapshotEvent.mock.calls.length).toBe(0);
		// No file writes should have occurred
		expect(mockBunWrite.mock.calls.length).toBe(0);
		expect(mockRenameSync.mock.calls.length).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Test 5: atomic plan.json write (temp+rename)
	// -------------------------------------------------------------------------
	test('5. writes plan.json via atomic temp+rename (renameSync called)', async () => {
		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
		}));

		const mockBunWrite = mock(async () => {});
		const mockRenameSync = mock(() => {});

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mockBunWrite,
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mockRenameSync,
		}));

		const plan = createTestPlan();

		await closePlanTerminalState(tempDir, plan, {
			closedPhaseIds: [],
			closedTaskIds: [],
		});

		// Verify renameSync was called (for plan.json temp file)
		const renameCalls = mockRenameSync.mock.calls;
		expect(renameCalls.length).toBeGreaterThanOrEqual(2); // plan.json + plan.md

		// bunWrite should have been called with temp paths that include 'plan.json.close.'
		const planJsonWriteCalls = mockBunWrite.mock.calls.filter(
			(call) =>
				typeof call[0] === 'string' && call[0].includes('plan.json.close.'),
		);
		expect(planJsonWriteCalls.length).toBe(1);

		// Verify content is valid JSON (the plan)
		const writtenContent = planJsonWriteCalls[0][1];
		const parsed = JSON.parse(writtenContent as string);
		expect(parsed.title).toBe('Test Plan');
	});

	// -------------------------------------------------------------------------
	// Test 6: plan.md with content hash
	// -------------------------------------------------------------------------
	test('6. writes plan.md with content hash', async () => {
		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));
		const mockBunWrite = mock(async () => {});
		const mockRenameSync = mock(() => {});

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
		}));

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mockBunWrite,
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mockRenameSync,
		}));

		const plan = createTestPlan();

		await closePlanTerminalState(tempDir, plan, {
			closedPhaseIds: [],
			closedTaskIds: [],
		});

		// Find plan.md write call
		const planMdWriteCalls = mockBunWrite.mock.calls.filter(
			(call) =>
				typeof call[0] === 'string' && call[0].includes('plan.md.close.'),
		);
		expect(planMdWriteCalls.length).toBe(1);

		const mdContent = planMdWriteCalls[0][1] as string;
		// Should have the hash comment and markdown content
		expect(mdContent).toContain('<!-- PLAN_HASH:');
		expect(mdContent).toContain('# Test Plan');
	});

	// -------------------------------------------------------------------------
	// Test 7: write-marker with correct source and metadata
	// -------------------------------------------------------------------------
	test('7. updates write-marker with source plan_manager_close and correct metadata', async () => {
		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));
		const mockBunWrite = mock(async () => {});
		const mockRenameSync = mock(() => {});

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
		}));

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mockBunWrite,
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mockRenameSync,
		}));

		const plan = createTestPlan();

		await closePlanTerminalState(tempDir, plan, {
			closedPhaseIds: [],
			closedTaskIds: [],
		});

		// Find the write-marker call (should be the 4th bunWrite call, after plan.json, in_progress marker, and plan.md)
		const allWriteCalls = mockBunWrite.mock.calls;
		expect(allWriteCalls.length).toBe(4);

		// The last write should be the final marker (not a temp file, not the intermediate in_progress marker)
		const markerCall = allWriteCalls[3];
		const markerPath = markerCall[0] as string;
		expect(markerPath).toContain('.plan-write-marker');

		const markerContent = JSON.parse(markerCall[1] as string);
		expect(markerContent.source).toBe('plan_manager_close');
		expect(markerContent.phases_count).toBe(2);
		expect(markerContent.tasks_count).toBe(3);
		expect(markerContent.timestamp).toBeDefined();
	});

	// -------------------------------------------------------------------------
	// Test 8: empty closedPhaseIds/closedTaskIds — still writes snapshot
	// -------------------------------------------------------------------------
	test('8. handles empty closedPhaseIds and closedTaskIds gracefully (still writes snapshot)', async () => {
		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));
		const mockBunWrite = mock(async () => {});
		const mockRenameSync = mock(() => {});

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
		}));

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mockBunWrite,
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mockRenameSync,
		}));

		const plan = createTestPlan();

		await closePlanTerminalState(tempDir, plan, {
			closedPhaseIds: [],
			closedTaskIds: [],
		});

		// No individual appendLedgerEvent calls for tasks/phases, but
		// takeSnapshotEvent was called once to persist terminal state
		expect(mockAppendLedgerEvent.mock.calls.length).toBe(0);
		expect(mockTakeSnapshotEvent.mock.calls.length).toBe(1);

		// Verify snapshot was called with validated plan and correct source
		const snapshotCall = mockTakeSnapshotEvent.mock.calls[0];
		expect(snapshotCall[0]).toBe(tempDir);
		expect((snapshotCall[1] as Plan).title).toBe('Test Plan');
		const snapshotOpts = snapshotCall[2] as {
			source?: string;
			planHashAfter?: string;
		};
		expect(snapshotOpts.source).toBe('close_terminal');
		expect(typeof snapshotOpts.planHashAfter).toBe('string');

		// Plan files should still be written
		expect(mockBunWrite.mock.calls.length).toBe(4); // plan.json, in_progress marker, plan.md, final marker
		expect(mockRenameSync.mock.calls.length).toBe(2); // plan.json rename, plan.md rename
	});

	// -------------------------------------------------------------------------
	// Test 9: terminal snapshot appended after task/phase events
	// -------------------------------------------------------------------------
	test('9. appends terminal snapshot after task and phase ledger events', async () => {
		const callOrder: string[] = [];
		const mockAppendLedgerEvent = mock(
			async (_dir: string, eventInput: { event_type?: string }) => {
				callOrder.push(`appendLedgerEvent:${eventInput.event_type}`);
			},
		);
		const mockTakeSnapshotEvent = mock(async () => {
			callOrder.push('takeSnapshotEvent');
			return {};
		});

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
		}));

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mock(async () => {}),
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
		}));

		const plan = createTestPlan();

		await closePlanTerminalState(tempDir, plan, {
			closedPhaseIds: [1],
			closedTaskIds: ['1.1'],
			originalStatuses: new Map([['1.1', 'in_progress']]),
		});

		// Verify call order: task event, phase event, snapshot
		expect(callOrder).toEqual([
			'appendLedgerEvent:task_status_changed',
			'appendLedgerEvent:phase_completed',
			'takeSnapshotEvent',
		]);

		// Snapshot should receive planHashAfter
		const snapshotCall = mockTakeSnapshotEvent.mock.calls[0];
		const snapshotOpts = snapshotCall[2] as {
			planHashAfter?: string;
			source?: string;
		};
		expect(snapshotOpts.planHashAfter).toBeDefined();
		expect(typeof snapshotOpts.planHashAfter).toBe('string');
		expect(snapshotOpts.source).toBe('close_terminal');
	});

	// -------------------------------------------------------------------------
	// Test 10: planHashAfter is consistent across all ledger events
	// -------------------------------------------------------------------------
	test('10. planHashAfter is identical across all appendLedgerEvent and takeSnapshotEvent calls', async () => {
		const mockAppendLedgerEvent = mock(async () => ({}));
		const mockTakeSnapshotEvent = mock(async () => ({}));

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
		}));

		mock.module('../../../src/utils/bun-compat', () => ({
			bunWrite: mock(async () => {}),
			bunHash: mock(() => 0n),
		}));

		mock.module('node:fs', () => ({
			...fsSync,
			renameSync: mock(() => {}),
		}));

		const plan = createTestPlan();

		await closePlanTerminalState(tempDir, plan, {
			closedPhaseIds: [1],
			closedTaskIds: ['1.1'],
			originalStatuses: new Map([['1.1', 'in_progress']]),
		});

		// Collect all planHashAfter values from appendLedgerEvent calls
		const appendHashes = mockAppendLedgerEvent.mock.calls.map(
			(call) => (call[2] as { planHashAfter?: string })?.planHashAfter,
		);
		// Collect planHashAfter from takeSnapshotEvent call
		const snapshotHash = mockTakeSnapshotEvent.mock.calls[0][2] as {
			planHashAfter?: string;
		};

		// All hashes should be defined, non-empty, and identical
		const allHashes = [...appendHashes, snapshotHash.planHashAfter].filter(
			Boolean,
		);
		expect(allHashes.length).toBe(3); // 2 appendLedgerEvent (task + phase) + 1 takeSnapshotEvent
		expect(new Set(allHashes).size).toBe(1); // All identical
	});
});
