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
function runWithEnv(cwd: string, args: string[], env: Record<string, string>) {
	const p = Bun.spawnSync({
		cmd: bashCommand(SCRIPT, ...args),
		cwd,
		env: { ...process.env, ...env },
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
	const value = canonicalMkdtemp('repro-check-');
	roots.push(value);
	git(value, 'init', '-q', '-b', 'main');
	git(value, 'config', 'user.email', 'trace@example.invalid');
	git(value, 'config', 'user.name', 'Trace');
	fs.writeFileSync(
		path.join(value, 'check.sh'),
		'#!/usr/bin/env bash\necho expected-base >&2\nexit 1\n',
	);
	fs.chmodSync(path.join(value, 'check.sh'), 0o755);
	fs.writeFileSync(path.join(value, 'subject.txt'), 'base\n');
	git(value, 'add', '-A');
	git(value, 'commit', '-q', '-m', 'base');
	return value;
}
function changePass(repoDir: string) {
	fs.writeFileSync(
		path.join(repoDir, 'check.sh'),
		'#!/usr/bin/env bash\necho green\n',
	);
	fs.chmodSync(path.join(repoDir, 'check.sh'), 0o755);
	git(repoDir, 'add', 'check.sh');
	git(repoDir, 'commit', '-q', '-m', 'fix');
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

describe('repro-check.sh disposable checks', () => {
	test('DISCRIMINATING passes from base RED to head GREEN and cleans its worktree', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		changePass(worktree);
		const result = run(worktree, [
			...args(base, 'DISCRIMINATING'),
			'--expect',
			'expected-base',
			'--',
			'bash',
			'check.sh',
		]);
		expect(result.code).toBe(0);
		expect(result.out).toContain('result=RED');
		expect(result.out).toContain('result=GREEN');
		expect(result.out).toContain('verdict: PASS');
		const removed = git(worktree, 'worktree', 'list')
			.split('\n')
			.filter((line) => line.includes('issue-tracer-repro.'));
		expect(removed).toHaveLength(0);
	});

	test('reports VACUOUS and ERROR for non-discriminating base failures', () => {
		const worktree = repo();
		fs.writeFileSync(
			path.join(worktree, 'check.sh'),
			'#!/usr/bin/env bash\nexit 0\n',
		);
		git(worktree, 'add', 'check.sh');
		git(worktree, 'commit', '-q', '-m', 'vacuous');
		const vacuousBase = git(worktree, 'rev-parse', 'HEAD');
		let result = run(worktree, [
			...args(vacuousBase, 'DISCRIMINATING'),
			'--expect',
			'expected-base',
			'--',
			'bash',
			'check.sh',
		]);
		expect(result.code).toBe(4);
		expect(result.out).toContain('VACUOUS');
		expect(
			git(worktree, 'worktree', 'list')
				.split('\n')
				.filter((line) => line.includes('issue-tracer-repro.')),
		).toHaveLength(0);
		fs.writeFileSync(
			path.join(worktree, 'check.sh'),
			'#!/usr/bin/env bash\necho wrong >&2\nexit 1\n',
		);
		git(worktree, 'add', 'check.sh');
		git(worktree, 'commit', '-q', '-m', 'error');
		const errorBase = git(worktree, 'rev-parse', 'HEAD');
		result = run(worktree, [
			...args(errorBase, 'DISCRIMINATING', 'C2'),
			'--expect',
			'expected-base',
			'--',
			'bash',
			'check.sh',
		]);
		expect(result.code).toBe(3);
		expect(result.out).toContain('verdict: ERROR');
	});

	test('PRESERVING and NEW-SURFACE report their pass and failure outcomes', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		fs.writeFileSync(
			path.join(worktree, 'check.sh'),
			'#!/usr/bin/env bash\nexit 0\n',
		);
		git(worktree, 'add', 'check.sh');
		git(worktree, 'commit', '-q', '-m', 'preserve');
		let result = run(worktree, [
			...args(base, 'PRESERVING'),
			'--',
			'bash',
			'-c',
			'exit 0',
		]);
		expect(result.code).toBe(0);
		result = run(worktree, [
			...args(base, 'PRESERVING', 'C2'),
			'--',
			'bash',
			'-c',
			'exit 1',
		]);
		expect(result.code).toBe(5);
		fs.writeFileSync(
			path.join(worktree, 'new.sh'),
			'#!/usr/bin/env bash\nexit 0\n',
		);
		fs.chmodSync(path.join(worktree, 'new.sh'), 0o755);
		result = run(worktree, [
			...args(base, 'NEW-SURFACE', 'C3'),
			'--expect',
			'No such file|cannot find',
			'--',
			'bash',
			'new.sh',
		]);
		expect(result.code).toBe(0);
		expect(result.out).toContain('result=ERROR');
	});

	test('rejects unsafe options and bounds a timed-out child', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		let result = run(worktree, [
			'run',
			'--base',
			base,
			'--class',
			'PRESERVING',
			'--id',
			'C1',
			'--slug',
			'issue-1',
			'--copy',
			'../escape',
			'--',
			'bash',
			'-c',
			'exit 0',
		]);
		expect(result.code).toBe(2);
		expect(result.err).toContain('--copy');
		result = run(worktree, [
			'run',
			'--base',
			'-bad',
			'--class',
			'PRESERVING',
			'--id',
			'C1',
			'--slug',
			'issue-1',
			'--',
			'bash',
			'-c',
			'exit 0',
		]);
		expect(result.code).toBe(2);
		result = run(worktree, [
			...args(base, 'PRESERVING'),
			'--timeout',
			'2',
			'--',
			'bash',
			'-c',
			'sleep 5',
		]);
		expect(result.code).toBe(6);
	}, 20_000);

	test('watchdog fallback (process-group kill) bounds a timed-out child when forced', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		const result = runWithEnv(
			worktree,
			[
				...args(base, 'PRESERVING'),
				'--timeout',
				'2',
				'--',
				'bash',
				'-c',
				'sleep 300 & wait',
			],
			{ REPRO_CHECK_FORCE_FALLBACK: '1' },
		);
		expect(result.code).toBe(6);
	}, 20_000);

	test('truncates oversized logs and tracks checkpoint amendments and changes', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		const result = run(worktree, [
			...args(base, 'PRESERVING'),
			'--',
			'bash',
			'-c',
			'head -c 3145728 /dev/zero; exit 1',
		]);
		expect(result.code).toBe(5);
		const log = path.join(
			worktree,
			'.agents/issue-traces/issue-1/repro/C1.base.log',
		);
		expect(fs.readFileSync(log, 'utf8')).toContain('[... truncated');
		let checkpoint = run(worktree, [
			'checkpoint',
			'--slug',
			'issue-1',
			'--id',
			'C1',
			'--argv',
			'bash check.sh',
			'--expect',
			'-',
			'--base',
			base,
			'subject.txt',
		]);
		expect(checkpoint.code).toBe(0);
		fs.writeFileSync(path.join(worktree, 'subject.txt'), 'changed\n');
		checkpoint = run(worktree, ['verify-checkpoint', '--slug', 'issue-1']);
		expect(checkpoint.code).toBe(1);
		expect(checkpoint.out).toContain('CHANGED subject.txt');
		checkpoint = run(worktree, [
			'checkpoint',
			'--slug',
			'issue-1',
			'--reason',
			'FORMAT_ONLY',
			'--id',
			'C1',
			'--argv',
			'bash check.sh',
			'--expect',
			'-',
			'--base',
			base,
			'subject.txt',
		]);
		expect(checkpoint.code).toBe(0);
		expect(
			fs.readFileSync(
				path.join(
					worktree,
					'.agents/issue-traces/issue-1/repro/checkpoint.manifest',
				),
				'utf8',
			),
		).toContain('\tAMEND\t');
	});
});
