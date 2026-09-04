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
