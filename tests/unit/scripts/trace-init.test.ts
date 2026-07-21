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
import { bashCommand } from '../../helpers/bash';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-init.sh',
);

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function runScript(
	cwd: string,
	args: string[],
	env: Record<string, string | undefined> = process.env,
): SpawnResult {
	const proc = Bun.spawnSync({
		cmd: bashCommand(SCRIPT, ...args),
		cwd,
		env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function git(repoDir: string, ...args: string[]): string {
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

/**
 * Build a `git` shim directory that rejects any `--path-format=...` flag
 * (mirroring how git < 2.31 rejects the option) while delegating every
 * other invocation to the real `git` on PATH. Prepending this directory to
 * PATH forces trace-init.sh's primary
 * `git rev-parse --path-format=absolute --git-common-dir` resolution to
 * fail, exercising the plain `--git-common-dir` fallback branch (with its
 * manual absolutization) that is otherwise never executed in this suite —
 * the test environment's real git (>= 2.31) always succeeds on the primary
 * path, so without this shim the fallback branch has zero coverage.
 */
function makeOldGitShim(): string {
	const realGit = Bun.which('git');
	if (!realGit) throw new Error('git is required for trace-init tests');
	const shimDir = fs.mkdtempSync(
		path.join(os.tmpdir(), 'trace-init-old-git-shim-'),
	);
	const shimScript = [
		'#!/usr/bin/env bash',
		'for arg in "$@"; do',
		'  case "$arg" in',
		'    --path-format=*)',
		'      echo "git: unrecognized option: $arg" >&2',
		'      exit 129',
		'      ;;',
		'  esac',
		'done',
		`exec "${realGit}" "$@"`,
		'',
	].join('\n');
	fs.writeFileSync(path.join(shimDir, 'git'), shimScript);
	fs.chmodSync(path.join(shimDir, 'git'), 0o755);
	return shimDir;
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

	test('F-D1: refuses to follow an existing directory link that escapes the repo root', async () => {
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
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		if (process.platform !== 'win32') {
			git(repo, 'add', '-A');
			git(repo, 'commit', '-q', '-m', 'add symlink escape');
		}

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
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 10_000,
		});
		expect(checkIgnore.exitCode).toBe(0);
	});

	test('F-D1: refuses a directory-link escape at a deeper ancestor (.agents/issue-traces itself, not .agents)', async () => {
		// Distinguishes the containment check's ancestor-walk from the
		// already-covered case where `.agents` itself is the symlink: here
		// `.agents` is a real, committed directory and only the nested
		// `issue-traces` path is a symlink escaping the repo. The while-loop
		// in trace-init.sh must stop its ancestor walk one level deeper and
		// still catch it.
		const outer = track(
			fs.realpathSync(
				fs.mkdtempSync(
					path.join(os.tmpdir(), 'trace-init-symlink-deep-outer-'),
				),
			),
		);
		const attackerTarget = path.join(outer, 'attacker-target-deep');
		fs.mkdirSync(attackerTarget);
		const repo = path.join(outer, 'victim-deep');
		fs.mkdirSync(repo);
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'config', 'user.email', 'test@example.com');
		git(repo, 'config', 'user.name', 'Test');
		fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'init');
		fs.mkdirSync(path.join(repo, '.agents'));
		fs.symlinkSync(
			attackerTarget,
			path.join(repo, '.agents', 'issue-traces'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		if (process.platform !== 'win32') {
			git(repo, 'add', '-A');
			git(repo, 'commit', '-q', '-m', 'add deeper symlink escape');
		}

		const result = await runScript(repo, ['evil-slug-deep']);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('outside the repo root');
		expect(fs.readdirSync(attackerTarget)).toHaveLength(0);
	});

	// Windows: the PATH-shim technique below relies on a bash script (no
	// extension, relying on the executable bit + shebang) being resolved via
	// PATH ahead of the real git.exe inside a Git-Bash/MSYS process spawned
	// from a native Windows process. That combination (Windows-native env var
	// construction feeding an MSYS bash's internal PATH search) is unreliable
	// across Git-for-Windows versions and was observed to silently fail to
	// intercept `git` in CI (exit 0, but the exclude entry was never
	// written — indicating the fallback branch never actually ran). The
	// fallback branch itself mirrors an already-shipped, precedented pattern
	// (src/knowledge/cohort-identity.ts, issue #1846 / PR #1851) and is
	// covered on Linux and macOS, where this shim technique is verified
	// reliable.
	test.skipIf(process.platform === 'win32')(
		'F-E1: falls back to plain --git-common-dir (with manual absolutization) when git predates --path-format, and still lands the exclude entry in the shared common dir',
		async () => {
			const mainRepo = track(makeRepo('trace-init-worktree-oldgit-main-'));
			const worktreeParent = fs.mkdtempSync(
				path.join(os.tmpdir(), 'trace-init-worktree-oldgit-linked-'),
			);
			const linkedWorktree = path.join(worktreeParent, 'linked');
			track(worktreeParent);
			git(
				mainRepo,
				'worktree',
				'add',
				'-q',
				'-b',
				'feature-oldgit',
				linkedWorktree,
			);

			const shimDir = track(makeOldGitShim());
			const { exitCode, stderr } = runScript(linkedWorktree, ['old-git-slug'], {
				...process.env,
				PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
			});

			expect(exitCode).toBe(0);
			expect(stderr).not.toContain('unrecognized option');
			expect(stderr).not.toContain('could not resolve the git directory');

			// Same assertion as the primary-path F-E1 test above: the exclude
			// entry must land in the SHARED common dir, not the worktree-private
			// admin dir, even when resolved via the fallback branch.
			const sharedExclude = path.join(mainRepo, '.git/info/exclude');
			expect(fs.readFileSync(sharedExclude, 'utf-8')).toContain(
				'.agents/issue-traces/',
			);
			const privateExclude = path.join(
				mainRepo,
				'.git/worktrees/linked/info/exclude',
			);
			expect(
				fs.existsSync(privateExclude) &&
					fs
						.readFileSync(privateExclude, 'utf-8')
						.includes('.agents/issue-traces/'),
			).toBe(false);
		},
	);

	test('residual (non-blocking, PR #1880 review): .agents already existing as a plain regular file fails safe — non-zero exit, no trace dir created — even though the diagnostic is a raw shell error rather than a clean trace-init message', async () => {
		// Known limitation: the containment check's ancestor-walk `cd`s into
		// the nearest existing ancestor. When that ancestor is a plain file
		// (not a directory, not a symlink), `cd` fails with bash's own
		// "Not a directory" message and `set -eu` aborts the script — exit
		// code 1, not the script's clean `exit 2` diagnostic. This test
		// pins the safety property that actually matters (no directory is
		// created, no write escapes, the script never reports success) so a
		// future change cannot silently turn this into a false success.
		// Upgrading the diagnostic itself is optional follow-up, not a
		// correctness blocker, since the script already fails closed.
		const repo = track(makeRepo('trace-init-agents-regular-file-'));
		fs.writeFileSync(path.join(repo, '.agents'), 'not a directory\n');

		const result = await runScript(repo, ['some-slug']);
		expect(result.exitCode).not.toBe(0);
		expect(fs.readFileSync(path.join(repo, '.agents'), 'utf-8')).toBe(
			'not a directory\n',
		);
	});
});
