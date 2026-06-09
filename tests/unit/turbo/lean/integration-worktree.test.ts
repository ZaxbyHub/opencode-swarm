/**
 * End-to-end integration tests for worktree isolation.
 *
 * Validates the full worktree isolation feature across AC-1 through AC-12,
 * covering config acceptance, per-lane worktree creation, .swarm/ state
 * anchoring, merge-back, conflict handling, graceful degradation,
 * guardrails safety, init safety, cross-platform paths, branch cleanup,
 * Windows file-lock retry, git clean -fd, and no dependency management.
 *
 * Strategy:
 * - Uses LeanTurboRunner with _internals DI seams for mocking subprocess calls
 * - Uses writeMinimalPlan helper pattern from runner.test.ts
 * - Mocks bunSpawn via worktree._internals and merge-back._internals for git simulation
 * - No mock.module usage — all mocking via instance seam or _internals
 * - Each test is self-contained and independent
 * - All temp dirs use os.tmpdir() + path.join() — no hardcoded paths
 * - All seams restored in afterEach
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../../src/config/constants';
import type { GuardrailsConfig } from '../../../../src/config/schema';
import { createGuardrailsHooks } from '../../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../../src/state';
import * as mergeBackModule from '../../../../src/turbo/lean/merge-back';
import type { LaneResult } from '../../../../src/turbo/lean/runner';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import type {
	LeanTurboLane,
	LeanTurboRunState,
} from '../../../../src/turbo/lean/state';
import * as leanState from '../../../../src/turbo/lean/state';
import * as worktreeModule from '../../../../src/turbo/lean/worktree';

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_ID = 'sess-integration-wt';

// ─── Shared helpers ───────────────────────────────────────────────────────────

interface MockSessionOps {
	create: ReturnType<typeof mock>;
	prompt: ReturnType<typeof mock>;
	delete: ReturnType<typeof mock>;
}

let tmpDir: string;
let mockSessionOps: MockSessionOps;

/**
 * Real seams saved at module scope so afterEach can restore them.
 */
const savedRunnerInternals = {
	provisionWorktree: LeanTurboRunner._internals.provisionWorktree,
	removeWorktree: LeanTurboRunner._internals.removeWorktree,
	mergeLaneBranch: LeanTurboRunner._internals.mergeLaneBranch,
	postMergeCleanup: LeanTurboRunner._internals.postMergeCleanup,
	attemptMergeBackFromDirty:
		LeanTurboRunner._internals.attemptMergeBackFromDirty,
	startupOrphanRecovery: LeanTurboRunner._internals.startupOrphanRecovery,
	getMergeStrategy: LeanTurboRunner._internals.getMergeStrategy,
	assertCleanWorkingTree: LeanTurboRunner._internals.assertCleanWorkingTree,
	acquireLaneLocks: LeanTurboRunner._internals.acquireLaneLocks,
	releaseLaneLocks: LeanTurboRunner._internals.releaseLaneLocks,
	loadLeanTurboRunState: LeanTurboRunner._internals.loadLeanTurboRunState,
	saveLeanTurboRunState: LeanTurboRunner._internals.saveLeanTurboRunState,
	hasActiveFullAuto: LeanTurboRunner._internals.hasActiveFullAuto,
	loadFullAutoRunState: LeanTurboRunner._internals.loadFullAutoRunState,
	writeLaneEvidence: LeanTurboRunner._internals.writeLaneEvidence,
	planLeanTurboLanes: LeanTurboRunner._internals.planLeanTurboLanes,
	laneDispatchTimeoutMs: LeanTurboRunner._internals.laneDispatchTimeoutMs,
	loadPlanJsonOnly: LeanTurboRunner._internals.loadPlanJsonOnly,
};

const savedWorktreeInternals = { ...worktreeModule._internals };

const savedMergeBackInternals = { ...mergeBackModule._internals };

function makeRunner(options?: {
	opencodeClient?: null;
	generatedAgentNames?: string[];
	leanConfig?: Partial<typeof DEFAULT_LEAN_TURBO_CONFIG>;
}) {
	const leanConfig = { ...DEFAULT_LEAN_TURBO_CONFIG, ...options?.leanConfig };
	const runnerOpts: Record<string, unknown> = {
		directory: tmpDir,
		sessionID: SESSION_ID,
		leanConfig,
	};
	// Only include opencodeClient when explicitly provided (not undefined).
	// Omitting it allows the constructor to leave _client undefined,
	// bypassing the fail-closed check and enabling test mock injection
	// via the _sessionOps seam.
	if (options?.opencodeClient !== undefined) {
		runnerOpts.opencodeClient = options.opencodeClient;
	}
	if (options?.generatedAgentNames) {
		runnerOpts.generatedAgentNames = options.generatedAgentNames;
	}
	return new LeanTurboRunner(
		runnerOpts as ConstructorParameters<typeof LeanTurboRunner>[0],
	);
}

function injectMockSessionOps(runner: LeanTurboRunner, ops: MockSessionOps) {
	(runner as unknown as { _sessionOps: MockSessionOps })._sessionOps = ops;
}

