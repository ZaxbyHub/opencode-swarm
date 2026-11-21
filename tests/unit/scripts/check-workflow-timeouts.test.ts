import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	main,
	scanWorkflowsDir,
} from '../../../scripts/check-workflow-timeouts';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * check-workflow-timeouts (#2952): red/green fixtures over scratch workflow
 * directories plus a ratchet over the repository's real workflows. Pure
 * parser tests — no mock.module, no module mocking of any kind.
 */

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

function makeWorkflowRepo(
	text: string,
	name = 'release-and-publish.yml',
): string {
	const repo = canonicalMkdtemp('workflow-timeouts-');
	roots.push(repo);
	const dir = path.join(repo, '.github', 'workflows');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), text);
	return repo;
}

function runMain(
	argv: string[] = [],
	root: string,
): { code: number; out: string } {
	const original = console.log;
	let out = '';
	console.log = (message: string) => {
		out += `${message}\n`;
	};
	try {
		const code = main(argv, root);
		return { code, out };
	} finally {
		console.log = original;
	}
}

// The #2952-era shipped helper shape (pre-#3259: ci.yml wait 360 x 5 s under
// target-duration 30, job timeout 70), retained as a parser fixture. The
// live post-#3259 shape's ratchet lives in check-workflow-timeouts-issue-3259.test.ts.
// timeout-minutes: 70 covers three waits (3,000 s declared ->
// required 3,900 s) but NOT four (adding the definition line as a fourth
// 600 s call would push required to 4,620 s) — so this fixture passing green
// also proves the definition line is not counted as a call site.
const SHIPPED_SHAPE = `name: release
on:
  workflow_dispatch:
jobs:
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 70
    steps:
      - name: Wait
        run: |
          wait_for_dispatched_run() {
            workflow="$1"
            max_attempts="\${2:-120}"
            poll_seconds="\${3:-5}"
            for _attempt in $(seq 1 "$max_attempts"); do
              gh run list >/dev/null
              sleep "$poll_seconds"
            done
          }
          # target-duration: 30
          ci_record="$(wait_for_dispatched_run ci.yml 360 5)"
          # target-duration: 10
          standards_record="$(wait_for_dispatched_run pr-standards.yml 120 5)"
          # target-duration: 10
          drift_record="$(wait_for_dispatched_run drift-check.yml 120 5)"
`;

// The pre-fix shape: literal 120 x 5 loop, parameterless calls, timeout 10.
const PRE_FIX_SHAPE = `name: release
on:
  workflow_dispatch:
jobs:
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Wait
        run: |
          wait_for_dispatched_run() {
            workflow="$1"
            for _attempt in $(seq 1 120); do
              gh run list >/dev/null
              sleep 5
            done
          }
          ci_record="$(wait_for_dispatched_run ci.yml)"
          standards_record="$(wait_for_dispatched_run pr-standards.yml)"
          drift_record="$(wait_for_dispatched_run drift-check.yml)"
`;

