/**
 * Integration tests for worktree deps_strategy (FR-101 / SC-101..SC-104)
 *
 * These tests exercise the real provisionWorktree flow with actual filesystem
 * operations (real cpSync, real symlinkSync, real git worktree commands).
 * They complement the mocked _internals tests in the sibling
 * `worktree.test.ts` file which validate the call-order / argument-logic path.
 *
 * Platform notes:
 * - Symlink/junction creation for node_modules is skipped on CI if the
 *   platform does not support directory symlinks (Windows requires elevation
 *   for true symlinks; junctions are used instead on win32).
 * - Real git worktree operations require a valid git repository.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals, provisionWorktree } from '../../../src/worktree/core';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal bare git repository at `repoPath` and configures
 * user.name / user.email so git operations don't fail.
 */
function initGitRepo(repoPath: string): void {
	fs.mkdirSync(repoPath, { recursive: true });
	// init and configure so git operations don't emit "please tell me who you are"
	runGitCmdSync(repoPath, ['init', '-q']);
	runGitCmdSync(repoPath, ['config', 'user.email', 'test@opencode.swarm']);
	runGitCmdSync(repoPath, ['config', 'user.name', 'Swarm Test']);
	// Create an initial commit so HEAD exists (worktree add needs HEAD)
	runGitCmdSync(repoPath, ['commit', '-q', '--allow-empty', '-m', 'initial']);
}