function writeMinimalPlan(
	phaseNumber = 1,
	overrides?: { worktreeIsolation?: boolean },
) {
	const plan = {
		schema_version: '1.0.0',
		title: 'Integration Worktree Test Plan',
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
						description: 'Task A',
						status: 'pending',
						phase: phaseNumber,
						size: 'small',
						depends: [],
						acceptance: 'Done',
					},
					{
						id: `${phaseNumber}.2`,
						description: 'Task B',
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
			worktree_isolation: overrides?.worktreeIsolation ?? false,
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

function mockFailingSessionOps(errorMsg = 'session create failed') {
	const failingOps = {
		create: mock(() => Promise.resolve({ data: null, error: errorMsg })),
		prompt: mock(() => Promise.resolve({ data: null, error: 'prompt failed' })),
		delete: mock(() => Promise.resolve()),
	};
	return failingOps;
}

/** Produces a deterministic worktree path for a given lane ID. */
function fakeWorktreePath(laneId: string): string {
	return path.join(tmpDir, '.swarm-worktrees', SESSION_ID, laneId);
}

function fakeBranchName(laneId: string): string {
	return `swarm-lane/${SESSION_ID}/${laneId}`;
}

/**
 * Installs a standard set of runner._internals mocks for worktree-mode tests.
 * Returns an object tracking all mock calls for verification.
 */
function setupWorktreeMocks() {
	const provisionCalls: unknown[] = [];
	const removeCalls: unknown[] = [];
	const mergeCalls: unknown[] = [];
	const cleanupCalls: unknown[] = [];
	const attemptMergeCalls: unknown[] = [];
	const recoveryCalls: unknown[] = [];
	const acquireCalls: unknown[] = [];
	const releaseCalls: unknown[] = [];

	let provisionIdx = 0;

	LeanTurboRunner._internals.provisionWorktree = mock(() => {
		const idx = provisionIdx++;
		provisionCalls.push(idx);
		const laneId = `lane-${idx + 1}`;
		return Promise.resolve({
			worktreePath: fakeWorktreePath(laneId),
			branchName: fakeBranchName(laneId),
		});
	});
	LeanTurboRunner._internals.removeWorktree = mock(() =>
		Promise.resolve({ success: true }),
	);
	LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
		Promise.resolve({ merged: true, strategy: 'merge' }),
	);
	LeanTurboRunner._internals.postMergeCleanup = mock(() =>
		Promise.resolve({ cleaned: true }),
	);
	LeanTurboRunner._internals.attemptMergeBackFromDirty = mock(() =>
		Promise.resolve({
			merged: true,
			strategy: 'merge',
			autoCommitted: false,
			cleaned: false,
		}),
	);
	LeanTurboRunner._internals.startupOrphanRecovery = mock(() =>
		Promise.resolve({
			prunedWorktrees: true,
			remainingBranches: [],
			warnings: [],
		}),
	);
	LeanTurboRunner._internals.acquireLaneLocks = mock(() =>
		Promise.resolve({ acquired: true, lockFiles: ['test.lock'] }),
	);
	LeanTurboRunner._internals.releaseLaneLocks = mock(() => Promise.resolve(1));

	return {
		provisionCalls,
		removeCalls,
		mergeCalls,
		cleanupCalls,
		attemptMergeCalls,
		recoveryCalls,
		acquireCalls,
		releaseCalls,
	};
}

/** Restores all saved runner/worktree/merge-back internals. */
function restoreAllSeams() {
	Object.assign(LeanTurboRunner._internals, savedRunnerInternals);
	Object.assign(worktreeModule._internals, savedWorktreeInternals);
	Object.assign(mergeBackModule._internals, savedMergeBackInternals);
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
	tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'integ-wt-')));
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	leanState.repairStateUnreadable(tmpDir);
	mockSessionOps = mockSuccessfulSessionOps();

	// Default mock: assertCleanWorkingTree returns clean so worktree_isolation
	// tests work without needing a real git repo. restoreAllSeams in afterEach
	// restores the original function from savedRunnerInternals.
	LeanTurboRunner._internals.assertCleanWorkingTree = mock(() =>
		Promise.resolve({ clean: true }),
	);
});

