import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateDiffScope } from './diff-scope';

/**
 * Create an isolated temp directory OUTSIDE the repo tree.
 */
function mkTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'diff-scope-test-'));
}

/**
 * Run a command in a directory.
 */
async function run(
	cmd: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

/**
 * Initialise a git repo with one initial commit.
 */
async function gitInit(cwd: string): Promise<void> {
	await run(['git', 'init'], cwd);
	await run(['git', 'config', 'user.email', 'test@test.com'], cwd);
	await run(['git', 'config', 'user.name', 'Test'], cwd);
	fs.writeFileSync(path.join(cwd, 'dummy.txt'), 'initial');
	await run(['git', 'add', '.'], cwd);
	await run(['git', 'commit', '-m', 'initial'], cwd);
}

/**
 * Create a .swarm/plan.json with the given tasks.
 */
function createPlanJson(
	cwd: string,
	tasks: Array<{ id: string; files_touched?: string | string[] }>,
): void {
	const plan = {
		phases: [{ id: '1', name: 'Phase 1', tasks }],
	};
	const swarmDir = path.join(cwd, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

/**
 * Stage (add) files to git index without committing — makes `git diff --name-only HEAD~1` return them.
 */
async function stageFiles(cwd: string, files: string[]): Promise<void> {
	for (const f of files) {
		const fullPath = path.join(cwd, f);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, `content of ${f}`);
	}
	await run(['git', 'add', ...files], cwd);
}

describe('validateDiffScope', () => {
	// Tracks the temp directory created by tests 1-9 for afterEach cleanup.
	// Tests 10-12 manage their own cleanup via try/finally and do not set this.
	let tmpDirToClean: string | undefined;

	afterEach(() => {
		if (tmpDirToClean) {
			try {
				fs.rmSync(tmpDirToClean, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
			tmpDirToClean = undefined;
		}
	});

	// ── 1. No warning when changed files match declared scope ──────────────────
	test('1. in-scope: returns null when git-changed files exactly match declared scope', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await gitInit(dir);
		await stageFiles(dir, ['src/foo.ts']);
		createPlanJson(dir, [{ id: '1.1', files_touched: ['src/foo.ts'] }]);

		const result = await validateDiffScope('1.1', dir);

		expect(result).toBeNull();
	});

	// ── 2. Warning when undeclared files modified ───────────────────────────────
	test('2. out-of-scope: returns SCOPE WARNING with undeclared file names', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await gitInit(dir);
		await stageFiles(dir, ['src/foo.ts', 'src/bar.ts']);
		createPlanJson(dir, [{ id: '2.1', files_touched: ['src/foo.ts'] }]);

		const result = await validateDiffScope('2.1', dir);

		expect(result).not.toBeNull();
		expect(typeof result).toBe('string');
		expect(result!.includes('SCOPE WARNING')).toBe(true);
		expect(result!.includes('src/bar.ts')).toBe(true);
	});

	// ── 3. Null for task with empty/absent files_touched ───────────────────────
	test('3. no-scope: returns null when task exists but files_touched is absent', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await gitInit(dir);
		await stageFiles(dir, ['src/foo.ts']);
		createPlanJson(dir, [{ id: '3.1' }]); // no files_touched

		const result = await validateDiffScope('3.1', dir);

		expect(result).toBeNull();
	});

	test('3b. no-scope: returns null when task exists but files_touched is empty array', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await gitInit(dir);
		await stageFiles(dir, ['src/foo.ts']);
		createPlanJson(dir, [{ id: '3.2', files_touched: [] }]);

		const result = await validateDiffScope('3.2', dir);

		expect(result).toBeNull();
	});

	// ── 4. Null when git unavailable (non-git directory) ──────────────────────
	test('4. no-git: returns null without throwing when directory is not a git repo', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		createPlanJson(dir, [{ id: '4.1', files_touched: ['src/foo.ts'] }]);
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'src', 'foo.ts'), 'content');

		// Should not throw and should return null
		const result = await validateDiffScope('4.1', dir);

		expect(result).toBeNull();
	});

	// ── 5. Null when task not found in plan.json ───────────────────────────────
	test('5. task-not-found: returns null when taskId does not exist in plan.json', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await gitInit(dir);
		await stageFiles(dir, ['src/foo.ts']);
		createPlanJson(dir, [{ id: '5.1', files_touched: ['src/foo.ts'] }]);

		const result = await validateDiffScope('nonexistent-task', dir);

		expect(result).toBeNull();
	});

	// ── 6. Null when plan.json missing ─────────────────────────────────────────
	test('6. no-plan: returns null without throwing when .swarm/plan.json is absent', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await gitInit(dir);
		await stageFiles(dir, ['src/foo.ts']);

		// No .swarm directory at all

		// Should not throw
		const result = await validateDiffScope('any-task', dir);

		expect(result).toBeNull();
	});

	// ── 7. Windows-style paths normalised ─────────────────────────────────────
	test('7. windows-paths: backslash paths in plan.json are normalised to forward slashes', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await gitInit(dir);
		await stageFiles(dir, ['src/foo.ts']);
		// Manually write plan.json with Windows-style paths
		const swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{ id: '1', tasks: [{ id: '7.1', files_touched: ['src\\foo.ts'] }] },
				],
			}),
		);

		const result = await validateDiffScope('7.1', dir);

		// Should be null — path was normalised and matched git output src/foo.ts
		expect(result).toBeNull();
	});

	// ── 8. files_touched as single string (not array) ─────────────────────────
	test('8. string-scope: files_touched as a single string (not array) still works', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await gitInit(dir);
		await stageFiles(dir, ['src/foo.ts']);
		createPlanJson(dir, [{ id: '8.1', files_touched: 'src/foo.ts' }]);

		const result = await validateDiffScope('8.1', dir);

		expect(result).toBeNull();
	});

	// ── 9. More than 5 undeclared files truncated ───────────────────────────────
	test('9. truncation: warning lists first 5 undeclared files then (+N more)', async () => {
		const dir = mkTempDir();
		tmpDirToClean = dir;
		await gitInit(dir);
		// Stage 8 files; scope declares only 1
		await stageFiles(dir, [
			'src/a.ts',
			'src/b.ts',
			'src/c.ts',
			'src/d.ts',
			'src/e.ts',
			'src/f.ts',
			'src/g.ts',
			'src/h.ts',
		]);
		createPlanJson(dir, [{ id: '9.1', files_touched: ['src/a.ts'] }]);

		const result = await validateDiffScope('9.1', dir);

		expect(result).not.toBeNull();
		// 8 total changed - 1 declared = 7 undeclared; first 5 undeclared shown: b,c,d,e,f → +2 more
		expect(result!.includes('(+2 more)')).toBe(true);
		// Declared file
		expect(result!.includes('src/a.ts')).toBe(true);
		// First 5 undeclared (b through f) should appear
		expect(result!.includes('src/b.ts')).toBe(true);
		expect(result!.includes('src/c.ts')).toBe(true);
		expect(result!.includes('src/d.ts')).toBe(true);
		expect(result!.includes('src/e.ts')).toBe(true);
		expect(result!.includes('src/f.ts')).toBe(true);
		// 6th and 7th undeclared (g, h) should NOT appear (replaced by +2 more)
		expect(result!.includes('src/g.ts')).toBe(false);
		expect(result!.includes('src/h.ts')).toBe(false);
	});

	// ── 10. .swarm/ paths filtered out — never trigger scope warnings ───────────
	test('10. swarm-filter: tracked .swarm/ changes are excluded from scope validation', async () => {
		// Create a real git repo using execSync (disabling commit signing for test env).
		const dir = mkTempDir();
		try {
			execSync('git init', { cwd: dir, stdio: 'pipe' });
			execSync('git config user.email "test@test.com"', {
				cwd: dir,
				stdio: 'pipe',
			});
			execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
			execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'pipe' });

			// Initial commit
			fs.writeFileSync(path.join(dir, 'dummy.txt'), 'initial');
			execSync('git add dummy.txt', { cwd: dir, stdio: 'pipe' });
			execSync('git commit -m "initial"', { cwd: dir, stdio: 'pipe' });

			// Create and commit a .swarm/ file (simulates already-tracked state)
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			fs.writeFileSync(path.join(dir, '.swarm', 'state.json'), '{"version":1}');
			execSync('git add .swarm/state.json', { cwd: dir, stdio: 'pipe' });
			execSync('git commit -m "track swarm"', { cwd: dir, stdio: 'pipe' });

			// Modify the tracked .swarm file — this would appear in git diff HEAD~1
			fs.writeFileSync(path.join(dir, '.swarm', 'state.json'), '{"version":2}');
			execSync('git add .swarm/state.json', { cwd: dir, stdio: 'pipe' });

			// Scope: only src/app.ts declared — .swarm/state.json is NOT declared
			createPlanJson(dir, [{ id: '10.1', files_touched: ['src/app.ts'] }]);

			const result = await validateDiffScope('10.1', dir);

			// .swarm/state.json should be filtered out — the only changed file is a .swarm/
			// runtime path which must never trigger a scope warning.
			expect(result).toBeNull();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// ── 11. Primary HEAD~1 path — exercises git diff HEAD~1 (not the fallback) ────
	// Tests 1-9 only have one commit, so git diff HEAD~1 fails and the fallback
	// (git diff HEAD vs staged) is used. This test has two commits so the primary
	// path is exercised.
	test('11. primary-path: git diff HEAD~1 is used when a second commit exists', async () => {
		const dir = mkTempDir();
		try {
			execSync('git init', { cwd: dir, stdio: 'pipe' });
			execSync('git config user.email "test@test.com"', {
				cwd: dir,
				stdio: 'pipe',
			});
			execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
			execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'pipe' });

			// Initial commit
			fs.writeFileSync(path.join(dir, 'dummy.txt'), 'initial');
			execSync('git add dummy.txt', { cwd: dir, stdio: 'pipe' });
			execSync('git commit -m "initial"', { cwd: dir, stdio: 'pipe' });

			// Second commit with src/foo.ts — this makes HEAD~1 resolvable
			fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'src', 'foo.ts'), 'content');
			execSync('git add src/foo.ts', { cwd: dir, stdio: 'pipe' });
			execSync('git commit -m "add foo"', { cwd: dir, stdio: 'pipe' });

			createPlanJson(dir, [{ id: '11.1', files_touched: ['src/foo.ts'] }]);

			const result = await validateDiffScope('11.1', dir);

			// src/foo.ts is in scope — no warning
			expect(result).toBeNull();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// ── 12. Primary HEAD~1 path — out-of-scope file triggers warning ──────────────
	test('12. primary-path-oos: git diff HEAD~1 detects undeclared file via primary path', async () => {
		const dir = mkTempDir();
		try {
			execSync('git init', { cwd: dir, stdio: 'pipe' });
			execSync('git config user.email "test@test.com"', {
				cwd: dir,
				stdio: 'pipe',
			});
			execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
			execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'pipe' });

			// Initial commit
			fs.writeFileSync(path.join(dir, 'dummy.txt'), 'initial');
			execSync('git add dummy.txt', { cwd: dir, stdio: 'pipe' });
			execSync('git commit -m "initial"', { cwd: dir, stdio: 'pipe' });

			// Second commit with two files — only one is in declared scope
			fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'src', 'foo.ts'), 'content');
			fs.writeFileSync(path.join(dir, 'src', 'bar.ts'), 'content');
			execSync('git add src/foo.ts src/bar.ts', { cwd: dir, stdio: 'pipe' });
			execSync('git commit -m "add foo and bar"', { cwd: dir, stdio: 'pipe' });

			createPlanJson(dir, [{ id: '12.1', files_touched: ['src/foo.ts'] }]);

			const result = await validateDiffScope('12.1', dir);

			// src/bar.ts is out of scope — warning expected
			expect(result).not.toBeNull();
			expect(result!.includes('SCOPE WARNING')).toBe(true);
			expect(result!.includes('src/bar.ts')).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
