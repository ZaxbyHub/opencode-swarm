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
	return { code: p.exitCode, out: p.stdout.toString() };
}
function repo() {
	const value = canonicalMkdtemp('trace-check-identity-');
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
function setup(worktree: string, gatesRow: string) {
	const dir = path.join(worktree, '.agents/issue-traces/issue-1');
	fs.mkdirSync(path.join(dir, 'repro'), { recursive: true });
	const head = git(worktree, 'rev-parse', 'HEAD');
	const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
	fs.writeFileSync(
		path.join(dir, 'state.md'),
		`# Trace State: issue-1\nprotocol: 3.0.0\nphase: 3\ntier: S\nclassification: VALID\nbase-ref: main\nbase-sha: ${head}\nfreshness: synced\nphase0-tree-id: ${tree}\ncheckpoint-tree-id: ${tree}\nhandshake: MATCH\ntools: none\nmerge: AWAITING_USER_APPROVAL\nnext-action: test\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n${gatesRow}`,
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
	return { dir, head, tree };
}
function criticReview(dir: string, identityBody: string) {
	fs.writeFileSync(
		path.join(dir, '06-critic-review.md'),
		`## Reviewed SHA / diff hash\n${identityBody}\n## Round 1\nx\n## Verdict\nAPPROVE\n## Check replay\nx\n`,
	);
}

describe('trace-check.sh phase 3 plan-critic identity binding', () => {
	test('06-critic-review.md identity differing from the gate row FAILS', () => {
		const worktree = repo();
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		const { dir } = setup(
			worktree,
			`| plan-critic | APPROVE | ${head} | ${tree} | 06-critic-review |\n`,
		);
		// Artifact claims a different (wrong) reviewed-commit than the gate row.
		criticReview(dir, `reviewed-commit: ${'a'.repeat(40)}\ntree-id: ${tree}`);
		const result = run(worktree, ['phase', '3', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL artifact-identity-plan-critic');
	});

	test('06-critic-review.md identity matching the gate row (HEAD/tree_id) passes', () => {
		const worktree = repo();
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		const { dir } = setup(
			worktree,
			`| plan-critic | APPROVE | ${head} | ${tree} | 06-critic-review |\n`,
		);
		criticReview(dir, `reviewed-commit: ${head}\ntree-id: ${tree}`);
		const result = run(worktree, ['phase', '3', '--slug', 'issue-1']);
		expect(result.out).toContain('OK artifact-identity-plan-critic');
		expect(result.code).toBe(0);
	});

	test('a Phase 3 gate row with a stale reviewed-commit (not current HEAD) FAILS', () => {
		const worktree = repo();
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		const stale = 'b'.repeat(40);
		const { dir } = setup(
			worktree,
			`| plan-critic | APPROVE | ${stale} | ${tree} | 06-critic-review |\n`,
		);
		criticReview(dir, `reviewed-commit: ${stale}\ntree-id: ${tree}`);
		const result = run(worktree, ['phase', '3', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL gate-plan-critic');
	});

	test('missing reviewed-commit/tree-id lines in the artifact FAILS identity binding', () => {
		const worktree = repo();
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		const { dir } = setup(
			worktree,
			`| plan-critic | APPROVE | ${head} | ${tree} | 06-critic-review |\n`,
		);
		criticReview(dir, '[reviewed-commit and tree-id you examined.]');
		const result = run(worktree, ['phase', '3', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL artifact-identity-plan-critic');
	});
});

describe('trace-check.sh phase 5 pr-head binding', () => {
	function repo5() {
		const value = canonicalMkdtemp('trace-check-prhead-');
		roots.push(value);
		git(value, 'init', '-q', '-b', 'main');
		git(value, 'config', 'user.email', 'trace@example.invalid');
		git(value, 'config', 'user.name', 'Trace');
		fs.writeFileSync(path.join(value, 'subject.txt'), 'base\n');
		git(value, 'add', '-A');
		git(value, 'commit', '-q', '-m', 'base');
		return value;
	}
	function setup5(worktree: string) {
		const dir = path.join(worktree, '.agents/issue-traces/issue-1');
		fs.mkdirSync(path.join(dir, 'repro'), { recursive: true });
		const head = git(worktree, 'rev-parse', 'HEAD');
		fs.writeFileSync(
			path.join(dir, 'state.md'),
			`# Trace State: issue-1\nprotocol: 3.0.0\nphase: 5\ntier: S\nclassification: VALID\nbase-ref: main\nbase-sha: ${head}\nfreshness: synced\nphase0-tree-id: ${'a'.repeat(40)}\ncheckpoint-tree-id: ${'a'.repeat(40)}\nhandshake: MATCH\ntools: none\nmerge: AWAITING_USER_APPROVAL\nnext-action: test\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n`,
		);
		fs.writeFileSync(
			path.join(dir, '01-issue-summary.md'),
			'## Source\nx\n## Observed Behavior\nx\n## Expected Behavior\nx\n## Acceptance Criteria\n- [ ] AC1: works\n## Classification\nVALID\n## Related Issues\nx\n',
		);
		return dir;
	}

	test('a PR head line not matching HEAD FAILS with the exact reason', () => {
		const worktree = repo5();
		const dir = setup5(worktree);
		const wrong = 'c'.repeat(40);
		fs.writeFileSync(
			path.join(dir, '10-pr-body.md'),
			`## Acceptance Criteria -> Evidence\nx\n## Waivers (or none)\nnone\nPR head: ${wrong}\n`,
		);
		const result = run(worktree, ['phase', '5', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL pr-head: does not match HEAD');
	});

	test('a PR head line matching HEAD passes', () => {
		const worktree = repo5();
		const dir = setup5(worktree);
		const head = git(worktree, 'rev-parse', 'HEAD');
		fs.writeFileSync(
			path.join(dir, '10-pr-body.md'),
			`## Acceptance Criteria -> Evidence\nx\n## Waivers (or none)\nnone\nPR head: ${head}\n`,
		);
		const result = run(worktree, ['phase', '5', '--slug', 'issue-1']);
		expect(result.out).toContain('OK pr-head');
	});
});

describe('trace-check.sh artifact_verdict_approved requires exactly one APPROVE line', () => {
	function repoV() {
		const value = canonicalMkdtemp('trace-check-verdict-');
		roots.push(value);
		git(value, 'init', '-q', '-b', 'main');
		git(value, 'config', 'user.email', 'trace@example.invalid');
		git(value, 'config', 'user.name', 'Trace');
		fs.writeFileSync(path.join(value, 'subject.txt'), 'base\n');
		git(value, 'add', '-A');
		git(value, 'commit', '-q', '-m', 'base');
		return value;
	}
	function setupV(worktree: string) {
		const dir = path.join(worktree, '.agents/issue-traces/issue-1');
		fs.mkdirSync(path.join(dir, 'repro'), { recursive: true });
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		fs.writeFileSync(
			path.join(dir, 'state.md'),
			`# Trace State: issue-1\nprotocol: 3.0.0\nphase: 4.5\ntier: S\nclassification: VALID\nbase-ref: main\nbase-sha: ${head}\nfreshness: synced\nphase0-tree-id: ${tree}\ncheckpoint-tree-id: ${tree}\nhandshake: MATCH\ntools: none\nmerge: AWAITING_USER_APPROVAL\nnext-action: test\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n| implementation-review | APPROVE | ${head} | ${tree} | 08b |\n`,
		);
		fs.writeFileSync(
			path.join(dir, '01-issue-summary.md'),
			'## Source\nx\n## Observed Behavior\nx\n## Expected Behavior\nx\n## Acceptance Criteria\n- [ ] AC1: works\n## Classification\nVALID\n## Related Issues\nx\n',
		);
		return dir;
	}

	test('a Verdict section with both APPROVE and BLOCKED lines FAILS', () => {
		const worktree = repoV();
		const dir = setupV(worktree);
		fs.writeFileSync(
			path.join(dir, '08b-implementation-review.md'),
			'## Reviewed SHA / diff hash\nx\n## Verdict\nAPPROVE\nBLOCKED\n## Independently re-run\nx\n## Check integrity\nx\n## Deferred / Scoped-Out / Unwired\nx\n',
		);
		const result = run(worktree, ['phase', '4.5', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL artifact-verdict-implementation-review');
	});

	test('a Verdict section with exactly one APPROVE line passes', () => {
		const worktree = repoV();
		const dir = setupV(worktree);
		fs.writeFileSync(
			path.join(dir, '08b-implementation-review.md'),
			'## Reviewed SHA / diff hash\nx\n## Verdict\nAPPROVE\n## Independently re-run\nx\n## Check integrity\nx\n## Deferred / Scoped-Out / Unwired\nx\n',
		);
		const result = run(worktree, ['phase', '4.5', '--slug', 'issue-1']);
		expect(result.out).toContain('OK artifact-verdict-implementation-review');
	});

	test('a Verdict section with two APPROVE lines (duplicate) FAILS', () => {
		const worktree = repoV();
		const dir = setupV(worktree);
		fs.writeFileSync(
			path.join(dir, '08b-implementation-review.md'),
			'## Reviewed SHA / diff hash\nx\n## Verdict\nAPPROVE\nAPPROVE\n## Independently re-run\nx\n## Check integrity\nx\n## Deferred / Scoped-Out / Unwired\nx\n',
		);
		const result = run(worktree, ['phase', '4.5', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL artifact-verdict-implementation-review');
	});
});

describe('trace-check.sh phase 0 freshness grammar is fully anchored', () => {
	function repoF() {
		const value = canonicalMkdtemp('trace-check-freshness-');
		roots.push(value);
		git(value, 'init', '-q', '-b', 'main');
		git(value, 'config', 'user.email', 'trace@example.invalid');
		git(value, 'config', 'user.name', 'Trace');
		fs.writeFileSync(path.join(value, 'subject.txt'), 'base\n');
		git(value, 'add', '-A');
		git(value, 'commit', '-q', '-m', 'base');
		return value;
	}
	function setupF(worktree: string, freshness: string) {
		const dir = path.join(worktree, '.agents/issue-traces/issue-1');
		fs.mkdirSync(path.join(dir, 'repro'), { recursive: true });
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		fs.writeFileSync(
			path.join(dir, 'state.md'),
			`# Trace State: issue-1\nprotocol: 3.0.0\nphase: 0\ntier: S\nclassification: unset\nbase-ref: main\nbase-sha: ${head}\nfreshness: ${freshness}\nphase0-tree-id: ${tree}\ncheckpoint-tree-id: unset\nhandshake: unset\ntools: none\nmerge: not-applicable\nnext-action: unset\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n`,
		);
		return dir;
	}

	test('fetch-failed:<reason> user-override:"<value>" followed by trailing garbage FAILS', () => {
		const worktree = repoF();
		setupF(worktree, 'fetch-failed:x user-override:"yes" garbage');
		const result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL freshness-fail-closed');
	});

	test('a clean fetch-failed:<reason> user-override:"<value>" line passes', () => {
		const worktree = repoF();
		setupF(worktree, 'fetch-failed:x user-override:"yes"');
		const result = run(worktree, ['phase', '0', '--slug', 'issue-1']);
		expect(result.out).toContain('OK freshness');
	});
});