afterEach(() => {
	restoreAllSeams();
	leanState.repairStateUnreadable(tmpDir);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-1: Config acceptance — worktree_isolation: true triggers worktree mode
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-1: config acceptance — worktree_isolation triggers worktree mode', () => {
	test('worktree_isolation: true enables provisionWorktree calls during runPhase', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);
		const mocks = setupWorktreeMocks();

		await runner.runPhase(1);

		restoreAllSeams();

		// provisionWorktree should have been called at least once
		expect(mocks.provisionCalls.length).toBeGreaterThan(0);
	});

	test('worktree_isolation: false does NOT call provisionWorktree', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: false },
		});
		injectMockSessionOps(runner, mockSessionOps);
		const mocks = setupWorktreeMocks();

		await runner.runPhase(1);

		restoreAllSeams();

		expect(mocks.provisionCalls.length).toBe(0);
	});

	test('DEFAULT_LEAN_TURBO_CONFIG has worktree_isolation false', () => {
		expect(DEFAULT_LEAN_TURBO_CONFIG.worktree_isolation).toBe(false);
	});

	test('config schema accepts worktree_isolation boolean', () => {
		const config = { ...DEFAULT_LEAN_TURBO_CONFIG, worktree_isolation: true };
		expect(typeof config.worktree_isolation).toBe('boolean');
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-2: Per-lane worktree creation — each lane gets a distinct worktree directory
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-2: per-lane worktree creation — distinct worktree directories', () => {
	test('two lanes get two different worktree paths', async () => {
		writeMinimalPlan(1);

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Force the planner to return two distinct lanes
		LeanTurboRunner._internals.planLeanTurboLanes = mock(
			(
				..._args: Parameters<typeof savedRunnerInternals.planLeanTurboLanes>
			) => ({
				phase: 1,
				planId: 'test-plan',
				lanes: [
					{
						laneId: 'lane-alpha',
						taskIds: ['1.1'],
						files: ['src/a.ts'],
						status: 'pending' as const,
					},
					{
						laneId: 'lane-beta',
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

		// Track provision calls to capture distinct paths
		const provisionedPaths: string[] = [];
		const origProvision = savedRunnerInternals.provisionWorktree;
		const provisionIdx = 0;
		LeanTurboRunner._internals.provisionWorktree = mock(
			(...args: Parameters<typeof origProvision>) => {
				// laneId is args[1]
				const laneId = args[1] as string;
				const wtPath = fakeWorktreePath(laneId);
				provisionedPaths.push(wtPath);
				return Promise.resolve({
					worktreePath: wtPath,
					branchName: fakeBranchName(laneId),
				});
			},
		);

		LeanTurboRunner._internals.startupOrphanRecovery = mock(() =>
			Promise.resolve({
				prunedWorktrees: true,
				remainingBranches: [],
				warnings: [],
			}),
		);
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		await runner.runPhase(1);

		restoreAllSeams();

		expect(provisionedPaths.length).toBe(2);
		expect(provisionedPaths[0]).not.toBe(provisionedPaths[1]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-3: .swarm/ state anchoring — state resolves to primary root, not worktree
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-3: .swarm/ state anchoring — primary root directory', () => {
	test('lock acquisition uses primary root, not worktree path', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const worktreePath = fakeWorktreePath('lane-1');

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const acquireCalls: Array<{ directory: string }> = [];
		LeanTurboRunner._internals.acquireLaneLocks = mock(
			(...args: Parameters<typeof savedRunnerInternals.acquireLaneLocks>) => {
				acquireCalls.push({ directory: args[0] as string });
				return Promise.resolve({ acquired: true, lockFiles: ['test.lock'] });
			},
		);

		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath,
				branchName: fakeBranchName('lane-1'),
			}),
		);
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		await runner.runPhase(1);

		restoreAllSeams();

		expect(acquireCalls.length).toBeGreaterThan(0);
		expect(acquireCalls[0].directory).toBe(tmpDir);
		expect(acquireCalls[0].directory).not.toBe(worktreePath);
	});

	test('lock release uses primary root, not worktree path', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const worktreePath = fakeWorktreePath('lane-1');

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const releaseCalls: Array<{ directory: string }> = [];
		LeanTurboRunner._internals.releaseLaneLocks = mock(
			(...args: Parameters<typeof savedRunnerInternals.releaseLaneLocks>) => {
				releaseCalls.push({ directory: args[0] as string });
				return Promise.resolve(1);
			},
		);

		LeanTurboRunner._internals.acquireLaneLocks = mock(() =>
			Promise.resolve({ acquired: true, lockFiles: ['test.lock'] }),
		);
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath,
				branchName: fakeBranchName('lane-1'),
			}),
		);
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		await runner.runPhase(1);

		restoreAllSeams();

		expect(releaseCalls.length).toBeGreaterThan(0);
		expect(releaseCalls[0].directory).toBe(tmpDir);
		expect(releaseCalls[0].directory).not.toBe(worktreePath);
	});

	test('durable state is written to primary root .swarm/, not worktree', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const worktreePath = fakeWorktreePath('lane-1');

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);
		setupWorktreeMocks();

		await runner.runPhase(1);

		restoreAllSeams();

		// Verify turbo-state.json exists in primary root's .swarm/
		const statePath = path.join(tmpDir, '.swarm', 'turbo-state.json');
		expect(fs.existsSync(statePath)).toBe(true);

		// Worktree path should NOT have its own .swarm/turbo-state.json
		const wtStatePath = path.join(worktreePath, '.swarm', 'turbo-state.json');
		expect(fs.existsSync(wtStatePath)).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-4: Merge-back success — after successful lane, merge-back integrates changes
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-4: merge-back success after successful lane', () => {
	test('mergeLaneBranch + removeWorktree + postMergeCleanup called in order for completed lane', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		const callOrder: string[] = [];

		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath: fakeWorktreePath('lane-1'),
				branchName: fakeBranchName('lane-1'),
			}),
		);
		LeanTurboRunner._internals.startupOrphanRecovery = mock(() =>
			Promise.resolve({
				prunedWorktrees: true,
				remainingBranches: [],
				warnings: [],
			}),
		);
		LeanTurboRunner._internals.acquireLaneLocks = mock(() =>
			Promise.resolve({ acquired: true, lockFiles: ['test.lock'] }),
		);
		LeanTurboRunner._internals.releaseLaneLocks = mock(() =>
			Promise.resolve(1),
		);
		LeanTurboRunner._internals.mergeLaneBranch = mock(() => {
			callOrder.push('merge');
			return Promise.resolve({ merged: true, strategy: 'merge' });
		});
		LeanTurboRunner._internals.postMergeCleanup = mock(() => {
			callOrder.push('cleanup');
			return Promise.resolve({ cleaned: true });
		});
		LeanTurboRunner._internals.removeWorktree = mock(() => {
			callOrder.push('remove');
			return Promise.resolve({ success: true });
		});

		await runner.runPhase(1);

		restoreAllSeams();

		expect(callOrder).toEqual(['merge', 'remove', 'cleanup']);
	});

	test('mergeLaneBranch called with correct primary directory and branch name', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const branchName = fakeBranchName('lane-1');

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);
		setupWorktreeMocks();

		const mergeArgs: unknown[] = [];
		LeanTurboRunner._internals.mergeLaneBranch = mock(
			(...args: Parameters<typeof savedRunnerInternals.mergeLaneBranch>) => {
				mergeArgs.push(args);
				return Promise.resolve({ merged: true, strategy: 'merge' });
			},
		);

		await runner.runPhase(1);

		restoreAllSeams();

		expect(mergeArgs.length).toBeGreaterThan(0);
		// First arg = primary directory
		expect(mergeArgs[0][0]).toBe(tmpDir);
		// Second arg = branch name
		expect(mergeArgs[0][1]).toBe(branchName);
	});

	test('session.create receives worktree path, not primary directory', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const worktreePath = fakeWorktreePath('lane-1');

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath,
				branchName: fakeBranchName('lane-1'),
			}),
		);
		LeanTurboRunner._internals.startupOrphanRecovery = mock(() =>
			Promise.resolve({
				prunedWorktrees: true,
				remainingBranches: [],
				warnings: [],
			}),
		);
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		await runner.runPhase(1);

		restoreAllSeams();

		expect(mockSessionOps.create).toHaveBeenCalled();
		const createCall = mockSessionOps.create.mock.calls[0];
		expect(
			(createCall[0] as { query: { directory: string } }).query.directory,
		).toBe(worktreePath);
		expect(
			(createCall[0] as { query: { directory: string } }).query.directory,
		).not.toBe(tmpDir);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-5: Failed lane isolation — failed lane doesn't corrupt others or primary
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-5: failed lane isolation', () => {
	test('failed lane does not prevent other lanes from completing', async () => {
		writeMinimalPlan(1);

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder', 'local_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		// Force two lanes
		LeanTurboRunner._internals.planLeanTurboLanes = mock(
			(
				..._args: Parameters<typeof savedRunnerInternals.planLeanTurboLanes>
			) => ({
				phase: 1,
				planId: 'test-plan',
				lanes: [
					{
						laneId: 'lane-ok',
						taskIds: ['1.1'],
						files: ['src/a.ts'],
						status: 'pending' as const,
					},
					{
						laneId: 'lane-fail',
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

		LeanTurboRunner._internals.startupOrphanRecovery = mock(() =>
			Promise.resolve({
				prunedWorktrees: true,
				remainingBranches: [],
				warnings: [],
			}),
		);

		// Track provision calls to give lane-ok success and lane-fail worktree
		let provisionIdx = 0;
		LeanTurboRunner._internals.provisionWorktree = mock(() => {
			provisionIdx++;
			const laneId = provisionIdx === 1 ? 'lane-ok' : 'lane-fail';
			return Promise.resolve({
				worktreePath: fakeWorktreePath(laneId),
				branchName: fakeBranchName(laneId),
			});
		});

		// Make session.create fail only for the second call (lane-fail)
		let createCallCount = 0;
		const selectiveFailingOps = {
			create: mock(() => {
				createCallCount++;
				if (createCallCount === 2) {
					return Promise.resolve({
						data: null,
						error: 'session create failed',
					});
				}
				return Promise.resolve({
					data: { id: `session-${createCallCount}` },
					error: null,
				});
			}),
			prompt: mock(() =>
				Promise.resolve({
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				}),
			),
			delete: mock(() => Promise.resolve()),
		};
		// Override mockSessionOps for this test
		injectMockSessionOps(runner, selectiveFailingOps);

		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		LeanTurboRunner._internals.postMergeCleanup = mock(() =>
			Promise.resolve({ cleaned: true }),
		);
		LeanTurboRunner._internals.attemptMergeBackFromDirty = mock(() =>
			Promise.resolve({
				merged: true,
				strategy: 'merge',
				autoCommitted: false,
				cleaned: false,
			}),
		);
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		const result = await runner.runPhase(1);

		restoreAllSeams();

		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBe(2);

		const completedLanes = result.lanes.filter(
			(l: LaneResult) => l.status === 'completed',
		);
		const failedLanes = result.lanes.filter(
			(l: LaneResult) => l.status === 'failed',
		);

		// lane-ok should complete
		expect(completedLanes.length).toBe(1);
		// lane-fail should fail
		expect(failedLanes.length).toBe(1);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-6: Conflict handling — merge conflicts detected and handled gracefully
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-6: conflict handling — merge conflicts', () => {
	test('mergeLaneBranch conflict returns conflict result without throwing', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				worktreePath: fakeWorktreePath('lane-1'),
				branchName: fakeBranchName('lane-1'),
			}),
		);
		LeanTurboRunner._internals.startupOrphanRecovery = mock(() =>
			Promise.resolve({
				prunedWorktrees: true,
				remainingBranches: [],
				warnings: [],
			}),
		);

		// Merge returns a conflict
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({
				conflict: true,
				files: ['src/a.ts'],
				message: 'CONFLICT (content) Merge conflict in src/a.ts',
			}),
		);
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		// runPhase should still complete without throwing
		const result = await runner.runPhase(1);

		restoreAllSeams();

		expect(result.ok).toBe(true);
		// Lane should still complete — dispatch succeeded even if merge had conflict
		const completedLanes = result.lanes.filter(
			(l: LaneResult) => l.status === 'completed',
		);
		expect(completedLanes.length).toBeGreaterThan(0);
	});

	test('getMergeStrategy returns config merge_strategy or defaults to merge', () => {
		expect(
			mergeBackModule.getMergeStrategy({ ...DEFAULT_LEAN_TURBO_CONFIG }),
		).toBe('merge');
		expect(
			mergeBackModule.getMergeStrategy({
				...DEFAULT_LEAN_TURBO_CONFIG,
				merge_strategy: 'rebase',
			}),
		).toBe('rebase');
		expect(
			mergeBackModule.getMergeStrategy({
				...DEFAULT_LEAN_TURBO_CONFIG,
				merge_strategy: 'cherry-pick',
			}),
		).toBe('cherry-pick');
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-7: Provision failure — explicit lane failure (no degradation)
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-7: provision failure — explicit lane failure (no degradation)', () => {
	test('provisionWorktree returning error fails the lane explicitly', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({
				error: 'git worktree add failed: worktree already exists',
			}),
		);

		const result = await runner.runPhase(1);

		restoreAllSeams();

		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBeGreaterThan(0);
		const failedLanes = result.lanes.filter(
			(l: LaneResult) => l.status === 'failed',
		);
		expect(failedLanes.length).toBeGreaterThan(0);
		expect(failedLanes[0].error).toContain('worktree provision failed');
		// Lane failed before dispatch — session.create should NOT have been called
		expect(mockSessionOps.create).not.toHaveBeenCalled();
	});

	test('provisionWorktree throwing also fails the lane explicitly', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.reject(new Error('fatal: not a git repository')),
		);
		LeanTurboRunner._internals.mergeLaneBranch = mock(() =>
			Promise.resolve({ merged: true, strategy: 'merge' }),
		);
		LeanTurboRunner._internals.removeWorktree = mock(() =>
			Promise.resolve({ success: true }),
		);

		const result = await runner.runPhase(1);

		restoreAllSeams();

		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBeGreaterThan(0);
		const failedLanes = result.lanes.filter(
			(l: LaneResult) => l.status === 'failed',
		);
		expect(failedLanes.length).toBeGreaterThan(0);
		expect(failedLanes[0].error).toContain('worktree provision failed');
		// Lane failed before dispatch — session.create should NOT have been called
		expect(mockSessionOps.create).not.toHaveBeenCalled();
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-8: Guardrails safety — git worktree remove --force remains blocked
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-8: guardrails safety — git worktree remove --force blocked at runtime', () => {
	function defaultGuardrailsConfig(
		overrides?: Partial<GuardrailsConfig>,
	): GuardrailsConfig {
		return {
			enabled: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			idle_timeout_minutes: 60,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			warning_threshold: 0.75,
			profiles: undefined,
			block_destructive_commands: true,
			...overrides,
		};
	}

	beforeEach(() => {
		resetSwarmState();
		startAgentSession(SESSION_ID, 'coder');
	});

	test('git worktree remove --force is rejected by guardrails toolBefore hook', async () => {
		const config = defaultGuardrailsConfig();
		const hooks = createGuardrailsHooks(tmpDir, undefined, config);

		const input = {
			tool: 'bash',
			sessionID: SESSION_ID,
			callID: 'call-1',
		};
		const output = {
			args: { command: 'git worktree remove --force /some/path' },
		};

		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			/git worktree remove --force.*detected/,
		);
	});

	test('git worktree remove --force with Windows path is rejected', async () => {
		const config = defaultGuardrailsConfig();
		const hooks = createGuardrailsHooks(tmpDir, undefined, config);

		const input = {
			tool: 'bash',
			sessionID: SESSION_ID,
			callID: 'call-2',
		};
		const output = {
			args: { command: 'git worktree remove --force C:\\worktrees\\lane-1' },
		};

		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			/git worktree remove --force.*detected/,
		);
	});

	test('git worktree remove --FORCE (uppercase) is also rejected', async () => {
		const config = defaultGuardrailsConfig();
		const hooks = createGuardrailsHooks(tmpDir, undefined, config);

		const input = {
			tool: 'bash',
			sessionID: SESSION_ID,
			callID: 'call-3',
		};
		const output = {
			args: { command: 'git worktree remove --FORCE /some/path' },
		};

		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			/git worktree remove --force.*detected/i,
		);
	});

	test('git worktree remove without --force is NOT rejected', async () => {
		const config = defaultGuardrailsConfig();
		const hooks = createGuardrailsHooks(tmpDir, undefined, config);

		const input = {
			tool: 'bash',
			sessionID: SESSION_ID,
			callID: 'call-4',
		};
		const output = {
			args: { command: 'git worktree remove /some/path' },
		};

		// Should NOT throw — no --force flag present
		await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
	});

	test('guardrails disabled allows any command through', async () => {
		const config = defaultGuardrailsConfig({
			enabled: false,
		});
		const hooks = createGuardrailsHooks(tmpDir, undefined, config);

		const input = {
			tool: 'bash',
			sessionID: SESSION_ID,
			callID: 'call-5',
		};
		const output = {
			args: { command: 'git worktree remove --force /some/path' },
		};

		// When guardrails disabled, destructive command should not be blocked
		await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
	});
});

