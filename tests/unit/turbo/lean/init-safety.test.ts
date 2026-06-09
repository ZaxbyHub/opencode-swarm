/**
 * Init safety tests for worktree isolation (AGENTS.md invariant #1).
 *
 * Verifies two safety properties:
 *
 * 1. Plugin init does NOT create worktrees — the plugin entry (src/index.ts)
 *    must NOT call any worktree functions during registration. Startup orphan
 *    recovery runs at Lean Turbo runner init (runPhase), NOT at plugin init.
 *
 * 2. Startup orphan recovery runs at Lean Turbo runner init, not plugin init —
 *    `startupOrphanRecovery` is called during `runPhase` when worktree_isolation
 *    is enabled, and NOT during runner construction or other lifecycle points.
 *
 * Uses the _internals DI seam pattern — no mock.module() calls.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../../src/config/constants';
import OpenCodeSwarm from '../../../../src/index';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';

// ---------------------------------------------------------------------------
// Test directories
// ---------------------------------------------------------------------------

const TEST_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'init-safety-')));
const PLUGIN_INIT_DIR = realpathSync(
	mkdtempSync(join(tmpdir(), 'init-safety-plugin-')),
);

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	rmSync(PLUGIN_INIT_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test #1: Plugin init does not import or call worktree functions
// ---------------------------------------------------------------------------

describe('init safety: plugin entry does not call worktree functions', () => {
	test('src/index.ts default export has plugin shape { id, server }', () => {
		// Dynamic import to avoid executing module-level init code at
		// hoist time. The default export is the v1 plugin object.
		const plugin = require('../../../../src/index');
		const mod = plugin.default ?? plugin;

		expect(mod).toBeDefined();
		expect(typeof mod.id).toBe('string');
		expect(mod.id).toBe('opencode-swarm');
		expect(typeof mod.server).toBe('function');
	});

	test('src/index.ts does not import worktree or merge-back modules (static check)', () => {
		// Supplementary static analysis: read the source and verify no runtime
		// imports from worktree/merge-back at the plugin entry level.
		// The authoritative runtime check is the test below.
		const source = readFileSync(
			join(__dirname, '../../../../src/index.ts'),
			'utf-8',
		);

		// These import patterns would indicate a direct dependency
		const forbiddenImports = [
			/from ['"].*worktree/,
			/from ['"].*merge-back/,
			/provisionWorktree/,
			/startupOrphanRecovery/,
			/removeWorktree/,
		];

		for (const pattern of forbiddenImports) {
			const re = new RegExp(pattern);
			expect(source).not.toMatch(re);
		}
	});

	test('plugin server init with worktree_isolation=true does NOT invoke worktree functions (runtime)', async () => {
		// Authoritative runtime check: actually invoke the plugin server() with
		// a project config that enables lean_turbo.worktree_isolation, and verify
		// that provisionWorktree, removeWorktree, and startupOrphanRecovery are
		// NOT called during init. Uses LeanTurboRunner._internals DI seams.
		//
		// Set up a temp project with worktree_isolation enabled in config.
		mkdirSync(join(PLUGIN_INIT_DIR, '.opencode'), { recursive: true });
		mkdirSync(join(PLUGIN_INIT_DIR, '.swarm'), { recursive: true });

		const projectConfig = {
			turbo: {
				strategy: 'lean' as const,
				lean: {
					worktree_isolation: true,
				},
			},
			quiet: true,
		};
		writeFileSync(
			join(PLUGIN_INIT_DIR, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(projectConfig, null, 2),
			'utf-8',
		);

		// Install spies on the _internals seams BEFORE calling server()
		const realProvisionWorktree = LeanTurboRunner._internals.provisionWorktree;
		const realRemoveWorktree = LeanTurboRunner._internals.removeWorktree;
		const realStartupOrphanRecovery =
			LeanTurboRunner._internals.startupOrphanRecovery;

		const spyProvisionWorktree = mock(() =>
			Promise.resolve({ worktreePath: '/fake', branchName: 'fake' }),
		);
		const spyRemoveWorktree = mock(() => Promise.resolve({ success: true }));
		const spyStartupOrphanRecovery = mock(() =>
			Promise.resolve({
				pruned: 0,
				orphanedBranches: [],
				cleanedBranches: [],
				warnings: [],
			}),
		);

		LeanTurboRunner._internals.provisionWorktree = spyProvisionWorktree;
		LeanTurboRunner._internals.removeWorktree = spyRemoveWorktree;
		LeanTurboRunner._internals.startupOrphanRecovery = spyStartupOrphanRecovery;

		try {
			// Invoke the real plugin server initializer — this runs the full
			// init path including config loading, hook creation, tool
			// registration, etc. The mockPluginInput provides a minimal
			// context that satisfies the Plugin type shape.
			const mockPluginInput = {
				client: {} as Record<string, unknown>,
				project: {} as Record<string, unknown>,
				directory: PLUGIN_INIT_DIR,
				worktree: PLUGIN_INIT_DIR,
				serverUrl: new URL('http://localhost:3000'),
				$: {} as Record<string, unknown>,
			};

			const pluginResult = await OpenCodeSwarm.server(mockPluginInput);

			// Plugin server() must return the Hooks interface
			expect(pluginResult).toBeDefined();
			expect(typeof pluginResult.name).toBe('string');

			// ASSERT: No worktree functions were called during init
			expect(spyProvisionWorktree).not.toHaveBeenCalled();
			expect(spyRemoveWorktree).not.toHaveBeenCalled();
			expect(spyStartupOrphanRecovery).not.toHaveBeenCalled();
		} finally {
			// Restore real functions
			LeanTurboRunner._internals.provisionWorktree = realProvisionWorktree;
			LeanTurboRunner._internals.removeWorktree = realRemoveWorktree;
			LeanTurboRunner._internals.startupOrphanRecovery =
				realStartupOrphanRecovery;
		}
	});

	test('plugin registration does not trigger worktree creation or orphan recovery', () => {
		// The plugin entry is a synchronous module-level object. Importing it
		// must not trigger any async operations (git subprocesses, worktree
		// creation, orphan recovery). This is verified structurally: the
		// default export is a plain object, not an async function result.
		const plugin = require('../../../../src/index');
		const mod = plugin.default ?? plugin;

		// The plugin object is a plain object created at module parse time
		expect(typeof mod).toBe('object');
		expect(typeof mod.server).toBe('function');

		// The server function is async (wraps initializeOpenCodeSwarm) but
		// the default export itself is synchronous — it's just the descriptor
		// { id, server }. No worktree operations happen at module load.
		expect(mod.server.constructor.name).toBe('AsyncFunction');
	});
});

// ---------------------------------------------------------------------------
// Test #2: Startup orphan recovery runs at runPhase, not construction
// ---------------------------------------------------------------------------

describe('init safety: startupOrphanRecovery runs at runPhase, not construction', () => {
	const realStartupOrphanRecovery =
		LeanTurboRunner._internals.startupOrphanRecovery;
	let mockStartupOrphanRecovery: ReturnType<typeof mock>;

	beforeAll(() => {
		mkdirSync(join(TEST_DIR, '.swarm'), { recursive: true });
	});

	beforeEach(() => {
		mockStartupOrphanRecovery = mock(() =>
			Promise.resolve({
				pruned: 0,
				orphanedBranches: [],
				cleanedBranches: [],
				warnings: [],
			}),
		);
		LeanTurboRunner._internals.startupOrphanRecovery =
			mockStartupOrphanRecovery;
	});

	afterEach(() => {
		LeanTurboRunner._internals.startupOrphanRecovery =
			realStartupOrphanRecovery;
	});

	/**
	 * Writes a minimal plan.json with worktree_isolation enabled in lean config.
	 */
	function writePlanWithWorktreeIsolation(
		phaseNumber = 1,
		worktreeIsolation = true,
	) {
		const plan = {
			schema_version: '1.0.0',
			title: 'Init Safety Test Plan',
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
							description: 'Test task',
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
				...DEFAULT_LEAN_TURBO_CONFIG,
				worktree_isolation: worktreeIsolation,
				max_parallel_coders: 1,
				phase_reviewer: false,
				phase_critic: false,
				integrated_diff_required: false,
			},
		};

		writeFileSync(
			join(TEST_DIR, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
			'utf-8',
		);
	}

	test('runner construction does NOT call startupOrphanRecovery', () => {
		LeanTurboRunner._internals.startupOrphanRecovery =
			mockStartupOrphanRecovery;

		// Construct runner — should NOT call startupOrphanRecovery
		new LeanTurboRunner({
			directory: TEST_DIR,
			sessionID: 'sess-init-safety',
			leanConfig: {
				...DEFAULT_LEAN_TURBO_CONFIG,
				worktree_isolation: true,
			},
		});

		expect(mockStartupOrphanRecovery).not.toHaveBeenCalled();
	});

	test('runPhase with worktree_isolation=true DOES call startupOrphanRecovery', async () => {
		writePlanWithWorktreeIsolation(1, true);
		LeanTurboRunner._internals.startupOrphanRecovery =
			mockStartupOrphanRecovery;

		const runner = new LeanTurboRunner({
			directory: TEST_DIR,
			sessionID: 'sess-init-safety-phase',
			leanConfig: {
				...DEFAULT_LEAN_TURBO_CONFIG,
				worktree_isolation: true,
			},
		});

		// Omit opencodeClient to stay in test mode (no fail-closed).
		// runPhase calls startupOrphanRecovery early (before dispatch),
		// so the mock is verified even though dispatch ultimately fails.
		await runner.runPhase(1);

		expect(mockStartupOrphanRecovery).toHaveBeenCalledTimes(1);
		expect(mockStartupOrphanRecovery).toHaveBeenCalledWith(
			TEST_DIR,
			expect.arrayContaining(['sess-init-safety-phase']),
		);
	});

	test('runPhase with worktree_isolation=false does NOT call startupOrphanRecovery', async () => {
		writePlanWithWorktreeIsolation(1, false);
		LeanTurboRunner._internals.startupOrphanRecovery =
			mockStartupOrphanRecovery;

		const runner = new LeanTurboRunner({
			directory: TEST_DIR,
			sessionID: 'sess-init-safety-no-wt',
			leanConfig: {
				...DEFAULT_LEAN_TURBO_CONFIG,
				worktree_isolation: false,
			},
		});

		await runner.runPhase(1);

		expect(mockStartupOrphanRecovery).not.toHaveBeenCalled();
	});

	test('runPhase without lean config (defaults) does NOT call startupOrphanRecovery', async () => {
		writePlanWithWorktreeIsolation(1, false);
		LeanTurboRunner._internals.startupOrphanRecovery =
			mockStartupOrphanRecovery;

		const runner = new LeanTurboRunner({
			directory: TEST_DIR,
			sessionID: 'sess-init-safety-defaults',
			// No leanConfig — uses defaults, worktree_isolation defaults to false
		});

		await runner.runPhase(1);

		expect(mockStartupOrphanRecovery).not.toHaveBeenCalled();
	});
});
