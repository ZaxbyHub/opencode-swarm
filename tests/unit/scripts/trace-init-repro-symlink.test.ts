import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-init.sh',
);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
	const p = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	if (p.exitCode !== 0) throw new Error(p.stderr.toString());
	return p.stdout.toString().trim();
}
function run(cwd: string, args: string[]) {
	const p = Bun.spawnSync({
		cmd: bashCommand(SCRIPT, ...args),
		cwd,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	return { code: p.exitCode, err: p.stderr.toString() };
}
function repo() {
	const value = canonicalMkdtemp('trace-init-repro-symlink-');
	roots.push(value);
	git(value, 'init', '-q', '-b', 'main');
	git(value, 'config', 'user.email', 'trace@example.invalid');
	git(value, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(value, 'README.md'), 'seed\n');
	git(value, 'add', '-A');
	git(value, 'commit', '-q', '-m', 'seed');
	return value;
}

describe('trace-init.sh refuses a pre-existing symlinked repro/ directory', () => {
	test('exits 2 and writes nothing outside the repo when repro/ is a symlink', () => {
		const worktree = repo();
		const outside = canonicalMkdtemp('trace-init-repro-outside-');
		roots.push(outside);
		fs.mkdirSync(path.join(worktree, '.agents/issue-traces/issue-1'), {
			recursive: true,
		});
		fs.symlinkSync(
			outside,
			path.join(worktree, '.agents/issue-traces/issue-1/repro'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		const result = run(worktree, ['issue-1']);
		expect(result.code).toBe(2);
		expect(result.err).toContain("refusing to use 'repro/' - it is a symlink");
		expect(fs.readdirSync(outside)).toHaveLength(0);
	});
});

describe('trace-init.sh refuses a pre-existing non-regular checkpoint.manifest', () => {
	// A file symlink (not a directory junction) requires elevated privilege to
	// create on Windows and fails with EPERM in this sandbox, so this exercises
	// the same `[ -e ] && [ ! -f ]` guard branch with a directory placed at the
	// manifest path - a directory is non-regular exactly like a symlink is, and
	// creating one needs no special privilege on any platform.
	test('exits 2 when checkpoint.manifest is a directory instead of a regular file', () => {
		const worktree = repo();
		fs.mkdirSync(
			path.join(
				worktree,
				'.agents/issue-traces/issue-1/repro/checkpoint.manifest',
			),
			{ recursive: true },
		);
		const result = run(worktree, ['issue-1']);
		expect(result.code).toBe(2);
		expect(result.err).toContain('refusing non-regular target');
	});

	// True symlink-following case: only runs where unprivileged symlink
	// creation is available (non-Windows).
	test.skipIf(process.platform === 'win32')(
		'exits 2 and leaves the symlink target untouched when checkpoint.manifest is a symlink',
		() => {
			const worktree = repo();
			const outsideFile = canonicalMkdtemp('trace-init-manifest-outside-');
			roots.push(outsideFile);
			const target = path.join(outsideFile, 'victim.txt');
			fs.writeFileSync(target, 'untouched\n');
			fs.mkdirSync(path.join(worktree, '.agents/issue-traces/issue-1/repro'), {
				recursive: true,
			});
			fs.symlinkSync(
				target,
				path.join(
					worktree,
					'.agents/issue-traces/issue-1/repro/checkpoint.manifest',
				),
				'file',
			);
			const result = run(worktree, ['issue-1']);
			expect(result.code).toBe(2);
			expect(result.err).toContain('refusing non-regular target');
			expect(fs.readFileSync(target, 'utf8')).toBe('untouched\n');
		},
	);
});

describe('trace-init.sh refuses a pre-existing non-regular state.md', () => {
	// Same `[ -L ] || ([ -e ] && [ ! -f ])` guard as the manifest write, applied
	// to state.md. A directory placed at the state.md path is non-regular
	// exactly like a symlink is, and creating one needs no special privilege
	// on any platform (unlike a file symlink on Windows).
	test('exits 2 when state.md is a directory instead of a regular file', () => {
		const worktree = repo();
		fs.mkdirSync(path.join(worktree, '.agents/issue-traces/issue-1/state.md'), {
			recursive: true,
		});
		const result = run(worktree, ['issue-1']);
		expect(result.code).toBe(2);
		expect(result.err).toContain('refusing non-regular target');
	});
});
