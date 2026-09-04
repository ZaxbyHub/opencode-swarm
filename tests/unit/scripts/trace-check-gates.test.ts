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
	const value = canonicalMkdtemp('trace-check-gates-');
	roots.push(value);
	git(value, 'init', '-q', '-b', 'main');
	git(value, 'config', 'user.email', 'trace@example.invalid');
	git(value, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(value, 'subject.txt'), 'base\n');
	git(value, 'add', '-A');
	git(value, 'commit', '-q', '-m', 'base');
	// Mirror trace-init.sh's local exclude so an untracked .agents/issue-traces
	// tree does not collapse into a single "?? .agents/" line under plain
	// `git status --porcelain` (default untracked-files mode does not descend
	// into a wholly-untracked directory), which would make clean_tree's
	// path-scoped filter miss it entirely and falsely report dirty.
	fs.mkdirSync(path.join(value, '.git/info'), { recursive: true });
	fs.appendFileSync(
		path.join(value, '.git/info/exclude'),
		'.agents/issue-traces/\n',
	);
	return value;
}
function setup(worktree: string, gatesRow = '') {
	const dir = path.join(worktree, '.agents/issue-traces/issue-1');
	fs.mkdirSync(path.join(dir, 'repro'), { recursive: true });
	const head = git(worktree, 'rev-parse', 'HEAD');
	const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
	fs.writeFileSync(
		path.join(dir, 'state.md'),
		`# Trace State: issue-1\nprotocol: 3.0.0\nphase: 4.5\ntier: S\nclassification: VALID\nbase-ref: main\nbase-sha: ${head}\nfreshness: synced\nphase0-tree-id: ${tree}\ncheckpoint-tree-id: ${tree}\nhandshake: MATCH\ntools: none\nmerge: AWAITING_USER_APPROVAL\nnext-action: test\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n${gatesRow}`,
	);
	fs.writeFileSync(
		path.join(dir, '01-issue-summary.md'),
		'## Source\nx\n## Observed Behavior\nx\n## Expected Behavior\nx\n## Acceptance Criteria\n- [ ] AC1: works\n## Classification\nVALID\n## Related Issues\nx\n',
	);
	return { dir, head, tree };
}
function implementationReview(dir: string, verdictLine: string) {
	fs.writeFileSync(
		path.join(dir, '08b-implementation-review.md'),
		`## Reviewed SHA / diff hash\nx\n## Verdict\n${verdictLine}\n## Independently re-run\nx\n## Check integrity\nx\n## Deferred / Scoped-Out / Unwired\nx\n`,
	);
}

