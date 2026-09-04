import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/repro-check.sh',
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
		timeout: 30_000,
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}
function repo() {
	const value = canonicalMkdtemp('repro-check-nonreg-');
	roots.push(value);
	git(value, 'init', '-q', '-b', 'main');
	git(value, 'config', 'user.email', 'trace@example.invalid');
	git(value, 'config', 'user.name', 'Trace');
	fs.writeFileSync(
		path.join(value, 'check.sh'),
		'#!/usr/bin/env bash\necho ok\nexit 0\n',
	);
	fs.chmodSync(path.join(value, 'check.sh'), 0o755);
	fs.writeFileSync(path.join(value, 'subject.txt'), 'base\n');
	git(value, 'add', '-A');
	git(value, 'commit', '-q', '-m', 'base');
	return value;
}
function args(base: string, kind: string, id = 'C1') {
	return [
		'run',
		'--base',
		base,
		'--class',
		kind,
		'--id',
		id,
		'--slug',
		'issue-1',
		'--deps',
		'none',
	];
}

// A file symlink (as opposed to a directory junction) requires elevated
// privilege to create on Windows and fails with EPERM in this sandbox. These
// tests instead place a DIRECTORY at the leaf log/manifest path, which hits
// the same `[ -e ] && [ ! -f ]` branch of `refuse_nonregular_target` as a
// symlink would (both are "exists and is not a regular file"), and needs no
// special privilege on any platform. A true symlink-following case is
// exercised separately below, skipped on Windows.
describe('repro-check.sh refuses a non-regular target at the base/head log paths', () => {
	test('run exits with the base log path non-regular and never executes the check', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		const dir = path.join(worktree, '.agents/issue-traces/issue-1/repro');
		fs.mkdirSync(path.join(dir, 'C1.base.log'), { recursive: true });
		const result = run(worktree, [
			...args(base, 'PRESERVING'),
			'--',
			'bash',
			'check.sh',
		]);
		expect(result.code).toBe(2);
		expect(result.err).toContain('refusing non-regular target');
		expect(fs.statSync(path.join(dir, 'C1.base.log')).isDirectory()).toBe(true);
	});

	test('run exits with the head log path non-regular', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		const dir = path.join(worktree, '.agents/issue-traces/issue-1/repro');
		fs.mkdirSync(path.join(dir, 'C1.head.log'), { recursive: true });
		const result = run(worktree, [
			...args(base, 'PRESERVING'),
			'--',
			'bash',
			'check.sh',
		]);
		expect(result.code).toBe(2);
		expect(result.err).toContain('refusing non-regular target');
	});
});

describe('repro-check.sh refuses a non-regular checkpoint.manifest', () => {
	test('checkpoint exits with the manifest path non-regular', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		const dir = path.join(worktree, '.agents/issue-traces/issue-1/repro');
		fs.mkdirSync(path.join(dir, 'checkpoint.manifest'), { recursive: true });
		const result = run(worktree, [
			'checkpoint',
			'--slug',
			'issue-1',
			'--id',
			'C1',
			'--argv',
			'cmd',
			'--expect',
			'-',
			'--base',
			base,
			'--',
			'subject.txt',
		]);
		expect(result.code).toBe(2);
		expect(result.err).toContain('refusing non-regular target');
	});
});

describe('repro-check.sh refuses a real pre-existing symlink at a leaf artifact path', () => {
	test.skipIf(process.platform === 'win32')(
		'run exits 2 and leaves the symlinked base log target untouched',
		() => {
			const worktree = repo();
			const base = git(worktree, 'rev-parse', 'HEAD');
			const dir = path.join(worktree, '.agents/issue-traces/issue-1/repro');
			fs.mkdirSync(dir, { recursive: true });
			const outside = canonicalMkdtemp('repro-check-nonreg-outside-');
			roots.push(outside);
			const target = path.join(outside, 'victim.log');
			fs.writeFileSync(target, 'untouched\n');
			fs.symlinkSync(target, path.join(dir, 'C1.base.log'), 'file');
			const result = run(worktree, [
				...args(base, 'PRESERVING'),
				'--',
				'bash',
				'check.sh',
			]);
			expect(result.code).toBe(2);
			expect(result.err).toContain('refusing non-regular target');
			expect(fs.readFileSync(target, 'utf8')).toBe('untouched\n');
		},
	);
});
