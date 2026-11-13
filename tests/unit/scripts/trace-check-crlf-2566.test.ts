import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-check.sh',
);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
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

function writeCrlf(file: string, content: string) {
	fs.writeFileSync(file, content.replace(/\n/g, '\r\n'));
}

describe('trace-check.sh CRLF fixture (#2566)', () => {
	test('accepts anchored phase-0 fields stored with CRLF line endings', () => {
		const repo = canonicalMkdtemp('trace-check-crlf-');
		roots.push(repo);
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'config', 'user.email', 'trace@example.invalid');
		git(repo, 'config', 'user.name', 'Trace');
		fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'seed');
		const sha = git(repo, 'rev-parse', 'HEAD');
		const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
		const trace = path.join(repo, '.agents', 'issue-traces', 'crlf-trace');
		fs.mkdirSync(path.join(trace, 'repro'), { recursive: true });
		const lines = [
			'# Trace State: crlf-trace',
			'protocol: 3.0.0',
			'phase: 0',
			'tier: S',
			'classification: VALID',
			'base-ref: main',
			`base-sha: ${sha}`,
			'freshness: synced',
			`phase0-tree-id: ${tree}`,
			`checkpoint-tree-id: ${tree}`,
			'handshake: ABSENT',
			'tools: none',
			'merge: not-applicable',
			'next-action: test',
			'',
			'## Gates',
			'| gate | verdict | reviewed-commit | tree-id | artifact |',
			'|---|---|---|---|---|',
			'',
		];
		fs.writeFileSync(path.join(trace, 'state.md'), `${lines.join('\r\n')}\r\n`);

		const proc = Bun.spawnSync({
			cmd: bashCommand(
				SCRIPT,
				'phase',
				'0',
				'--slug',
				'crlf-trace',
				'--trace-dir',
				trace,
			),
			cwd: repo,
			env: process.env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 15_000,
		});

		expect(
			proc.exitCode,
			`${proc.stdout.toString()}\n${proc.stderr.toString()}`,
		).toBe(0);
	}, 30_000);

	test('accepts CRLF in phase gates and all line-oriented trace artifacts', () => {
		const repo = canonicalMkdtemp('trace-check-crlf-gates-');
		roots.push(repo);
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'config', 'user.email', 'trace@example.invalid');
		git(repo, 'config', 'user.name', 'Trace');
		fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'seed');
		const sha = git(repo, 'rev-parse', 'HEAD');
		const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
		const trace = path.join(repo, '.agents', 'issue-traces', 'crlf-gates');
		fs.mkdirSync(path.join(trace, 'repro'), { recursive: true });

		writeCrlf(
			path.join(trace, 'state.md'),
			[
				'# Trace State: crlf-gates',
				'protocol: 3.0.0',
				'phase: 3',
				'tier: S',
				'classification: VALID',
				'base-ref: main',
				`base-sha: ${sha}`,
				'freshness: synced',
				`phase0-tree-id: ${tree}`,
				`checkpoint-tree-id: ${tree}`,
				'handshake: MATCH',
				'tools: none',
				'merge: AWAITING_USER_APPROVAL',
				'next-action: test',
				'',
				'## Gates',
				'| gate | verdict | reviewed-commit | tree-id | artifact |',
				'|---|---|---|---|---|',
				`| plan-critic | APPROVE | ${sha} | ${tree} | 06-critic-review |`,
				'| merge-approval | RECORDED | - | - | 10b-merge-approval |',
				'',
			].join('\n') + '\n',
		);
		writeCrlf(
			path.join(trace, '01-issue-summary.md'),
			'## Source\nx\n## Observed Behavior\nx\n## Expected Behavior\nx\n## Acceptance Criteria\n- [ ] AC1: works\n## Classification\nVALID\n## Related Issues\nx\n',
		);
		writeCrlf(
			path.join(trace, 'repro', 'cluster-preflight.md'),
			'recorded-at: 2026-01-01T00:00:00Z\n\n## candidate #1\n\n- claim comments (live): none\n- open PRs naming 1 in:body: none\n- verdict: CLEAR\n',
		);
		writeCrlf(
			path.join(trace, '02-reproduction.md'),
			'## Commands Tried\n```text\nrun\n```\n- Exit code: 1\n## Reproduction Verdict\nred\n',
		);
		writeCrlf(
			path.join(trace, '05-fix-plan.md'),
			'## Selected Fix\nfix\n## Candidate Fixes\nother\n## Impact Analysis\nimpact\n## Anticipated Defect-Class Sweep (Phase 4.2)\nsweep\n',
		);
		writeCrlf(
			path.join(trace, '06-critic-review.md'),
			`## Reviewed SHA / diff hash\nreviewed-commit: ${sha}\ntree-id: ${tree}\n## Verdict\nAPPROVE\n## Check replay\nreplayed\n## Round 1\nreview\n`,
		);
		writeCrlf(path.join(trace, '07-approved-plan.md'), '## Plan\napproved\n');
		writeCrlf(
			path.join(trace, '08a-recurrence-sweep.md'),
			'# Recurrence Sweep and Guardrail\n\nno-defect-class: true\n\n## Justification\nCRLF is supported.\n',
		);
		writeCrlf(
			path.join(trace, '10-pr-body.md'),
			`## Acceptance Criteria -> Evidence\nAC1 evidence\n## Waivers (or none)\nnone\nPR head: ${sha}\n`,
		);
		writeCrlf(
			path.join(trace, '10b-merge-approval.md'),
			`## User approval (verbatim)\nyes\n## PR head SHA\n${sha}\n## Final critic reviewed-commit\n${sha}\n`,
		);

		for (const [command, expected] of [
			[['phase', '1'], ['OK classification']],
			[
				['phase', '2'],
				['OK reproduction-text-block', 'OK reproduction-exit-code'],
			],
			[
				['phase', '3'],
				[
					'OK heading-round',
					'OK critic-verdict',
					'OK artifact-identity-plan-critic',
				],
			],
			[['phase', '4.2'], ['OK recurrence-sweep']],
			[
				['phase', '5'],
				['OK pr-head', 'OK merge-state'],
			],
			[['merge'], ['OK merge-sha-binding']],
		] as const) {
			const result = run(repo, [
				...command,
				'--slug',
				'crlf-gates',
				'--trace-dir',
				trace,
			]);
			expect(
				result.code,
				`${command.join(' ')}\n${result.out}\n${result.err}`,
			).toBe(0);
			for (const line of expected) expect(result.out).toContain(line);
		}
	}, 30_000);
});
