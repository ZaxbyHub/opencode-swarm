/**
 * PR #1880 review F-A1/F-B/F-F1 — coverage for
 * `.opencode/skills/issue-tracer/scripts/scan-deferred.sh`.
 *
 * Each test spawns the real script against a temp git repository so the
 * diff-header exclusion and the bad-base-ref failure mode are exercised
 * against real `git diff` output rather than a mocked shell.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/scan-deferred.sh',
);

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runScript(cwd: string, args: string[]): Promise<SpawnResult> {
	const proc = Bun.spawn({
		cmd: ['bash', SCRIPT, ...args],
		cwd,
		env: process.env,
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

function git(repoDir: string, ...args: string[]): string {
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
	return proc.stdout.toString();
}

function writeFile(repoDir: string, relPath: string, content: string): void {
	const full = path.join(repoDir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
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

function track(dir: string): string {
	tempRoots.push(dir);
	return dir;
}

/**
 * Build a temp repo with a `main` base commit and an `origin/main` branch
 * ref pointing at it, then a checked-out `feature` branch for the diff.
 */
function makeRepo(prefix: string): string {
	const repoDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
	);
	git(repoDir, 'init', '-q', '-b', 'main');
	git(repoDir, 'config', 'user.email', 'test@example.com');
	git(repoDir, 'config', 'user.name', 'Test');
	writeFile(repoDir, 'README.md', 'hi\n');
	git(repoDir, 'add', '-A');
	git(repoDir, 'commit', '-q', '-m', 'init');
	git(repoDir, 'branch', 'origin/main');
	git(repoDir, 'checkout', '-q', '-b', 'feature');
	return repoDir;
}

describe('scan-deferred.sh — Full-Resolution Contract deferred-work gate (PR #1880 review)', () => {
	test('clean diff passes', async () => {
		const repo = track(makeRepo('scan-deferred-clean-'));
		writeFile(repo, 'src/foo.ts', 'export const x = 1;\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add foo');

		const result = await runScript(repo, ['origin/main']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toInclude('clean');
	});

	test('catches a genuine TODO on an added line', async () => {
		const repo = track(makeRepo('scan-deferred-todo-'));
		writeFile(repo, 'src/foo.ts', '// TODO: fix this\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add todo');

		const result = await runScript(repo, ['origin/main']);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toInclude('TODO: fix this');
	});

	test.each([
		['FIXME'],
		['XXX'],
		['HACK'],
		['NotImplemented'],
		['todo!'],
	])('catches marker %p on an added line', async (marker) => {
		const repo = track(makeRepo('scan-deferred-marker-'));
		writeFile(repo, 'src/foo.ts', `// ${marker}: placeholder\n`);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add marker');

		const result = await runScript(repo, ['origin/main']);
		expect(result.exitCode).toBe(1);
	});

	test('F-A1: does not false-positive on a diff header whose PATH contains a marker word', async () => {
		const repo = track(makeRepo('scan-deferred-header-fp-'));
		writeFile(repo, 'src/HACK-workaround.ts', 'export const x = 1;\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add file with marker word in path');

		const result = await runScript(repo, ['origin/main']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toInclude('clean');
	});

	test('F-A1: still catches a real marker in a file whose path also contains a marker word', async () => {
		const repo = track(makeRepo('scan-deferred-header-fp-real-hit-'));
		writeFile(repo, 'src/HACK-workaround.ts', '// TODO: real marker\n');
		git(repo, 'add', '-A');
		git(
			repo,
			'commit',
			'-q',
			'-m',
			'add file with marker word in path and content',
		);

		const result = await runScript(repo, ['origin/main']);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toInclude('TODO: real marker');
	});

	test('F-B: an unresolvable base ref fails loudly instead of reporting false-clean', async () => {
		const repo = track(makeRepo('scan-deferred-bad-base-'));
		writeFile(repo, 'src/foo.ts', 'export const x = 1;\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add foo');

		const result = await runScript(repo, ['--not-a-real-ref']);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).not.toInclude('clean');
		expect(result.stderr).toInclude('does not resolve to a commit');
	});

	test('no base ref resolvable at all exits 2 with usage guidance', async () => {
		const repoDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'scan-deferred-no-base-')),
		);
		track(repoDir);
		// Use a branch name outside the candidate list (origin/main,
		// origin/master, main, master) so none of them resolve.
		git(repoDir, 'init', '-q', '-b', 'trunk');
		git(repoDir, 'config', 'user.email', 'test@example.com');
		git(repoDir, 'config', 'user.name', 'Test');
		writeFile(repoDir, 'README.md', 'hi\n');
		git(repoDir, 'add', '-A');
		git(repoDir, 'commit', '-q', '-m', 'init');

		const result = await runScript(repoDir, []);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toInclude('could not resolve a base branch');
	});
});
