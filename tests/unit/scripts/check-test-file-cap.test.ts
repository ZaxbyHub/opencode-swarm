/**
 * Issue #1781 E1 — diff-scoped ratchet for the FR-006 500-line test-file cap.
 * Issue #2078 — the gate is now `scripts/check-test-file-cap.ts`, invoked
 * through `bun` so it runs on Windows hosts with no Bash in PATH.
 *
 * Each test spawns the real TypeScript gate in a temp git repository so the
 * diff-scoped logic (new-file vs ratchet vs pre-existing) is exercised against
 * real `git diff` output — no Bash involved. The final case additionally
 * asserts that the retained `check-test-file-cap.sh` shim produces byte-equal
 * output, which is what makes the two entry points incapable of drifting.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';

const TS_GATE = path.resolve(
	process.cwd(),
	'scripts',
	'check-test-file-cap.ts',
);
const SH_SHIM = path.resolve(
	process.cwd(),
	'scripts',
	'check-test-file-cap.sh',
);

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function spawn(
	cmd: string[],
	repoDir: string,
	env?: Record<string, string>,
): SpawnResult {
	const proc = Bun.spawnSync({
		cmd,
		cwd: repoDir,
		env: { ...process.env, ...env },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

/** Run the real gate the way CI and contributors do — via bun, no shell. */
function runScript(repoDir: string, env?: Record<string, string>): SpawnResult {
	return spawn([process.execPath, 'run', TS_GATE], repoDir, env);
}

/** Run the retained Bash shim, which must delegate to the same TS gate. */
function runShim(repoDir: string, env?: Record<string, string>): SpawnResult {
	return spawn(bashCommand(SH_SHIM), repoDir, env);
}

function git(repoDir: string, ...args: string[]): void {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd: repoDir,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
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

describe('check-test-file-cap — diff-scoped ratchet (issues #1781 E1, #2078)', () => {
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
		// Note: passing '' sets the var to empty string, which the gate
		// treats as "set but empty" → enforce, matching the original Bash
		// `${TEST_CAP_ENFORCE+x}` semantics.
		expect(result.exitCode).toBe(1);
	});

	test('J. issue #2078 — the .sh shim and the .ts gate agree exactly', () => {
		const repo = track(makeRepo());
		writeFile(repo, 'tests/foo.test.ts', 600);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add big test');

		const direct = runScript(repo);
		const shim = runShim(repo);
		expect(shim.exitCode).toBe(direct.exitCode);
		expect(shim.stdout).toBe(direct.stdout);
		expect(direct.exitCode).toBe(1);
	});

	test('L. issue #2078 — running from a subdirectory gives the same verdict', () => {
		const repo = track(makeRepo());
		writeFile(repo, 'tests/foo.test.ts', 600);
		writeFile(repo, 'src/nested/keep.ts', 1);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add big test');

		const fromRoot = runScript(repo);
		const fromSubdir = runScript(path.join(repo, 'src', 'nested'));
		// Without repo-root resolution the subdirectory run silently reported
		// "All test-file-cap checks passed" — a vacuous pass.
		expect(fromSubdir.exitCode).toBe(1);
		expect(fromSubdir.stdout).toBe(fromRoot.stdout);
	});

	test('K. issue #2078 — the shim carries no cap value or ratchet logic', () => {
		const shimSource = fs.readFileSync(SH_SHIM, 'utf-8');
		const body = shimSource
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		// A second cap constant is exactly the drift issue #2078 forbids.
		expect(body).not.toInclude('500');
		expect(body).not.toInclude('MAX_LINES');
		expect(body).not.toInclude('TEST_CAP_ENFORCE');
		expect(body).toInclude('check-test-file-cap.ts');
	});
});