describe('check-workflow-timeouts (#2952)', () => {
	test('reds on the pre-fix shape: timeout below a single wait budget', () => {
		const single = PRE_FIX_SHAPE.replace(
			/ {10}ci_record[\s\S]*$/,
			'          ci_record="$(wait_for_dispatched_run ci.yml)"\n',
		).replace('timeout-minutes: 10', 'timeout-minutes: 10');
		const repo = makeWorkflowRepo(single);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('cleanup-release-fragments');
		expect(out).toContain('sum waits 600s x 1.2 + 5min margin');
	});

	test('reds on the pre-fix triple-wait shape (timeout below the sum)', () => {
		const repo = makeWorkflowRepo(PRE_FIX_SHAPE);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('cleanup-release-fragments');
		expect(out).toContain('sum waits 1800s x 1.2 + 5min margin');
		expect(out).toContain('timeout 10min (600s) < required 2460s');
	});

	test('reds when a parameterized budget is below its declared target-duration', () => {
		const underfunded = SHIPPED_SHAPE.replace(
			'# target-duration: 30\n          ci_record="$(wait_for_dispatched_run ci.yml 360 5)"',
			'# target-duration: 30\n          ci_record="$(wait_for_dispatched_run ci.yml 120 5)"',
		);
		const repo = makeWorkflowRepo(underfunded);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('budget-below-target');
		expect(out).toContain('10min (120x5s) < declared target-duration 30min');
	});

	test('reds when a wait call site has no target-duration directive', () => {
		const bare = SHIPPED_SHAPE.replace(
			'          # target-duration: 10\n          drift_record="$(wait_for_dispatched_run drift-check.yml 120 5)"',
			'          drift_record="$(wait_for_dispatched_run drift-check.yml 120 5)"',
		);
		const repo = makeWorkflowRepo(bare);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('missing-target-duration');
		expect(out).toContain('drift-check.yml');
	});

	test('reds when a waiting job declares no job-level timeout-minutes', () => {
		const noTimeout = SHIPPED_SHAPE.replace('    timeout-minutes: 70\n', '');
		const repo = makeWorkflowRepo(noTimeout);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('timeout-missing');
		expect(out).toContain('declares no job-level timeout-minutes');
	});

	test('reds on an expression-valued job timeout-minutes (fail closed)', () => {
		const expression = SHIPPED_SHAPE.replace(
			'timeout-minutes: 70',
			'timeout-minutes: ${{ matrix.minutes }}',
		);
		const repo = makeWorkflowRepo(expression);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('timeout-unparsable');
	});

	test('reds on an expression-valued timeout even for a job with no waits', () => {
		const waitless = `name: release
on:
  workflow_dispatch:
jobs:
  plain-job:
    runs-on: ubuntu-latest
    timeout-minutes: \${{ matrix.minutes }}
    steps:
      - name: No waits
        run: echo hello
`;
		const repo = makeWorkflowRepo(waitless);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('timeout-unparsable');
	});

	test('reds on a wait call with a variable workflow argument (fail closed)', () => {
		const variableHead = SHIPPED_SHAPE.replace(
			'# target-duration: 30\n          ci_record="$(wait_for_dispatched_run ci.yml 360 5)"',
			'          ci_record="$(wait_for_dispatched_run "$wf" 360 5)"',
		);
		const repo = makeWorkflowRepo(variableHead);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('unparseable-wait-call');
		expect(out).toContain('literal call convention');
	});

	test('reds on a wait call with variable budget arguments (fail closed)', () => {
		const variableBudget = SHIPPED_SHAPE.replace(
			'# target-duration: 30\n          ci_record="$(wait_for_dispatched_run ci.yml 360 5)"',
			'# target-duration: 30\n          ci_record="$(wait_for_dispatched_run ci.yml "$n" 5)"',
		);
		const repo = makeWorkflowRepo(variableBudget);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('unparseable-wait-call');
		expect(out).toContain('non-literal budget arguments');
	});

	test('reds on a wait construct outside every job (unattributable)', () => {
		const orphan = `name: release
on:
  workflow_dispatch:
    # stray poll loop in the trigger block: not inside any job
    # for attempt in $(seq 1 60); do sleep 10; done
jobs:
  ok-job:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: No waits
        run: echo hello
`;
		const repo = makeWorkflowRepo(orphan);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('unattributable-wait-construct');
	});

	test('reds on an inline seq/sleep pair inside a job but outside any wait function', () => {
		const inline = `name: release
on:
  workflow_dispatch:
jobs:
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 70
    steps:
      - name: Hand-rolled poll
        run: |
          for _attempt in $(seq 1 30); do
            gh run list >/dev/null
            sleep 20
          done
`;
		const repo = makeWorkflowRepo(inline);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('uncounted-wait-construct');
		expect(out).toContain('not inside a recognized wait function');
	});

	test('reds on a parameterless call whose defaults are unresolvable', () => {
		const unresolvable = `name: release
on:
  workflow_dispatch:
jobs:
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 70
    steps:
      - name: Wait
        run: |
          wait_for_dispatched_run() {
            workflow="$1"
            iters="$2"
            secs="$3"
            for _attempt in $(seq 1 "$iters"); do
              gh run list >/dev/null
              sleep "$secs"
            done
          }
          # target-duration: 30
          ci_record="$(wait_for_dispatched_run ci.yml)"
`;
		const repo = makeWorkflowRepo(unresolvable);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('unresolvable-wait-defaults');
	});

	test('greens on the exact shipped parameterized shape (anti-vacuousness)', () => {
		const repo = makeWorkflowRepo(SHIPPED_SHAPE);
		const { code, out } = runMain([], repo);
		expect(code).toBe(0);
		expect(out).toContain('pass (0 finding(s), 1 workflow file(s)');
	});

	test('mutation: dropping one directive from the shipped shape reds', () => {
		const mutated = SHIPPED_SHAPE.replace(
			'          # target-duration: 10\n          standards_record="$(wait_for_dispatched_run pr-standards.yml 120 5)"',
			'          standards_record="$(wait_for_dispatched_run pr-standards.yml 120 5)"',
		);
		const repo = makeWorkflowRepo(mutated);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('missing-target-duration');
		expect(out).toContain('pr-standards.yml');
	});

	test('greens on partial parameterization with the defaulted sleep', () => {
		const partial = SHIPPED_SHAPE.replace(
			'# target-duration: 30\n          ci_record="$(wait_for_dispatched_run ci.yml 360 5)"',
			'# target-duration: 20\n          ci_record="$(wait_for_dispatched_run ci.yml 240)"',
		);
		const repo = makeWorkflowRepo(partial);
		const { code, out } = runMain([], repo);
		expect(code).toBe(0);
		expect(out).toContain('pass (0 finding(s)');
	});

	test('greens on the repository real workflows (ratchet)', () => {
		const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
		const { code, out } = runMain([], repoRoot);
		expect(code).toBe(0);
		expect(out).toContain('pass (0 finding(s)');
	});

	test('ignores a step-level timeout-minutes (job-level value is authoritative)', () => {
		const withStep = SHIPPED_SHAPE.replace(
			'          # target-duration: 30\n',
			'      - name: Step with its own timeout\n        timeout-minutes: 1\n        run: echo hi\n      - name: Wait\n        run: |\n          # target-duration: 30\n',
		).replace(/ {4}steps:\n {6}- name: Wait\n/, '    steps:\n');
		const repo = makeWorkflowRepo(withStep);
		const { code, out } = runMain([], repo);
		expect(code).toBe(0);
		expect(out).toContain('pass (0 finding(s)');
	});

	test('accepts fractional target-duration directives', () => {
		const fractional = SHIPPED_SHAPE.replace(
			'# target-duration: 10\n          drift_record="$(wait_for_dispatched_run drift-check.yml 120 5)"',
			'# target-duration: 2.5\n          drift_record="$(wait_for_dispatched_run drift-check.yml 120 5)"',
		);
		const repo = makeWorkflowRepo(fractional);
		const { code, out } = runMain([], repo);
		expect(code).toBe(0);
	});

	test('tolerates whitespace variants in seq/sleep constructs', () => {
		const spaced = `name: release
on:
  workflow_dispatch:
jobs:
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Wait
        run: |
          wait_for_dispatched_run() {
            workflow="$1"
            max_attempts="\${2:-60}"
            poll_seconds="\${3:-10}"
            for _attempt in $(seq   1   "$max_attempts") ; do
              gh run list >/dev/null
              sleep    "$poll_seconds"
            done
          }
          # target-duration: 10
          ci_record="$(wait_for_dispatched_run ci.yml 60 10)"
`;
		const repo = makeWorkflowRepo(spaced);
		const { code, out } = runMain([], repo);
		expect(code).toBe(0);
		expect(out).toContain('pass (0 finding(s)');
	});

	test('reds (fail closed) on an oversized workflow file', () => {
		const repo = canonicalMkdtemp('workflow-timeouts-oversize-');
		roots.push(repo);
		const dir = path.join(repo, '.github', 'workflows');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'huge.yml'),
			`name: huge\njobs:\n  j:\n    runs-on: ubuntu-latest\n` +
				'x'.repeat(512 * 1024 + 1),
		);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('file-too-large');
	});

	test('ignores non-workflow files in the scanned directory', () => {
		const repo = makeWorkflowRepo(SHIPPED_SHAPE);
		fs.writeFileSync(
			path.join(repo, '.github', 'workflows', 'notes.txt'),
			'seq 1 999; sleep 999\n',
		);
		const result = scanWorkflowsDir(path.join(repo, '.github', 'workflows'));
		expect(result.filesScanned).toBe(1);
		expect(result.findings).toHaveLength(0);
	});

	test('supports --workflows-dir for scanning an arbitrary directory', () => {
		const repo = canonicalMkdtemp('workflow-timeouts-dirflag-');
		roots.push(repo);
		fs.mkdirSync(path.join(repo, 'arbitrary'), { recursive: true });
		fs.writeFileSync(
			path.join(repo, 'arbitrary', 'only-this.yml'),
			PRE_FIX_SHAPE,
		);
		const { code, out } = runMain(['--workflows-dir', 'arbitrary'], repo);
		expect(code).toBe(1);
		expect(out).toContain('timeout-below-wait-sum');
	});
});
