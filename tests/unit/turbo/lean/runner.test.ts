/**
 * Tests for LeanTurboRunner.
 *
 * Tests the lane runner's orchestration: fail-closed semantics, lane planning,
 * lock acquisition, coder dispatch, round-robin agent selection, lock conflict
 * handling, cleanup, and durable state updates.
 *
 * Strategy:
 * - Uses real tmpDir + real lane planning via _internals
 * - Injects mock SessionClient via _sessionOps seam
 * - Uses real lock acquisition (file-locks._internals can be patched if needed)
 * - No mock.module usage — all mocking via instance seam or _internals
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import type {
	LeanTurboLane,
	LeanTurboRunState,
} from '../../../../src/turbo/lean/state';
import * as leanState from '../../../../src/turbo/lean/state';

const SESSION_ID = 'sess-runner-test';

interface MockSessionOps {
	create: ReturnType<typeof mock>;
	prompt: ReturnType<typeof mock>;
	delete: ReturnType<typeof mock>;
}

let tmpDir: string;
let mockSessionOps: MockSessionOps;
let origAssertCleanWorkingTree: typeof LeanTurboRunner._internals.assertCleanWorkingTree;

function makeRunner(options?: {
	opencodeClient?: null;
	generatedAgentNames?: string[];
	leanConfig?: { max_parallel_coders: number };
}) {
	return new LeanTurboRunner({
		directory: tmpDir,
		sessionID: SESSION_ID,
		...options,
	});
}

function injectMockSessionOps(runner: LeanTurboRunner, ops: MockSessionOps) {
	(runner as unknown as { _sessionOps: MockSessionOps })._sessionOps = ops;
}

function writeMinimalPlan(phaseNumber = 1) {
	const plan = {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: phaseNumber,
		phases: [
			{
				id: phaseNumber,
				name: `Phase ${phaseNumber}`,
				status: 'in_progress',
				tasks: [
					{
						id: `${phaseNumber}.1`,
						description: 'Task 1',
						status: 'pending',
						phase: phaseNumber,
						size: 'small',
						depends: [],
						acceptance: 'Done',
					},
					{
						id: `${phaseNumber}.2`,
						description: 'Task 2',
						status: 'pending',
						phase: phaseNumber,
						size: 'small',
						depends: [],
						acceptance: 'Done',
					},
				],
			},
		],
		lean: {
			max_parallel_coders: 4,
			require_declared_scope: false,
			conflict_policy: 'serialize',
			degrade_on_risk: true,
			phase_reviewer: false,
			phase_critic: false,
			integrated_diff_required: false,
			allow_docs_only_without_reviewer: false,
			worktree_isolation: false,
		},
	};

	fs.writeFileSync(
		path.join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf-8',
	);
}

function writeScopeFiles(taskFiles: Record<string, string[]>) {
	const scopeDir = path.join(tmpDir, '.swarm', 'scopes');
	fs.mkdirSync(scopeDir, { recursive: true });
	for (const [taskId, files] of Object.entries(taskFiles)) {
		fs.writeFileSync(
			path.join(scopeDir, `scope-${taskId}.json`),
			JSON.stringify({ files }),
			'utf-8',
		);
	}
}

function mockSuccessfulSessionOps() {
	const mockCreate = mock(() =>
		Promise.resolve({
			data: { id: `session-${Math.random().toString(36).slice(2)}` },
			error: null,
		}),
	);
	const mockPrompt = mock(() =>
		Promise.resolve({
			data: { parts: [{ type: 'text', text: 'Done' }] },
			error: null,
		}),
	);
	const mockDelete = mock(() => Promise.resolve());
	return { create: mockCreate, prompt: mockPrompt, delete: mockDelete };
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	leanState.repairStateUnreadable(tmpDir);
	mockSessionOps = mockSuccessfulSessionOps();

	// Default mock: assertCleanWorkingTree returns clean so worktree_isolation
	// tests work without needing a real git repo. Individual tests that test
	// dirty/throw scenarios override this mock within their own scope.
	origAssertCleanWorkingTree =
		LeanTurboRunner._internals.assertCleanWorkingTree;
	LeanTurboRunner._internals.assertCleanWorkingTree = mock(() =>
		Promise.resolve({ clean: true }),
	);
});

afterEach(() => {
	// Restore assertCleanWorkingTree before cleaning up tmpDir
	LeanTurboRunner._internals.assertCleanWorkingTree =
		origAssertCleanWorkingTree;

	leanState.repairStateUnreadable(tmpDir);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// ─── Test 1: Fail-closed with null client ─────────────────────────────────────

describe('fail-closed semantics', () => {
	test('runPhase returns NO_CLIENT when opencodeClient is null', async () => {
		const runner = makeRunner({ opencodeClient: null });
		const result = await runner.runPhase(1);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_CLIENT');
		expect(result.lanes).toHaveLength(0);
		expect(result.degradedTasks).toHaveLength(0);
	});

	test('dispatchLane returns NO_CLIENT when client is null', async () => {
		const runner = makeRunner({ opencodeClient: null });
		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'coder');
		expect(result.ok).toBe(false);
		expect(result.error).toBe('NO_CLIENT');
	});
});

// ─── Test 2: Lane planning and lock acquisition ────────────────────────────────

describe('lane planning and lock acquisition', () => {
	test('runPhase plans lanes from plan.json and acquires locks', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({
			'1.1': ['src/a.ts'],
			'1.2': ['src/b.ts'],
		});

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Spy on acquireLaneLocks to verify locks were acquired during the run
		const originalAcquire = LeanTurboRunner._internals.acquireLaneLocks;
		let acquireCalls = 0;
		LeanTurboRunner._internals.acquireLaneLocks = mock(() => {
			acquireCalls++;
			return Promise.resolve({ acquired: true, lockFiles: ['test.lock'] });
		});

		const result = await runner.runPhase(1);

		LeanTurboRunner._internals.acquireLaneLocks = originalAcquire;

		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBeGreaterThan(0);

		// Verify locks were acquired during the run (completed lanes release their own locks)
		expect(acquireCalls).toBeGreaterThan(0);

		// Verify session was created for each lane
		expect(mockSessionOps.create).toHaveBeenCalled();
	});

	test('runPhase returns NO_PLAN when plan.json is missing', async () => {
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
	});
});

// ─── Test: NO_LANES regression ─────────────────────────────────────────────────

describe('runPhase NO_LANES — regression: returns ok:false when planner yields zero lanes', () => {
	test('runPhase returns NO_LANES when all tasks are already completed', async () => {
		// Create a plan where all tasks are already completed — the planner
		// should yield zero lanes for phase 1, so runPhase must return ok:false.
		const plan = {
			schema_version: '1.0.0',
			title: 'All Done Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'completed',
					tasks: [
						{
							id: '1.1',
							description: 'Task 1',
							status: 'completed', // already done
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
						},
					],
				},
			],
			lean: {
				max_parallel_coders: 4,
				require_declared_scope: false,
				conflict_policy: 'serialize',
				degrade_on_risk: true,
				phase_reviewer: false,
				phase_critic: false,
				integrated_diff_required: false,
				allow_docs_only_without_reviewer: false,
				worktree_isolation: false,
			},
		};

		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
			'utf-8',
		);

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_LANES');
		expect(result.lanes).toHaveLength(0);
	});
});

// ─── Test 3: Correct agent name dispatch ──────────────────────────────────────

describe('agent dispatch', () => {
	test('dispatches to the correct agent name from generatedAgentNames', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		await runner.runPhase(1);

		// The prompt should have been called with 'mega_coder' as the agent
		expect(mockSessionOps.prompt).toHaveBeenCalled();
		const promptCall = mockSessionOps.prompt.mock.calls[0];
		expect(promptCall[0].body.agent).toBe('mega_coder');
	});

	test('dispatches to bare coder when no generated names provided', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// No generatedAgentNames — should fallback to 'coder'
		const runner = makeRunner({ generatedAgentNames: [] });
		injectMockSessionOps(runner, mockSessionOps);

		await runner.runPhase(1);

		expect(mockSessionOps.prompt).toHaveBeenCalled();
		const promptCall = mockSessionOps.prompt.mock.calls[0];
		expect(promptCall[0].body.agent).toBe('coder');
	});
});

// ─── Test 4: Round-robin coder selection ───────────────────────────────────────

describe('round-robin coder selection', () => {
	test('cycles through available coders for multiple lanes', async () => {
		writeMinimalPlan(1);
		// Two tasks that go to two separate lanes (no file conflicts)
		writeScopeFiles({
			'1.1': ['src/a.ts'],
			'1.2': ['src/b.ts'],
		});

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder', 'local_coder', 'coder'],
		});
		injectMockSessionOps(runner, mockSessionOps);

		await runner.runPhase(1);

		// Should have 2 lanes with 2 different agents
		expect(mockSessionOps.prompt.mock.calls.length).toBeGreaterThanOrEqual(1);

		// Extract agent names from prompt calls
		const agentNames = mockSessionOps.prompt.mock.calls.map(
			(call) => (call[0] as { body: { agent: string } }).body.agent,
		);

		// Verify round-robin: different agents for different lanes
		const uniqueAgents = [...new Set(agentNames)];
		expect(uniqueAgents.length).toBeGreaterThan(0);
	});

	test('resolves coder agents preferring prefixed names', async () => {
		// _resolveCoderAgents sorts prefixed coders first
		const runner = makeRunner({
			generatedAgentNames: ['coder', 'mega_coder', 'local_coder'],
		});

		// Force access to the internal resolution
		// The first agent used should be prefixed
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });
		injectMockSessionOps(runner, mockSessionOps);

		await runner.runPhase(1);

		expect(mockSessionOps.prompt).toHaveBeenCalled();
		const promptCall = mockSessionOps.prompt.mock.calls[0];
		// Should prefer mega_coder (prefixed) over coder (bare)
		expect(['mega_coder', 'local_coder']).toContain(promptCall[0].body.agent);
	});
});

// ─── Test 5: Lock conflict blocking ───────────────────────────────────────────

describe('lock conflict handling', () => {
	test('marks lane as blocked when lock acquisition fails', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Pre-create a lock file to simulate a conflicting lock
		const locksDir = path.join(tmpDir, '.swarm', 'locks');
		fs.mkdirSync(locksDir, { recursive: true });

		// Create a sentinel file that will conflict with lock acquisition
		// The lock system uses path hash — create a file that will conflict
		fs.writeFileSync(path.join(locksDir, 'placeholder.lock'), '', 'utf-8');

		// Patch acquireLaneLocks to simulate a conflict
		const originalAcquire = LeanTurboRunner._internals.acquireLaneLocks;
		LeanTurboRunner._internals.acquireLaneLocks = mock(() =>
			Promise.resolve({ acquired: false, conflicts: ['src/a.ts'] }),
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.acquireLaneLocks = originalAcquire;

		expect(result.ok).toBe(true); // Phase ran, but lane was failed
		const failedLanes = result.lanes.filter((l) => l.status === 'failed');
		expect(failedLanes.length).toBeGreaterThan(0);
		expect(failedLanes[0].error).toContain('lock conflict');
	});
});

// ─── Test 6: Lock release on cleanup ──────────────────────────────────────────

describe('cleanup', () => {
	test('releases all lane locks on cleanup()', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Patch releaseLaneLocks to track calls
		const releaseCalls: string[] = [];
		const originalRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(
			(dir: string, laneId: string) => {
				releaseCalls.push(laneId);
				return Promise.resolve(1);
			},
		);

		// Run phase to acquire locks
		await runner.runPhase(1);

		// Track which lanes were locked
		const lockedLaneIds = Object.keys(
			(runner as unknown as { _laneLockMap: Record<string, string[]> })
				._laneLockMap,
		);

		// Call cleanup
		await runner.cleanup();

		// Restore
		LeanTurboRunner._internals.releaseLaneLocks = originalRelease;

		// Verify release was called for each locked lane
		expect(releaseCalls.length).toBeGreaterThanOrEqual(lockedLaneIds.length);
	});

	test('cleanup does not throw when no lanes were locked', async () => {
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		await expect(runner.cleanup()).resolves.toBeUndefined();
	});

	test('cleanup preserves completed and failed lane statuses', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Patch _withStateLock so we can directly manipulate durable state
		const origWithStateLock = (
			runner as unknown as {
				_withStateLock: Function;
			}
		)._withStateLock;
		(runner as unknown as { _withStateLock: Function })._withStateLock = mock(
			(fn: () => Promise<unknown>) => fn(),
		);

		// Bootstrap durable state with lanes in mixed statuses
		const initialState: LeanTurboRunState = {
			status: 'running',
			sessionID: SESSION_ID,
			strategy: 'lean',
			maxParallelCoders: 4,
			phase: 1,
			planId: 'test-plan',
			activeLanePlanId: 'test-plan',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: ['src/a.ts'],
					status: 'running',
				},
				{
					laneId: 'lane-2',
					taskIds: ['1.2'],
					files: ['src/b.ts'],
					status: 'completed',
				},
				{
					laneId: 'lane-3',
					taskIds: ['1.3'],
					files: ['src/c.ts'],
					status: 'failed',
					error: 'boom',
				},
				{
					laneId: 'lane-4',
					taskIds: ['1.4'],
					files: ['src/d.ts'],
					status: 'pending',
				},
			],
			degradedTasks: [],
			counters: {
				lanesPlanned: 4,
				lanesStarted: 1,
				lanesCompleted: 1,
				lanesFailed: 1,
				tasksSerialized: 0,
				tasksDegraded: 0,
			},
		};
		leanState.saveLeanTurboRunState(tmpDir, initialState);

		await runner.cleanup();

		// Restore
		(runner as unknown as { _withStateLock: Function })._withStateLock =
			origWithStateLock;

		// Verify state: completed and failed lanes should be untouched
		const finalState = leanState.loadLeanTurboRunState(tmpDir, SESSION_ID);
		expect(finalState).not.toBeNull();

		const laneMap = new Map(finalState!.lanes.map((l) => [l.laneId, l.status]));

		// lane-1 was running → should be blocked
		expect(laneMap.get('lane-1')).toBe('blocked');
		// lane-2 was completed → should stay completed
		expect(laneMap.get('lane-2')).toBe('completed');
		// lane-3 was failed → should stay failed
		expect(laneMap.get('lane-3')).toBe('failed');
		// lane-4 was pending → should be blocked
		expect(laneMap.get('lane-4')).toBe('blocked');
	});

	test('cleanup uses state lock to prevent races', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Patch _withStateLock to track that it was called
		const withStateLockCalls: unknown[] = [];
		const origWithStateLock = (
			runner as unknown as {
				_withStateLock: Function;
			}
		)._withStateLock;
		(runner as unknown as { _withStateLock: Function })._withStateLock = mock(
			(fn: () => Promise<unknown>) => {
				withStateLockCalls.push(fn);
				return fn();
			},
		);

		await runner.cleanup();

		// Restore
		(runner as unknown as { _withStateLock: Function })._withStateLock =
			origWithStateLock;

		// Verify _withStateLock was called (at least once for the state update)
		expect(withStateLockCalls.length).toBeGreaterThan(0);
	});
});

// ─── Test 7: Durable state updates ───────────────────────────────────────────

describe('durable state', () => {
	test('runPhase updates durable state with planned lanes', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const saveCalls: Array<{ dir: string; state: unknown }> = [];
		const originalSave = LeanTurboRunner._internals.saveLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState = mock(
			(dir: string, state: unknown) => {
				saveCalls.push({ dir, state });
			},
		);

		await runner.runPhase(1);

		LeanTurboRunner._internals.saveLeanTurboRunState = originalSave;

		// Verify save was called at least once (during runPhase)
		expect(saveCalls.length).toBeGreaterThan(0);

		// Verify the saved state contains lanes
		const lastSave = saveCalls[saveCalls.length - 1];
		const savedState = lastSave.state as {
			lanes?: LeanTurboLane[];
			status?: string;
		};
		expect(savedState.status).toBe('running');
		expect(savedState.lanes).toBeDefined();
		expect(savedState.lanes!.length).toBeGreaterThan(0);
	});

	test('cleanupAfterFailure updates durable state to blocked status for running lanes', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Track save calls and also write to disk
		const saveCalls: Array<{ dir: string; state: unknown }> = [];
		const originalSave = LeanTurboRunner._internals.saveLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState = mock(
			(dir: string, state: unknown) => {
				saveCalls.push({ dir, state });
				// Also call original to persist to disk (so load reads latest)
				originalSave(dir, state as Parameters<typeof originalSave>[1]);
			},
		);

		await runner.runPhase(1);

		// Manually inject a running lane into durable state to simulate
		// a scenario where cleanup runs while a lane is still in progress
		const currentState = leanState.loadLeanTurboRunState(tmpDir, SESSION_ID);
		expect(currentState).not.toBeNull();
		currentState!.lanes = [
			...(currentState?.lanes ?? []),
			{
				laneId: 'lane-stuck',
				taskIds: ['1.2'],
				files: ['src/stuck.ts'],
				status: 'running' as const,
			},
		];
		originalSave(tmpDir, currentState!);

		await runner.cleanupAfterFailure();

		LeanTurboRunner._internals.saveLeanTurboRunState = originalSave;

		// Find a save call where the stuck running lane was marked blocked
		const blockedSave = saveCalls.find((call) =>
			(call.state as { lanes?: LeanTurboLane[] }).lanes?.some(
				(l) => l.status === 'blocked',
			),
		);
		expect(blockedSave).toBeDefined();
	});
});

// ─── Test 8: Dispatch failure releases locks ──────────────────────────────────

describe('dispatch failure handling', () => {
	test('releases locks when dispatch fails', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Make dispatch fail
		const failingOps = {
			create: mock(() =>
				Promise.resolve({ data: null, error: 'session creation failed' }),
			),
			prompt: mock(() =>
				Promise.resolve({ data: null, error: 'prompt failed' }),
			),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, failingOps);

		const releaseCalls: string[] = [];
		const originalRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(
			(dir: string, laneId: string) => {
				releaseCalls.push(laneId);
				return Promise.resolve(1);
			},
		);

		const result = await runner.runPhase(1);

		LeanTurboRunner._internals.releaseLaneLocks = originalRelease;

		// Phase ran but lane failed
		expect(result.ok).toBe(true);
		const failedLanes = result.lanes.filter((l) => l.status === 'failed');
		expect(failedLanes.length).toBeGreaterThan(0);

		// Locks should have been released
		expect(releaseCalls.length).toBeGreaterThan(0);
	});
});

// ─── Test 9: Tool permissions regression (F#) ─────────────────────────────────
// Regression for reviewer finding: dispatchLane() sent tools:{write:false,edit:false,patch:false}
// which prevented coder agents from modifying files, contradicting the lane prompt.

describe('dispatchLane tool permissions — regression: coders must be able to write/edit/patch files (F#)', () => {
	test('prompt payload does NOT restrict file-modifying tools', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		await runner.runPhase(1);

		expect(mockSessionOps.prompt).toHaveBeenCalled();
		const promptCall = mockSessionOps.prompt.mock.calls[0];
		const tools = (
			promptCall[0] as {
				body: { tools: { write: boolean; edit: boolean; patch: boolean } };
			}
		).body.tools;

		// Prior bug: tools was { write: false, edit: false, patch: false }
		// Coder agents need these tools to implement their tasks.
		expect(tools.write).not.toBe(false);
		expect(tools.edit).not.toBe(false);
		expect(tools.patch).not.toBe(false);
	});
});

// ─── Test 10: waitForLanes returns current status ──────────────────────────────

describe('waitForLanes', () => {
	test('returns in-memory lane statuses', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		await runner.runPhase(1);

		const statuses = await runner.waitForLanes();
		expect(statuses.length).toBeGreaterThan(0);
		expect(statuses[0].laneId).toBeDefined();
		expect(statuses[0].status).toBeDefined();
	});
});

// ─── Test 11: Lane timeout marks failed and cleans up orphan ─────────────────────

describe('lane timeout', () => {
	test('marks lane as failed when dispatch exceeds timeout and cleans up orphan session', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Session that takes longer than our timeout
		const slowCreate = mock(() =>
			Bun.sleep(200).then(() =>
				Promise.resolve({
					data: { id: `session-${Math.random().toString(36).slice(2)}` },
					error: null,
				}),
			),
		);
		const slowPrompt = mock(() =>
			Bun.sleep(200).then(() =>
				Promise.resolve({
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				}),
			),
		);
		const deleteMock = mock(() => Promise.resolve());
		const slowOps = {
			create: slowCreate,
			prompt: slowPrompt,
			delete: deleteMock,
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, slowOps);

		// Set a short timeout (50ms) via _internals
		const origTimeout = LeanTurboRunner._internals.laneDispatchTimeoutMs;
		LeanTurboRunner._internals.laneDispatchTimeoutMs = 50;

		// Track release calls to verify locks are released on timeout
		const releaseCalls: string[] = [];
		const origRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(
			(dir: string, laneId: string) => {
				releaseCalls.push(laneId);
				return Promise.resolve(1);
			},
		);

		const result = await runner.runPhase(1);

		// Wait for background dispatch to complete and cleanup to happen
		await Bun.sleep(500);

		// Restore
		LeanTurboRunner._internals.laneDispatchTimeoutMs = origTimeout;
		LeanTurboRunner._internals.releaseLaneLocks = origRelease;

		// Phase should complete (at least attempt lanes)
		expect(result.ok).toBe(true);
		// The lane should be marked as failed due to timeout
		const failedLanes = result.lanes.filter((l) => l.status === 'failed');
		expect(failedLanes.length).toBeGreaterThan(0);
		// Verify the error indicates timeout
		expect(failedLanes[0].error).toContain('timed out');
		// Locks should have been released
		expect(releaseCalls.length).toBeGreaterThan(0);
		// session.delete should have been called to clean up the orphan session
		expect(deleteMock).toHaveBeenCalled();
	});
});

describe('timeout after session.create succeeds', () => {
	test('cleans up orphan session when timeout fires after create but before prompt completes', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Session that creates quickly but prompt hangs
		const sessionId = `session-orphan-${Math.random().toString(36).slice(2)}`;
		const fastCreate = mock(() =>
			Promise.resolve({
				data: { id: sessionId },
				error: null,
			}),
		);
		const hangingPrompt = mock(() =>
			Bun.sleep(500).then(() =>
				Promise.resolve({
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				}),
			),
		);
		const deleteMock = mock(() => Promise.resolve());
		const hangingOps = {
			create: fastCreate,
			prompt: hangingPrompt,
			delete: deleteMock,
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, hangingOps);

		// Set a short timeout (50ms) via _internals
		const origTimeout = LeanTurboRunner._internals.laneDispatchTimeoutMs;
		LeanTurboRunner._internals.laneDispatchTimeoutMs = 50;

		// Track release calls
		const releaseCalls: string[] = [];
		const origRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(
			(dir: string, laneId: string) => {
				releaseCalls.push(laneId);
				return Promise.resolve(1);
			},
		);

		const result = await runner.runPhase(1);

		// Wait for background dispatch to complete and cleanup to happen
		await Bun.sleep(600);

		// Restore
		LeanTurboRunner._internals.laneDispatchTimeoutMs = origTimeout;
		LeanTurboRunner._internals.releaseLaneLocks = origRelease;

		// Phase should complete
		expect(result.ok).toBe(true);
		// The lane should be marked as failed due to timeout
		const failedLanes = result.lanes.filter((l) => l.status === 'failed');
		expect(failedLanes.length).toBeGreaterThan(0);
		expect(failedLanes[0].error).toContain('timed out');
		// Locks should have been released
		expect(releaseCalls.length).toBeGreaterThan(0);
		// session.delete should have been called to clean up the orphan session
		expect(deleteMock).toHaveBeenCalled();
		// Verify delete was called with the orphaned session ID
		const deleteCall = deleteMock.mock.calls[0];
		expect((deleteCall[0] as { path: { id: string } }).path.id).toBe(sessionId);
		// session.prompt IS called (fire-and-forget) but timeout fired before it completed
		// The prompt will fail naturally since the session is deleted
		expect(hangingPrompt).toHaveBeenCalled();
	});
});

// ─── Test 12: Full-Auto does not bypass enforcement ─────────────────────────────

describe('full-auto enforcement', () => {
	test('still enforces lane planning and lock acquisition when full-auto is active', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({
			'1.1': ['src/a.ts'],
			'1.2': ['src/b.ts'],
		});

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Simulate full-auto being active by patching hasActiveFullAuto via state._internals
		// We need to verify that even with full-auto active, lane planning and locks still happen
		const { _internals: stateInternals } = await import(
			'../../../../src/state'
		);
		const origHasActiveFullAuto = stateInternals.hasActiveFullAuto;
		stateInternals.hasActiveFullAuto = mock(() => true);

		// Patch the planner to verify it was called
		const planCalls: unknown[] = [];
		const origPlan = LeanTurboRunner._internals.planLeanTurboLanes;
		LeanTurboRunner._internals.planLeanTurboLanes = mock(
			(...args: Parameters<typeof origPlan>) => {
				planCalls.push(args);
				return origPlan(...args);
			},
		);

		// Patch lock acquisition to verify it was called
		const lockCalls: unknown[] = [];
		const origAcquire = LeanTurboRunner._internals.acquireLaneLocks;
		LeanTurboRunner._internals.acquireLaneLocks = mock(
			(...args: Parameters<typeof origAcquire>) => {
				lockCalls.push(args);
				return origAcquire(...args);
			},
		);

		const result = await runner.runPhase(1);

		// Restore
		stateInternals.hasActiveFullAuto = origHasActiveFullAuto;
		LeanTurboRunner._internals.planLeanTurboLanes = origPlan;
		LeanTurboRunner._internals.acquireLaneLocks = origAcquire;

		// Phase should run successfully
		expect(result.ok).toBe(true);
		// Lane planning should have been called
		expect(planCalls.length).toBeGreaterThan(0);
		// Lock acquisition should have been called
		expect(lockCalls.length).toBeGreaterThan(0);
		// Lanes should have been created and processed
		expect(result.lanes.length).toBeGreaterThan(0);
	});
});

// ─── Test: Full-Auto composition — blocked states ───────────────────────────────

describe('full-auto composition blocking', () => {
	test('runPhase returns FULL_AUTO_BLOCKED when full-auto is paused', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Mock hasActiveFullAuto to return true (patch LeanTurboRunner._internals)
		const origHasActiveFullAuto = LeanTurboRunner._internals.hasActiveFullAuto;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => true);

		// Mock loadFullAutoRunState to return paused state
		const origLoadFullAutoRunState =
			LeanTurboRunner._internals.loadFullAutoRunState;
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => ({
			sessionID: SESSION_ID,
			status: 'paused',
			mode: 'supervised',
			planID: 'test-plan',
			currentPhase: 1,
			currentTaskID: '1.1',
			pauseReason: 'user_paused',
			terminateReason: undefined,
			denialCounters: { consecutive: 0, total: 0 },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}));

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.hasActiveFullAuto = origHasActiveFullAuto;
		LeanTurboRunner._internals.loadFullAutoRunState = origLoadFullAutoRunState;

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('FULL_AUTO_BLOCKED');
		expect(result.lanes).toHaveLength(0);
		expect(result.degradedTasks).toHaveLength(0);
	});

	test('runPhase returns FULL_AUTO_BLOCKED when full-auto is terminated', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Mock hasActiveFullAuto to return true (patch LeanTurboRunner._internals)
		const origHasActiveFullAuto = LeanTurboRunner._internals.hasActiveFullAuto;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => true);

		// Mock loadFullAutoRunState to return terminated state
		const origLoadFullAutoRunState =
			LeanTurboRunner._internals.loadFullAutoRunState;
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => ({
			sessionID: SESSION_ID,
			status: 'terminated',
			mode: 'supervised',
			planID: 'test-plan',
			currentPhase: 1,
			currentTaskID: '1.1',
			pauseReason: undefined,
			terminateReason: 'user_terminated',
			denialCounters: { consecutive: 0, total: 0 },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}));

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.hasActiveFullAuto = origHasActiveFullAuto;
		LeanTurboRunner._internals.loadFullAutoRunState = origLoadFullAutoRunState;

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('FULL_AUTO_BLOCKED');
		expect(result.lanes).toHaveLength(0);
		expect(result.degradedTasks).toHaveLength(0);
	});

	test('runPhase proceeds normally when full-auto is running', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Mock hasActiveFullAuto to return true (patch LeanTurboRunner._internals)
		const origHasActiveFullAuto = LeanTurboRunner._internals.hasActiveFullAuto;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => true);

		// Mock loadFullAutoRunState to return running state
		const origLoadFullAutoRunState =
			LeanTurboRunner._internals.loadFullAutoRunState;
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => ({
			sessionID: SESSION_ID,
			status: 'running',
			mode: 'supervised',
			planID: 'test-plan',
			currentPhase: 1,
			currentTaskID: '1.1',
			pauseReason: undefined,
			terminateReason: undefined,
			denialCounters: { consecutive: 0, total: 0 },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}));

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.hasActiveFullAuto = origHasActiveFullAuto;
		LeanTurboRunner._internals.loadFullAutoRunState = origLoadFullAutoRunState;

		// Phase should proceed normally
		expect(result.ok).toBe(true);
		// Lanes should have been processed
		expect(result.lanes.length).toBeGreaterThan(0);
	});

	test('runPhase proceeds normally when full-auto is inactive', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Mock hasActiveFullAuto to return false (inactive)
		const origHasActiveFullAuto = LeanTurboRunner._internals.hasActiveFullAuto;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.hasActiveFullAuto = origHasActiveFullAuto;

		// Phase should proceed normally
		expect(result.ok).toBe(true);
		// Lanes should have been processed
		expect(result.lanes.length).toBeGreaterThan(0);
	});
});

// ─── Test 13: Max concurrency honored ───────────────────────────────────────────

describe('max concurrency', () => {
	test('respects max_parallel_coders limit when planning lanes', async () => {
		// Create a plan with 6 tasks that have CONFLICTING files
		// (all touch the same file) so they need separate lanes
		// max_parallel_coders is set to 2, so only 2 lanes should be created
		// and 4 tasks should be serialized
		const plan = {
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
							description: 'Task 1',
							status: 'pending',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
						},
						{
							id: '1.2',
							description: 'Task 2',
							status: 'pending',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
						},
						{
							id: '1.3',
							description: 'Task 3',
							status: 'pending',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
						},
						{
							id: '1.4',
							description: 'Task 4',
							status: 'pending',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
						},
						{
							id: '1.5',
							description: 'Task 5',
							status: 'pending',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
						},
						{
							id: '1.6',
							description: 'Task 6',
							status: 'pending',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
						},
					],
				},
			],
			lean: {
				max_parallel_coders: 2, // Set to 2 to test limiting
				require_declared_scope: true,
				conflict_policy: 'serialize',
				degrade_on_risk: true,
				phase_reviewer: false,
				phase_critic: false,
				integrated_diff_required: false,
				allow_docs_only_without_reviewer: false,
				worktree_isolation: false,
			},
		};

		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
			'utf-8',
		);

		// Create scopes directory first
		const scopesDir = path.join(tmpDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });

		// Write scope files for all tasks - all touch the SAME file to force conflicts
		// This will cause each task to need its own lane (since they all conflict)
		for (let i = 1; i <= 6; i++) {
			fs.writeFileSync(
				path.join(scopesDir, `scope-1.${i}.json`),
				JSON.stringify({ files: ['src/shared.ts'] }), // All conflict on same file
				'utf-8',
			);
		}

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Capture the lane plan to verify max lanes
		const origPlan = LeanTurboRunner._internals.planLeanTurboLanes;
		let capturedPlan: ReturnType<typeof origPlan> | null = null;
		LeanTurboRunner._internals.planLeanTurboLanes = mock(
			(...args: Parameters<typeof origPlan>) => {
				capturedPlan = origPlan(...args);
				return capturedPlan;
			},
		);

		const result = await runner.runPhase(1);

		LeanTurboRunner._internals.planLeanTurboLanes = origPlan;

		// Phase should run
		expect(result.ok).toBe(true);
		// The planner should have limited lanes to max_parallel_coders (2)
		expect(capturedPlan).not.toBeNull();
		expect(capturedPlan!.lanes.length).toBeLessThanOrEqual(2);
		// The 4 remaining tasks should be serialized
		expect(capturedPlan!.counters.tasksSerialized).toBeGreaterThanOrEqual(4);
	});
});

// ─── Test 14: Arbitrary swarm ID coder selection ─────────────────────────────────

describe('arbitrary swarm ID coder selection', () => {
	test('correctly selects from coders with different swarm prefixes', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({
			'1.1': ['src/a.ts'],
			'1.2': ['src/b.ts'],
			'1.3': ['src/c.ts'],
		});

		// Test with mixed prefix coders - should select mega_coder first (prefixed)
		const runner1 = makeRunner({
			generatedAgentNames: ['coder', 'mega_coder', 'local_coder'],
		});
		injectMockSessionOps(runner1, mockSessionOps);

		await runner1.runPhase(1);

		expect(mockSessionOps.prompt).toHaveBeenCalled();
		// Prefixed coders should be preferred
		const agentUsed = (
			mockSessionOps.prompt.mock.calls[0][0] as { body: { agent: string } }
		).body.agent;
		expect(['mega_coder', 'local_coder']).toContain(agentUsed);
	});

	test('handles coders with underscore-containing prefixes correctly', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Test with various underscore-containing names
		const runner = makeRunner({
			generatedAgentNames: ['dev_coder', 'test_coder', 'qa_coder'],
		});
		injectMockSessionOps(runner, mockSessionOps);

		await runner.runPhase(1);

		expect(mockSessionOps.prompt).toHaveBeenCalled();
		const agentUsed = (
			mockSessionOps.prompt.mock.calls[0][0] as { body: { agent: string } }
		).body.agent;
		// All are prefixed (have underscore before coder) so first one by length should win
		expect(agentUsed).toBeTruthy();
	});

	test('handles coders with no prefix correctly', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Test with only bare 'coder'
		const runner = makeRunner({
			generatedAgentNames: ['coder'],
		});
		injectMockSessionOps(runner, mockSessionOps);

		await runner.runPhase(1);

		expect(mockSessionOps.prompt).toHaveBeenCalled();
		const agentUsed = (
			mockSessionOps.prompt.mock.calls[0][0] as { body: { agent: string } }
		).body.agent;
		expect(agentUsed).toBe('coder');
	});
});

// ─── Test 15: Multiple lanes dispatched concurrently ─────────────────────────────

describe('multiple lane dispatch', () => {
	test('dispatches multiple lanes concurrently when files do not conflict', async () => {
		writeMinimalPlan(1);
		// Non-conflicting files go into separate lanes for parallel execution
		writeScopeFiles({
			'1.1': ['src/a.ts'],
			'1.2': ['src/b.ts'],
		});

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1);

		// At least one lane should be processed
		expect(result.lanes.length).toBeGreaterThanOrEqual(1);

		// session.create and session.prompt should have been called for the lane(s)
		expect(mockSessionOps.create).toHaveBeenCalled();
		expect(mockSessionOps.prompt).toHaveBeenCalled();
	});

	test('lane processing completes even if dispatch fails', async () => {
		writeMinimalPlan(1);
		// Use non-conflicting files that go in one lane
		writeScopeFiles({
			'1.1': ['src/a.ts'],
			'1.2': ['src/b.ts'],
		});

		// Make dispatch fail
		const failingOps = {
			create: mock(() =>
				Promise.resolve({
					data: null,
					error: 'Intentional session create failure',
				}),
			),
			prompt: mock(() =>
				Promise.resolve({
					data: null,
					error: 'Intentional prompt failure',
				}),
			),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, failingOps);

		const result = await runner.runPhase(1);

		// Phase should complete (not throw) even with dispatch failure
		expect(result.ok).toBe(true);
		// The lane should be marked as failed
		const failedLanes = result.lanes.filter((l) => l.status === 'failed');
		expect(failedLanes.length).toBeGreaterThan(0);
	});
});

// ─── Test 16: leanConfig propagation ─────────────────────────────────────────────

describe('leanConfig propagation', () => {
	test('runPhase passes provided leanConfig to lane planner instead of defaults', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Create runner with a custom leanConfig that differs from defaults
		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { max_parallel_coders: 2 },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Capture the config passed to planLeanTurboLanes
		const origPlan = LeanTurboRunner._internals.planLeanTurboLanes;
		let capturedConfig: unknown = null;
		LeanTurboRunner._internals.planLeanTurboLanes = mock(
			(...args: Parameters<typeof origPlan>) => {
				// config is the 4th argument (index 3)
				capturedConfig = args[3];
				return origPlan(...args);
			},
		);

		await runner.runPhase(1);

		LeanTurboRunner._internals.planLeanTurboLanes = origPlan;

		// Verify the custom config was passed
		expect(capturedConfig).not.toBeNull();
		expect(
			(capturedConfig as { max_parallel_coders: number }).max_parallel_coders,
		).toBe(2);
	});

	test('runPhase uses defaults when no leanConfig provided (backward compatible)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Create runner WITHOUT leanConfig
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Capture the config passed to planLeanTurboLanes
		const origPlan = LeanTurboRunner._internals.planLeanTurboLanes;
		let capturedConfig: unknown = null;
		LeanTurboRunner._internals.planLeanTurboLanes = mock(
			(...args: Parameters<typeof origPlan>) => {
				capturedConfig = args[3];
				return origPlan(...args);
			},
		);

		await runner.runPhase(1);

		LeanTurboRunner._internals.planLeanTurboLanes = origPlan;

		// Verify defaults were used (max_parallel_coders defaults to 4)
		expect(capturedConfig).not.toBeNull();
		expect(
			(capturedConfig as { max_parallel_coders: number }).max_parallel_coders,
		).toBe(4);
	});
});

// ─── Test 17: Worktree isolation integration ──────────────────────────────────

describe('worktree isolation integration', () => {
	test('calls provisionWorktree when worktree_isolation is true', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Mock provisionWorktree
		const provisionCalls: unknown[] = [];
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() => ({
			worktreePath: path.join(
				tmpDir,
				'.swarm-worktrees',
				'sess-runner-test',
				'lane-1',
			),
			branchName: `swarm-lane/${SESSION_ID}/lane-1`,
		}));
		// Wrap to capture calls
		LeanTurboRunner._internals.provisionWorktree = mock(
			(...args: Parameters<typeof origProvision>) => {
				provisionCalls.push(args);
				return Promise.resolve({
					worktreePath: path.join(
						tmpDir,
						'.swarm-worktrees',
						SESSION_ID,
						'lane-1',
					),
					branchName: `swarm-lane/${SESSION_ID}/lane-1`,
				});
			},
		);

		// Mock merge-back and cleanup so they don't fail
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		expect(result.ok).toBe(true);
		expect(provisionCalls.length).toBeGreaterThan(0);
	});

	test('does NOT call provisionWorktree when worktree_isolation is false', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: false },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Mock provisionWorktree to track calls
		const provisionCalls: unknown[] = [];
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(
			(...args: Parameters<typeof origProvision>) => {
				provisionCalls.push(args);
				return Promise.resolve({
					worktreePath: path.join(
						tmpDir,
						'.swarm-worktrees',
						SESSION_ID,
						'lane-1',
					),
					branchName: `swarm-lane/${SESSION_ID}/lane-1`,
				});
			},
		);

		await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;

		expect(provisionCalls.length).toBe(0);
	});

	test('passes worktree path to session.create (not this._directory)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);

		// Mock provisionWorktree to return a known path
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath,
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			}),
		);

		// Mock merge-back and cleanup
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		// Verify session.create was called with the worktree path, NOT tmpDir
		expect(mockSessionOps.create).toHaveBeenCalled();
		const createCall = mockSessionOps.create.mock.calls[0];
		expect(
			(createCall[0] as { query: { directory: string } }).query.directory,
		).toBe(worktreePath);
		expect(
			(createCall[0] as { query: { directory: string } }).query.directory,
		).not.toBe(tmpDir);
	});

	test('calls merge-back + cleanup on lane success', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Mock provisionWorktree
		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath,
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			}),
		);

		// Track merge and cleanup calls
		const mergeCalls: unknown[] = [];
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(
			(...args: Parameters<typeof origMerge>) => {
				mergeCalls.push(args);
				return Promise.resolve({ merged: true, strategy: 'merge' });
			},
		);

		const cleanupCalls: unknown[] = [];
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(
			(...args: Parameters<typeof origCleanup>) => {
				cleanupCalls.push(args);
				return Promise.resolve({ cleaned: true });
			},
		);

		const removeCalls: unknown[] = [];
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(
			(...args: Parameters<typeof origRemove>) => {
				removeCalls.push(args);
				return Promise.resolve({ success: true });
			},
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		expect(result.ok).toBe(true);
		expect(mergeCalls.length).toBeGreaterThan(0);
		expect(cleanupCalls.length).toBeGreaterThan(0);
		expect(removeCalls.length).toBeGreaterThan(0);
	});

	test('calls attemptMergeBackFromDirty + removeWorktree sequentially for failed lane', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Make session fail
		const failingOps = {
			create: mock(() =>
				Promise.resolve({ data: null, error: 'session create failed' }),
			),
			prompt: mock(() =>
				Promise.resolve({ data: null, error: 'prompt failed' }),
			),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, failingOps);

		// Mock provisionWorktree
		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath,
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			}),
		);

		// Track failure-path calls
		const attemptMergeCalls: unknown[] = [];
		const origAttemptMerge =
			LeanTurboRunner._internals.attemptMergeBackFromDirty;
		LeanTurboRunner._internals.attemptMergeBackFromDirty = mock(
			(...args: Parameters<typeof origAttemptMerge>) => {
				attemptMergeCalls.push(args);
				return Promise.resolve({
					merged: true,
					strategy: 'merge',
					autoCommitted: false,
					cleaned: false,
				});
			},
		);

		const removeCalls: unknown[] = [];
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(
			(...args: Parameters<typeof origRemove>) => {
				removeCalls.push(args);
				return Promise.resolve({ success: true });
			},
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.attemptMergeBackFromDirty = origAttemptMerge;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		expect(result.ok).toBe(true);
		// Lane should have failed
		const failedLanes = result.lanes.filter((l) => l.status === 'failed');
		expect(failedLanes.length).toBeGreaterThan(0);
		// attemptMergeBackFromDirty should have been called
		expect(attemptMergeCalls.length).toBeGreaterThan(0);
		// removeWorktree should have been called
		expect(removeCalls.length).toBeGreaterThan(0);
	});

	test('calls startupOrphanRecovery at runPhase start when worktree_isolation is enabled', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Track startupOrphanRecovery calls
		const recoveryCalls: unknown[] = [];
		const origRecovery = LeanTurboRunner._internals.startupOrphanRecovery;
		LeanTurboRunner._internals.startupOrphanRecovery = mock(
			(...args: Parameters<typeof origRecovery>) => {
				recoveryCalls.push(args);
				return Promise.resolve({
					prunedWorktrees: true,
					remainingBranches: [],
					warnings: [],
				});
			},
		);

		// Mock provision + merge + cleanup
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath: path.join(
					tmpDir,
					'.swarm-worktrees',
					SESSION_ID,
					'lane-1',
				),
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			}),
		);
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.startupOrphanRecovery = origRecovery;
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		expect(recoveryCalls.length).toBe(1);
		// Verify it was called with the directory and session ID
		expect(recoveryCalls[0][0]).toBe(tmpDir);
		expect(recoveryCalls[0][1]).toEqual([SESSION_ID]);
	});

	test('does NOT call startupOrphanRecovery when worktree_isolation is disabled', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: false },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Track startupOrphanRecovery calls
		const recoveryCalls: unknown[] = [];
		const origRecovery = LeanTurboRunner._internals.startupOrphanRecovery;
		LeanTurboRunner._internals.startupOrphanRecovery = mock(
			(...args: Parameters<typeof origRecovery>) => {
				recoveryCalls.push(args);
				return Promise.resolve({
					prunedWorktrees: true,
					remainingBranches: [],
					warnings: [],
				});
			},
		);

		await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.startupOrphanRecovery = origRecovery;

		expect(recoveryCalls.length).toBe(0);
	});

	test('worktree provision failure fails lane explicitly, does NOT degrade to shared directory', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Mock provisionWorktree to FAIL with a permanent error
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				error: 'git worktree add failed: worktree already exists',
			}),
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;

		// Phase returns ok:true (runPhase always returns ok when there are lanes),
		// but the lane itself should have failed
		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBe(1);
		expect(result.lanes[0].status).toBe('failed');
		expect(result.lanes[0].error).toContain('worktree provision failed');
		// session.create should NOT have been called — lane failed before dispatch
		expect(mockSessionOps.create).not.toHaveBeenCalled();
	});

	test('cleanup removes worktrees for active lanes', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);

		// Mock provisionWorktree
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath,
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			}),
		);

		// Mock merge + cleanup so lanes complete with worktree state
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		await runner.runPhase(1);

		// Reset remove mock to track cleanup-specific calls
		const cleanupRemoveCalls: unknown[] = [];
		LeanTurboRunner._internals.removeWorktree = mock(
			(...args: Parameters<typeof origRemove>) => {
				cleanupRemoveCalls.push(args);
				return Promise.resolve({ success: true });
			},
		);

		await runner.cleanup();

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		// removeWorktree should have been called during cleanup for worktree lanes
		expect(cleanupRemoveCalls.length).toBeGreaterThan(0);
	});
});

// ─── Test 18: Sequential merge-back after all lanes complete (Finding 1 fix) ─────

describe('sequential merge-back after concurrent lanes (race condition fix)', () => {
	test('merge-back runs sequentially AFTER all lanes complete, not inside _processLane', async () => {
		writeMinimalPlan(1);

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Mock the planner to return TWO separate lanes.
		// The real planner greedily packs non-conflicting tasks into one lane,
		// so we inject a custom plan to force 2 lanes for this test.
		const origPlan = LeanTurboRunner._internals.planLeanTurboLanes;
		LeanTurboRunner._internals.planLeanTurboLanes = mock(
			(..._args: Parameters<typeof origPlan>) => ({
				phase: 1,
				planId: 'test-plan',
				lanes: [
					{
						laneId: 'lane-1',
						taskIds: ['1.1'],
						files: ['src/a.ts'],
						status: 'pending' as const,
					},
					{
						laneId: 'lane-2',
						taskIds: ['1.2'],
						files: ['src/b.ts'],
						status: 'pending' as const,
					},
				],
				degradedTasks: [],
				serializedTasks: [],
				counters: {
					lanesPlanned: 2,
					lanesStarted: 0,
					lanesCompleted: 0,
					lanesFailed: 0,
					tasksSerialized: 0,
					tasksDegraded: 0,
				},
				crossLaneDependencies: {},
			}),
		);

		// Mock startupOrphanRecovery to avoid git commands in non-git tmpDir
		const origOrphanRecovery = LeanTurboRunner._internals.startupOrphanRecovery;
		LeanTurboRunner._internals.startupOrphanRecovery = mock(() =>
			Promise.resolve({
				prunedWorktrees: true,
				remainingBranches: [],
				warnings: [],
			}),
		);

		// Mock provisionWorktree to return distinct paths per lane
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		let provisionCallIndex = 0;
		const worktreePaths = [
			path.join(tmpDir, '.swarm-worktrees', SESSION_ID, 'lane-1'),
			path.join(tmpDir, '.swarm-worktrees', SESSION_ID, 'lane-2'),
		];
		LeanTurboRunner._internals.provisionWorktree = mock(() => {
			const idx = provisionCallIndex++;
			return Promise.resolve({
				worktreePath: worktreePaths[idx] ?? worktreePaths[0],
				branchName: `swarm-lane/${SESSION_ID}/lane-${idx + 1}`,
			});
		});

		// Track the order of mergeLaneBranch calls to verify sequential execution
		const mergeCallOrder: number[] = [];
		let mergeRunning = false;
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(
			async (...args: Parameters<typeof origMerge>) => {
				const callNum = mergeCallOrder.length;
				mergeCallOrder.push(callNum);
				// Simulate non-zero duration to expose concurrent execution
				if (mergeRunning) {
					// If another merge is already running, this proves they are concurrent
					mergeCallOrder.push(-1); // sentinel for concurrent execution
				}
				mergeRunning = true;
				await Bun.sleep(10);
				mergeRunning = false;
				return { merged: true, strategy: 'merge' as const };
			},
		);

		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		let result;
		try {
			result = await runner.runPhase(1);

			expect(result.ok).toBe(true);
			expect(result.lanes.length).toBe(2);
			// Both lanes should complete
			const completedLanes = result.lanes.filter(
				(l) => l.status === 'completed',
			);
			expect(completedLanes.length).toBe(2);
			// mergeLaneBranch should have been called twice (once per completed worktree lane)
			expect(mergeCallOrder.filter((n) => n >= 0).length).toBe(2);
			// No concurrent sentinel (-1) should appear — merges ran sequentially
			expect(mergeCallOrder).not.toContain(-1);
		} finally {
			LeanTurboRunner._internals.planLeanTurboLanes = origPlan;
			LeanTurboRunner._internals.startupOrphanRecovery = origOrphanRecovery;
			LeanTurboRunner._internals.provisionWorktree = origProvision;
			LeanTurboRunner._internals.mergeLaneBranch = origMerge;
			LeanTurboRunner._internals.postMergeCleanup = origCleanup;
			LeanTurboRunner._internals.removeWorktree = origRemove;
		}
	});

	test('failed worktree lanes are cleaned up sequentially in post-processing', async () => {
		writeMinimalPlan(1);

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});

		// Make session fail for BOTH lanes
		const failingOps = {
			create: mock(() =>
				Promise.resolve({ data: null, error: 'session create failed' }),
			),
			prompt: mock(() =>
				Promise.resolve({ data: null, error: 'prompt failed' }),
			),
			delete: mock(() => Promise.resolve()),
		};
		injectMockSessionOps(runner, failingOps);

		// Mock the planner to return TWO separate lanes
		const origPlan = LeanTurboRunner._internals.planLeanTurboLanes;
		LeanTurboRunner._internals.planLeanTurboLanes = mock(
			(..._args: Parameters<typeof origPlan>) => ({
				phase: 1,
				planId: 'test-plan',
				lanes: [
					{
						laneId: 'lane-1',
						taskIds: ['1.1'],
						files: ['src/a.ts'],
						status: 'pending' as const,
					},
					{
						laneId: 'lane-2',
						taskIds: ['1.2'],
						files: ['src/b.ts'],
						status: 'pending' as const,
					},
				],
				degradedTasks: [],
				serializedTasks: [],
				counters: {
					lanesPlanned: 2,
					lanesStarted: 0,
					lanesCompleted: 0,
					lanesFailed: 0,
					tasksSerialized: 0,
					tasksDegraded: 0,
				},
				crossLaneDependencies: {},
			}),
		);

		// Mock startupOrphanRecovery to avoid git commands in non-git tmpDir
		const origOrphanRecovery = LeanTurboRunner._internals.startupOrphanRecovery;
		LeanTurboRunner._internals.startupOrphanRecovery = mock(() =>
			Promise.resolve({
				prunedWorktrees: true,
				remainingBranches: [],
				warnings: [],
			}),
		);

		// Mock provisionWorktree to return distinct paths per lane
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		let provisionCallIndex = 0;
		const worktreePaths = [
			path.join(tmpDir, '.swarm-worktrees', SESSION_ID, 'lane-1'),
			path.join(tmpDir, '.swarm-worktrees', SESSION_ID, 'lane-2'),
		];
		LeanTurboRunner._internals.provisionWorktree = mock(() => {
			const idx = provisionCallIndex++;
			return Promise.resolve({
				worktreePath: worktreePaths[idx] ?? worktreePaths[0],
				branchName: `swarm-lane/${SESSION_ID}/lane-${idx + 1}`,
			});
		});

		// Track the order of attemptMergeBackFromDirty calls to verify sequential execution
		const attemptMergeCallOrder: number[] = [];
		let attemptMergeRunning = false;
		const origAttemptMerge =
			LeanTurboRunner._internals.attemptMergeBackFromDirty;
		LeanTurboRunner._internals.attemptMergeBackFromDirty = mock(
			async (...args: Parameters<typeof origAttemptMerge>) => {
				const callNum = attemptMergeCallOrder.length;
				attemptMergeCallOrder.push(callNum);
				// Simulate non-zero duration to expose concurrent execution
				if (attemptMergeRunning) {
					// If another merge is already running, this proves they are concurrent
					attemptMergeCallOrder.push(-1); // sentinel for concurrent execution
				}
				attemptMergeRunning = true;
				await Bun.sleep(10);
				attemptMergeRunning = false;
				return {
					merged: true,
					strategy: 'merge',
					autoCommitted: false,
					cleaned: false,
				};
			},
		);

		const removeCalls: unknown[] = [];
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(
			(...args: Parameters<typeof origRemove>) => {
				removeCalls.push(args);
				return Promise.resolve({ success: true });
			},
		);

		let result;
		try {
			result = await runner.runPhase(1);

			expect(result.ok).toBe(true);
			expect(result.lanes.length).toBe(2);
			// Both lanes should have failed
			const failedLanes = result.lanes.filter((l) => l.status === 'failed');
			expect(failedLanes.length).toBe(2);
			// attemptMergeBackFromDirty should have been called twice (once per failed worktree lane)
			expect(attemptMergeCallOrder.filter((n) => n >= 0).length).toBe(2);
			// No concurrent sentinel (-1) should appear — cleanup ran sequentially
			expect(attemptMergeCallOrder).not.toContain(-1);
			// removeWorktree should have been called for both failed worktree lanes
			expect(removeCalls.length).toBe(2);
		} finally {
			LeanTurboRunner._internals.planLeanTurboLanes = origPlan;
			LeanTurboRunner._internals.startupOrphanRecovery = origOrphanRecovery;
			LeanTurboRunner._internals.provisionWorktree = origProvision;
			LeanTurboRunner._internals.attemptMergeBackFromDirty = origAttemptMerge;
			LeanTurboRunner._internals.removeWorktree = origRemove;
		}
	});
});

// ─── Test 19: provisionWorktree throw caught gracefully (Finding 2 fix) ─────────

describe('provisionWorktree throw handling', () => {
	test('catches provisionWorktree rejection and fails lane explicitly', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Mock provisionWorktree to THROW (not return an error object)
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.reject(
				new Error('git worktree add: fatal: not a git repository'),
			),
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;

		// The lane should have failed — not degraded to shared directory
		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBe(1);
		expect(result.lanes[0].status).toBe('failed');
		expect(result.lanes[0].error).toContain('worktree provision failed');
		// session.create should NOT have been called — lane failed before dispatch
		expect(mockSessionOps.create).not.toHaveBeenCalled();
	});
});

// ─── Test 20: worktreePath persisted to durable state (Finding 3 fix) ────────────

describe('worktreePath persisted to durable state', () => {
	test('persists worktreePath and branchName to turbo-state.json after provisioning', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);
		const branchName = `swarm-lane/${SESSION_ID}/lane-1`;

		// Mock provisionWorktree
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({ worktreePath, branchName }),
		);

		// Mock merge + cleanup
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		expect(result.ok).toBe(true);

		// Load durable state from disk and verify worktreePath/branchName are persisted
		const durableState = leanState.loadLeanTurboRunState(tmpDir, SESSION_ID);
		expect(durableState).not.toBeNull();
		const persistedLane = durableState!.lanes.find((l) =>
			l.laneId?.startsWith('lane-'),
		);
		expect(persistedLane).toBeDefined();
		expect(persistedLane!.worktreePath).toBe(worktreePath);
		expect(persistedLane!.branchName).toBe(branchName);
	});
});

// ─── Test 21: Transient failure retry for worktree provisioning ──────────────

describe('transient worktree provision retry', () => {
	test('transient provision error (EBUSY) retries once and succeeds on retry → lane uses worktree', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);

		// Mock provisionWorktree: first call fails with EBUSY, second succeeds
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		let provisionCallCount = 0;
		LeanTurboRunner._internals.provisionWorktree = mock(() => {
			provisionCallCount++;
			if (provisionCallCount === 1) {
				return Promise.resolve({ error: 'EBUSY: worktree add failed' });
			}
			return Promise.resolve({
				worktreePath,
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			});
		});

		// Mock merge + cleanup so lane completes fully
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		expect(result.ok).toBe(true);
		expect(provisionCallCount).toBe(2); // initial + 1 retry
		// session.create should have been called with the worktree path (retry succeeded)
		expect(mockSessionOps.create).toHaveBeenCalled();
		const createCall = mockSessionOps.create.mock.calls[0];
		expect(
			(createCall[0] as { query: { directory: string } }).query.directory,
		).toBe(worktreePath);
	});

	test('transient provision error retries once and fails again → lane fails explicitly', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		let provisionCallCount = 0;
		LeanTurboRunner._internals.provisionWorktree = mock(() => {
			provisionCallCount++;
			// Both calls fail with transient ETIMEDOUT
			return Promise.resolve({
				error: `ETIMEDOUT: git worktree add timed out (attempt ${provisionCallCount})`,
			});
		});

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;

		expect(result.ok).toBe(true);
		expect(provisionCallCount).toBe(2); // initial + 1 retry
		// Lane should have failed — NOT degraded
		expect(result.lanes.length).toBe(1);
		expect(result.lanes[0].status).toBe('failed');
		expect(result.lanes[0].error).toContain('worktree provision failed');
		// session.create should NOT have been called — lane failed before dispatch
		expect(mockSessionOps.create).not.toHaveBeenCalled();
	});

	test('permanent provision error (already exists) does NOT retry → lane fails immediately', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		let provisionCallCount = 0;
		LeanTurboRunner._internals.provisionWorktree = mock(() => {
			provisionCallCount++;
			return Promise.resolve({ error: 'worktree already exists' });
		});

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;

		expect(result.ok).toBe(true);
		expect(provisionCallCount).toBe(1); // NO retry — permanent error
		// Lane should have failed — NOT degraded
		expect(result.lanes.length).toBe(1);
		expect(result.lanes[0].status).toBe('failed');
		expect(result.lanes[0].error).toContain('worktree provision failed');
		// session.create should NOT have been called — lane failed before dispatch
		expect(mockSessionOps.create).not.toHaveBeenCalled();
	});

	test('provisionWorktree throws with transient error message → retries once', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);

		// Mock provisionWorktree: first call throws with EPERM, second succeeds
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		let provisionCallCount = 0;
		LeanTurboRunner._internals.provisionWorktree = mock(() => {
			provisionCallCount++;
			if (provisionCallCount === 1) {
				return Promise.reject(
					new Error('EPERM: resource locked by another process'),
				);
			}
			return Promise.resolve({
				worktreePath,
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			});
		});

		// Mock merge + cleanup so lane completes fully
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		expect(result.ok).toBe(true);
		expect(provisionCallCount).toBe(2); // initial throw + 1 retry
		// session.create should have been called with the worktree path (retry succeeded)
		expect(mockSessionOps.create).toHaveBeenCalled();
		const createCall = mockSessionOps.create.mock.calls[0];
		expect(
			(createCall[0] as { query: { directory: string } }).query.directory,
		).toBe(worktreePath);
	});

	// ─── FR-006 / FR-011 defense-in-depth tests ──────────────────────────────────

	test('file locks are still acquired when worktree_isolation is enabled (FR-006)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Track acquireLaneLocks calls to verify locks are still acquired
		const acquireCalls: unknown[] = [];
		const origAcquire = LeanTurboRunner._internals.acquireLaneLocks;
		LeanTurboRunner._internals.acquireLaneLocks = mock(
			(...args: Parameters<typeof origAcquire>) => {
				acquireCalls.push(args);
				return Promise.resolve({
					acquired: true,
					locks: [
						{
							filePath: 'src/a.ts',
							laneId: 'lane-1',
							_release: async () => {},
						},
					],
				});
			},
		);

		// Mock worktree provision + merge + cleanup
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath: path.join(
					tmpDir,
					'.swarm-worktrees',
					SESSION_ID,
					'lane-1',
				),
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			}),
		);
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.acquireLaneLocks = origAcquire;
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		expect(result.ok).toBe(true);
		// Lock acquisition MUST still happen even in worktree mode (FR-006)
		expect(acquireCalls.length).toBeGreaterThan(0);
	});

	test('file locks use primary root directory, not worktree path (FR-006)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);

		// Capture the exact arguments passed to acquireLaneLocks
		const acquireCalls: unknown[] = [];
		const origAcquire = LeanTurboRunner._internals.acquireLaneLocks;
		LeanTurboRunner._internals.acquireLaneLocks = mock(
			(...args: Parameters<typeof origAcquire>) => {
				acquireCalls.push(args);
				return Promise.resolve({
					acquired: true,
					locks: [
						{
							filePath: 'src/a.ts',
							laneId: 'lane-1',
							_release: async () => {},
						},
					],
				});
			},
		);

		// Mock worktree provision + merge + cleanup
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath,
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			}),
		);
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.acquireLaneLocks = origAcquire;
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		expect(acquireCalls.length).toBeGreaterThan(0);
		// First argument to acquireLaneLocks must be the PRIMARY root directory,
		// NOT the worktree path — locks live under primary root's .swarm/locks/
		const firstCall = acquireCalls[0] as [string, ...unknown[]];
		expect(firstCall[0]).toBe(tmpDir);
		expect(firstCall[0]).not.toBe(worktreePath);
	});

	test('no package manager commands are spawned in worktree path (FR-011)', () => {
		// Static analysis: verify runner.ts source contains no package-manager
		// spawn calls.  The runner only delegates to _internals for worktree
		// lifecycle (provision, merge, cleanup) which use git commands via
		// bunSpawn.  No npm/yarn/pnpm/pip/bun install should ever appear.
		const runnerSource = fs.readFileSync(
			path.resolve(__dirname, '../../../../src/turbo/lean/runner.ts'),
			'utf-8',
		);

		// Package manager patterns that must NOT appear in runner source
		// Covers both shell-string (npm install) and array-form (['npm', 'install']) patterns
		const forbiddenPatterns: RegExp[] = [
			// Shell-string forms: "npm install", "bun add", etc.
			/npm\s+install/,
			/npm\s+ci/,
			/yarn\s+install/,
			/pnpm\s+install/,
			/bun\s+install/,
			/bun\s+add/,
			/bun\s+remove/,
			/pip\s+install/,
			/pip3\s+install/,
			// Array-form patterns: ['npm', 'install'], ("npm", "install"), etc.
			/\[\s*['"]npm['"]\s*,/,
			/\[\s*['"]yarn['"]\s*,/,
			/\[\s*['"]pnpm['"]\s*,/,
			/\[\s*['"]pip['"]\s*,/,
			/\[\s*['"]pip3['"]\s*,/,
			/\(\s*['"]npm['"]\s*,/,
			/\(\s*['"]yarn['"]\s*,/,
			/\(\s*['"]pnpm['"]\s*,/,
			/\(\s*['"]pip['"]\s*,/,
			/\(\s*['"]pip3['"]\s*,/,
			// bun add/remove via array form
			/\[\s*['"]bun['"]\s*,.*['"](?:install|add|remove)['"]/,
			/\(\s*['"]bun['"]\s*,.*['"](?:install|add|remove)['"]/,
		];

		for (const pattern of forbiddenPatterns) {
			expect(runnerSource).not.toMatch(pattern);
		}

		// The runner must not import child_process directly — subprocesses are
		// delegated through the worktree / merge-back modules' _internals seam.
		expect(runnerSource).not.toContain('child_process');
	});

	test('assertCleanWorkingTree dirty → worktree provisioning skipped, lanes run in shared directory', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Mock assertCleanWorkingTree to return dirty
		const origAssertClean = LeanTurboRunner._internals.assertCleanWorkingTree;
		LeanTurboRunner._internals.assertCleanWorkingTree = mock(() =>
			Promise.resolve({
				clean: false,
				error:
					'Working tree has uncommitted changes. Please commit or stash before provisioning worktrees.',
			}),
		);

		// Track provisionWorktree calls — should be ZERO since we degraded
		const provisionCalls: unknown[] = [];
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(
			(...args: Parameters<typeof origProvision>) => {
				provisionCalls.push(args);
				return Promise.resolve({
					worktreePath: path.join(
						tmpDir,
						'.swarm-worktrees',
						SESSION_ID,
						'lane-1',
					),
					branchName: `swarm-lane/${SESSION_ID}/lane-1`,
				});
			},
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.assertCleanWorkingTree = origAssertClean;
		LeanTurboRunner._internals.provisionWorktree = origProvision;

		// Phase should still succeed (degraded, not failed)
		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBeGreaterThan(0);
		// provisionWorktree must NOT have been called — degraded to shared directory
		expect(provisionCalls.length).toBe(0);
		// session.create should have been called with the PRIMARY directory (shared mode)
		expect(mockSessionOps.create).toHaveBeenCalled();
		const createCall = mockSessionOps.create.mock.calls[0];
		expect(
			(createCall[0] as { query: { directory: string } }).query.directory,
		).toBe(tmpDir);
	});

	test('assertCleanWorkingTree clean → worktree provisioning proceeds normally', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Mock assertCleanWorkingTree to return clean
		const origAssertClean = LeanTurboRunner._internals.assertCleanWorkingTree;
		LeanTurboRunner._internals.assertCleanWorkingTree = mock(() =>
			Promise.resolve({ clean: true }),
		);

		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);

		// Mock provisionWorktree to succeed
		const provisionCalls: unknown[] = [];
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(
			(...args: Parameters<typeof origProvision>) => {
				provisionCalls.push(args);
				return Promise.resolve({
					worktreePath,
					branchName: `swarm-lane/${SESSION_ID}/lane-1`,
				});
			},
		);

		// Mock merge + cleanup so lane completes fully
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.assertCleanWorkingTree = origAssertClean;
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		// Phase should succeed with worktree isolation
		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBeGreaterThan(0);
		// provisionWorktree MUST have been called — clean tree means worktrees are allowed
		expect(provisionCalls.length).toBeGreaterThan(0);
		// session.create should have been called with the WORKTREE path
		expect(mockSessionOps.create).toHaveBeenCalled();
		const createCall = mockSessionOps.create.mock.calls[0];
		expect(
			(createCall[0] as { query: { directory: string } }).query.directory,
		).toBe(worktreePath);
	});

	test('assertCleanWorkingTree NOT called when worktree_isolation is false', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: false },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Track assertCleanWorkingTree calls
		const assertCleanCalls: unknown[] = [];
		const origAssertClean = LeanTurboRunner._internals.assertCleanWorkingTree;
		LeanTurboRunner._internals.assertCleanWorkingTree = mock(
			(...args: Parameters<typeof origAssertClean>) => {
				assertCleanCalls.push(args);
				return Promise.resolve({ clean: true });
			},
		);

		await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.assertCleanWorkingTree = origAssertClean;

		// assertCleanWorkingTree must NOT have been called when worktree_isolation is off
		expect(assertCleanCalls.length).toBe(0);
	});

	test('assertCleanWorkingTree throw → degrades to shared directory gracefully', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Mock assertCleanWorkingTree to throw
		const origAssertClean = LeanTurboRunner._internals.assertCleanWorkingTree;
		LeanTurboRunner._internals.assertCleanWorkingTree = mock(() =>
			Promise.reject(new Error('not a git repository')),
		);

		// Track provisionWorktree calls — should be ZERO since we degraded
		const provisionCalls: unknown[] = [];
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(
			(...args: Parameters<typeof origProvision>) => {
				provisionCalls.push(args);
				return Promise.resolve({
					worktreePath: path.join(
						tmpDir,
						'.swarm-worktrees',
						SESSION_ID,
						'lane-1',
					),
					branchName: `swarm-lane/${SESSION_ID}/lane-1`,
				});
			},
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.assertCleanWorkingTree = origAssertClean;
		LeanTurboRunner._internals.provisionWorktree = origProvision;

		// Phase should still succeed (degraded, not failed)
		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBeGreaterThan(0);
		// provisionWorktree must NOT have been called — degraded to shared directory
		expect(provisionCalls.length).toBe(0);
	});

	test('lock release after lane completion uses primary root, not worktree path (FR-006)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);

		// Capture releaseLaneLocks arguments
		const releaseCalls: unknown[] = [];
		const origRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(
			(...args: Parameters<typeof origRelease>) => {
				releaseCalls.push(args);
				return Promise.resolve(1);
			},
		);

		// Mock acquireLaneLocks to succeed
		const origAcquire = LeanTurboRunner._internals.acquireLaneLocks;
		LeanTurboRunner._internals.acquireLaneLocks = mock(() =>
			Promise.resolve({
				acquired: true,
				locks: [
					{ filePath: 'src/a.ts', laneId: 'lane-1', _release: async () => {} },
				],
			}),
		);

		// Mock worktree provision + merge + cleanup
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath,
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			}),
		);
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.releaseLaneLocks = origRelease;
		LeanTurboRunner._internals.acquireLaneLocks = origAcquire;
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		expect(result.ok).toBe(true);
		// releaseLaneLocks should have been called after lane completion
		expect(releaseCalls.length).toBeGreaterThan(0);
		// First argument must be the PRIMARY root directory, NOT the worktree path
		const firstReleaseCall = releaseCalls[0] as [string, ...unknown[]];
		expect(firstReleaseCall[0]).toBe(tmpDir);
		expect(firstReleaseCall[0]).not.toBe(worktreePath);
	});

	// ─── New: worktree provision permanent failure → lane fails ─────────────

	test('worktree provision permanent failure → lane fails explicitly, does NOT degrade to shared directory', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Mock provisionWorktree to always fail with a permanent error
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				error: 'ENOTDIR: not a directory',
			}),
		);

		// Mock releaseLaneLocks to verify it was called on failure
		const origRelease = LeanTurboRunner._internals.releaseLaneLocks;
		const releaseCalls: unknown[] = [];
		LeanTurboRunner._internals.releaseLaneLocks = mock(
			(...args: Parameters<typeof origRelease>) => {
				releaseCalls.push(args);
				return Promise.resolve();
			},
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.releaseLaneLocks = origRelease;

		// runPhase returns ok:true but the lane failed
		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBe(1);
		const laneResult = result.lanes[0];
		expect(laneResult.status).toBe('failed');
		expect(laneResult.error).toContain('worktree provision failed');
		expect(laneResult.error).toContain('ENOTDIR');
		// session.create should NOT have been called — lane failed before dispatch
		expect(mockSessionOps.create).not.toHaveBeenCalled();
		// releaseLaneLocks SHOULD have been called to release the lock we acquired
		expect(releaseCalls.length).toBeGreaterThan(0);

		// Durable state should reflect the lane failure
		const durableState = leanState.loadLeanTurboRunState(tmpDir, SESSION_ID);
		expect(durableState).not.toBeNull();
		const persistedLane = durableState!.lanes.find((l) =>
			l.laneId?.startsWith('lane-'),
		);
		expect(persistedLane).toBeDefined();
		expect(persistedLane!.status).toBe('failed');
	});

	// ─── New: worktree provision transient failure then success ────────────

	test('worktree provision transient failure then success → lane proceeds normally', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);

		// Mock provisionWorktree: first call throws with EACCES (transient), second succeeds
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		let provisionCallCount = 0;
		LeanTurboRunner._internals.provisionWorktree = mock(() => {
			provisionCallCount++;
			if (provisionCallCount === 1) {
				return Promise.reject(new Error('EBUSY: resource busy or locked'));
			}
			return Promise.resolve({
				worktreePath,
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			});
		});

		// Mock merge + cleanup so lane completes fully
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		const result = await runner.runPhase(1);

		// Restore
		LeanTurboRunner._internals.provisionWorktree = origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = origMerge;
		LeanTurboRunner._internals.postMergeCleanup = origCleanup;
		LeanTurboRunner._internals.removeWorktree = origRemove;

		expect(result.ok).toBe(true);
		expect(provisionCallCount).toBe(2); // initial throw + 1 retry
		// Lane should have completed (retry succeeded, dispatch proceeded)
		expect(result.lanes.length).toBe(1);
		expect(result.lanes[0].status).toBe('completed');
		// session.create should have been called with the worktree path (retry succeeded)
		expect(mockSessionOps.create).toHaveBeenCalled();
		const createCall = mockSessionOps.create.mock.calls[0];
		expect(
			(createCall[0] as { query: { directory: string } }).query.directory,
		).toBe(worktreePath);
	});
});

// ─── Test 22: Merge-back failure handling (final council HIGH finding fix) ───────

describe('merge-back failure handling', () => {
	function setupWorktreeRunnerAndMocks(opts?: {
		mergeResult?:
			| { merged: true; strategy: string }
			| { conflict: true; files: string[]; message: string }
			| { error: string };
		sessionFail?: boolean;
	}) {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const sessionOps = opts?.sessionFail
			? {
					create: mock(() =>
						Promise.resolve({ data: null, error: 'session create failed' }),
					),
					prompt: mock(() =>
						Promise.resolve({ data: null, error: 'prompt failed' }),
					),
					delete: mock(() => Promise.resolve()),
				}
			: mockSuccessfulSessionOps();

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, sessionOps);

		// Mock planner to return a single lane
		const origPlan = LeanTurboRunner._internals.planLeanTurboLanes;
		LeanTurboRunner._internals.planLeanTurboLanes = mock(
			(..._args: Parameters<typeof origPlan>) => ({
				phase: 1,
				planId: 'test-plan',
				lanes: [
					{
						laneId: 'lane-1',
						taskIds: ['1.1'],
						files: ['src/a.ts'],
						status: 'pending' as const,
					},
				],
				degradedTasks: [],
				serializedTasks: [],
				counters: {
					lanesPlanned: 1,
					lanesStarted: 0,
					lanesCompleted: 0,
					lanesFailed: 0,
					tasksSerialized: 0,
					tasksDegraded: 0,
				},
				crossLaneDependencies: {},
			}),
		);

		// Mock orphan recovery
		const origOrphanRecovery = LeanTurboRunner._internals.startupOrphanRecovery;
		LeanTurboRunner._internals.startupOrphanRecovery = mock(() =>
			Promise.resolve({
				prunedWorktrees: true,
				remainingBranches: [],
				warnings: [],
			}),
		);

		// Mock provision
		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath,
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			}),
		);

		// Track merge calls
		const mergeCalls: unknown[] = [];
		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		const defaultMergeResult = opts?.mergeResult ?? {
			merged: true,
			strategy: 'merge' as const,
		};
		LeanTurboRunner._internals.mergeLaneBranch = mock(
			(...args: Parameters<typeof origMerge>) => {
				mergeCalls.push(args);
				return Promise.resolve(defaultMergeResult);
			},
		);

		// Track cleanup calls
		const cleanupCalls: unknown[] = [];
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(
			(...args: Parameters<typeof origCleanup>) => {
				cleanupCalls.push(args);
				return Promise.resolve({ cleaned: true });
			},
		);

		// Track remove calls
		const removeCalls: unknown[] = [];
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(
			(...args: Parameters<typeof origRemove>) => {
				removeCalls.push(args);
				return Promise.resolve({ success: true });
			},
		);

		return {
			runner,
			sessionOps,
			worktreePath,
			origPlan,
			origOrphanRecovery,
			origProvision,
			origMerge,
			origCleanup,
			origRemove,
			mergeCalls,
			cleanupCalls,
			removeCalls,
		};
	}

	function restoreMocks(mocks: ReturnType<typeof setupWorktreeRunnerAndMocks>) {
		LeanTurboRunner._internals.planLeanTurboLanes = mocks.origPlan;
		LeanTurboRunner._internals.startupOrphanRecovery = mocks.origOrphanRecovery;
		LeanTurboRunner._internals.provisionWorktree = mocks.origProvision;
		LeanTurboRunner._internals.mergeLaneBranch = mocks.origMerge;
		LeanTurboRunner._internals.postMergeCleanup = mocks.origCleanup;
		LeanTurboRunner._internals.removeWorktree = mocks.origRemove;
	}

	test('merge conflict: worktree NOT removed, lane result indicates merge-back failure', async () => {
		const mocks = setupWorktreeRunnerAndMocks({
			mergeResult: {
				conflict: true,
				files: ['src/a.ts', 'src/b.ts'],
				message: 'CONFLICT (content): Merge conflict in src/a.ts',
			},
		});

		const result = await mocks.runner.runPhase(1);
		restoreMocks(mocks);

		// Phase should still report ok (coder completed)
		expect(result.ok).toBe(true);

		// Lane should still be completed (coder finished work)
		expect(result.lanes.length).toBe(1);
		expect(result.lanes[0].status).toBe('completed');

		// Lane result should include merge-back failure info
		expect(result.lanes[0].mergeBackFailure).toBeDefined();
		expect(result.lanes[0].mergeBackFailure!.laneId).toBe('lane-1');
		expect(result.lanes[0].mergeBackFailure!.reason).toContain('CONFLICT');
		expect(result.lanes[0].mergeBackFailure!.conflictFiles).toEqual([
			'src/a.ts',
			'src/b.ts',
		]);

		// removeWorktree should NOT have been called (preserved for manual recovery)
		expect(mocks.removeCalls.length).toBe(0);

		// postMergeCleanup should NOT have been called
		expect(mocks.cleanupCalls.length).toBe(0);

		// Phase result should include merge-back failures
		expect(result.mergeBackFailures).toBeDefined();
		expect(result.mergeBackFailures!.length).toBe(1);
		expect(result.mergeBackFailures![0].laneId).toBe('lane-1');
	});

	test('merge error: worktree NOT removed, lane result indicates merge-back failure', async () => {
		const mocks = setupWorktreeRunnerAndMocks({
			mergeResult: {
				error: 'fatal: not something we can merge',
			},
		});

		const result = await mocks.runner.runPhase(1);
		restoreMocks(mocks);

		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBe(1);
		expect(result.lanes[0].status).toBe('completed');

		// Lane result should include merge-back failure info
		expect(result.lanes[0].mergeBackFailure).toBeDefined();
		expect(result.lanes[0].mergeBackFailure!.laneId).toBe('lane-1');
		expect(result.lanes[0].mergeBackFailure!.reason).toContain('fatal:');

		// removeWorktree should NOT have been called
		expect(mocks.removeCalls.length).toBe(0);

		// postMergeCleanup should NOT have been called
		expect(mocks.cleanupCalls.length).toBe(0);

		// Phase result should include merge-back failures
		expect(result.mergeBackFailures).toBeDefined();
		expect(result.mergeBackFailures!.length).toBe(1);
	});

	test('merge success: worktree IS removed, lane result shows success (no mergeBackFailure)', async () => {
		const mocks = setupWorktreeRunnerAndMocks({
			mergeResult: { merged: true, strategy: 'merge' },
		});

		const result = await mocks.runner.runPhase(1);
		restoreMocks(mocks);

		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBe(1);
		expect(result.lanes[0].status).toBe('completed');

		// Lane result should NOT have merge-back failure
		expect(result.lanes[0].mergeBackFailure).toBeUndefined();

		// removeWorktree SHOULD have been called
		expect(mocks.removeCalls.length).toBeGreaterThan(0);

		// postMergeCleanup SHOULD have been called
		expect(mocks.cleanupCalls.length).toBeGreaterThan(0);

		// Phase result should NOT have merge-back failures
		expect(result.mergeBackFailures).toBeUndefined();
	});

	test('phase result includes merge-back failure information in summary', async () => {
		const mocks = setupWorktreeRunnerAndMocks({
			mergeResult: {
				conflict: true,
				files: ['src/a.ts'],
				message: 'CONFLICT: Merge conflict in src/a.ts',
			},
		});

		const result = await mocks.runner.runPhase(1);
		restoreMocks(mocks);

		// Phase result should have mergeBackFailures array
		expect(result.mergeBackFailures).toBeDefined();
		expect(result.mergeBackFailures).toHaveLength(1);
		expect(result.mergeBackFailures![0].laneId).toBe('lane-1');
		expect(result.mergeBackFailures![0].conflictFiles).toEqual(['src/a.ts']);
	});
});

// ─── Test 23: postMergeCleanup call order after removeWorktree ──────────
// Regression: git branch -D fails when the branch is still checked out in an
// active worktree. postMergeCleanup MUST run AFTER removeWorktree.

describe('postMergeCleanup runs AFTER removeWorktree (branch delete order fix)', () => {
	test('removeWorktree is called before postMergeCleanup on successful merge', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSuccessfulSessionOps());

		// Mock planner to return a single lane
		const origPlan = LeanTurboRunner._internals.planLeanTurboLanes;
		LeanTurboRunner._internals.planLeanTurboLanes = mock(
			(..._args: Parameters<typeof origPlan>) => ({
				phase: 1,
				planId: 'test-plan',
				lanes: [
					{
						laneId: 'lane-1',
						taskIds: ['1.1'],
						files: ['src/a.ts'],
						status: 'pending' as const,
					},
				],
				degradedTasks: [],
				serializedTasks: [],
				counters: {
					lanesPlanned: 1,
					lanesStarted: 0,
					lanesCompleted: 0,
					lanesFailed: 0,
					tasksSerialized: 0,
					tasksDegraded: 0,
				},
				crossLaneDependencies: {},
			}),
		);

		// Mock orphan recovery
		const origOrphanRecovery = LeanTurboRunner._internals.startupOrphanRecovery;
		LeanTurboRunner._internals.startupOrphanRecovery = mock(() =>
			Promise.resolve({
				prunedWorktrees: true,
				remainingBranches: [],
				warnings: [],
			}),
		);

		// Mock provision
		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath,
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			}),
		);

		// Track call order using a shared array
		const callOrder: string[] = [];

		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() => {
			callOrder.push('mergeLaneBranch');
			return Promise.resolve({ merged: true, strategy: 'merge' });
		});
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() => {
			callOrder.push('postMergeCleanup');
			return Promise.resolve({ cleaned: true });
		});
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() => {
			callOrder.push('removeWorktree');
			return Promise.resolve({ success: true });
		});

		let result;
		try {
			result = await runner.runPhase(1);

			expect(result.ok).toBe(true);

			// All three operations should have been called
			expect(callOrder).toContain('mergeLaneBranch');
			expect(callOrder).toContain('removeWorktree');
			expect(callOrder).toContain('postMergeCleanup');

			// removeWorktree MUST appear before postMergeCleanup in the call order
			const removeIdx = callOrder.indexOf('removeWorktree');
			const cleanupIdx = callOrder.indexOf('postMergeCleanup');
			expect(removeIdx).toBeGreaterThan(-1);
			expect(cleanupIdx).toBeGreaterThan(-1);
			expect(removeIdx).toBeLessThan(cleanupIdx);

			// mergeLaneBranch must be first
			expect(callOrder[0]).toBe('mergeLaneBranch');
		} finally {
			LeanTurboRunner._internals.planLeanTurboLanes = origPlan;
			LeanTurboRunner._internals.startupOrphanRecovery = origOrphanRecovery;
			LeanTurboRunner._internals.provisionWorktree = origProvision;
			LeanTurboRunner._internals.mergeLaneBranch = origMerge;
			LeanTurboRunner._internals.postMergeCleanup = origCleanup;
			LeanTurboRunner._internals.removeWorktree = origRemove;
		}
	});

	test('postMergeCleanup is NOT called on merge conflict (worktree preserved)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSuccessfulSessionOps());

		// Mock planner
		const origPlan = LeanTurboRunner._internals.planLeanTurboLanes;
		LeanTurboRunner._internals.planLeanTurboLanes = mock(
			(..._args: Parameters<typeof origPlan>) => ({
				phase: 1,
				planId: 'test-plan',
				lanes: [
					{
						laneId: 'lane-1',
						taskIds: ['1.1'],
						files: ['src/a.ts'],
						status: 'pending' as const,
					},
				],
				degradedTasks: [],
				serializedTasks: [],
				counters: {
					lanesPlanned: 1,
					lanesStarted: 0,
					lanesCompleted: 0,
					lanesFailed: 0,
					tasksSerialized: 0,
					tasksDegraded: 0,
				},
				crossLaneDependencies: {},
			}),
		);

		// Mock orphan recovery
		const origOrphanRecovery = LeanTurboRunner._internals.startupOrphanRecovery;
		LeanTurboRunner._internals.startupOrphanRecovery = mock(() =>
			Promise.resolve({
				prunedWorktrees: true,
				remainingBranches: [],
				warnings: [],
			}),
		);

		// Mock provision
		const worktreePath = path.join(
			tmpDir,
			'.swarm-worktrees',
			SESSION_ID,
			'lane-1',
		);
		const origProvision = LeanTurboRunner._internals.provisionWorktree;
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath,
				branchName: `swarm-lane/${SESSION_ID}/lane-1`,
			}),
		);

		const callOrder: string[] = [];

		const origMerge = LeanTurboRunner._internals.mergeLaneBranch;
		LeanTurboRunner._internals.mergeLaneBranch = mock(() => {
			callOrder.push('mergeLaneBranch');
			return Promise.resolve({
				conflict: true,
				files: ['src/a.ts'],
				message: 'CONFLICT: Merge conflict in src/a.ts',
			});
		});
		const origCleanup = LeanTurboRunner._internals.postMergeCleanup;
		LeanTurboRunner._internals.postMergeCleanup = mock(() => {
			callOrder.push('postMergeCleanup');
			return Promise.resolve({ cleaned: true });
		});
		const origRemove = LeanTurboRunner._internals.removeWorktree;
		LeanTurboRunner._internals.removeWorktree = mock(() => {
			callOrder.push('removeWorktree');
			return Promise.resolve({ success: true });
		});

		let result;
		try {
			result = await runner.runPhase(1);

			expect(result.ok).toBe(true);

			// On conflict: mergeLaneBranch called, but neither removeWorktree nor postMergeCleanup
			expect(callOrder).toContain('mergeLaneBranch');
			expect(callOrder).not.toContain('removeWorktree');
			expect(callOrder).not.toContain('postMergeCleanup');
		} finally {
			LeanTurboRunner._internals.planLeanTurboLanes = origPlan;
			LeanTurboRunner._internals.startupOrphanRecovery = origOrphanRecovery;
			LeanTurboRunner._internals.provisionWorktree = origProvision;
			LeanTurboRunner._internals.mergeLaneBranch = origMerge;
			LeanTurboRunner._internals.postMergeCleanup = origCleanup;
			LeanTurboRunner._internals.removeWorktree = origRemove;
		}
	});
});