function runGitCmdSync(cwd: string, args: string[]): void {
	const { spawnSync } = require('node:child_process');
	const result = spawnSync('git', args, {
		cwd,
		stdio: 'pipe',
		env: { ...process.env, LC_ALL: 'C' },
	});
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: ${result.stderr?.toString()}`,
		);
	}
}

/** Creates a node_modules directory with real packages for deps_strategy testing */
function createHostNodeModules(hostDir: string, packages: string[]): string {
	const nmDir = path.join(hostDir, 'node_modules');
	fs.mkdirSync(nmDir, { recursive: true });
	for (const pkg of packages) {
		fs.mkdirSync(path.join(nmDir, pkg), { recursive: true });
		fs.writeFileSync(
			path.join(nmDir, pkg, 'package.json'),
			JSON.stringify({ name: pkg, version: '1.0.0' }),
		);
		fs.writeFileSync(
			path.join(nmDir, pkg, 'index.js'),
			`module.exports = '${pkg}';`,
		);
	}
	return nmDir;
}

// ---------------------------------------------------------------------------
// Per-test temp dir management
// ---------------------------------------------------------------------------

interface TestDirs {
	/** Git repo root (simulates the "host" project directory) */
	hostDir: string;
	/** Safe cleanup function */
	cleanup: () => void;
}

// Save real _internals for restoration
const realInternals = { ..._internals };

let currentTestDirs: TestDirs | null = null;

function setupRealGitRepo(prefix: string, packages: string[] = []): TestDirs {
	const { dir: hostDir, cleanup } = createSafeTestDir(prefix);
	initGitRepo(hostDir);
	if (packages.length > 0) {
		createHostNodeModules(hostDir, packages);
	}
	return { hostDir, cleanup };
}

afterEach(() => {
	// Restore real _internals (especially fs) after each test
	Object.assign(_internals, realInternals);
	if (currentTestDirs) {
		try {
			currentTestDirs.cleanup();
		} catch {
			/* best-effort */
		}
		currentTestDirs = null;
	}
	// Clean up any .swarm-worktrees directories left in os.tmpdir() by git worktree add.
	// provisionWorktree creates worktrees at <os.tmpdir()>/.swarm-worktrees/<sessionId>/<id>,
	// which is a sibling of the unique per-test temp dir created by mkdtempSync.
	// The per-test cleanup above only removes the unique temp dir, not this sibling.
	try {
		const swarmWorktreesInTemp = path.join(os.tmpdir(), '.swarm-worktrees');
		if (fs.existsSync(swarmWorktreesInTemp)) {
			fs.rmSync(swarmWorktreesInTemp, { recursive: true, force: true });
		}
	} catch {
		/* best-effort — might not exist or be locked */
	}
});

// ---------------------------------------------------------------------------
// Per-test setup — clean any leftover .swarm-worktrees from prior failed runs
// ---------------------------------------------------------------------------

beforeEach(() => {
	try {
		const swarmWorktreesInTemp = path.join(os.tmpdir(), '.swarm-worktrees');
		if (fs.existsSync(swarmWorktreesInTemp)) {
			fs.rmSync(swarmWorktreesInTemp, { recursive: true, force: true });
		}
	} catch {
		/* best-effort */
	}
});

// ---------------------------------------------------------------------------
// SC-101: deps_strategy='copy' — real cpSync copies node_modules files
// ---------------------------------------------------------------------------

describe('SC-101: provisionWorktree deps_strategy=copy (real fs)', () => {
	test('copies real node_modules into the worktree via cpSync', async () => {
		const { hostDir, cleanup } = setupRealGitRepo('deps-copy-', [
			'lodash',
			'axios',
		]);
		currentTestDirs = { hostDir, cleanup };

		const result = await provisionWorktree(hostDir, 'lane-copy', 'sess-copy', {
			purpose: 'lane',
			branchStyle: 'legacy-lane',
			depsStrategy: 'copy',
		});

		expect(result).toHaveProperty('worktreePath');
		const wtPath = (result as { worktreePath: string }).worktreePath;

		// SC-101: cpSync was invoked and real files exist in the lane's node_modules
		const laneNm = path.join(wtPath, 'node_modules');
		expect(
			fs.existsSync(laneNm),
			'lane node_modules should exist after copy',
		).toBe(true);

		// Verify packages were copied
		for (const pkg of ['lodash', 'axios']) {
			const pkgDir = path.join(laneNm, pkg);
			expect(
				fs.existsSync(pkgDir),
				`package ${pkg} should exist in lane node_modules`,
			).toBe(true);
			expect(fs.existsSync(path.join(pkgDir, 'package.json'))).toBe(true);
		}

		// Verify contents match host
		const hostPkgJson = fs.readFileSync(
			path.join(hostDir, 'node_modules', 'lodash', 'package.json'),
			'utf-8',
		);
		const lanePkgJson = fs.readFileSync(
			path.join(laneNm, 'lodash', 'package.json'),
			'utf-8',
		);
		expect(lanePkgJson).toBe(hostPkgJson);
	});

	test('copy fails loudly when host node_modules is absent (SC-103)', async () => {
		const { hostDir, cleanup } = setupRealGitRepo('deps-copy-missing-');
		currentTestDirs = { hostDir, cleanup };

		// No node_modules created — host has none
		const result = await provisionWorktree(
			hostDir,
			'lane-copy-missing',
			'sess-copy-missing',
			{
				purpose: 'lane',
				branchStyle: 'legacy-lane',
				depsStrategy: 'copy',
			},
		);

		expect(result).toHaveProperty('error');
		expect((result as { error: string }).error).toContain(
			'WORKTREE_DEPS_STRATEGY_HOST_DIR_MISSING',
		);
		expect((result as { error: string }).error).toContain('copy');
	});
});

// ---------------------------------------------------------------------------
// SC-102: deps_strategy='link' — real symlink/junction is created
// ---------------------------------------------------------------------------

describe('SC-102: provisionWorktree deps_strategy=link (real fs)', () => {
	// Symlinks on Windows CI can require admin elevation; skip if not available
	const isWindows = process.platform === 'win32';

	test.skipIf(isWindows)(
		'creates a real symlink/junction for node_modules (non-Windows)',
		async () => {
			// On Windows, junctions are used (tested in unit tests) and creating
			// directory symlinks in non-elevated CI can fail silently.
			const { hostDir, cleanup } = setupRealGitRepo('deps-link-', [
				'lodash',
				'axios',
			]);
			currentTestDirs = { hostDir, cleanup };

			const result = await provisionWorktree(
				hostDir,
				'lane-link',
				'sess-link',
				{
					purpose: 'lane',
					branchStyle: 'legacy-lane',
					depsStrategy: 'link',
				},
			);

			expect(result).toHaveProperty('worktreePath');
			const wtPath = (result as { worktreePath: string }).worktreePath;

			// SC-102: symlink/junction exists at lane node_modules
			const laneNm = path.join(wtPath, 'node_modules');
			const stats = fs.lstatSync(laneNm);
			expect(
				stats.isSymbolicLink(),
				'lane node_modules should be a symlink',
			).toBe(true);

			// Verify the symlink resolves to the host node_modules
			const realPath = fs.realpathSync(laneNm);
			expect(realPath).toBe(path.join(hostDir, 'node_modules'));
		},
	);

	test('link fails loudly when host node_modules is absent (SC-103)', async () => {
		const { hostDir, cleanup } = setupRealGitRepo('deps-link-missing-');
		currentTestDirs = { hostDir, cleanup };

		const result = await provisionWorktree(
			hostDir,
			'lane-link-missing',
			'sess-link-missing',
			{
				purpose: 'lane',
				branchStyle: 'legacy-lane',
				depsStrategy: 'link',
			},
		);

		expect(result).toHaveProperty('error');
		expect((result as { error: string }).error).toContain(
			'WORKTREE_DEPS_STRATEGY_HOST_DIR_MISSING',
		);
		expect((result as { error: string }).error).toContain('link');
	});
});

// ---------------------------------------------------------------------------
// SC-103: missing host node_modules — error returned, no destination created
// ---------------------------------------------------------------------------

describe('SC-103: provisionWorktree missing host node_modules — no silent no-op', () => {
	/**
	 * Computes the expected worktree path the same way provisionWorktree does,
	 * so we can check the lane node_modules even when result.error is returned
	 * (checkPathBudget may fail before worktree creation on long-Windows paths).
	 */
	function expectedWorktreePath(
		hostDir: string,
		id: string,
		sessionId: string,
	): string {
		return path.resolve(
			path.dirname(hostDir),
			'.swarm-worktrees',
			sessionId,
			id,
		);
	}

	test('copy with missing host node_modules: error returned, no destination directory created', async () => {
		const { hostDir, cleanup } = setupRealGitRepo('sc103-copy-');
		currentTestDirs = { hostDir, cleanup };

		const result = await provisionWorktree(
			hostDir,
			'lane-sc103',
			'sess-sc103',
			{
				purpose: 'lane',
				branchStyle: 'legacy-lane',
				depsStrategy: 'copy',
			},
		);

		expect(result).toHaveProperty('error');
		expect((result as { error: string }).error).toContain(
			'WORKTREE_DEPS_STRATEGY_HOST_DIR_MISSING',
		);

		// The error message must mention the strategy
		expect((result as { error: string }).error).toContain('copy');

		// No lane node_modules should have been created (not even an empty directory)
		// Use computed path since result.worktreePath may be undefined when
		// checkPathBudget fails before worktree creation.
		const laneNm = path.join(
			expectedWorktreePath(hostDir, 'lane-sc103', 'sess-sc103'),
			'node_modules',
		);
		expect(
			fs.existsSync(laneNm),
			'lane node_modules should NOT be created when host is missing',
		).toBe(false);
	});

	test('link with missing host node_modules: error returned, no symlink created', async () => {
		const { hostDir, cleanup } = setupRealGitRepo('sc103-link-');
		currentTestDirs = { hostDir, cleanup };

		const result = await provisionWorktree(
			hostDir,
			'lane-sc103-link',
			'sess-sc103-link',
			{
				purpose: 'lane',
				branchStyle: 'legacy-lane',
				depsStrategy: 'link',
			},
		);

		expect(result).toHaveProperty('error');
		expect((result as { error: string }).error).toContain(
			'WORKTREE_DEPS_STRATEGY_HOST_DIR_MISSING',
		);
		expect((result as { error: string }).error).toContain('link');

		// No lane node_modules symlink should have been created
		const laneNm = path.join(
			expectedWorktreePath(hostDir, 'lane-sc103-link', 'sess-sc103-link'),
			'node_modules',
		);
		expect(
			fs.existsSync(laneNm),
			'lane node_modules symlink should NOT be created when host is missing',
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Lean adapter deps_strategy passthrough (FR-101 / SC-101..SC-103 integration)
// ---------------------------------------------------------------------------

describe('Lean adapter provisionWorktree — deps_strategy passthrough', () => {
	test('leans provisionWorktree propagates deps_strategy copy to shared core', async () => {
		const { hostDir, cleanup } = setupRealGitRepo('lean-copy-', [
			'lodash',
			'axios',
		]);
		currentTestDirs = { hostDir, cleanup };

		// Import lean adapter directly
		const { provisionWorktree: leanProvision } = await import(
			'../../../src/turbo/lean/worktree'
		);

		const result = await leanProvision(
			hostDir,
			'lane-lean-copy',
			'sess-lean-copy',
			{ deps_strategy: 'copy' } as any, // LeanTurboConfig shape
		);

		expect(result).toHaveProperty('worktreePath');
		const wtPath = (result as { worktreePath: string }).worktreePath;
		const laneNm = path.join(wtPath, 'node_modules');

		// Lean adapter should have passed copy strategy through; node_modules should exist
		expect(
			fs.existsSync(laneNm),
			'lane node_modules should exist after lean copy',
		).toBe(true);
		expect(fs.existsSync(path.join(laneNm, 'lodash', 'package.json'))).toBe(
			true,
		);
	});

	test('leans provisionWorktree propagates deps_strategy link to shared core', async () => {
		const { hostDir, cleanup } = setupRealGitRepo('lean-link-', ['lodash']);
		currentTestDirs = { hostDir, cleanup };

		const { provisionWorktree: leanProvision } = await import(
			'../../../src/turbo/lean/worktree'
		);

		const result = await leanProvision(
			hostDir,
			'lane-lean-link',
			'sess-lean-link',
			{ deps_strategy: 'link' } as any,
		);

		expect(result).toHaveProperty('worktreePath');
		const wtPath = (result as { worktreePath: string }).worktreePath;
		const laneNm = path.join(wtPath, 'node_modules');

		if (process.platform === 'win32') {
			// On Windows junctions are used; verify it exists
			expect(fs.existsSync(laneNm)).toBe(true);
		} else {
			const stats = fs.lstatSync(laneNm);
			expect(stats.isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(laneNm)).toBe(path.join(hostDir, 'node_modules'));
		}
	});
});
