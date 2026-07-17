/**
 * PR #1880 review F-D1/F-E1/F-F1/F-I1 — coverage for
 * `.opencode/skills/issue-tracer/scripts/trace-init.sh`.
 *
 * Each test spawns the real script against a temp git repository (and, for
 * the worktree case, a linked worktree) so the symlink-containment check,
 * the shared-vs-worktree-private git dir resolution, and the slug allowlist
 * are exercised against real `git` behavior rather than a mocked shell.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-init.sh',
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

function makeRepo(prefix: string): string {
	const repoDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
	);
	git(repoDir, 'init', '-q', '-b', 'main');
	git(repoDir, 'config', 'user.email', 'test@example.com');
	git(repoDir, 'config', 'user.name', 'Test');
	fs.writeFileSync(path.join(repoDir, 'README.md'), 'hi\n');
	git(repoDir, 'add', '-A');
	git(repoDir, 'commit', '-q', '-m', 'init');
	return repoDir;
}

describe('trace-init.sh — issue-tracer trace directory setup (PR #1880 review)', () => {
	test('creates the trace dir and seeds state.md', async () => {
		const repo = track(makeRepo('trace-init-basic-'));
		const result = await runScript(repo, ['issue-1849']);
		expect(result.exitCode).toBe(0);

		const stateFile = path.join(
			repo,
			'.agents/issue-traces/issue-1849/state.md',
		);
		expect(fs.existsSync(stateFile)).toBe(true);
		expect(fs.readFileSync(stateFile, 'utf-8')).toContain(
			'Trace State: issue-1849',
		);
	});

	test('is idempotent — a second run does not clobber an edited state.md', async () => {
		const repo = track(makeRepo('trace-init-idempotent-'));
		await runScript(repo, ['issue-1849']);

		const stateFile = path.join(
			repo,
			'.agents/issue-traces/issue-1849/state.md',
		);
		fs.writeFileSync(stateFile, 'edited by the tracer\n');

		const result = await runScript(repo, ['issue-1849']);
		expect(result.exitCode).toBe(0);
		expect(fs.readFileSync(stateFile, 'utf-8')).toBe('edited by the tracer\n');
	});

	test('exclude entry is written once, not duplicated across runs', async () => {
		const repo = track(makeRepo('trace-init-exclude-dedup-'));
		await runScript(repo, ['issue-1849']);
		await runScript(repo, ['issue-1849']);

		const excludeFile = path.join(repo, '.git/info/exclude');
		const lines = fs
			.readFileSync(excludeFile, 'utf-8')
			.split('\n')
			.filter((l) => l === '.agents/issue-traces/');
		expect(lines).toHaveLength(1);
	});

	test('rejects a missing slug argument', async () => {
		const repo = track(makeRepo('trace-init-missing-slug-'));
		const result = await runScript(repo, []);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('usage:');
	});

	test.each([
		['../escape'],
		['foo/bar'],
		['foo bar'],
		['foo;rm -rf'],
		['foo$(whoami)'],
		['.'],
		['..'],
		['UPPER'],
		['foo`id`'],
	])('rejects invalid slug %p (F-I1 positive allowlist)', async (slug) => {
		const repo = track(makeRepo('trace-init-bad-slug-'));
		const result = await runScript(repo, [slug]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('invalid slug');
	});

	test.each([
		['123-numeric-start'],
		['a'],
		['issue-1849'],
		['abc123'],
	])('accepts valid slug %p', async (slug) => {
		const repo = track(makeRepo('trace-init-good-slug-'));
		const result = await runScript(repo, [slug]);
		expect(result.exitCode).toBe(0);
	});

	test('F-D1: refuses to follow a committed symlink that escapes the repo root', async () => {
		const outer = track(
			fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'trace-init-symlink-outer-')),
			),
		);
		const attackerTarget = path.join(outer, 'attacker-target');
		fs.mkdirSync(attackerTarget);
		const repo = path.join(outer, 'victim');
		fs.mkdirSync(repo);
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'config', 'user.email', 'test@example.com');
		git(repo, 'config', 'user.name', 'Test');
		fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'init');
		fs.symlinkSync(
			path.join(outer, 'attacker-target'),
			path.join(repo, '.agents'),
		);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add symlink escape');

		const result = await runScript(repo, ['evil-slug']);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('outside the repo root');
		expect(fs.readdirSync(attackerTarget)).toHaveLength(0);
	});

	test('F-E1: in a linked worktree, the exclude entry lands where git status --ignored actually looks', async () => {
		const mainRepo = track(makeRepo('trace-init-worktree-main-'));
		const worktreeParent = fs.mkdtempSync(
			path.join(os.tmpdir(), 'trace-init-worktree-linked-'),
		);
		const linkedWorktree = path.join(worktreeParent, 'linked');
		track(worktreeParent);
		git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature', linkedWorktree);

		const result = await runScript(linkedWorktree, ['test-slug']);
		expect(result.exitCode).toBe(0);

		// The exclude entry must be written to the SHARED common dir
		// (mainRepo/.git/info/exclude), not the worktree-private admin dir
		// (mainRepo/.git/worktrees/linked/info/exclude) — only the former is
		// consulted by `git status --ignored` / `git check-ignore`.
		const sharedExclude = path.join(mainRepo, '.git/info/exclude');
		expect(fs.readFileSync(sharedExclude, 'utf-8')).toContain(
			'.agents/issue-traces/',
		);

		fs.writeFileSync(
			path.join(linkedWorktree, '.agents/issue-traces/test-slug/extra.txt'),
			'x',
		);
		const checkIgnore = Bun.spawnSync({
			cmd: [
				'git',
				'check-ignore',
				'-q',
				'.agents/issue-traces/test-slug/extra.txt',
			],
			cwd: linkedWorktree,
			env: process.env,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(checkIgnore.exitCode).toBe(0);
	});
});
