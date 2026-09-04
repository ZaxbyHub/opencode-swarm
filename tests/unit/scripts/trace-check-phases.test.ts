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
	const value = canonicalMkdtemp('trace-check-phases-');
	roots.push(value);
	git(value, 'init', '-q', '-b', 'main');
	git(value, 'config', 'user.email', 'trace@example.invalid');
	git(value, 'config', 'user.name', 'Trace');
	fs.writeFileSync(path.join(value, 'subject.txt'), 'base\n');
	git(value, 'add', '-A');
	git(value, 'commit', '-q', '-m', 'base');
	return value;
}
function setup(worktree: string, classification = 'VALID') {
	const dir = path.join(worktree, '.agents/issue-traces/issue-1');
	fs.mkdirSync(path.join(dir, 'repro'), { recursive: true });
	const head = git(worktree, 'rev-parse', 'HEAD');
	const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
	fs.writeFileSync(
		path.join(dir, 'state.md'),
		`# Trace State: issue-1\nprotocol: 3.0.0\nphase: 2.5\ntier: S\nclassification: ${classification}\nbase-ref: main\nbase-sha: ${head}\nfreshness: synced\nphase0-tree-id: ${tree}\ncheckpoint-tree-id: ${tree}\nhandshake: MATCH\ntools: none\nmerge: AWAITING_USER_APPROVAL\nnext-action: test\n\n## Gates\n| gate | verdict | reviewed-commit | tree-id | artifact |\n|---|---|---|---|---|\n`,
	);
	fs.writeFileSync(
		path.join(dir, '01-issue-summary.md'),
		'## Source\nx\n## Observed Behavior\nx\n## Expected Behavior\nx\n## Acceptance Criteria\n- [ ] AC1: works\n- [ ] AC2: remains\n## Classification\nVALID\n## Related Issues\nx\n',
	);
	return dir;
}
function reproduction(dir: string, rows: string) {
	fs.writeFileSync(
		path.join(dir, '02-reproduction.md'),
		`## Commands Tried\n\`\`\`text\nrun\n\`\`\`\n- Exit code: 1\n## Reproduction Verdict\nred\n## Acceptance checks\n| AC | class | check | argv | expect | pre-fix | post-fix | notes |\n|---|---|---|---|---|---|---|---|\n${rows}\n## Red checkpoint\nmanifest: repro/checkpoint.manifest\ncheckpoint-tree-id: TREE\n`,
	);
}
function manifest(dir: string, paths = ['subject.txt']) {
	fs.writeFileSync(
		path.join(dir, 'repro/checkpoint.manifest'),
		`# issue-tracer checkpoint manifest v1\n1\tCHECKPOINT\t${paths[0]}\t${'a'.repeat(40)}\t100644\tC1\tcmd\t-\t${'b'.repeat(40)}\t-\n`,
	);
}
function replaceTree(dir: string, tree: string) {
	const file = path.join(dir, '02-reproduction.md');
	fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('TREE', tree));
	const state = path.join(dir, 'state.md');
	fs.writeFileSync(
		state,
		fs
			.readFileSync(state, 'utf8')
			.replace(/checkpoint-tree-id: [^\n]+/, `checkpoint-tree-id: ${tree}`),
	);
}

