/**
 * FR-102 scope durability tests for worktree lanes.
 *
 * Verifies that when a lane is provisioned with a declared scope,
 * the scope file is materialized into <lane>/.swarm/scopes/scope-{taskId}.json
 * so that resolveScopeWithFallbacks called from the worktree context
 * (after simulated plugin restart clearing in-memory state) recovers the narrow scope.
 *
 * Also verifies the materialized file is gitignored (inherits primary .gitignore).
 *
 * Uses the _internals seam on worktree/core for write injection (no mock.module).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readScopeFromDisk,
	resolveScopeWithFallbacks,
	writeScopeToDisk,
} from '../../../src/scope/scope-persistence';
import {
	provisionWorktree,
	_internals as worktreeInternals,
} from '../../../src/worktree/core';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

interface TestDirs {
	hostDir: string;
	cleanup: () => void;
}

function initGitRepo(repoPath: string): void {
	fs.mkdirSync(repoPath, { recursive: true });
	runGitCmdSync(repoPath, ['init', '-q']);
	runGitCmdSync(repoPath, ['config', 'user.email', 'test@opencode.swarm']);
	runGitCmdSync(repoPath, ['config', 'user.name', 'Swarm Test']);
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

function createHostGitRepo(): TestDirs {
	const { dir, cleanup } = createSafeTestDir();
	const hostDir = dir;
	initGitRepo(hostDir);
	// Ensure primary .gitignore excludes .swarm/ (as in real repo)
	const gitignore = path.join(hostDir, '.gitignore');
	if (!fs.existsSync(gitignore)) {
		fs.writeFileSync(gitignore, '.swarm/\n');
	} else {
		const content = fs.readFileSync(gitignore, 'utf-8');
		if (!content.includes('.swarm/')) {
			fs.appendFileSync(gitignore, '\n.swarm/\n');
		}
	}
	runGitCmdSync(hostDir, ['add', '.gitignore']);
	runGitCmdSync(hostDir, ['commit', '-q', '-m', 'add gitignore']);
	return { hostDir, cleanup };
}

describe('FR-102: scope materialization into lane worktrees (SC-105)', () => {
	let dirs: TestDirs;
	let realWriteScope: typeof worktreeInternals.writeScopeToDisk;

	beforeEach(() => {
		dirs = createHostGitRepo();
		// Save real seam for restore
		realWriteScope = worktreeInternals.writeScopeToDisk;
		// Clean any leftover .swarm-worktrees from prior runs (same pattern as core.deps-strategy.integration.test.ts)
		try {
			const swarmWorktreesInTemp = path.join(os.tmpdir(), '.swarm-worktrees');
			if (fs.existsSync(swarmWorktreesInTemp)) {
				fs.rmSync(swarmWorktreesInTemp, { recursive: true, force: true });
			}
		} catch {
			/* best-effort */
		}
	});

	afterEach(() => {
		worktreeInternals.writeScopeToDisk = realWriteScope;
		dirs.cleanup();
		// Clean any leftover .swarm-worktrees from this run
		try {
			const swarmWorktreesInTemp = path.join(os.tmpdir(), '.swarm-worktrees');
			if (fs.existsSync(swarmWorktreesInTemp)) {
				fs.rmSync(swarmWorktreesInTemp, { recursive: true, force: true });
			}
		} catch {
			/* best-effort */
		}
	});

	test('provisionWorktree with scope materializes scope file into lane .swarm/scopes/', async () => {
		const taskId = '1.2';
		const scopeFiles = ['src/foo.ts', 'src/bar.ts'];

		const result = await provisionWorktree(
			dirs.hostDir,
			'lane-42',
			'sess-abc',
			{
				purpose: 'lane',
				scope: { taskId, files: scopeFiles },
			},
		);

		if ('error' in result) {
			throw new Error(`provision failed: ${result.error}`);
		}

		const lanePath = result.worktreePath;
		const scopePath = path.join(
			lanePath,
			'.swarm',
			'scopes',
			`scope-${taskId}.json`,
		);

		expect(fs.existsSync(scopePath)).toBe(true);

		const recovered = readScopeFromDisk(lanePath, taskId);
		expect(recovered).toEqual(scopeFiles);
	});

	test('resolveScopeWithFallbacks from worktree path recovers materialized scope (no in-memory)', async () => {
		const taskId = '1.2';
		const scopeFiles = ['src/a.ts', 'src/b.ts'];

		const result = await provisionWorktree(
			dirs.hostDir,
			'lane-43',
			'sess-def',
			{
				purpose: 'lane',
				scope: { taskId, files: scopeFiles },
			},
		);
		if ('error' in result) throw new Error(result.error);

		const lanePath = result.worktreePath;

		// Simulate plugin restart: no in-memory, no pending map
		const resolved = resolveScopeWithFallbacks({
			directory: lanePath,
			taskId,
			inMemoryScope: null,
			pendingMapScope: null,
		});

		expect(resolved).toEqual(scopeFiles);
	});

	test('materialized scope file is gitignored at lane root (inherits primary .gitignore)', async () => {
		const taskId = '1.2';
		const scopeFiles = ['src/x.ts'];

		const result = await provisionWorktree(
			dirs.hostDir,
			'lane-44',
			'sess-ghi',
			{
				purpose: 'lane',
				scope: { taskId, files: scopeFiles },
			},
		);
		if ('error' in result) throw new Error(result.error);

		const lanePath = result.worktreePath;

		// Verify via git ls-files --others --exclude-standard from the lane
		const { spawnSync } = require('node:child_process');
		const lsResult = spawnSync(
			'git',
			['ls-files', '--others', '--exclude-standard'],
			{
				cwd: lanePath,
				stdio: 'pipe',
				env: { ...process.env, LC_ALL: 'C' },
			},
		);
		const untracked = lsResult.stdout
			.toString()
			.trim()
			.split('\n')
			.filter(Boolean);

		// The scope file must NOT appear as untracked
		const scopeRel = path
			.relative(
				lanePath,
				path.join(lanePath, '.swarm', 'scopes', `scope-${taskId}.json`),
			)
			.replace(/\\/g, '/');
		expect(
			untracked.some((f) => f.includes('.swarm') || f.includes(scopeRel)),
		).toBe(false);

		// Also verify the lane's toplevel .gitignore contains .swarm/ (inheritance)
		const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
			cwd: lanePath,
			stdio: 'pipe',
		})
			.stdout.toString()
			.trim();
		const laneGitignore = path.join(toplevel, '.gitignore');
		const gi = fs.readFileSync(laneGitignore, 'utf-8');
		expect(gi).toContain('.swarm/');
	});
});

