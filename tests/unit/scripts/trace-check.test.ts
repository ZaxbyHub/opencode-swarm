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
function run(cwd: string, args: string[], home?: string) {
	const proc = Bun.spawnSync({
		cmd: bashCommand(SCRIPT, ...args),
		cwd,
		env: { ...process.env, ...(home ? { HOME: home } : {}) },
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
function repo(prefix = 'trace-check-'): string {
	const value = canonicalMkdtemp(prefix);
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
	const values = {
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
	fs.writeFileSync(
		path.join(traceDir, 'state.md'),
		`# Trace State: issue-1\n${Object.entries(values)
			.map(([key, value]) => `${key}: ${value}`)
			.join(
				'\n',
			)}\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n`,
	);
}
function writeSummary(dir: string, classification = 'VALID') {
	fs.writeFileSync(
		path.join(dir, '01-issue-summary.md'),
		`## Source\nx\n## Observed Behavior\nx\n## Expected Behavior\nx\n## Acceptance Criteria\n- [ ] AC1: works\n## Classification\n${classification}\n## Related Issues\nx\n`,
	);
}

describe('trace-check.sh identities, handshake, and early phases', () => {
	// Multi-spawn tests get a 20s budget because each spawn is a bash+git subprocess
	// (~1-4s on Windows CI), not because any single assertion is slow.

	test('tree-id matches HEAD tree when clean and includes untracked files', () => {
		const worktree = repo();
		expect(run(worktree, ['tree-id']).out.trim()).toBe(
			git(worktree, 'rev-parse', 'HEAD^{tree}'),
		);
		fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'x\n');
		expect(run(worktree, ['tree-id']).out.trim()).not.toBe(
			git(worktree, 'rev-parse', 'HEAD^{tree}'),
		);
	}, 20_000);

	test('tree-id excludes .agents/issue-traces/ even without an info/exclude entry', () => {
		// trace-init.sh writes .agents/issue-traces/ to info/exclude, but that is
		// an unenforced convention (a missing or hand-edited exclude file would
		// silently drop it). tree_id() must exclude the trace directory by
		// pathspec so trace artifacts never affect the identity either way.
		const worktree = repo();
		const clean = run(worktree, ['tree-id']).out.trim();
		fs.mkdirSync(path.join(worktree, '.agents/issue-traces/issue-1/repro'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(worktree, '.agents/issue-traces/issue-1/state.md'),
			'trace artifact\n',
		);
		expect(run(worktree, ['tree-id']).out.trim()).toBe(clean);
	}, 20_000);

	test('handshake reports ABSENT, MATCH, SHIM, and STALE without exposing file contents', () => {
		const worktree = repo();
		const canonical = path.join(worktree, '.opencode/skills/issue-tracer');
		fs.mkdirSync(canonical, { recursive: true });
		fs.writeFileSync(
			path.join(canonical, 'SKILL.md'),
			'metadata:\n  version: 3.0.0\n',
		);
		const home = canonicalMkdtemp('trace-handshake-');
		roots.push(home);
		const skill = path.join(home, '.claude/skills/issue-tracer');
		fs.mkdirSync(skill, { recursive: true });
		fs.writeFileSync(
			path.join(skill, 'SKILL.md'),
			'metadata:\n  version: 3.0.0\n',
		);
		const codex = path.join(home, '.codex/skills/issue-tracer');
		fs.mkdirSync(codex, { recursive: true });
		fs.writeFileSync(
			path.join(codex, 'SKILL.md'),
			'metadata:\n  version: 3.0.0\nshim: true\n',
		);
		const agents = path.join(home, '.agents/skills/issue-tracer');
		fs.mkdirSync(agents, { recursive: true });
		fs.writeFileSync(
			path.join(agents, 'SKILL.md'),
			'metadata:\n  version: 0.0.0\nsecret-content\n',
		);
		const result = run(worktree, ['handshake'], home);
		expect(result.code).toBe(0);
		expect(result.out).toContain('handshake: MATCH');
		expect(result.out).toContain('handshake: SHIM');
		expect(result.out).toContain('handshake: STALE:');
		expect(result.out).toContain('handshake: ABSENT');
		expect(result.out).not.toContain('secret-content');
	});

	test('phase 0 rejects missing keys, invalid identities, and fetch failures without user override, then accepts a valid ledger', () => {
		const worktree = repo();
		const dir = trace(worktree);
		writeState(worktree, dir);
		expect(run(worktree, ['phase', '0', '--slug', 'issue-1']).code).toBe(0);
		fs.writeFileSync(
			path.join(dir, 'state.md'),
			fs
				.readFileSync(path.join(dir, 'state.md'), 'utf8')
				.replace('tier: S\n', '')
				.replace('base-sha: ', 'base-sha: not-a-sha'),
		);
		let result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL state-tier');
		expect(result.out).toContain('FAIL base-sha');
		writeState(worktree, dir, { freshness: 'fetch-failed:offline' });
		result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL freshness-fail-closed');
	}, 20_000);

	test('phase 1 rejects missing and duplicate headings and classification mismatch', () => {
		const worktree = repo();
		const dir = trace(worktree);
		writeState(worktree, dir);
		writeSummary(dir);
		let result = run(worktree, ['phase', '1', '--slug', 'issue-1']);
		expect(result.code).toBe(0);
		fs.writeFileSync(
			path.join(dir, '01-issue-summary.md'),
			fs
				.readFileSync(path.join(dir, '01-issue-summary.md'), 'utf8')
				.replace('## Classification\nVALID\n', ''),
		);
		result = run(worktree, ['phase', '1', '--slug', 'issue-1']);
		expect(result.out).toContain('FAIL heading-Classification');
		writeSummary(dir, 'AMBIGUOUS');
		result = run(worktree, ['phase', '1', '--slug', 'issue-1']);
		expect(result.out).toContain('FAIL classification');
		fs.appendFileSync(
			path.join(dir, '01-issue-summary.md'),
			'## Source\nagain\n',
		);
		result = run(worktree, ['phase', '1', '--slug', 'issue-1']);
		expect(result.out).toContain('FAIL duplicate-heading-Source');
	}, 20_000);

	test('phase 2 requires a text block and recorded exit code, while a legacy trace warns and exits zero', () => {
		const worktree = repo();
		const dir = trace(worktree);
		writeState(worktree, dir);
		fs.writeFileSync(
			path.join(dir, '02-reproduction.md'),
			'## Commands Tried\ncommand\n## Reproduction Verdict\nno exit code\n',
		);
		let result = run(worktree, ['phase', '2', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL reproduction-exit-code');
		fs.writeFileSync(
			path.join(dir, '02-reproduction.md'),
			'## Commands Tried\n```text\nrun\n```\n- Exit code: 1\n## Reproduction Verdict\nred\n',
		);
		result = run(worktree, ['phase', '2', '--slug', 'issue-1']);
		expect(result.code).toBe(0);
		fs.writeFileSync(path.join(dir, 'state.md'), '# old trace\nphase: 2\n');
		result = run(worktree, ['phase', '2', '--slug', 'issue-1']);
		expect(result.code).toBe(0);
		expect(result.out).toContain('WARN');
	}, 20_000);

	test('phase 0 freshness accepts only synced or a valid override, rejects behind/banana', () => {
		const worktree = repo();
		const dir = trace(worktree);
		writeState(worktree, dir, { freshness: 'banana' });
		let result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL freshness: unknown value');

		writeState(worktree, dir, { freshness: 'behind:3' });
		result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain(
			'FAIL freshness: behind, sync before proceeding',
		);

		writeState(worktree, dir, { freshness: 'synced' });
		result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.out).toContain('OK freshness');

		writeState(worktree, dir, {
			freshness: 'fetch-failed:offline user-override:"go ahead"',
		});
		result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.out).toContain('OK freshness');

		writeState(worktree, dir, { freshness: 'fetch-failed:offline' });
		result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL freshness-fail-closed');

		writeState(worktree, dir, { freshness: 'user-override:""' });
		result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL freshness: unknown value');
	}, 20_000);

	test('tree-id ignores gitignored content', () => {
		const worktree = repo();
		// Record tree-id with clean working directory
		const cleanId = run(worktree, ['tree-id']).out.trim();

		// Create .gitignore and commit it
		fs.writeFileSync(
			path.join(worktree, '.gitignore'),
			'node_modules/\ndist/\n',
		);
		git(worktree, 'add', '.gitignore');
		git(worktree, 'commit', '-q', '-m', 'add .gitignore');

		// Record tree-id after .gitignore commit
		const withIgnoreId = run(worktree, ['tree-id']).out.trim();
		expect(withIgnoreId).not.toBe(cleanId);

		// Create gitignored files
		fs.mkdirSync(path.join(worktree, 'node_modules/foo'), { recursive: true });
		fs.writeFileSync(
			path.join(worktree, 'node_modules/foo/big.js'),
			'code here\n',
		);
		fs.mkdirSync(path.join(worktree, 'dist'));
		fs.writeFileSync(path.join(worktree, 'dist/bundle.js'), 'bundle here\n');

		// tree-id should not change because files are gitignored, and computing
		// it must not intern the ignored blobs into the real object store (a
		// forced add would): the loose-object count stays identical.
		const objectsBefore = git(worktree, 'count-objects');
		expect(run(worktree, ['tree-id']).out.trim()).toBe(withIgnoreId);
		expect(git(worktree, 'count-objects')).toBe(objectsBefore);

		// Create a non-ignored untracked file
		fs.writeFileSync(path.join(worktree, 'src-new.txt'), 'new source\n');

		// tree-id should change because this file is not gitignored
		expect(run(worktree, ['tree-id']).out.trim()).not.toBe(withIgnoreId);
	}, 20_000);
});
