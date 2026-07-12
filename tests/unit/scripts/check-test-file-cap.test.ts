/**
 * Issue #1781 E1 — diff-scoped ratchet for the FR-006 500-line test-file cap.
 *
 * Each test spawns the real `scripts/check-test-file-cap.sh` in a temp git
 * repository so the diff-scoped logic (new-file vs ratchet vs pre-existing)
 * is exercised against real `git diff` output.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(process.cwd(), 'scripts', 'check-test-file-cap.sh');

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runScript(
	repoDir: string,
	env?: Record<string, string>,
): Promise<SpawnResult> {
	const proc = Bun.spawn({
		cmd: ['bash', SCRIPT],
		cwd: repoDir,
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

function git(repoDir: string, ...args: string[]): void {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd: repoDir,
		env: process.env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (proc.exitCode !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed in ${repoDir}: ${proc.stderr.toString()}`,
		);
	}
}

function writeFile(repoDir: string, relPath: string, lineCount: number): void {
	const full = path.join(repoDir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	// Write `lineCount` lines ending with a newline so wc -l counts exactly N.
	const content = `${Array.from({ length: lineCount }, (_, i) => `// line ${i + 1}`).join('\n')}\n`;
	fs.writeFileSync(full, content, 'utf-8');
}

/**
 * Build a temp git repo with one initial commit on `main` (the base branch).
 * Tests then branch, modify, commit, and run the script.
 */
function makeRepo(): string {
	const repoDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'test-cap-1781-')),
	);
	// `git init` defaults to `master` on older git, `main` on newer. Force
	// `main` so the script's branch-priority lookup resolves origin/main-like.
	git(repoDir, 'init', '-q', '-b', 'main');
	git(repoDir, 'config', 'user.email', 'test@example.com');
	git(repoDir, 'config', 'user.name', 'Test');
	// Seed an initial commit so HEAD exists.
	writeFile(repoDir, 'README.md', 1);
	git(repoDir, 'add', '-A');
	git(repoDir, 'commit', '-q', '-m', 'init');
	// Create `origin/main` as a branch ref so the script's lookup resolves it.
	git(repoDir, 'branch', 'origin/main');
	return repoDir;
}

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			try {
				fs.rmSync(root, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	}
});

function track(repoDir: string): string {
	tempRoots.push(repoDir);
	return repoDir;
}

describe('check-test-file-cap.sh — diff-scoped ratchet (issue #1781 E1)', () => {
	test('A. new 600-line test file in the diff FAILS (default enforce)', async () => {
		const repo = track(makeRepo());
		writeFile(repo, 'tests/foo.test.ts', 600);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add big test');

		const result = await runScript(repo);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toInclude('new file');
		expect(result.stdout).toInclude('tests/foo.test.ts');
	});

	test('B. new 400-line test file in the diff PASSES', async () => {
		const repo = track(makeRepo());
		writeFile(repo, 'tests/foo.test.ts', 400);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add small test');

		const result = await runScript(repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toInclude('All test-file-cap checks passed');
	});

	test('C. growing an existing over-cap file 4000→4050 FAILS (ratchet)', async () => {
		const repo = track(makeRepo());
		// Seed base commit with a 4000-line file.
		writeFile(repo, 'tests/big.test.ts', 4000);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'seed big');
		// Update origin/main to point at the seed commit.
		git(repo, 'branch', '-f', 'origin/main');

		// Now grow to 4050.
		writeFile(repo, 'tests/big.test.ts', 4050);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'grow big');

		const result = await runScript(repo);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toInclude('ratchet');
		expect(result.stdout).toInclude('4000');
		expect(result.stdout).toInclude('4050');
	});

	test('D. shrinking an existing over-cap file 4000→3990 PASSES', async () => {
		const repo = track(makeRepo());
		writeFile(repo, 'tests/big.test.ts', 4000);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'seed big');
		git(repo, 'branch', '-f', 'origin/main');

		writeFile(repo, 'tests/big.test.ts', 3990);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'shrink big');

		const result = await runScript(repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toInclude('All test-file-cap checks passed');
	});

	test('E. pre-existing over-cap file NOT in the diff is silent', async () => {
		const repo = track(makeRepo());
		writeFile(repo, 'tests/huge.test.ts', 4697);
		// Add a non-test file too so the diff is non-empty but doesn't touch
		// the over-cap test file.
		writeFile(repo, 'src/foo.ts', 1);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'seed huge + src');
		git(repo, 'branch', '-f', 'origin/main');

		// New commit that only touches src/foo.ts.
		writeFile(repo, 'src/foo.ts', 2);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'edit src only');

		const result = await runScript(repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toInclude('All test-file-cap checks passed');
		// The huge file is never mentioned.
		expect(result.stdout).not.toInclude('tests/huge.test.ts');
	});

	test('G. TEST_CAP_ENFORCE=0 soft-warns on a 600-line new file', async () => {
		const repo = track(makeRepo());
		writeFile(repo, 'tests/foo.test.ts', 600);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add big test');

		const result = await runScript(repo, { TEST_CAP_ENFORCE: '0' });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toInclude('soft-warn');
	});

	test('I. TEST_CAP_ENFORCE unset → enforce (CI scenario)', async () => {
		const repo = track(makeRepo());
		writeFile(repo, 'tests/foo.test.ts', 600);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add big test');

		// Explicitly unset to simulate CI.
		const result = await runScript(repo, { TEST_CAP_ENFORCE: '' });
		// Note: passing '' sets the var to empty string, which the script
		// treats as "set but empty" → enforce. To truly unset, we'd need to
		// delete from env; the script's `${TEST_CAP_ENFORCE+x}` test handles
		// both unset and set-empty as enforce.
		expect(result.exitCode).toBe(1);
	});
});