describe('trace-check.sh later phases', () => {
	test('phase 2.5 rejects table and checkpoint integrity failures', () => {
		// note: multiple sequential script invocations under Windows Git Bash;
		// extend beyond the default per-test budget (see 20_000ms below).
		const worktree = repo();
		const dir = setup(worktree);
		const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
		reproduction(
			dir,
			'| AC1 | DISCRIMINATING | C1 | cmd | fail | RED | pending | x |',
		);
		replaceTree(dir, tree);
		manifest(dir);
		let result = run(worktree, ['phase', '2.5', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL acceptance-AC2');
		reproduction(
			dir,
			'| AC1 | DISCRIMINATING | C1 | cmd | fail | RED | pending | x |\n| AC1 | NON-EXECUTABLE | DOCS_ONLY | - | - | - | pending | evidence |\n| AC2 | NON-EXECUTABLE | DOCS_ONLY | - | - | - | pending | evidence |',
		);
		replaceTree(dir, tree);
		result = run(worktree, ['phase', '2.5', '--slug', 'issue-1']);
		expect(result.out).toContain('FAIL acceptance-AC1');
		reproduction(
			dir,
			'| AC1 | INVALID | C1 | cmd | - | RED | pending | x |\n| AC2 | NON-EXECUTABLE | UNKNOWN | - | - | - | pending | evidence |',
		);
		replaceTree(dir, tree);
		result = run(worktree, ['phase', '2.5', '--slug', 'issue-1']);
		expect(result.out).toContain('FAIL class-AC1');
		expect(result.out).toContain('FAIL non-executable-AC2');
		reproduction(
			dir,
			'| AC1 | DISCRIMINATING | C1 | cmd | fail | RED | pending | x |\n| AC2 | NON-EXECUTABLE | DOCS_ONLY | - | - | - | pending | evidence |',
		);
		replaceTree(dir, tree);
		result = run(worktree, ['phase', '2.5', '--slug', 'issue-1']);
		expect(result.out).toContain('FAIL base-log-C1');
		fs.writeFileSync(path.join(dir, 'repro/C1.base.log'), 'fail\n');
		fs.rmSync(path.join(dir, 'repro/checkpoint.manifest'));
		result = run(worktree, ['phase', '2.5', '--slug', 'issue-1']);
		expect(result.out).toContain('FAIL checkpoint-manifest');
	}, 20_000);

	test('phase 2.5 rejects an unmanifested checkpoint diff and phase 4 catches missing checks and changed checkpoint files', () => {
		const worktree = repo();
		const dir = setup(worktree);
		fs.writeFileSync(path.join(worktree, 'other.txt'), 'new\n');
		git(worktree, 'add', 'other.txt');
		const checkpoint = git(worktree, 'write-tree');
		git(worktree, 'reset', '--', 'other.txt');
		reproduction(
			dir,
			'| AC1 | DISCRIMINATING | C1 | cmd | fail | RED | pending | x |\n| AC2 | NON-EXECUTABLE | DOCS_ONLY | - | - | - | pending | evidence |',
		);
		replaceTree(dir, checkpoint);
		fs.writeFileSync(path.join(dir, 'repro/C1.base.log'), 'fail\n');
		manifest(dir);
		let result = run(worktree, ['phase', '2.5', '--slug', 'issue-1']);
		expect(result.out).toContain('FAIL manifest-path-other.txt');
		// git clean -fd would also remove the untracked (git-excluded)
		// .agents/issue-traces dir in this fixture repo; remove only the
		// probe file it created.
		fs.rmSync(path.join(worktree, 'other.txt'));
		replaceTree(dir, git(worktree, 'rev-parse', 'HEAD^{tree}'));
		fs.writeFileSync(
			path.join(dir, '08-test-results.md'),
			'## Regression Test\nx\n## Acceptance check results\nx\n## Quality Checks\nx\n## Deferred-Work Scan\nscan-deferred: clean\n## Verification Reasoning\nx\n## Checkpoint verification\nx\n',
		);
		result = run(worktree, ['phase', '4', '--slug', 'issue-1']);
		expect(result.out).toContain('FAIL check-block-C1');
		expect(result.out).toContain('FAIL checkpoint-verification');
	});

	test('phase 4.2 verifies disposition totals, phase 4.5 verifies clean and current review, and merge binds SHA', () => {
		const worktree = repo();
		const dir = setup(worktree);
		fs.writeFileSync(
			path.join(dir, '08a-recurrence-sweep.md'),
			'## Defect Class\nx\n## Predicates and Results\n- Predicate alpha hits: 2\n## Dispositions\n| path | status |\n|---|---|\n| a | fixed |\n## Guardrail\n### Check C1 RED then GREEN\n',
		);
		let result = run(worktree, ['phase', '4.2', '--slug', 'issue-1']);
		expect(result.out).toContain('FAIL recurrence-dispositions');
		fs.writeFileSync(path.join(worktree, 'dirty.txt'), 'x\n');
		fs.writeFileSync(
			path.join(dir, '08b-implementation-review.md'),
			'## Reviewed SHA / diff hash\nx\n## Verdict\nAPPROVE\n## Independently re-run\nx\n## Check integrity\nx\n## Deferred / Scoped-Out / Unwired\nx\n',
		);
		result = run(worktree, ['phase', '4.5', '--slug', 'issue-1']);
		expect(result.out).toContain('FAIL clean-tree');
		fs.rmSync(path.join(worktree, 'dirty.txt'));
		result = run(worktree, ['phase', '4.5', '--slug', 'issue-1']);
		expect(result.out).toContain('FAIL gate-implementation-review');
		const head = git(worktree, 'rev-parse', 'HEAD');
		fs.writeFileSync(
			path.join(dir, '10b-merge-approval.md'),
			`## User approval (verbatim)\nyes\n## PR head SHA\n${head}\n## Final critic reviewed-commit\n${'0'.repeat(40)}\n`,
		);
		result = run(worktree, ['merge', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL merge-sha-binding');
		expect(result.out).toContain('NOTE: human-enforced gate');
	}, 20_000);

	test('phase 5 requires the pr-template headings, a PR head line, and an anchored merge state', () => {
		const worktree = repo();
		const dir = setup(worktree);
		const head = git(worktree, 'rev-parse', 'HEAD');
		fs.writeFileSync(
			path.join(dir, '10-pr-body.md'),
			'## Acceptance Criteria\nx\n## Waivers\nnone\n',
		);
		let result = run(worktree, ['phase', '5', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain(
			'FAIL heading-Acceptance Criteria -> Evidence',
		);
		expect(result.out).toContain('FAIL heading-Waivers (or none)');
		expect(result.out).toContain('FAIL pr-head');

		fs.writeFileSync(
			path.join(dir, '10-pr-body.md'),
			`## Acceptance Criteria -> Evidence\nx\n## Waivers (or none)\nnone\nPR head: ${head}\n`,
		);
		result = run(worktree, ['phase', '5', '--slug', 'issue-1']);
		expect(result.out).toContain('OK pr-head');
		expect(result.out).toContain('OK merge-state');

		const state = path.join(dir, 'state.md');
		fs.writeFileSync(
			state,
			fs
				.readFileSync(state, 'utf8')
				.replace('merge: AWAITING_USER_APPROVAL', 'merge: PENDING'),
		);
		result = run(worktree, ['phase', '5', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('FAIL merge-state');

		fs.writeFileSync(
			state,
			fs
				.readFileSync(state, 'utf8')
				.replace('merge: PENDING', `merge: APPROVED:${head}`),
		);
		result = run(worktree, ['phase', '5', '--slug', 'issue-1']);
		expect(result.out).toContain('OK merge-state');
	});

	test('phase 4.2 fast path requires a ## Justification heading with content', () => {
		const worktree = repo();
		const dir = setup(worktree);
		fs.writeFileSync(
			path.join(dir, '08a-recurrence-sweep.md'),
			'## Defect Class\nno defect class - pure rename\n',
		);
		let result = run(worktree, ['phase', '4.2', '--slug', 'issue-1']);
		expect(result.code).toBe(1);
		expect(result.out).not.toContain('OK recurrence-sweep');

		fs.writeFileSync(
			path.join(dir, '08a-recurrence-sweep.md'),
			'## Defect Class\nno defect class - pure rename\n## Justification\nRename only, no behavior change.\n',
		);
		result = run(worktree, ['phase', '4.2', '--slug', 'issue-1']);
		expect(result.code).toBe(0);
		expect(result.out).toContain('OK recurrence-sweep');
	});

	test('ALREADY_FIXED traces use the required subset after phase 2', () => {
		const worktree = repo();
		const dir = setup(worktree, 'ALREADY_FIXED');
		fs.writeFileSync(
			path.join(dir, '02-reproduction.md'),
			'## Commands Tried\n```text\nx\n```\n- Exit code: 0\n## Reproduction Verdict\ngreen\n## Fixing Change\nx\n',
		);
		for (const phase of ['2.5', '3', '4', '4.2', '4.5', '4.6', '5']) {
			const result = run(worktree, ['phase', phase, '--slug', 'issue-1']);
			expect(result.code).toBe(0);
			expect(result.out).toContain('OK obe-subset');
		}
	});
});
