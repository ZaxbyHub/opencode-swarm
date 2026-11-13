import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// #3605 AC3: trace-check.sh phase 1 refuses a trace whose cluster-preflight
// artifact is absent or malformed, and accepts one that records per-candidate
// claim and open-PR evidence with a recorded-at line. The rule is universal
// (every trace selects a cluster of >= 1 issue); the shape check exists so a
// recorded-at-only artifact cannot pass vacuously.

const SCRIPT = path.join(
	process.cwd(),
	'.opencode',
	'skills',
	'issue-tracer',
	'scripts',
	'trace-check.sh',
);

const PREFLIGHT_VALID =
	'recorded-at: 2026-01-01T00:00:00Z\n\n## candidate #1\n\n- claim comments (live): none\n- open PRs naming 1 in:body: none\n- verdict: CLEAR\n';

interface RunResult {
	code: number;
	out: string;
}

function run(cwd: string, args: string[]): RunResult {
	const [shell, ...rest] = bashCommand(SCRIPT, ...args);
	const proc = spawnSync(shell, rest, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 30_000,
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_SYSTEM: '/dev/null',
		},
	});
	return { code: proc.status ?? 1, out: proc.stdout?.toString() ?? '' };
}

function git(cwd: string, ...args: string[]): string {
	const proc = spawnSync('git', ['-C', cwd, ...args], {
		encoding: 'utf8',
		timeout: 15_000,
	});
	if (proc.status !== 0)
		throw new Error(`git ${args.join(' ')} failed: ${proc.stderr}`);
	return proc.stdout.toString().trim();
}

const repos: string[] = [];

afterEach(() => {
	for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
	repos.length = 0;
});

function makeRepo(): string {
	const dir = canonicalMkdtemp('trace-check-preflight-');
	repos.push(dir);
	git(dir, 'init', '-q', '-b', 'main');
	git(dir, 'config', 'user.email', 'trace@example.invalid');
	git(dir, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', 'seed');
	return dir;
}

function makeTrace(repoDir: string): string {
	const head = git(repoDir, 'rev-parse', 'HEAD');
	const tree = git(repoDir, 'rev-parse', 'HEAD^{tree}');
	const traceDir = path.join(repoDir, '.agents', 'issue-traces', 'issue-1');
	fs.mkdirSync(path.join(traceDir, 'repro'), { recursive: true });
	fs.writeFileSync(
		path.join(traceDir, 'state.md'),
		[
			'# Trace State: issue-1',
			'protocol: 3.0.0',
			'phase: 1',
			'tier: S',
			'classification: VALID',
			'base-ref: main',
			`base-sha: ${head}`,
			'freshness: synced',
			`phase0-tree-id: ${tree}`,
			`checkpoint-tree-id: ${tree}`,
			'handshake: MATCH',
			'tools: none',
			'merge: not-applicable',
			'next-action: test',
			'',
			'## Gates',
			'| gate | verdict | reviewed-commit | tree-id | artifact |',
			'|---|---|---|---|---|',
			'',
		].join('\n') + '\n',
	);
	fs.writeFileSync(
		path.join(traceDir, '01-issue-summary.md'),
		'## Source\nx\n## Observed Behavior\nx\n## Expected Behavior\nx\n## Acceptance Criteria\n- [ ] AC1: works\n## Classification\nVALID\n## Related Issues\nx\n',
	);
	return traceDir;
}

describe('trace-check phase 1 cluster-preflight gate (#3605 AC3)', () => {
	test('phase 1 fails when repro/cluster-preflight.md is absent', () => {
		const repoDir = makeRepo();
		makeTrace(repoDir);
		const result = run(repoDir, ['phase', '1', '--slug', 'issue-1']);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain('FAIL cluster-preflight');
		expect(result.out).toContain('phase-1 requires repro/cluster-preflight.md');
	}, 60_000);

	test('phase 1 fails when the artifact has no recorded-at line', () => {
		const repoDir = makeRepo();
		const traceDir = makeTrace(repoDir);
		fs.writeFileSync(
			path.join(traceDir, 'repro', 'cluster-preflight.md'),
			'## candidate #1\n\n- claim comments: none\n- open PRs: none\n',
		);
		const result = run(repoDir, ['phase', '1', '--slug', 'issue-1']);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain('missing its recorded-at line');
	}, 60_000);

	test('phase 1 fails a recorded-at-only artifact with zero candidate sections', () => {
		const repoDir = makeRepo();
		const traceDir = makeTrace(repoDir);
		fs.writeFileSync(
			path.join(traceDir, 'repro', 'cluster-preflight.md'),
			'recorded-at: 2026-01-01T00:00:00Z\n',
		);
		const result = run(repoDir, ['phase', '1', '--slug', 'issue-1']);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain('no candidate sections');
	}, 60_000);

	test('phase 1 fails a candidate section missing the claim evidence line', () => {
		const repoDir = makeRepo();
		const traceDir = makeTrace(repoDir);
		fs.writeFileSync(
			path.join(traceDir, 'repro', 'cluster-preflight.md'),
			'recorded-at: 2026-01-01T00:00:00Z\n\n## candidate #1\n\n- open PRs naming 1 in:body: none\n',
		);
		const result = run(repoDir, ['phase', '1', '--slug', 'issue-1']);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain('missing claim or open-PR evidence');
	}, 60_000);

	test('phase 1 fails a candidate section missing the open-PR evidence line', () => {
		const repoDir = makeRepo();
		const traceDir = makeTrace(repoDir);
		fs.writeFileSync(
			path.join(traceDir, 'repro', 'cluster-preflight.md'),
			'recorded-at: 2026-01-01T00:00:00Z\n\n## candidate #1\n\n- claim comments (live): none\n',
		);
		const result = run(repoDir, ['phase', '1', '--slug', 'issue-1']);
		expect(result.code).not.toBe(0);
		expect(result.out).toContain('missing claim or open-PR evidence');
	}, 60_000);

	test('phase 1 passes with a valid multi-candidate preflight artifact', () => {
		const repoDir = makeRepo();
		const traceDir = makeTrace(repoDir);
		fs.writeFileSync(
			path.join(traceDir, 'repro', 'cluster-preflight.md'),
			'recorded-at: 2026-01-01T00:00:00Z\n\n## candidate #3605\n\n- claim comments (live): none foreign\n- open PRs naming 3605 in:body: none\n- verdict: CLEAR\n\n## candidate #3601\n\n- claim comments (live): none foreign\n- open PRs naming 3601 in:body: none\n- verdict: CLEAR\n',
		);
		const result = run(repoDir, ['phase', '1', '--slug', 'issue-1']);
		expect(result.code).toBe(0);
		expect(result.out).toContain('OK cluster-preflight');
	}, 60_000);
});