describe('FR-102: restart-mid-dispatch durability (SC-106)', () => {
	let dirs: TestDirs;
	let realWriteScope: typeof worktreeInternals.writeScopeToDisk;

	beforeEach(() => {
		dirs = createHostGitRepo();
		realWriteScope = worktreeInternals.writeScopeToDisk;
	});

	afterEach(() => {
		worktreeInternals.writeScopeToDisk = realWriteScope;
		dirs.cleanup();
	});

	test('scope declared before restart is recovered from lane disk after clearing in-memory state', async () => {
		const taskId = '2.1';
		const scopeFiles = ['src/feature.ts', 'tests/feature.test.ts'];

		// 1. Simulate architect declaring scope (writes to primary root)
		await writeScopeToDisk(dirs.hostDir, taskId, scopeFiles);

		// 2. Provision lane (in real flow this would be called from precreateStandardWorktreeSession
		//    after the pending map or declare_scope has populated the scope for the task).
		//    For this test we pass the scope explicitly to exercise materialization.
		const provisionResult = await provisionWorktree(
			dirs.hostDir,
			'lane-restart',
			'sess-restart',
			{
				purpose: 'lane',
				scope: { taskId, files: scopeFiles },
			},
		);
		if ('error' in provisionResult) throw new Error(provisionResult.error);

		const lanePath = provisionResult.worktreePath;

		// 3. Simulate plugin restart: clear any in-memory state (we pass nulls)
		//    Callers (scope-guard, tool-before, full-auto-permission) will invoke
		//    resolveScopeWithFallbacks({ directory: lanePath, ... })
		const recovered = resolveScopeWithFallbacks({
			directory: lanePath,
			taskId,
			inMemoryScope: null,
			pendingMapScope: null,
		});

		expect(recovered).toEqual(scopeFiles);

		// Also verify the file physically exists under the lane
		const scopeOnDisk = path.join(
			lanePath,
			'.swarm',
			'scopes',
			`scope-${taskId}.json`,
		);
		expect(fs.existsSync(scopeOnDisk)).toBe(true);
	});
});
