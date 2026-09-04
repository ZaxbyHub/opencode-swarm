import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Regression coverage for the round-6 H1 fix: with the documented
// append-only re-review path, a gate can accumulate TWO APPROVE rows for the
// same gate (a stale one from an earlier round, then a current one after
// re-review). artifact_identity_matches_gate must require the artifact's own
// identity to equal the CURRENT expected commit/tree AND require a gate row
// with exactly that identity to exist - not just "the first APPROVE row for
// this gate, whichever commit/tree it names".

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-check.sh',
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
		timeout: 15_000,
	});
	return { code: p.exitCode, out: p.stdout.toString() };
}
function repo() {
	const value = canonicalMkdtemp('trace-check-identity-rows-');
	roots.push(value);
	git(value, 'init', '-q', '-b', 'main');
	git(value, 'config', 'user.email', 'trace@example.invalid');
	git(value, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(value, 'subject.txt'), 'base\n');
	git(value, 'add', '-A');
	git(value, 'commit', '-q', '-m', 'base');
	fs.mkdirSync(path.join(value, '.git/info'), { recursive: true });
	fs.appendFileSync(
		path.join(value, '.git/info/exclude'),
		'.agents/issue-traces/\n',
	);
	return value;
}
function issueSummary() {
	return '## Source\nx\n## Observed Behavior\nx\n## Expected Behavior\nx\n## Acceptance Criteria\n- [ ] AC1: works\n## Classification\nVALID\n## Related Issues\nx\n';
}
function stateMd(head: string, tree: string, phase: string, gatesRows: string) {
	return `# Trace State: issue-1\nprotocol: 3.0.0\nphase: ${phase}\ntier: S\nclassification: VALID\nbase-ref: main\nbase-sha: ${head}\nfreshness: synced\nphase0-tree-id: ${tree}\ncheckpoint-tree-id: ${tree}\nhandshake: MATCH\ntools: none\nmerge: AWAITING_USER_APPROVAL\nnext-action: test\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n${gatesRows}`;
}

type Case = {
	gate: string;
	phase: string;
	setup: (dir: string, identity: string) => void;
};

const cases: Case[] = [
	{
		gate: 'plan-critic',
		phase: '3',
		setup(dir, identity) {
			fs.writeFileSync(
				path.join(dir, '05-fix-plan.md'),
				'## Selected Fix\nx\n## Candidate Fixes\nx\n## Impact Analysis\nx\n## Anticipated Defect-Class Sweep (Phase 4.2)\nx\n',
			);
			fs.writeFileSync(path.join(dir, '07-approved-plan.md'), '## Plan\nx\n');
			fs.writeFileSync(
				path.join(dir, '06-critic-review.md'),
				`## Reviewed SHA / diff hash\n${identity}\n## Round 1\nx\n## Verdict\nAPPROVE\n## Check replay\nx\n`,
			);
		},
	},
	{
		gate: 'implementation-review',
		phase: '4.5',
		setup(dir, identity) {
			fs.writeFileSync(
				path.join(dir, '08b-implementation-review.md'),
				`## Reviewed SHA / diff hash\n${identity}\n## Verdict\nAPPROVE\n## Independently re-run\nx\n## Check integrity\nx\n## Deferred / Scoped-Out / Unwired\nx\n`,
			);
		},
	},
	{
		gate: 'final-critic',
		phase: '4.6',
		setup(dir, identity) {
			fs.writeFileSync(
				path.join(dir, '09-final-critic.md'),
				`## Reviewed SHA / diff hash\n${identity}\n## Verdict\nAPPROVE\n## Review Freshness\nx\n## Deferred / Scoped-Out / Unwired\nx\n## Acceptance criteria evidence\nAC1: covered\n`,
			);
		},
	},
];

for (const c of cases) {
	describe(`trace-check.sh phase ${c.phase} (${c.gate}) with two appended APPROVE rows`, () => {
		function setupTrace(worktree: string, gatesRows: string) {
			const dir = path.join(worktree, '.agents/issue-traces/issue-1');
			fs.mkdirSync(path.join(dir, 'repro'), { recursive: true });
			const head = git(worktree, 'rev-parse', 'HEAD');
			const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
			fs.writeFileSync(
				path.join(dir, 'state.md'),
				stateMd(head, tree, c.phase, gatesRows),
			);
			fs.writeFileSync(path.join(dir, '01-issue-summary.md'), issueSummary());
			return { dir, head, tree };
		}

		test('stale row first, current row second + CURRENT artifact identity -> OK', () => {
			const worktree = repo();
			const head = git(worktree, 'rev-parse', 'HEAD');
			const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
			const stale = 'a'.repeat(40);
			const gatesRows =
				`| ${c.gate} | APPROVE | ${stale} | ${tree} | artifact |\n` +
				`| ${c.gate} | APPROVE | ${head} | ${tree} | artifact |\n`;
			const { dir } = setupTrace(worktree, gatesRows);
			c.setup(dir, `reviewed-commit: ${head}\ntree-id: ${tree}`);
			const result = run(worktree, ['phase', c.phase, '--slug', 'issue-1']);
			expect(result.out).toContain(`OK artifact-identity-${c.gate}`);
			expect(result.code).toBe(0);
		});

		test('stale row first, current row second + STALE artifact identity -> FAIL', () => {
			const worktree = repo();
			const head = git(worktree, 'rev-parse', 'HEAD');
			const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
			const stale = 'a'.repeat(40);
			const gatesRows =
				`| ${c.gate} | APPROVE | ${stale} | ${tree} | artifact |\n` +
				`| ${c.gate} | APPROVE | ${head} | ${tree} | artifact |\n`;
			const { dir } = setupTrace(worktree, gatesRows);
			c.setup(dir, `reviewed-commit: ${stale}\ntree-id: ${tree}`);
			const result = run(worktree, ['phase', c.phase, '--slug', 'issue-1']);
			expect(result.out).toContain(`FAIL artifact-identity-${c.gate}`);
			expect(result.code).toBe(1);
		});

		test('current row first, stale row second (reverse order) + CURRENT artifact -> OK', () => {
			const worktree = repo();
			const head = git(worktree, 'rev-parse', 'HEAD');
			const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
			const stale = 'a'.repeat(40);
			const gatesRows =
				`| ${c.gate} | APPROVE | ${head} | ${tree} | artifact |\n` +
				`| ${c.gate} | APPROVE | ${stale} | ${tree} | artifact |\n`;
			const { dir } = setupTrace(worktree, gatesRows);
			c.setup(dir, `reviewed-commit: ${head}\ntree-id: ${tree}`);
			const result = run(worktree, ['phase', c.phase, '--slug', 'issue-1']);
			expect(result.out).toContain(`OK artifact-identity-${c.gate}`);
			expect(result.code).toBe(0);
		});
	});
}
