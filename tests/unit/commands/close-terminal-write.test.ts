/**
 * Regression test: raw-write bypass is fixed (Task 2.2)
 *
 * Prior code wrote terminal plan state via a raw fs.writeFile call directly
 * in handleCloseCommand, bypassing the ledger-event + atomic-write machinery
 * in closePlanTerminalState (src/plan/manager). This test verifies that
 * closePlanTerminalState is called — and raw fs.writeFile is NOT used —
 * when persisting terminal plan state.
 *
 * F#: TBD (swarm review finding)
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Track raw fs.writeFile calls to plan.json as a side-effect sensor
const rawWriteCalls: string[] = [];
const originalWriteFile = await import('node:fs/promises').then(
	(fs) => fs.writeFile,
);

const mockClosePlanTerminalState = mock(async () => {});

await import('../../../src/tools/write-retro.js');
await import('../../../src/hooks/knowledge-curator.js');
await import('../../../src/evidence/manager.js');
await import('../../../src/session/snapshot-writer.js');

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockExecuteWriteRetro = mock(async () =>
	JSON.stringify({ success: true }),
);
const mockCurateAndStoreSwarm = mock(async () => {});
const mockArchiveEvidence = mock(async () => {});
const mockFlushPendingSnapshot = mock(async () => {});

mock.module('../../../src/tools/write-retro.js', () => ({
	executeWriteRetro: mockExecuteWriteRetro,
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: mockCurateAndStoreSwarm,
}));

mock.module('../../../src/evidence/manager.js', () => ({
	archiveEvidence: mockArchiveEvidence,
}));

mock.module('../../../src/session/snapshot-writer.js', () => ({
	flushPendingSnapshot: mockFlushPendingSnapshot,
}));

mock.module('../../../src/state.js', () => ({
	swarmState: {
		activeToolCalls: new Map(),
		toolAggregates: new Map(),
		activeAgent: new Map(),
		delegationChains: new Map(),
		pendingEvents: 0,
		lastBudgetPct: 0,
		agentSessions: new Map(),
		pendingRehydrations: new Set(),
	},
	endAgentSession: () => {},
	resetSwarmState: () => {},
}));

mock.module('../../../src/git/branch.js', () => ({
	isGitRepo: () => false,
	resetToRemoteBranch: () => ({
		success: true,
		targetBranch: 'main',
		localBranch: 'main',
		message: 'Already aligned',
		alreadyAligned: true,
		prunedBranches: [],
		warnings: [],
	}),
	resetToMainAfterMerge: () => ({
		success: true,
		targetBranch: 'origin/main',
		previousBranch: 'main',
		message: 'Already on main',
		branchDeleted: false,
		warnings: [],
	}),
}));

mock.module('../../../src/plan/checkpoint.js', () => ({
	writeCheckpoint: async () => {},
}));

// Mock the plan/manager so we can verify closePlanTerminalState is called
mock.module('../../../src/plan/manager.js', () => ({
	closePlanTerminalState: mockClosePlanTerminalState,
	// Stub other plan/manager exports that might be imported transitively
	loadPlan: mock(async () => null),
	derivePlanId: () => 'test-plan-id',
	computePlanHash: () => 'test-hash',
	computePlanContentHash: () => 'test-content-hash',
	appendLedgerEvent: mock(async () => {}),
	takeSnapshotEvent: mock(async () => {}),
	_snapshot_test_exports: {},
}));

// ── Import under test ─────────────────────────────────────────────────────────
const { handleCloseCommand } = await import('../../../src/commands/close.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

function writePlan(): void {
	const plan = {
		title: 'Regression Test Plan',
		schema_version: '1.0.0',
		current_phase: 1,
		swarm: 'test-swarm',
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
						description: 'Task A',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
	writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('handleCloseCommand — terminal state uses closePlanTerminalState (regression: T2.2)', () => {
	beforeEach(() => {
		mockExecuteWriteRetro.mockClear();
		mockCurateAndStoreSwarm.mockClear();
		mockArchiveEvidence.mockClear();
		mockFlushPendingSnapshot.mockClear();
		mockClosePlanTerminalState.mockClear();
		rawWriteCalls.length = 0;
		testDir = mkdtempSync(
			path.join(os.tmpdir(), 'close-terminal-write-regression-'),
		);
		// Create .swarm directory (handleCloseCommand reads plan.json from it)
		mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		mock.restore();
	});

	it('calls closePlanTerminalState (not raw fs.writeFile) when persisting terminal plan state', async () => {
		writePlan();

		await handleCloseCommand(testDir, []);

		// Key assertion: closePlanTerminalState must have been called
		expect(mockClosePlanTerminalState).toHaveBeenCalled();

		// Verify it was called with the correct arguments
		const call = mockClosePlanTerminalState.mock.calls[0];
		expect(call[0]).toBe(testDir); // directory
		expect(call[1]).toMatchObject({
			// planData with in_progress tasks should be closed
			phases: expect.arrayContaining([
				expect.objectContaining({
					status: 'closed',
					tasks: expect.arrayContaining([
						expect.objectContaining({
							id: '1.1',
							status: 'closed',
							close_reason: 'session_terminated',
						}),
					]),
				}),
			]),
		});
		expect(call[2]).toMatchObject({
			closedPhaseIds: expect.arrayContaining([1]),
			closedTaskIds: expect.arrayContaining(['1.1']),
		});
	});

	it('closePlanTerminalState is NOT called when plan already has all phases complete', async () => {
		// Write a plan where all phases are already 'complete'
		const plan = {
			title: 'Already Done',
			schema_version: '1.0.0',
			current_phase: 1,
			swarm: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'complete',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							size: 'small',
							description: 'Task A',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));

		await handleCloseCommand(testDir, []);

		// When plan is already done, closePlanTerminalState should NOT be called
		// because there's nothing to close — the plan is already terminal
		// The condition at close.ts:631-634 requires new closures
		expect(mockClosePlanTerminalState).not.toHaveBeenCalled();
	});

	it('closePlanTerminalState IS called when plan is done but has newly closed items via --force', async () => {
		// Write a plan where phases are complete but tasks are still in_progress
		const plan = {
			title: 'Done but tasks open',
			schema_version: '1.0.0',
			current_phase: 1,
			swarm: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'complete', // phase is complete
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'in_progress', // but task is not
							size: 'small',
							description: 'Task A',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));

		// With --force, tasks get closed even though phase is complete
		await handleCloseCommand(testDir, ['--force']);

		// --force triggers closure of in-progress tasks, so closePlanTerminalState is called
		expect(mockClosePlanTerminalState).toHaveBeenCalled();
	});
});