describe('trace-check.sh gate table parsing (state_gate)', () => {
	test('a DISAPPROVED verdict does not satisfy an APPROVE gate (unanchored-regex regression)', () => {
		const worktree = repo();
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		const { dir } = setup(
			worktree,
			`| implementation-review | DISAPPROVED | ${head} | ${tree} | 08b |\n`,
		);
		implementationReview(dir, 'APPROVE');
		const result = run(worktree, ['phase', '4.5', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL gate-implementation-review');
	});

	test('a mismatched tree-id at phase 4.5 fails the gate even with a matching commit and APPROVE verdict', () => {
		const worktree = repo();
		const head = git(worktree, 'rev-parse', 'HEAD');
		const { dir } = setup(
			worktree,
			`| implementation-review | APPROVE | ${head} | ${'f'.repeat(40)} | 08b |\n`,
		);
		implementationReview(dir, 'APPROVE');
		const result = run(worktree, ['phase', '4.5', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL gate-implementation-review');
	});

	test('a matching APPROVE row with correct commit and tree-id passes the gate', () => {
		const worktree = repo();
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		const { dir } = setup(
			worktree,
			`| implementation-review | APPROVE | ${head} | ${tree} | 08b |\n`,
		);
		implementationReview(dir, 'APPROVE');
		const result = run(worktree, ['phase', '4.5', '--slug', 'issue-1']);
		expect(result.out).toContain('OK gate-implementation-review');
	});

	test('an artifact Verdict of BLOCKED fails even when the Gates row itself says APPROVE', () => {
		const worktree = repo();
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		const { dir } = setup(
			worktree,
			`| implementation-review | APPROVE | ${head} | ${tree} | 08b |\n`,
		);
		implementationReview(dir, 'BLOCKED');
		const result = run(worktree, ['phase', '4.5', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL artifact-verdict-implementation-review');
	});

	test('"Verdict: APPROVE" text form is also accepted for the artifact verdict', () => {
		const worktree = repo();
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		const { dir } = setup(
			worktree,
			`| implementation-review | APPROVE | ${head} | ${tree} | 08b |\n`,
		);
		implementationReview(dir, 'Verdict: APPROVE');
		const result = run(worktree, ['phase', '4.5', '--slug', 'issue-1']);
		expect(result.out).toContain('OK artifact-verdict-implementation-review');
	});

	test('merge-approval gate requires an exact RECORDED verdict, not APPROVE', () => {
		const worktree = repo();
		const dir = path.join(worktree, '.agents/issue-traces/issue-1');
		fs.mkdirSync(path.join(dir, 'repro'), { recursive: true });
		const head = git(worktree, 'rev-parse', 'HEAD');
		fs.writeFileSync(
			path.join(dir, 'state.md'),
			`# Trace State: issue-1\nprotocol: 3.0.0\nphase: 5\ntier: S\nclassification: VALID\nbase-ref: main\nbase-sha: ${head}\nfreshness: synced\nphase0-tree-id: ${'a'.repeat(40)}\ncheckpoint-tree-id: ${'a'.repeat(40)}\nhandshake: MATCH\ntools: none\nmerge: AWAITING_USER_APPROVAL\nnext-action: test\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n| merge-approval | APPROVE | - | - | 10b |\n`,
		);
		fs.writeFileSync(
			path.join(dir, '10b-merge-approval.md'),
			`## User approval (verbatim)\nyes\n## PR head SHA\n${head}\n## Final critic reviewed-commit\n${head}\n`,
		);
		const result = run(worktree, ['merge', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL gate-merge-approval');
	});

	test('phase 3 fails when 06-critic-review.md has DISAPPROVED verdict despite APPROVE gate row', () => {
		const worktree = repo();
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		const { dir } = setup(
			worktree,
			`| plan-critic | APPROVE | ${head} | ${tree} | 06-critic-review |\n`,
		);
		// Add required phase 3 artifacts
		fs.writeFileSync(
			path.join(dir, '05-fix-plan.md'),
			`## Selected Fix\nFix description\n## Candidate Fixes\nOther options\n## Impact Analysis\nImpact details\n## Anticipated Defect-Class Sweep (Phase 4.2)\nSweep plan\n`,
		);
		fs.writeFileSync(
			path.join(dir, '06-critic-review.md'),
			`## Reviewed SHA / diff hash\n${head}\n## Verdict\nDISAPPROVED\n## Check replay\nReplayed\n## Round 1\nReview feedback\n`,
		);
		fs.writeFileSync(
			path.join(dir, '07-approved-plan.md'),
			'## Plan\nApproved plan\n',
		);
		const result = run(worktree, ['phase', '3', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL critic-verdict');
	});

	test('phase 3 fails when 06-critic-review.md has NEEDS_REVISION verdict despite APPROVE gate row', () => {
		const worktree = repo();
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		const { dir } = setup(
			worktree,
			`| plan-critic | APPROVE | ${head} | ${tree} | 06-critic-review |\n`,
		);
		// Add required phase 3 artifacts
		fs.writeFileSync(
			path.join(dir, '05-fix-plan.md'),
			`## Selected Fix\nFix description\n## Candidate Fixes\nOther options\n## Impact Analysis\nImpact details\n## Anticipated Defect-Class Sweep (Phase 4.2)\nSweep plan\n`,
		);
		fs.writeFileSync(
			path.join(dir, '06-critic-review.md'),
			`## Reviewed SHA / diff hash\n${head}\n## Verdict\nNEEDS_REVISION\n## Check replay\nReplayed\n## Round 1\nReview feedback\n`,
		);
		fs.writeFileSync(
			path.join(dir, '07-approved-plan.md'),
			'## Plan\nApproved plan\n',
		);
		const result = run(worktree, ['phase', '3', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL critic-verdict');
	});

	test('phase 3 passes when 06-critic-review.md has exactly APPROVE verdict', () => {
		const worktree = repo();
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		const { dir } = setup(
			worktree,
			`| plan-critic | APPROVE | ${head} | ${tree} | 06-critic-review |\n`,
		);
		// Add required phase 3 artifacts
		fs.writeFileSync(
			path.join(dir, '05-fix-plan.md'),
			`## Selected Fix\nFix description\n## Candidate Fixes\nOther options\n## Impact Analysis\nImpact details\n## Anticipated Defect-Class Sweep (Phase 4.2)\nSweep plan\n`,
		);
		fs.writeFileSync(
			path.join(dir, '06-critic-review.md'),
			`## Reviewed SHA / diff hash\n${head}\n## Verdict\nAPPROVE\n## Check replay\nReplayed\n## Round 1\nReview feedback\n`,
		);
		fs.writeFileSync(
			path.join(dir, '07-approved-plan.md'),
			'## Plan\nApproved plan\n',
		);
		const result = run(worktree, ['phase', '3', '--slug', 'issue-1']);
		expect(result.out).toContain('OK critic-verdict');
	});

	test('state_gate still matches the APPROVE row when state.md has no trailing newline', () => {
		const worktree = repo();
		const head = git(worktree, 'rev-parse', 'HEAD');
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		const { dir } = setup(worktree);
		implementationReview(dir, 'APPROVE');
		const statePath = path.join(dir, 'state.md');
		const withNewline = fs.readFileSync(statePath, 'utf8');
		// Build the content the same way the fixture does, then strip the
		// final newline so the last physical line (the gate row) has no
		// trailing "\n" -- mirrors `printf '%s'` writing an unterminated file.
		const gateRow = `| implementation-review | APPROVE | ${head} | ${tree} | 08b |`;
		const noTrailingNewline = `${withNewline.trimEnd()}\n${gateRow}`.replace(
			/\n$/,
			'',
		);
		fs.writeFileSync(statePath, noTrailingNewline);
		expect(noTrailingNewline.endsWith('\n')).toBe(false);
		const result = run(worktree, ['phase', '4.5', '--slug', 'issue-1']);
		expect(result.out).toContain('OK gate-implementation-review');
	});
});
