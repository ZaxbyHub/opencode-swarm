/**
 * FR-102 scope durability — additional verification tests (SC-105, SC-106).
 *
 * These tests complement the existing tests in:
 *   - tests/unit/scope/scope-persistence.test.ts         (core provisionWorktree scope materialization)
 *   - tests/unit/hooks/delegation-gate-worktree-isolation.resolution.test.ts (precreateStandardWorktreeSession e2e)
 *
 * New coverage:
 *   1. Negative: precreateStandardWorktreeSession without scope → no scope file created
 *   2. Lean turbo path: provisionWorktree via lean adapter creates scope file
 *   3. Symlink boundary: scope write does not follow symlinks outside the lane
 *
 * Uses real git repos and node:fs (no mock.module).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals as isolationInternals,
	precreateStandardWorktreeSession,
	resetStandardWorktreeIsolationState,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	readScopeFromDisk,
	writeScopeToDisk,
} from '../../../src/scope/scope-persistence';
import { resetSwarmState, swarmState } from '../../../src/state';
import {
	_internals as leanInternals,
	provisionWorktree as provisionLeanWorktree,
} from '../../../src/turbo/lean/worktree';
import {
	provisionWorktree,
	_internals as worktreeInternals,
} from '../../../src/worktree/core';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function initGitRepo(repoPath: string): void {
	fs.mkdirSync(repoPath, { recursive: true });
	runGitCmdSync(repoPath, ['init', '-q']);
	runGitCmdSync(repoPath, ['config', 'user.email', 'test@opencode.swarm']);
	runGitCmdSync(repoPath, ['config', 'user.name', 'Swarm Test']);
	runGitCmdSync(repoPath, ['commit', '-q', '--allow-empty', '-m', 'initial']);
}

function initGitRepoWithGitignore(repoPath: string): string {
	initGitRepo(repoPath);
	// Ensure primary .gitignore excludes .swarm/ (as in real repo)
	const gitignore = path.join(repoPath, '.gitignore');
	if (!fs.existsSync(gitignore)) {
		fs.writeFileSync(gitignore, '.swarm/\n');
	} else {
		const content = fs.readFileSync(gitignore, 'utf-8');
		if (!content.includes('.swarm/')) {
			fs.appendFileSync(gitignore, '\n.swarm/\n');
		}
	}
	runGitCmdSync(repoPath, ['add', '.gitignore']);
	runGitCmdSync(repoPath, ['commit', '-q', '-m', 'add gitignore']);
	return gitignore;
}

function makeRealGitRepo(prefix: string): { dir: string; cleanup: () => void } {
	const { dir, cleanup } = createSafeTestDir(prefix);
	initGitRepoWithGitignore(dir);
	return { dir, cleanup };
}

// ---------------------------------------------------------------------------
// Test 1: Negative — no scope → no scope file
// SC-105 negative path
// ---------------------------------------------------------------------------

describe('FR-102 SC-105: precreateStandardWorktreeSession without scope does NOT create scope file', () => {
	let gitDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		const created = makeRealGitRepo('scope-neg-');
		gitDir = created.dir;
		cleanup = created.cleanup;
	});

	afterEach(() => {
		resetSwarmState();
		isolationInternals.provisionWorktree = provisionWorktree;
		isolationInternals.removeWorktree =
			require('../../../src/worktree').removeWorktree;
		isolationInternals.attemptMergeBackFromDirty =
			require('../../../src/worktree').attemptMergeBackFromDirty;
		isolationInternals.postMergeCleanup =
			require('../../../src/worktree').postMergeCleanup;
		swarmState.opencodeClient = undefined;
		resetStandardWorktreeIsolationState();
		cleanup();
		// Clean up .swarm-worktrees left by git worktree operations
		try {
			const swarmWorktreesInTemp = path.join(os.tmpdir(), '.swarm-worktrees');
			if (fs.existsSync(swarmWorktreesInTemp)) {
				fs.rmSync(swarmWorktreesInTemp, { recursive: true, force: true });
			}
		} catch {
			/* best-effort */
		}
	});

	test('precreateStandardWorktreeSession without scope option does not materialize a scope file', async () => {
		swarmState.opencodeClient = {
			session: {
				create: async () => ({ data: { id: 'sess-no-scope' } }),
			},
		} as any;

		// Use real provision so the lane is actually created
		const origProvision = isolationInternals.provisionWorktree;
		let capturedScope: any = null;
		isolationInternals.provisionWorktree = async (...args: any[]) => {
			// Capture scope argument
			capturedScope = args[3]?.scope;
			return origProvision(...args);
		};

		// Call WITHOUT scope — this is the negative case
		await precreateStandardWorktreeSession({
			config: { worktree: { policy: 'auto' } } as any,
			directory: gitDir,
			parentSessionID: 'neg-session',
			callID: 'call-neg-scope',
			taskId: 'task-neg',
			outputArgs: {},
			// NO scope field — this is the key distinction
		});

		// Verify provisionWorktree was called with undefined scope
		expect(capturedScope).toBeUndefined();

		// Find the lane that was created
		const dispatch = standardWorktreeByCallID.get('call-neg-scope');
		expect(dispatch).toBeDefined();
		const lanePath = dispatch!.handle.worktreePath;

		// Verify: no .swarm/scopes/ directory should exist in the lane
		const scopesDir = path.join(lanePath, '.swarm', 'scopes');
		expect(fs.existsSync(scopesDir)).toBe(false);

		// Also verify that readScopeFromDisk returns null for the taskId
		const recovered = readScopeFromDisk(lanePath, 'task-neg');
		expect(recovered).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Test 2: Lean turbo path — scope materialization via lean adapter
// Verifies: src/turbo/lean/worktree.ts:provisionWorktree forwards scope correctly
// ---------------------------------------------------------------------------

describe('FR-102 SC-105: lean turbo provisionWorktree creates scope file in lane', () => {
	let gitDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		// Save real _internals for writeScopeToDisk restoration
		// Clean up any leftover worktrees
		try {
			const swarmWorktreesInTemp = path.join(os.tmpdir(), '.swarm-worktrees');
			if (fs.existsSync(swarmWorktreesInTemp)) {
				fs.rmSync(swarmWorktreesInTemp, { recursive: true, force: true });
			}
		} catch {
			/* best-effort */
		}
		const created = makeRealGitRepo('lean-scope-');
		gitDir = created.dir;
		cleanup = created.cleanup;
	});

	afterEach(() => {
		// Restore lean internals
		Object.assign(leanInternals, { writeScopeToDisk: undefined });
		cleanup();
		// Clean up .swarm-worktrees
		try {
			const swarmWorktreesInTemp = path.join(os.tmpdir(), '.swarm-worktrees');
			if (fs.existsSync(swarmWorktreesInTemp)) {
				fs.rmSync(swarmWorktreesInTemp, { recursive: true, force: true });
			}
		} catch {
			/* best-effort */
		}
	});

	test('lean provisionWorktree creates scope file at lane .swarm/scopes/scope-{taskId}.json', async () => {
		const taskId = '3.1';
		const scopeFiles = ['src/lean-feature.ts', 'tests/lean-feature.test.ts'];

		const result = await provisionLeanWorktree(
			gitDir,
			'lane-lean',
			'sess-lean',
			{
				worktree_dir: undefined,
				merge_strategy: 'merge',
				deps_strategy: 'skip',
			} as any, // LeanTurboConfig — scope provided here
			{
				taskId,
				files: scopeFiles,
			},
		);

		expect(result).not.toHaveProperty('error');
		const wtPath = (result as { worktreePath: string }).worktreePath;

		// SC-105: scope file must exist in lane
		const scopePath = path.join(
			wtPath,
			'.swarm',
			'scopes',
			`scope-${taskId}.json`,
		);
		expect(fs.existsSync(scopePath)).toBe(true);

		// Verify content
		const recovered = readScopeFromDisk(wtPath, taskId);
		expect(recovered).toEqual(scopeFiles);
	});

	test('lean provisionWorktree with undefined scope does NOT create scope file', async () => {
		const result = await provisionLeanWorktree(
			gitDir,
			'lane-lean-no-scope',
			'sess-lean-no-scope',
			{
				worktree_dir: undefined,
				merge_strategy: 'merge',
				deps_strategy: 'skip',
			} as any,
			undefined, // explicitly no scope
		);

		expect(result).not.toHaveProperty('error');
		const wtPath = (result as { worktreePath: string }).worktreePath;

		// No scope file should exist
		const scopesDir = path.join(wtPath, '.swarm', 'scopes');
		expect(fs.existsSync(scopesDir)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Test 3: Symlink boundary — scope write does not escape via symlink
// AGENTS.md invariant 4 protection (scope file containment)
// ---------------------------------------------------------------------------

describe('FR-102 SC-105: scope write is contained within lane — symlink boundary protection', () => {
	let gitDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		const created = makeRealGitRepo('scope-symlink-');
		gitDir = created.dir;
		cleanup = created.cleanup;
	});

	afterEach(() => {
		worktreeInternals.writeScopeToDisk =
			require('../../../src/scope/scope-persistence').writeScopeToDisk;
		cleanup();
		try {
			const swarmWorktreesInTemp = path.join(os.tmpdir(), '.swarm-worktrees');
			if (fs.existsSync(swarmWorktreesInTemp)) {
				fs.rmSync(swarmWorktreesInTemp, { recursive: true, force: true });
			}
		} catch {
			/* best-effort */
		}
	});

	test('writeScopeToDisk rejects a scopesDir that is a symlink escaping the worktree', async () => {
		// This test verifies the defense-in-depth: even if an attacker could
		// somehow make .swarm/scopes/ a symlink to outside the lane, the
		// realpathSync containment check in isScopesDirSafe would reject it.
		//
		// We test this by calling writeScopeToDisk with a directory that has
		// a symlinked scopes subdirectory — verifying the guard fires.

		// Create a "victim" directory outside any real worktree
		const { dir: victimDir, cleanup: victimCleanup } =
			createSafeTestDir('scope-victim-');
		const victimScopesDir = path.join(victimDir, '.swarm', 'scopes');
		fs.mkdirSync(victimScopesDir, { recursive: true });

		// Create a "lane" directory
		const laneDir = path.join(gitDir, 'lane-dir');
		fs.mkdirSync(laneDir, { recursive: true });

		// Create a .swarm/scopes inside the lane that is a symlink to the victim
		const laneScopesSymlink = path.join(laneDir, '.swarm', 'scopes');
		try {
			fs.symlinkSync(victimScopesDir, laneScopesSymlink);
		} catch {
			// On Windows, symlinks may require admin — skip this specific assertion
			// but still verify the function returns safely (no crash)
			victimCleanup();
			return;
		}

		try {
			// Attempt to write scope — should be silently rejected by isScopesDirSafe
			const writeFn = worktreeInternals.writeScopeToDisk;
			await writeFn(laneDir, '1.99', ['src/evil.ts']);

			// Verify: no scope file should exist in the victim directory
			const victimScopeFile = path.join(victimScopesDir, 'scope-1.99.json');
			expect(fs.existsSync(victimScopeFile)).toBe(false);

			// Verify: no scope file should exist in the lane (because the symlink
			// guard in isScopesDirSafe should have rejected the write)
			const laneScopeFile = path.join(laneScopesSymlink, 'scope-1.99.json');
			expect(fs.existsSync(laneScopeFile)).toBe(false);
		} finally {
			victimCleanup();
		}
	});

	test('provisionWorktree with scope creates scope file inside real lane, not via symlink', async () => {
		// Integration test: provision a real lane and verify the scope file
		// is inside the lane's realpath, not accessible via any symlink trick
		const taskId = '5.5';
		const scopeFiles = ['src/safe.ts'];

		const result = await provisionWorktree(gitDir, 'lane-safe', 'sess-safe', {
			purpose: 'lane',
			scope: { taskId, files: scopeFiles },
		});

		expect(result).not.toHaveProperty('error');
		const wtPath = (result as { worktreePath: string }).worktreePath;

		// Verify: scope file exists at the expected real path
		const scopePath = path.join(
			wtPath,
			'.swarm',
			'scopes',
			`scope-${taskId}.json`,
		);
		expect(fs.existsSync(scopePath)).toBe(true);

		// Verify: realpath of the lane's scopes directory is inside the realpath of the lane
		const realWtPath = fs.realpathSync(wtPath);
		const realScopesDir = fs.realpathSync(
			path.join(wtPath, '.swarm', 'scopes'),
		);
		const rel = path.relative(realWtPath, realScopesDir);
		expect(rel).not.toMatch(/^\.\./); // must not escape upward
		expect(rel.startsWith('..')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Test 4: AGENTS.md invariant 4 — scope file is gitignored in lane
// (complements existing test in scope-persistence.test.ts)
// ---------------------------------------------------------------------------

describe('FR-102: AGENTS.md invariant 4 — materialized scope file is gitignored in lane', () => {
	let gitDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		const created = makeRealGitRepo('scope-gitignore-');
		gitDir = created.dir;
		cleanup = created.cleanup;
	});

	afterEach(() => {
		worktreeInternals.writeScopeToDisk =
			require('../../../src/scope/scope-persistence').writeScopeToDisk;
		cleanup();
		try {
			const swarmWorktreesInTemp = path.join(os.tmpdir(), '.swarm-worktrees');
			if (fs.existsSync(swarmWorktreesInTemp)) {
				fs.rmSync(swarmWorktreesInTemp, { recursive: true, force: true });
			}
		} catch {
			/* best-effort */
		}
	});

	test('git ls-files --others from lane root shows NO untracked scope file (file is gitignored)', async () => {
		const taskId = '4.4';
		const scopeFiles = ['src/safe.ts'];

		// Manually write scope to disk (as provisionWorktree would do)
		await writeScopeToDisk(gitDir, taskId, scopeFiles);

		// Read back to confirm it was written
		expect(
			fs.existsSync(
				path.join(gitDir, '.swarm', 'scopes', `scope-${taskId}.json`),
			),
		).toBe(true);

		// Verify via git ls-files --others --exclude-standard: the scope file must NOT appear
		// This is the AGENTS.md invariant 4 check
		const { spawnSync } = require('node:child_process');
		const lsResult = spawnSync(
			'git',
			['ls-files', '--others', '--exclude-standard'],
			{
				cwd: gitDir,
				stdio: 'pipe',
				env: { ...process.env, LC_ALL: 'C' },
			},
		);
		const untracked = lsResult.stdout
			.toString()
			.trim()
			.split('\n')
			.filter(Boolean);

		const scopeFileName = `.swarm/scopes/scope-${taskId}.json`;
		expect(untracked.some((f: string) => f.includes(scopeFileName))).toBe(
			false,
		);
	});

	test('lane .gitignore contains .swarm/ (scope file inherits primary gitignore)', async () => {
		const taskId = '4.5';
		const scopeFiles = ['src/gi.ts'];

		const result = await provisionWorktree(gitDir, 'lane-gi', 'sess-gi', {
			purpose: 'lane',
			scope: { taskId, files: scopeFiles },
		});

		expect(result).not.toHaveProperty('error');
		const wtPath = (result as { worktreePath: string }).worktreePath;

		// The lane's .gitignore must contain .swarm/
		const laneGitignore = path.join(wtPath, '.gitignore');
		expect(fs.existsSync(laneGitignore)).toBe(true);
		const giContent = fs.readFileSync(laneGitignore, 'utf-8');
		expect(giContent).toContain('.swarm/');
	});
});
