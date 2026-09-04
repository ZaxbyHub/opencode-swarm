import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-check.sh',
);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
	return proc.stdout.toString().trim();
}
function run(cwd: string, args: string[]) {
	const proc = Bun.spawnSync({
		cmd: bashCommand(SCRIPT, ...args),
		cwd,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 15_000,
	});
	return {
		code: proc.exitCode,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
	};
}
function repo(): string {
	const value = canonicalMkdtemp('trace-check-legacy-');
	roots.push(value);
	git(value, 'init', '-q', '-b', 'main');
	git(value, 'config', 'user.email', 'trace@example.invalid');
	git(value, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(value, 'README.md'), 'seed\n');
	git(value, 'add', '-A');
	git(value, 'commit', '-q', '-m', 'seed');
	return value;
}
function trace(repoDir: string, slug = 'issue-1'): string {
	const value = path.join(repoDir, '.agents/issue-traces', slug);
	fs.mkdirSync(path.join(value, 'repro'), { recursive: true });
	return value;
}
function writeState(
	repoDir: string,
	traceDir: string,
	overrides: Record<string, string> = {},
) {
	const head = git(repoDir, 'rev-parse', 'HEAD');
	const tree = git(repoDir, 'rev-parse', 'HEAD^{tree}');
	const values: Record<string, string> = {
		protocol: '3.0.0',
		phase: '0',
		tier: 'S',
		classification: 'VALID',
		'base-ref': 'main',
		'base-sha': head,
		freshness: 'synced',
		'phase0-tree-id': tree,
		'checkpoint-tree-id': tree,
		handshake: 'MATCH',
		tools: 'none',
		merge: 'not-applicable',
		'next-action': 'test',
		...overrides,
	};
	const lines = Object.entries(values)
		.filter(([, v]) => v !== undefined)
		.map(([key, value]) => `${key}: ${value}`);
	fs.writeFileSync(
		path.join(traceDir, 'state.md'),
		`# Trace State: issue-1\n${lines.join(
			'\n',
		)}\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n`,
	);
}

describe('trace-check.sh legacy/protocol gating', () => {
	test('absent trace dir fails phase 0 and merge with exit 1', () => {
		const worktree = repo();
		let result = run(worktree, ['phase', '0', '--slug', 'no-such-trace']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL state: missing');
		result = run(worktree, ['merge', '--slug', 'no-such-trace']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL state: missing');
	});

	test('a v3 ledger with the protocol line removed fails closed instead of downgrading to legacy', () => {
		const worktree = repo();
		const dir = trace(worktree);
		writeState(worktree, dir);
		let result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.code).toBe(0);
		const stripped = fs
			.readFileSync(path.join(dir, 'state.md'), 'utf8')
			.split('\n')
			.filter((line) => !line.startsWith('protocol: '))
			.join('\n');
		fs.writeFileSync(path.join(dir, 'state.md'), stripped);
		result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain(
			'FAIL state-protocol: missing (v3 ledger without protocol line)',
		);
		expect(result.out).not.toContain('WARN');
	});

	test('an unsupported protocol value fails closed rather than warning', () => {
		const worktree = repo();
		const dir = trace(worktree);
		writeState(worktree, dir, { protocol: '2.9.9' });
		const result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL state-protocol: unsupported 2.9.9');
		expect(result.out).not.toContain('WARN');
	});

	test('a genuine v2 ledger (no protocol, no v3-only keys) still warns and exits 0', () => {
		const worktree = repo();
		const dir = trace(worktree);
		fs.writeFileSync(
			path.join(dir, 'state.md'),
			'# old trace\nphase: 0\nclassification: VALID\n',
		);
		const result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.code).toBe(0);
		expect(result.out).toContain('WARN protocol: legacy trace');
	});
});
