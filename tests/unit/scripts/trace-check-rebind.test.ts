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
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}
function repo() {
	const value = canonicalMkdtemp('trace-check-rebind-');
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
// mode: 'none' leaves the Gates table empty; 'plan-critic' records a
// plan-critic APPROVE row at the current head/tree; 'impl-review' records
// plan-critic AND implementation-review rows at the current head/tree.
function setup(worktree: string, mode: 'none' | 'plan-critic' | 'impl-review') {
	const dir = path.join(worktree, '.agents/issue-traces/issue-1');
	fs.mkdirSync(path.join(dir, 'repro'), { recursive: true });
	const head = git(worktree, 'rev-parse', 'HEAD');
	const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
	let gatesRows = '';
	if (mode === 'plan-critic' || mode === 'impl-review') {
		gatesRows += `| plan-critic | APPROVE | ${head} | ${tree} | 06-critic-review.md |\n`;
	}
	if (mode === 'impl-review') {
		gatesRows += `| implementation-review | APPROVE | ${head} | ${tree} | 08b |\n`;
	}
	fs.writeFileSync(
		path.join(dir, 'state.md'),
		`# Trace State: issue-1\nprotocol: 3.0.0\nphase: 3\ntier: S\nclassification: VALID\nbase-ref: main\nbase-sha: ${head}\nfreshness: synced\nphase0-tree-id: ${tree}\ncheckpoint-tree-id: ${tree}\nhandshake: MATCH\ntools: none\nmerge: AWAITING_USER_APPROVAL\nnext-action: test\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n${gatesRows}`,
	);
	fs.writeFileSync(
		path.join(dir, '01-issue-summary.md'),
		'## Source\nx\n## Observed Behavior\nx\n## Expected Behavior\nx\n## Acceptance Criteria\n- [ ] AC1: works\n## Classification\nVALID\n## Related Issues\nx\n',
	);
	fs.writeFileSync(
		path.join(dir, '05-fix-plan.md'),
		'## Selected Fix\nx\n## Candidate Fixes\nx\n## Impact Analysis\nx\n## Anticipated Defect-Class Sweep (Phase 4.2)\nx\n',
	);
	fs.writeFileSync(path.join(dir, '07-approved-plan.md'), '## Plan\nx\n');
	fs.writeFileSync(
		path.join(dir, '06-critic-review.md'),
		`## Reviewed SHA / diff hash\nreviewed-commit: ${head}\ntree-id: ${tree}\n## Round 1\nx\n## Verdict\nAPPROVE\n## Check replay\nx\n`,
	);
	return { dir, head, tree };
}
function implCommit(worktree: string) {
	fs.writeFileSync(path.join(worktree, 'subject.txt'), 'impl\n');
	git(worktree, 'add', '-A');
	git(worktree, 'commit', '-q', '-m', 'impl');
	return {
		head: git(worktree, 'rev-parse', 'HEAD'),
		tree: git(worktree, 'rev-parse', 'HEAD^{tree}'),
	};
}

describe('trace-check.sh rebind subcommand', () => {
	test('rebind prints a row bound to the current HEAD/tree with the rebind marker', () => {
		const worktree = repo();
		setup(worktree, 'plan-critic');
		const { head, tree } = implCommit(worktree);
		const result = run(worktree, [
			'rebind',
			'--gate',
			'plan-critic',
			'--reason',
			'POST_IMPL drift',
			'--slug',
			'issue-1',
		]);
		expect(result.code).toBe(0);
		expect(result.out).toContain(
			`| plan-critic | APPROVE | ${head} | ${tree} | 06-critic-review.md rebind(POST_IMPL drift) |`,
		);
		expect(result.err).toContain('rebind: append this row');
	}, 60_000);

	test('rebind refuses when the latest APPROVE row already binds the current HEAD/tree', () => {
		const worktree = repo();
		setup(worktree, 'plan-critic');
		const result = run(worktree, [
			'rebind',
			'--gate',
			'plan-critic',
			'--reason',
			'should refuse: no drift',
			'--slug',
			'issue-1',
		]);
		expect(result.code).toBe(1);
		expect(result.err).toContain('nothing to rebind');
	}, 60_000);

	test('rebind refuses when no plan-critic APPROVE row exists', () => {
		const worktree = repo();
		setup(worktree, 'none');
		implCommit(worktree);
		const result = run(worktree, [
			'rebind',
			'--gate',
			'plan-critic',
			'--reason',
			'no row to rebind',
			'--slug',
			'issue-1',
		]);
		expect(result.code).toBe(1);
		expect(result.err).toContain('no plan-critic APPROVE row to rebind from');
	}, 60_000);

	test('rebind refuses unknown gates, missing reasons, and pipe characters', () => {
		const worktree = repo();
		setup(worktree, 'plan-critic');
		implCommit(worktree);
		const unknownGate = run(worktree, [
			'rebind',
			'--gate',
			'merge-approval',
			'--reason',
			'x',
			'--slug',
			'issue-1',
		]);
		expect(unknownGate.code).toBe(2);
		expect(unknownGate.err).toContain('rebind --gate must be');
		const noReason = run(worktree, [
			'rebind',
			'--gate',
			'plan-critic',
			'--slug',
			'issue-1',
		]);
		expect(noReason.code).toBe(2);
		expect(noReason.err).toContain('requires a non-empty --reason');
		const pipeReason = run(worktree, [
			'rebind',
			'--gate',
			'plan-critic',
			'--reason',
			'bad|pipe',
			'--slug',
			'issue-1',
		]);
		expect(pipeReason.code).toBe(2);
		expect(pipeReason.err).toContain('cannot contain a pipe character');
	}, 60_000);
});

describe('trace-check.sh phase 3 rebind chain', () => {
	test('phase 3 accepts historical APPROVE + rebind row at the current head', () => {
		const worktree = repo();
		const { dir, head, tree } = setup(worktree, 'plan-critic');
		const { head: h2, tree: t2 } = implCommit(worktree);
		fs.appendFileSync(
			path.join(dir, 'state.md'),
			`| plan-critic | APPROVE | ${h2} | ${t2} | 06-critic-review.md rebind(POST_IMPL drift) |\n`,
		);
		const result = run(worktree, ['phase', '3', '--slug', 'issue-1']);
		expect(result.code).toBe(0);
		expect(result.out).toContain('OK artifact-identity-plan-critic-rebind-chain');
	}, 60_000);

	test('phase 3 without the rebind row still FAILS with both known FAILs', () => {
		const worktree = repo();
		setup(worktree, 'plan-critic');
		implCommit(worktree);
		const result = run(worktree, ['phase', '3', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL gate-plan-critic');
		expect(result.out).toContain('FAIL artifact-identity-plan-critic:');
	}, 60_000);
});

describe('trace-check.sh phase 4.5 stays strict under rebind rows', () => {
	test('a rebind row does not satisfy implementation-review', () => {
		const worktree = repo();
		const { dir, head, tree } = setup(worktree, 'impl-review');
		const { head: h2, tree: t2 } = implCommit(worktree);
		const statePath = path.join(dir, 'state.md');
		fs.writeFileSync(
			statePath,
			fs.readFileSync(statePath, 'utf8').replace('phase: 3', 'phase: 4.5'),
		);
		fs.appendFileSync(
			statePath,
			`| implementation-review | APPROVE | ${h2} | ${t2} | 08b rebind(x) |\n`,
		);
		fs.writeFileSync(
			path.join(dir, '08b-implementation-review.md'),
			`## Reviewed SHA / diff hash\nreviewed-commit: ${head}\ntree-id: ${tree}\n## Verdict\nAPPROVE\n## Independently re-run\nx\n## Check integrity\nx\n## Deferred / Scoped-Out / Unwired\nx\n`,
		);
		const result = run(worktree, ['phase', '4.5', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL artifact-identity-implementation-review');
	}, 60_000);
});
