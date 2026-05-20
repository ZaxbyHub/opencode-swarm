/**
 * Tests for the .swarm/ gitignore warning emitted on plugin startup.
 *
 * Covers:
 * 1. Warning fires when .gitignore exists but does not contain .swarm/
 * 2. Warning does NOT fire when .gitignore contains .swarm/
 * 3. Warning does NOT fire when .gitignore contains .swarm (without trailing slash)
 * 4. Warning does NOT fire when .git/info/exclude covers .swarm/
 * 5. Warning does NOT fire when no .git/ directory is found (not a git repo)
 * 6. Warning fires at most once (module-level deduplication)
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	ensureSwarmGitExcluded,
	resetGitignoreWarningState,
	resetSwarmGitExcludedState,
	warnIfSwarmNotGitignored,
} from '../src/utils/gitignore-warning';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-gitignore-test-'));
}

function makeGitRepo(dir: string): void {
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
}

function writeGitignore(dir: string, content: string): void {
	fs.writeFileSync(path.join(dir, '.gitignore'), content, 'utf8');
}

function writeExclude(dir: string, content: string): void {
	fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), content, 'utf8');
}

function rmrf(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('warnIfSwarmNotGitignored', () => {
	let tmpDir: string;
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		resetGitignoreWarningState();
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		rmrf(tmpDir);
		resetGitignoreWarningState();
	});

	// -------------------------------------------------------------------------
	// 1. Warning fires when .gitignore exists but does not cover .swarm/
	// -------------------------------------------------------------------------
	it('fires when .gitignore exists but does not contain .swarm/', () => {
		makeGitRepo(tmpDir);
		writeGitignore(tmpDir, 'node_modules/\ndist/\n');

		warnIfSwarmNotGitignored(tmpDir);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [message] = warnSpy.mock.calls[0] as [string];
		expect(message).toContain('[opencode-swarm] WARNING');
		expect(message).toContain('.swarm/');
		expect(message).toContain('.gitignore');
	});

	// -------------------------------------------------------------------------
	// 2. Warning does NOT fire when .gitignore contains .swarm/
	// -------------------------------------------------------------------------
	it('does NOT fire when .gitignore contains .swarm/', () => {
		makeGitRepo(tmpDir);
		writeGitignore(tmpDir, 'node_modules/\n.swarm/\ndist/\n');

		warnIfSwarmNotGitignored(tmpDir);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// 3. Warning does NOT fire when .gitignore contains .swarm (no trailing /)
	// -------------------------------------------------------------------------
	it('does NOT fire when .gitignore contains .swarm (without trailing slash)', () => {
		makeGitRepo(tmpDir);
		writeGitignore(tmpDir, 'node_modules/\n.swarm\n');

		warnIfSwarmNotGitignored(tmpDir);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// 4. Warning does NOT fire when .git/info/exclude covers .swarm/
	// -------------------------------------------------------------------------
	it('does NOT fire when .git/info/exclude contains .swarm/', () => {
		makeGitRepo(tmpDir);
		// .gitignore exists but doesn't cover .swarm/
		writeGitignore(tmpDir, 'node_modules/\n');
		// exclude file covers it
		writeExclude(tmpDir, '# git exclude\n.swarm/\n');

		warnIfSwarmNotGitignored(tmpDir);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('does NOT fire when .git/info/exclude contains .swarm (no trailing slash)', () => {
		makeGitRepo(tmpDir);
		writeGitignore(tmpDir, 'node_modules/\n');
		writeExclude(tmpDir, '.swarm\n');

		warnIfSwarmNotGitignored(tmpDir);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// 5. Warning does NOT fire when no .git/ directory is found
	// -------------------------------------------------------------------------
	it('does NOT fire when no .git/ directory is found (not a git repo)', () => {
		// tmpDir has no .git/ — create a nested subdir to call from
		const subDir = path.join(tmpDir, 'some', 'nested', 'path');
		fs.mkdirSync(subDir, { recursive: true });

		warnIfSwarmNotGitignored(subDir);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// 6. Warning fires at most once per process (module-level deduplication)
	// -------------------------------------------------------------------------
	it('fires at most once even when called multiple times', () => {
		makeGitRepo(tmpDir);
		writeGitignore(tmpDir, 'node_modules/\n');

		warnIfSwarmNotGitignored(tmpDir);
		warnIfSwarmNotGitignored(tmpDir);
		warnIfSwarmNotGitignored(tmpDir);

		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it('does NOT fire a second call after flag was set by a covered repo', () => {
		// First call: covered — flag set without warning
		makeGitRepo(tmpDir);
		writeGitignore(tmpDir, '.swarm/\n');
		warnIfSwarmNotGitignored(tmpDir);
		expect(warnSpy).not.toHaveBeenCalled();

		// Second call with a different (uncovered) dir — should be suppressed
		const tmpDir2 = makeTmpDir();
		try {
			makeGitRepo(tmpDir2);
			writeGitignore(tmpDir2, 'node_modules/\n');
			warnIfSwarmNotGitignored(tmpDir2);
			// Still no warning because flag already set
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			rmrf(tmpDir2);
		}
	});

	// -------------------------------------------------------------------------
	// Edge cases
	// -------------------------------------------------------------------------
	it('ignores comment lines when scanning .gitignore', () => {
		makeGitRepo(tmpDir);
		// Lines that look like .swarm but are comments — should NOT count
		writeGitignore(tmpDir, '# .swarm/\n# .swarm\nnode_modules/\n');

		warnIfSwarmNotGitignored(tmpDir);

		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it('handles whitespace around .swarm/ in .gitignore', () => {
		makeGitRepo(tmpDir);
		// Leading/trailing whitespace should be stripped before matching
		writeGitignore(tmpDir, '  .swarm/  \n');

		warnIfSwarmNotGitignored(tmpDir);

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('fires when .gitignore does not exist at all', () => {
		makeGitRepo(tmpDir);
		// No .gitignore written — no exclude either

		warnIfSwarmNotGitignored(tmpDir);

		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it('walks up to the git root when called from a subdirectory', () => {
		makeGitRepo(tmpDir);
		writeGitignore(tmpDir, 'node_modules/\n');

		// Create a nested project directory
		const subDir = path.join(tmpDir, 'packages', 'core', 'src');
		fs.mkdirSync(subDir, { recursive: true });

		warnIfSwarmNotGitignored(subDir);

		// Should find tmpDir/.git and read tmpDir/.gitignore
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it('does NOT fire when walking up finds a covered .gitignore', () => {
		makeGitRepo(tmpDir);
		writeGitignore(tmpDir, '.swarm/\n');

		const subDir = path.join(tmpDir, 'src', 'deep', 'path');
		fs.mkdirSync(subDir, { recursive: true });

		warnIfSwarmNotGitignored(subDir);

		expect(warnSpy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// ensureSwarmGitExcluded — real git integration tests
// ---------------------------------------------------------------------------

function makeRealGitRepo(dir: string): void {
	execSync('git init', { cwd: dir, stdio: 'pipe' });
	execSync('git config user.email "test@test.com"', {
		cwd: dir,
		stdio: 'pipe',
	});
	execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
	execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'pipe' });
}

function readExclude(dir: string): string {
	try {
		return fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
	} catch {
		return '';
	}
}

describe('ensureSwarmGitExcluded', () => {
	let tmpDir: string;
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-ensure-git-test-'));
		resetSwarmGitExcludedState();
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		rmrf(tmpDir);
		resetSwarmGitExcludedState();
	});

	// 1. Fresh git repo — appends .swarm/ to .git/info/exclude
	it('appends .swarm/ to .git/info/exclude in a fresh git repo', async () => {
		makeRealGitRepo(tmpDir);

		await ensureSwarmGitExcluded(tmpDir);

		const exclude = readExclude(tmpDir);
		expect(exclude).toContain('# opencode-swarm');
		expect(exclude).toContain('.swarm/');
	});

	// 2. .swarm/ already in .gitignore — no exclude write
	it('does not write to exclude when .swarm/ is already in .gitignore', async () => {
		makeRealGitRepo(tmpDir);
		writeGitignore(tmpDir, '.swarm/\n');

		await ensureSwarmGitExcluded(tmpDir);

		// Should not have appended to exclude (already ignored via .gitignore)
		const exclude = readExclude(tmpDir);
		expect(exclude).not.toContain('.swarm/');
	});

	// 3. .swarm/ already in .git/info/exclude — no duplicate append
	it('does not duplicate .swarm/ if already in .git/info/exclude', async () => {
		makeRealGitRepo(tmpDir);
		fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, '.git', 'info', 'exclude'),
			'# existing\n.swarm/\n',
			'utf8',
		);

		await ensureSwarmGitExcluded(tmpDir);

		const exclude = readExclude(tmpDir);
		// Count occurrences of .swarm/
		const matches = exclude.match(/^\.swarm\/$/gm);
		expect(matches?.length ?? 0).toBe(1);
	});

	// 4. quiet mode — exclude write still runs, no cosmetic log
	it('still writes to exclude in quiet mode (no cosmetic log)', async () => {
		makeRealGitRepo(tmpDir);

		await ensureSwarmGitExcluded(tmpDir, { quiet: true });

		const exclude = readExclude(tmpDir);
		expect(exclude).toContain('.swarm/');
		// Cosmetic "Added .swarm/" log suppressed in quiet mode
		const addedMsg = warnSpy.mock.calls.find((c) =>
			String(c[0]).includes('Added .swarm/'),
		);
		expect(addedMsg).toBeUndefined();
	});

	// 5. Tracked .swarm/foo.json — emits unsuppressed warning with remediation
	it('emits unsuppressed tracked-file warning when .swarm/ files are tracked', async () => {
		makeRealGitRepo(tmpDir);
		// Create and commit a .swarm/ file
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'state.json'), '{}', 'utf8');
		execSync('git add .swarm/state.json', { cwd: tmpDir, stdio: 'pipe' });
		execSync('git commit -m "accidentally track swarm"', {
			cwd: tmpDir,
			stdio: 'pipe',
		});

		await ensureSwarmGitExcluded(tmpDir, { quiet: true }); // quiet: true must NOT suppress this

		const trackedWarning = warnSpy.mock.calls.find((c) =>
			String(c[0]).includes('.swarm/ files are tracked by Git'),
		);
		expect(trackedWarning).toBeDefined();
		expect(String(trackedWarning?.[0])).toContain('git rm -r --cached .swarm');
	});

	// 6. No git repo — no throw, no write
	it('does not throw when called from a non-git directory', async () => {
		const noGitDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'swarm-nogit-test-'),
		);
		try {
			await expect(ensureSwarmGitExcluded(noGitDir)).resolves.toBeUndefined();
		} finally {
			rmrf(noGitDir);
		}
	});

	// 7. Idempotent — called twice, .swarm/ appears only once in exclude
	it('is idempotent — .swarm/ appears only once when called twice', async () => {
		makeRealGitRepo(tmpDir);

		resetSwarmGitExcludedState();
		await ensureSwarmGitExcluded(tmpDir);
		resetSwarmGitExcludedState();
		await ensureSwarmGitExcluded(tmpDir);

		const exclude = readExclude(tmpDir);
		const matches = exclude.match(/^\.swarm\/$/gm);
		expect(matches?.length ?? 0).toBe(1);
	});

	// 8. Called from a subdirectory — still protects the containing repo's exclude
	it('resolves exclude path correctly when called from a repo subdirectory', async () => {
		makeRealGitRepo(tmpDir);

		// Create a nested subdirectory — plugin is typically launched from within the project
		const subDir = path.join(tmpDir, 'packages', 'core');
		fs.mkdirSync(subDir, { recursive: true });

		await ensureSwarmGitExcluded(subDir);

		// The exclude file in the root repo should have .swarm/
		const exclude = readExclude(tmpDir);
		expect(exclude).toContain('.swarm/');
	});

	// 9. Subdirectory + .swarm/ in root .gitignore — check-ignore finds root rules from subdir
	it('does not write to exclude when called from subdir and root .gitignore covers .swarm/', async () => {
		makeRealGitRepo(tmpDir);
		writeGitignore(tmpDir, '.swarm/\n');

		const subDir = path.join(tmpDir, 'packages', 'core');
		fs.mkdirSync(subDir, { recursive: true });

		await ensureSwarmGitExcluded(subDir);

		// check-ignore is run with -C <subDir> and must still find the root .gitignore rule
		const exclude = readExclude(tmpDir);
		expect(exclude).not.toContain('.swarm/');
	});

	// 10. .swarm/ in .gitignore AND files already tracked — tracked warning still fires
	it('emits tracked warning even when .swarm/ is already covered by .gitignore', async () => {
		makeRealGitRepo(tmpDir);
		// Commit .swarm/ file first, then add .gitignore — simulates the "already tracked" state
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'state.json'), '{}', 'utf8');
		execSync('git add .swarm/state.json', { cwd: tmpDir, stdio: 'pipe' });
		execSync('git commit -m "accidentally track swarm"', {
			cwd: tmpDir,
			stdio: 'pipe',
		});
		// Now add .gitignore covering .swarm/ — check-ignore returns 0, exclude write skipped
		writeGitignore(tmpDir, '.swarm/\n');

		await ensureSwarmGitExcluded(tmpDir);

		// Exclude write skipped (gitignore already covers it)
		const exclude = readExclude(tmpDir);
		expect(exclude).not.toContain('.swarm/');
		// But tracked-file warning must still fire regardless
		const trackedWarning = warnSpy.mock.calls.find((c) =>
			String(c[0]).includes('.swarm/ files are tracked by Git'),
		);
		expect(trackedWarning).toBeDefined();
	});

	// 11. Worktree — .git is a file, not a directory (core worktree-safety claim)
	it('handles git worktrees where .git is a file, not a directory', async () => {
		makeRealGitRepo(tmpDir);
		// Need an initial commit for worktree creation
		fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'initial');
		execSync('git add dummy.txt', { cwd: tmpDir, stdio: 'pipe' });
		execSync('git commit -m "initial"', { cwd: tmpDir, stdio: 'pipe' });

		const worktreeDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'swarm-worktree-test-'),
		);
		try {
			execSync('git branch worktree-branch', { cwd: tmpDir, stdio: 'pipe' });
			execSync(`git worktree add "${worktreeDir}" worktree-branch`, {
				cwd: tmpDir,
				stdio: 'pipe',
			});

			// Verify .git in worktree is a file (not a directory)
			const gitPath = path.join(worktreeDir, '.git');
			const stat = fs.statSync(gitPath);
			expect(stat.isFile()).toBe(true);

			resetSwarmGitExcludedState();
			await ensureSwarmGitExcluded(worktreeDir);

			// Resolve the worktree-specific exclude path via git CLI
			const excludeRelPath = execSync(
				`git -C "${worktreeDir}" rev-parse --git-path info/exclude`,
				{ stdio: 'pipe' },
			)
				.toString()
				.trim();
			const excludePath = path.isAbsolute(excludeRelPath)
				? excludeRelPath
				: path.join(worktreeDir, excludeRelPath);
			const exclude = fs.readFileSync(excludePath, 'utf8');

			expect(exclude).toContain('# opencode-swarm');
			expect(exclude).toContain('.swarm/');
		} finally {
			try {
				execSync(`git worktree remove --force "${worktreeDir}"`, {
					cwd: tmpDir,
					stdio: 'pipe',
				});
			} catch {
				rmrf(worktreeDir);
			}
		}
	});

	// 12. git not on PATH — ENOENT is silently swallowed, never throws
	it('does not throw when git is not on PATH (simulated ENOENT)', async () => {
		const noGitDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'swarm-enoent-test-'),
		);
		const originalBunSpawn = _internals.bunSpawn;
		try {
			makeRealGitRepo(noGitDir);
			resetSwarmGitExcludedState();
			// Simulate git not found on PATH
			_internals.bunSpawn = () => {
				throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
			};
			await expect(ensureSwarmGitExcluded(noGitDir)).resolves.toBeUndefined();
			// No exclude written — git was unavailable
			const exclude = readExclude(noGitDir);
			expect(exclude).not.toContain('.swarm/');
		} finally {
			_internals.bunSpawn = originalBunSpawn;
			rmrf(noGitDir);
		}
	});

	// 13. Concurrent calls — synchronous deduplication flag prevents duplicate writes
	it('concurrent calls write .swarm/ exactly once due to synchronous flag', async () => {
		makeRealGitRepo(tmpDir);
		resetSwarmGitExcludedState();

		// Both calls start before either can set the flag; the flag is set
		// synchronously at the top of the function so the second call no-ops.
		await Promise.all([
			ensureSwarmGitExcluded(tmpDir),
			ensureSwarmGitExcluded(tmpDir),
		]);

		const exclude = readExclude(tmpDir);
		const matches = exclude.match(/^\.swarm\/$/gm);
		expect(matches?.length ?? 0).toBe(1);
	});
});