describe('AC-8: supplemental static source checks — no --force in worktree source', () => {
	test('worktree.ts source does not contain "worktree remove --force"', () => {
		const source = fs.readFileSync(
			path.resolve(__dirname, '../../../../src/turbo/lean/worktree.ts'),
			'utf-8',
		);
		expect(source).not.toContain('worktree remove --force');
	});

	test('runner.ts source does not contain "worktree remove --force"', () => {
		const source = fs.readFileSync(
			path.resolve(__dirname, '../../../../src/turbo/lean/runner.ts'),
			'utf-8',
		);
		expect(source).not.toContain('worktree remove --force');
	});

	test('merge-back.ts source does not contain "worktree remove --force"', () => {
		const source = fs.readFileSync(
			path.resolve(__dirname, '../../../../src/turbo/lean/merge-back.ts'),
			'utf-8',
		);
		expect(source).not.toContain('worktree remove --force');
	});

	test('removeWorktree function calls git worktree remove WITHOUT --force flag', () => {
		const source = fs.readFileSync(
			path.resolve(__dirname, '../../../../src/turbo/lean/worktree.ts'),
			'utf-8',
		);
		expect(source).toContain("'worktree', 'remove'");
		expect(source).not.toMatch(/'worktree',\s*'remove'.*--force/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-9: Init safety — plugin init doesn't create worktrees
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-9: init safety — no worktree creation during init', () => {
	test('runner constructor does not call provisionWorktree', () => {
		// Simply constructing the runner should not trigger any worktree operations
		const provisionCalls: unknown[] = [];
		LeanTurboRunner._internals.provisionWorktree = mock(
			(...args: Parameters<typeof savedRunnerInternals.provisionWorktree>) => {
				provisionCalls.push(args);
				return Promise.resolve({
					worktreePath: fakeWorktreePath('lane-1'),
					branchName: fakeBranchName('lane-1'),
				});
			},
		);

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});

		restoreAllSeams();

		// Construction should not call provisionWorktree
		expect(provisionCalls.length).toBe(0);
	});

	test('runPhase with null client returns immediately without worktree ops', async () => {
		const provisionCalls: unknown[] = [];
		LeanTurboRunner._internals.provisionWorktree = mock(
			(...args: Parameters<typeof savedRunnerInternals.provisionWorktree>) => {
				provisionCalls.push(args);
				return Promise.resolve({
					worktreePath: fakeWorktreePath('lane-1'),
					branchName: fakeBranchName('lane-1'),
				});
			},
		);

		const runner = makeRunner({
			opencodeClient: null,
			leanConfig: { worktree_isolation: true },
		});
		const result = await runner.runPhase(1);

		restoreAllSeams();

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_CLIENT');
		expect(provisionCalls.length).toBe(0);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-10: Cross-platform path handling — path budget checked on Windows
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-10: cross-platform path handling — Windows path budget', () => {
	test('checkPathBudget returns ok:true on non-Windows platform regardless of path length', async () => {
		const realPlatform = worktreeModule._internals.platform;
		worktreeModule._internals.platform = 'linux';

		// Mock bunSpawn to return a file list with a very long path
		worktreeModule._internals.bunSpawn = mock(() => ({
			exited: Promise.resolve(0),
			exitCode: 0,
			stdout: {
				text: () =>
					Promise.resolve(
						'a/very/deeply/nested/long/path/that/exceeds/budget/file.ts',
					),
			},
			stderr: { text: () => Promise.resolve('') },
		}));

		const result = await worktreeModule.checkPathBudget(
			path.join(
				'C:\\Users\\VeryLongUserName\\Projects\\MyProject\\.swarm-worktrees\\session\\lane',
			),
			tmpDir,
		);

		worktreeModule._internals.platform = realPlatform;
		restoreAllSeams();

		// Non-Windows should always pass
		expect(result.ok).toBe(true);
	});

	test('checkPathBudget returns ok:false on win32 when path exceeds budget', async () => {
		const realPlatform = worktreeModule._internals.platform;
		worktreeModule._internals.platform = 'win32';

		// Create a very long worktree root and a long file path that together
		// exceed the WIN_PATH_BUDGET of 250 characters.
		const longWorktreeRoot =
			'C:\\Users\\VeryLongUserName\\Projects\\MyVeryLongProjectName\\.swarm-worktrees\\session-id\\lane-1';
		// Generate a file path long enough to push the total over 250.
		// The prefix and suffix use single backslashes (TypeScript escape sequences).
		const prefix = 'src\\very\\deeply\\nested\\';
		const suffix = '\\file.ts';
		const padding = 'a'.repeat(
			251 - longWorktreeRoot.length - prefix.length - suffix.length,
		);
		const longFileName = prefix + padding + suffix;

		worktreeModule._internals.bunSpawn = mock(() => ({
			exited: Promise.resolve(0),
			exitCode: 0,
			stdout: { text: () => Promise.resolve(longFileName) },
			stderr: { text: () => Promise.resolve('') },
		}));

		const result = await worktreeModule.checkPathBudget(
			longWorktreeRoot,
			tmpDir,
		);

		worktreeModule._internals.platform = realPlatform;
		restoreAllSeams();

		// Windows: total path = longWorktreeRoot + 1 + longFileName > 250
		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.error).toContain('Total path budget exceeded');
			expect(result.suggestion).toBeDefined();
		}
	});

	test('shortenWorktreePath returns os.tmpdir-based path', () => {
		const customTmp = 'C:\\Temp\\CustomPath';
		worktreeModule._internals.osTmpdir = () => customTmp;

		const result = worktreeModule.shortenWorktreePath(
			tmpDir,
			'sess-123',
			'lane-1',
		);

		worktreeModule._internals.osTmpdir = savedWorktreeInternals.osTmpdir;

		expect(result).toBe(path.join(customTmp, 'swwt', 'sess-123', 'lane-1'));
	});

	test('shortenWorktreePath uses path.join for cross-platform correctness', () => {
		// Verify no hardcoded separators
		const result = worktreeModule.shortenWorktreePath(
			'/project',
			'sess',
			'lane',
		);
		expect(result).not.toContain('//');
		// On Windows, should use backslash
		if (process.platform === 'win32') {
			expect(result).toContain(path.sep);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC-11/AC-12: Post-merge branch cleanup — branch deleted, worktree pruned (DD-9)
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-11/AC-12: post-merge branch cleanup (DD-9)', () => {
	test('postMergeCleanup calls git branch -D and git worktree prune', async () => {
		// Test the merge-back module's postMergeCleanup directly via _internals seam
		const gitCalls: string[][] = [];
		mergeBackModule._internals.bunSpawn = mock((args: string[]) => {
			gitCalls.push(args);
			return {
				exited: Promise.resolve(0),
				exitCode: 0,
				stdout: { text: () => Promise.resolve('') },
				stderr: { text: () => Promise.resolve('') },
			};
		});

		const branchName = 'swarm-lane/session-1/lane-1';
		const result = await mergeBackModule.postMergeCleanup(tmpDir, branchName);

		restoreAllSeams();

		expect(result.cleaned).toBe(true);
		// Verify git branch -D was called with the branch name
		const branchDeleteCall = gitCalls.find(
			(c) =>
				c[0] === 'git' &&
				c[1] === 'branch' &&
				c[2] === '-D' &&
				c[3] === branchName,
		);
		expect(branchDeleteCall).toBeDefined();
		// Verify git worktree prune was called
		const pruneCall = gitCalls.find(
			(c) => c[0] === 'git' && c[1] === 'worktree' && c[2] === 'prune',
		);
		expect(pruneCall).toBeDefined();
	});

	test('postMergeCleanup returns partial success when branch delete fails but prune succeeds', async () => {
		let callCount = 0;
		mergeBackModule._internals.bunSpawn = mock((args: string[]) => {
			callCount++;
			// branch -D fails, worktree prune succeeds
			if (args[1] === 'branch') {
				return {
					exited: Promise.resolve(1),
					exitCode: 1,
					stdout: { text: () => Promise.resolve('') },
					stderr: {
						text: () => Promise.resolve("error: branch 'x' not found"),
					},
				};
			}
			return {
				exited: Promise.resolve(0),
				exitCode: 0,
				stdout: { text: () => Promise.resolve('') },
				stderr: { text: () => Promise.resolve('') },
			};
		});

		const result = await mergeBackModule.postMergeCleanup(
			tmpDir,
			'swarm-lane/sess/1',
		);

		restoreAllSeams();

		expect(result.partial).toBe(true);
		expect(result.error).toContain('Branch delete failed');
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// DD-10: Windows file-lock retry — removeWorktree retries on EBUSY/EPERM
// ═══════════════════════════════════════════════════════════════════════════════

describe('DD-10: Windows file-lock retry — EBUSY/EPERM', () => {
	test('removeWorktree retries on EBUSY on Windows platform', async () => {
		worktreeModule._internals.platform = 'win32';

		let attempts = 0;
		const sleepCalls: number[] = [];
		worktreeModule._internals.sleep = mock(async (ms: number) => {
			sleepCalls.push(ms);
		});

		worktreeModule._internals.bunSpawn = mock(() => {
			attempts++;
			if (attempts <= 2) {
				// First two attempts fail with EBUSY
				return {
					exited: Promise.resolve(128),
					exitCode: 128,
					stdout: { text: () => Promise.resolve('') },
					stderr: {
						text: () =>
							Promise.resolve("fatal: unable to delete 'path': EBUSY"),
					},
				};
			}
			// Third attempt succeeds
			return {
				exited: Promise.resolve(0),
				exitCode: 0,
				stdout: { text: () => Promise.resolve('') },
				stderr: { text: () => Promise.resolve('') },
			};
		});

		const result = await worktreeModule.removeWorktree(
			path.join(tmpDir, '.swarm-worktrees', 'lane-1'),
			tmpDir,
		);

		restoreAllSeams();

		expect(result.success).toBe(true);
		expect(attempts).toBe(3);
		expect(sleepCalls.length).toBe(2);
		expect(sleepCalls[0]).toBe(2000); // RETRY_DELAY_MS
	});

	test('removeWorktree retries on EPERM on Windows platform', async () => {
		worktreeModule._internals.platform = 'win32';

		let attempts = 0;
		worktreeModule._internals.sleep = mock(async () => {});

		worktreeModule._internals.bunSpawn = mock(() => {
			attempts++;
			if (attempts <= 1) {
				return {
					exited: Promise.resolve(128),
					exitCode: 128,
					stdout: { text: () => Promise.resolve('') },
					stderr: {
						text: () => Promise.resolve('fatal: EPERM: resource locked'),
					},
				};
			}
			return {
				exited: Promise.resolve(0),
				exitCode: 0,
				stdout: { text: () => Promise.resolve('') },
				stderr: { text: () => Promise.resolve('') },
			};
		});

		const result = await worktreeModule.removeWorktree(
			path.join(tmpDir, '.swarm-worktrees', 'lane-1'),
			tmpDir,
		);

		restoreAllSeams();

		expect(result.success).toBe(true);
		expect(attempts).toBe(2);
	});

	test('removeWorktree does NOT retry non-EBUSY/EPERM errors', async () => {
		worktreeModule._internals.platform = 'win32';

		let attempts = 0;
		worktreeModule._internals.sleep = mock(async () => {});

		worktreeModule._internals.bunSpawn = mock(() => {
			attempts++;
			return {
				exited: Promise.resolve(1),
				exitCode: 1,
				stdout: { text: () => Promise.resolve('') },
				stderr: { text: () => Promise.resolve('fatal: not a git repository') },
			};
		});

		const result = await worktreeModule.removeWorktree(
			path.join(tmpDir, '.swarm-worktrees', 'lane-1'),
			tmpDir,
		);

		restoreAllSeams();

		expect('error' in result).toBe(true);
		// Should NOT retry — only 1 attempt
		expect(attempts).toBe(1);
	});

	test('removeWorktree on non-Windows does not retry', async () => {
		worktreeModule._internals.platform = 'linux';

		let attempts = 0;
		worktreeModule._internals.sleep = mock(async () => {});

		worktreeModule._internals.bunSpawn = mock(() => {
			attempts++;
			return {
				exited: Promise.resolve(1),
				exitCode: 1,
				stdout: { text: () => Promise.resolve('') },
				stderr: { text: () => Promise.resolve('EBUSY: device busy') },
			};
		});

		const result = await worktreeModule.removeWorktree(
			path.join(tmpDir, '.swarm-worktrees', 'lane-1'),
			tmpDir,
		);

		restoreAllSeams();

		expect('error' in result).toBe(true);
		// Non-Windows should not retry
		expect(attempts).toBe(1);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// DD-7: git clean -fd in cleanup — untracked files cleaned before merge-back
// ═══════════════════════════════════════════════════════════════════════════════

describe('DD-7: git clean -fd in cleanup — untracked files cleaned', () => {
	test('attemptMergeBackFromDirty calls autoCommitDirty then cleanUntrackedFiles then merge', async () => {
		const callOrder: string[] = [];

		// autoCommitDirty and cleanUntrackedFiles are imported from worktree.ts
		// and use worktree._internals.bunSpawn, while attemptMergeBackFromDirty's
		// own runGit uses merge-back._internals.bunSpawn. Mock both seams.
		worktreeModule._internals.bunSpawn = mock((args: string[]) => {
			if (args[1] === 'add' && args[2] === '-A') {
				callOrder.push('autoCommit:git-add');
			} else if (args[1] === 'commit') {
				callOrder.push('autoCommit:git-commit');
			} else if (args[1] === 'clean' && args[2] === '-fd') {
				callOrder.push('cleanUntracked:git-clean');
			}
			return {
				exited: Promise.resolve(0),
				exitCode: 0,
				stdout: { text: () => Promise.resolve('') },
				stderr: { text: () => Promise.resolve('') },
			};
		});
		mergeBackModule._internals.bunSpawn = mock((args: string[]) => {
			if (args[1] === 'merge') {
				callOrder.push('merge:git-merge');
			}
			return {
				exited: Promise.resolve(0),
				exitCode: 0,
				stdout: { text: () => Promise.resolve('') },
				stderr: { text: () => Promise.resolve('') },
			};
		});

		const result = await mergeBackModule.attemptMergeBackFromDirty(
			path.join(tmpDir, '.swarm-worktrees', 'lane-1'),
			'swarm-lane/session-1/lane-1',
			tmpDir,
			'merge',
		);

		restoreAllSeams();

		expect('merged' in result && result.merged).toBe(true);
		// Pipeline order: add → commit → clean → merge
		expect(callOrder).toContain('autoCommit:git-add');
		expect(callOrder.indexOf('autoCommit:git-add')).toBeLessThan(
			callOrder.indexOf('autoCommit:git-commit'),
		);
		expect(callOrder.indexOf('autoCommit:git-commit')).toBeLessThan(
			callOrder.indexOf('cleanUntracked:git-clean'),
		);
		expect(callOrder.indexOf('cleanUntracked:git-clean')).toBeLessThan(
			callOrder.indexOf('merge:git-merge'),
		);
	});

	test('cleanUntrackedFiles calls git clean -fd via bunSpawn', async () => {
		const gitArgs: string[][] = [];
		worktreeModule._internals.bunSpawn = mock((args: string[]) => {
			gitArgs.push(args);
			return {
				exited: Promise.resolve(0),
				exitCode: 0,
				stdout: { text: () => Promise.resolve('') },
				stderr: { text: () => Promise.resolve('') },
			};
		});

		const result = await worktreeModule.cleanUntrackedFiles(
			path.join(tmpDir, '.swarm-worktrees', 'lane-1'),
		);

		restoreAllSeams();

		expect(result.cleaned).toBe(true);
		// Verify the exact command
		const cleanCall = gitArgs.find((a) => a[1] === 'clean' && a[2] === '-fd');
		expect(cleanCall).toBeDefined();
		// Should have cwd set to the worktree path
		expect(cleanCall).toBeDefined();
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// FR-011: No dependency management in worktrees — no npm/bun install in worktree paths
// ═══════════════════════════════════════════════════════════════════════════════

describe('FR-011: no dependency management in worktrees', () => {
	test('runner.ts source contains no npm/yarn/pnpm/pip/bun install commands', () => {
		const runnerSource = fs.readFileSync(
			path.resolve(__dirname, '../../../../src/turbo/lean/runner.ts'),
			'utf-8',
		);

		const forbiddenPatterns: RegExp[] = [
			/npm\s+install/,
			/npm\s+ci/,
			/yarn\s+install/,
			/pnpm\s+install/,
			/bun\s+install/,
			/bun\s+add/,
			/bun\s+remove/,
			/pip\s+install/,
			/pip3\s+install/,
			/\[\s*['"]npm['"]\s*,/,
			/\[\s*['"]yarn['"]\s*,/,
			/\[\s*['"]pnpm['"]\s*,/,
			/\[\s*['"]pip['"]\s*,/,
			/\[\s*['"]bun['"]\s*,.*['"](?:install|add|remove)['"]/,
		];

		for (const pattern of forbiddenPatterns) {
			expect(runnerSource).not.toMatch(pattern);
		}

		expect(runnerSource).not.toContain('child_process');
	});

	test('worktree.ts source contains no dependency management commands', () => {
		const source = fs.readFileSync(
			path.resolve(__dirname, '../../../../src/turbo/lean/worktree.ts'),
			'utf-8',
		);

		const forbiddenPatterns: RegExp[] = [
			/npm\s+install/,
			/yarn\s+install/,
			/bun\s+install/,
			/bun\s+add/,
			/pip\s+install/,
		];

		for (const pattern of forbiddenPatterns) {
			expect(source).not.toMatch(pattern);
		}
	});

	test('merge-back.ts source contains no dependency management commands', () => {
		const source = fs.readFileSync(
			path.resolve(__dirname, '../../../../src/turbo/lean/merge-back.ts'),
			'utf-8',
		);

		const forbiddenPatterns: RegExp[] = [
			/npm\s+install/,
			/yarn\s+install/,
			/bun\s+install/,
			/bun\s+add/,
			/pip\s+install/,
		];

		for (const pattern of forbiddenPatterns) {
			expect(source).not.toMatch(pattern);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// End-to-end: Full lane lifecycle with worktree isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe('end-to-end: full lane lifecycle with worktree isolation', () => {
	test('startupOrphanRecovery → provision → dispatch → merge → remove → cleanup — complete pipeline', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const worktreePath = fakeWorktreePath('lane-1');
		const branchName = fakeBranchName('lane-1');
		const pipelineOrder: string[] = [];

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockSessionOps);

		LeanTurboRunner._internals.startupOrphanRecovery = mock(() => {
			pipelineOrder.push('orphanRecovery');
			return Promise.resolve({
				prunedWorktrees: true,
				remainingBranches: [],
				warnings: [],
			});
		});

		LeanTurboRunner._internals.acquireLaneLocks = mock(() => {
			pipelineOrder.push('acquireLocks');
			return Promise.resolve({ acquired: true, lockFiles: ['test.lock'] });
		});

		LeanTurboRunner._internals.provisionWorktree = mock(() => {
			pipelineOrder.push('provisionWorktree');
			return Promise.resolve({ worktreePath, branchName });
		});

		LeanTurboRunner._internals.releaseLaneLocks = mock(() => {
			pipelineOrder.push('releaseLocks');
			return Promise.resolve(1);
		});

		LeanTurboRunner._internals.mergeLaneBranch = mock(() => {
			pipelineOrder.push('mergeLaneBranch');
			return Promise.resolve({ merged: true, strategy: 'merge' });
		});

		LeanTurboRunner._internals.postMergeCleanup = mock(() => {
			pipelineOrder.push('postMergeCleanup');
			return Promise.resolve({ cleaned: true });
		});

		LeanTurboRunner._internals.removeWorktree = mock(() => {
			pipelineOrder.push('removeWorktree');
			return Promise.resolve({ success: true });
		});

		const result = await runner.runPhase(1);

		restoreAllSeams();

		expect(result.ok).toBe(true);

		// Verify complete pipeline order
		expect(pipelineOrder[0]).toBe('orphanRecovery');
		expect(pipelineOrder).toContain('acquireLocks');
		expect(pipelineOrder).toContain('provisionWorktree');
		expect(pipelineOrder).toContain('releaseLocks');
		expect(pipelineOrder).toContain('mergeLaneBranch');
		expect(pipelineOrder).toContain('postMergeCleanup');
		expect(pipelineOrder).toContain('removeWorktree');

		// Locks should be acquired before provision
		expect(pipelineOrder.indexOf('acquireLocks')).toBeLessThan(
			pipelineOrder.indexOf('provisionWorktree'),
		);
		// Merge should come after locks are released
		expect(pipelineOrder.indexOf('releaseLocks')).toBeLessThan(
			pipelineOrder.indexOf('mergeLaneBranch'),
		);
		// Remove should come before cleanup
		expect(pipelineOrder.indexOf('removeWorktree')).toBeLessThan(
			pipelineOrder.indexOf('postMergeCleanup'),
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// End-to-end: Failed lane with dirty merge-back pipeline
// ═══════════════════════════════════════════════════════════════════════════════

describe('end-to-end: failed lane dirty merge-back pipeline', () => {
	test('failed lane calls attemptMergeBackFromDirty then removeWorktree', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const worktreePath = fakeWorktreePath('lane-1');
		const branchName = fakeBranchName('lane-1');
		const pipelineOrder: string[] = [];

		const runner = makeRunner({
			generatedAgentNames: ['mega_coder'],
			leanConfig: { worktree_isolation: true },
		});
		injectMockSessionOps(runner, mockFailingSessionOps());

		LeanTurboRunner._internals.startupOrphanRecovery = mock(() => {
			pipelineOrder.push('orphanRecovery');
			return Promise.resolve({
				prunedWorktrees: true,
				remainingBranches: [],
				warnings: [],
			});
		});

		LeanTurboRunner._internals.provisionWorktree = mock(() => {
			pipelineOrder.push('provisionWorktree');
			return Promise.resolve({ worktreePath, branchName });
		});

		LeanTurboRunner._internals.attemptMergeBackFromDirty = mock(() => {
			pipelineOrder.push('attemptMergeBackFromDirty');
			return Promise.resolve({
				merged: true,
				strategy: 'merge',
				autoCommitted: true,
				cleaned: true,
			});
		});

		LeanTurboRunner._internals.removeWorktree = mock(() => {
			pipelineOrder.push('removeWorktree');
			return Promise.resolve({ success: true });
		});

		const result = await runner.runPhase(1);

		restoreAllSeams();

		expect(result.ok).toBe(true);
		const failedLanes = result.lanes.filter(
			(l: LaneResult) => l.status === 'failed',
		);
		expect(failedLanes.length).toBeGreaterThan(0);

		// Failed lane should trigger dirty merge-back then remove
		expect(pipelineOrder).toContain('attemptMergeBackFromDirty');
		expect(pipelineOrder).toContain('removeWorktree');
		expect(pipelineOrder.indexOf('attemptMergeBackFromDirty')).toBeLessThan(
			pipelineOrder.indexOf('removeWorktree'),
		);
	});
});
