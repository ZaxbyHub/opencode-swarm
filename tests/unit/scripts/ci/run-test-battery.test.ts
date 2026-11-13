import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../../helpers/tmpdir.js';

// #3605 AC1/AC6/AC7: scripts/ci/run-test-battery.ts is the fail-closed battery
// wrapper. Raw multi-file `bun test` batches silently drop unmatched paths and
// exit 0; the wrapper refuses them at admission, refuses non-test/out-of-root/
// git-ignored paths (their content cannot be tree-bound), counts a zero-test
// run as FAILED, keeps discovered == executed, and binds a passing battery to
// the tree it ran on with a before/after snapshot. Execution legs run inside
// THROWAWAY git repos so fixtures never touch this repo's working tree (the
// dirty digest the receipt binds must describe the real tree, not test litter).

const ROOT = path.join(import.meta.dir, '..', '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'run-test-battery.ts');

let directory = '';

beforeEach(() => {
	directory = canonicalMkdtemp('battery-wrapper-test-');
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

function runBattery(
	args: string[],
	cwd = ROOT,
): { status: number; output: string } {
	// Invoke bun directly: bashCommand() would hand the .ts to bash as a shell
	// script (an explicit interpreter bypasses the shebang), which is how the
	// compat-wiring suite drives the sibling runner too.
	const result = spawnSync(process.execPath, [SCRIPT, ...args], {
		cwd,
		encoding: 'utf-8',
		stdin: 'ignore',
		timeout: 180_000,
	});
	return {
		status: result.status ?? -1,
		output: `${result.stdout}${result.stderr}`,
	};
}

function git(args: string[], cwd: string): string {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		stdin: 'ignore',
		timeout: 30_000,
	});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}
	return `${result.stdout}`;
}

/**
 * Throwaway repo with the keepalive preload stub the per-file argv expects
 * (buildTestArgv resolves scripts/ci/bun-32056-keepalive.ts inside the TARGET
 * root) and one committed empty commit so rev-parse HEAD resolves.
 */
function makeFixtureRepo(name: string): string {
	const repo = path.join(directory, name);
	fsSync.mkdirSync(repo, { recursive: true });
	git(['init', '-q'], repo);
	git(['config', 'user.email', 'battery-fixture@example.invalid'], repo);
	git(['config', 'user.name', 'battery-fixture'], repo);
	fsSync.mkdirSync(path.join(repo, 'scripts', 'ci'), { recursive: true });
	fsSync.writeFileSync(
		path.join(repo, 'scripts', 'ci', 'bun-32056-keepalive.ts'),
		'// no-op keepalive stub for the battery fixture repo\n',
		'utf-8',
	);
	// The per-file argv (`bun ... test <file>`) resolves `test` as a
	// package.json SCRIPT first (bun run test); without a "test" script bun
	// fails with `Script not found "test"` (probed on bun 1.3.14).
	fsSync.writeFileSync(
		path.join(repo, 'package.json'),
		JSON.stringify(
			{ name: 'battery-fixture', scripts: { test: 'bun test' } },
			null,
			2,
		),
		'utf-8',
	);
	git(['add', '.'], repo);
	git(['commit', '-q', '-m', 'fixture'], repo);
	return repo;
}

// vacuous-ok: fixture FILE CONTENT for a passing bun test, not an assertion in this suite
const PASS_FIXTURE = `import { test, expect } from 'bun:test';\ntest('pass', () => { expect(1).toBe(1); });\n`;
const FAIL_FIXTURE = `import { test, expect } from 'bun:test';\ntest('fail', () => { expect(1).toBe(2); });\n`;
// An empty module matches the .test.ts suffix but executes zero tests — the
// vacuous-pass class the wrapper must count as FAILED (bun prints
// "Ran 0 tests across 1 file." for it).
const ZERO_TEST_FIXTURE = `export {};\n`;

describe('run-test-battery admission (#3605 AC1)', () => {
	test('refuses an unmatched path inside a multi-file batch, naming it', () => {
		const real = path.join(
			ROOT,
			'tests/unit/pr-review/observability-generation-ceiling-3593-r4.test.ts',
		);
		const { status, output } = runBattery([
			'tests/unit/pr-review/no-such-file-3605a.test.ts',
			real,
		]);
		expect(status).toBe(1);
		expect(output).toContain('BATTERY-REFUSED');
		expect(output).toContain('no-such-file-3605a.test.ts');
	}, 60_000);

	test('refuses a literal unmatched glob and a directory argument (F-03)', () => {
		const glob = path.join(directory, 'no-such-*.test.ts');
		const { status, output } = runBattery([glob, path.join(directory)]);
		expect(status).toBe(1);
		expect(output).toContain('BATTERY-REFUSED');
		// The directory is outside the repo root AND not a regular file; both
		// refusals name their reason class.
		expect(output).toContain('not a regular file');
	}, 60_000);

	test('refuses a path outside the repository root (content cannot be tree-bound)', () => {
		const outside = path.join(directory, 'fixture-outside.test.ts');
		fsSync.writeFileSync(outside, PASS_FIXTURE, 'utf-8');
		const { status, output } = runBattery([outside]);
		expect(status).toBe(1);
		expect(output).toContain('outside the repository root');
	}, 60_000);

	test('refuses a non-test file even when it exists (F-05 suffix admission)', () => {
		const repo = makeFixtureRepo('suffix-repo');
		const txt = path.join(repo, 'notes.txt');
		fsSync.writeFileSync(txt, 'not a test\n', 'utf-8');
		const { status, output } = runBattery(['notes.txt'], repo);
		expect(status).toBe(1);
		expect(output).toContain('not a test file');
	}, 60_000);

	test('refuses empty discovery (no positional args)', () => {
		const { status, output } = runBattery([]);
		expect(status).toBe(1);
		expect(output).toContain('BATTERY-REFUSED: no test files discovered');
	}, 30_000);

	test('refuses a git-ignored test file (its content would not be tree-bound)', () => {
		const repo = makeFixtureRepo('ignored-repo');
		fsSync.writeFileSync(
			path.join(repo, '.gitignore'),
			'ignored-*.test.ts\n',
			'utf-8',
		);
		const fixture = path.join(repo, 'ignored-1.test.ts');
		fsSync.writeFileSync(fixture, PASS_FIXTURE, 'utf-8');
		const { status, output } = runBattery(['ignored-1.test.ts'], repo);
		expect(status).toBe(1);
		expect(output).toContain('git-ignored');
	}, 60_000);
});

describe('run-test-battery zero-test refusal (#3605 AC1, hermes F-04)', () => {
	test('a passing exit with "Ran 0 tests" is counted FAILED', async () => {
		const repo = makeFixtureRepo('zero-repo');
		const fixture = path.join(repo, 'fixture-zero.test.ts');
		await fs.writeFile(fixture, ZERO_TEST_FIXTURE, 'utf-8');
		const receiptOut = path.join(directory, 'zero-receipt.json');
		const { status, output } = runBattery(
			['fixture-zero.test.ts', '--receipt-out', receiptOut],
			repo,
		);
		expect(status).toBe(1);
		expect(output).toContain('reported zero executed tests');
		// A skip-only file's "Ran 1 test" must not satisfy the zero-executed
		// detector either — a skipped test did not execute (Stage-B finding).
		// Covered by the dedicated skip-only leg below.
		// A failed battery must not leave a receipt a readiness check could
		// mistake for one (F-04 stale-receipt removal).
		expect(fsSync.existsSync(receiptOut)).toBe(false);
	}, 120_000);

	test('a skip-only file ("Ran 1 test", "0 pass") is counted FAILED (skip does not execute)', async () => {
		const repo = makeFixtureRepo('skip-repo');
		await fs.writeFile(
			path.join(repo, 'fixture-skip.test.ts'),
			// vacuous-ok: fixture FILE CONTENT for a skip-only bun test, not an assertion in this suite
			"import { test } from 'bun:test';\ntest.skip('skipped', () => {});\n",
			'utf-8',
		);
		const receiptOut = path.join(directory, 'skip-receipt.json');
		const { status, output } = runBattery(
			['fixture-skip.test.ts', '--receipt-out', receiptOut],
			repo,
		);
		expect(status).toBe(1);
		expect(output).toContain('reported zero executed tests');
		expect(fsSync.existsSync(receiptOut)).toBe(false);
	}, 120_000);

	test('a REFUSED run does not delete an existing receipt target (cleanup deferred past admission)', async () => {
		const repo = makeFixtureRepo('order-repo');
		// Pre-existing receipt-shaped target, then an admission-refused run:
		// the refusal must change nothing on disk.
		const target = path.join(directory, 'keep-me.json');
		await fs.writeFile(
			target,
			'{"head": "aaaaaaaaaa", "dirty": "", "files": []}\n',
			'utf-8',
		);
		const { status, output } = runBattery(
			['no-such-file-3605b.test.ts', '--receipt-out', target],
			repo,
		);
		expect(status).toBe(1);
		expect(output).toContain('BATTERY-REFUSED');
		const preserved = await fs.readFile(target, 'utf-8');
		expect(preserved).toContain('"head"'); // still there
	}, 120_000);

	test('a mid-run tree change refuses the receipt (F-01 enforcement arm, Stage-B FB-005 gap)', async () => {
		const repo = makeFixtureRepo('midrun-repo');
		// The fixture test MUTATES the tree while the battery runs (appends an
		// untracked file): the after-snapshot must refuse to write a receipt
		// that would not describe the tree the tests ran on.
		await fs.writeFile(
			path.join(repo, 'fixture-midrun.test.ts'),
			// vacuous-ok: fixture FILE CONTENT for a passing bun test that mutates the tree mid-run, not an assertion in this suite
			"import { test, expect } from 'bun:test';\nimport { appendFileSync } from 'node:fs';\ntest('pass', () => { expect(1).toBe(1); appendFileSync('midrun-written.txt', 'x\\n'); });\n",
			'utf-8',
		);
		const receiptOut = path.join(directory, 'midrun-receipt.json');
		const { status, output } = runBattery(
			['fixture-midrun.test.ts', '--receipt-out', receiptOut],
			repo,
		);
		expect(status).toBe(1);
		expect(output).toContain(
			'the repository tree changed during the battery run',
		);
		expect(fsSync.existsSync(receiptOut)).toBe(false);
	}, 120_000);

	test('an unreadable-git refusal preserves a pre-existing receipt target (cleanup after every refusal arm)', async () => {
		// A git repo with NO commits: rev-parse HEAD fails, so the pre-run
		// unreadable-git refusal fires — and it must fire BEFORE any state
		// mutation, including stale-receipt cleanup (closeout NEW-BATCH-4).
		const repo = path.join(directory, 'no-commit-repo');
		fsSync.mkdirSync(repo, { recursive: true });
		git(['init', '-q'], repo);
		await fs.writeFile(
			path.join(repo, 'fixture-pass.test.ts'),
			PASS_FIXTURE,
			'utf-8',
		);
		const target = path.join(directory, 'unreadable-keep.json');
		await fs.writeFile(
			target,
			'{"head": "bbbbbbbbbb", "dirty": "", "files": []}\n',
			'utf-8',
		);
		const { status, output } = runBattery(
			['fixture-pass.test.ts', '--receipt-out', target],
			repo,
		);
		expect(status).toBe(1);
		expect(output).toContain('the git state is unreadable');
		const preserved = await fs.readFile(target, 'utf-8');
		expect(preserved).toContain('"head"'); // still there
	}, 120_000);
});

describe('run-test-battery exit semantics (#3605 AC6)', () => {
	test('nonzero when any executed file failed, naming the file', async () => {
		const repo = makeFixtureRepo('exit-repo');
		await fs.writeFile(
			path.join(repo, 'fixture-fail.test.ts'),
			FAIL_FIXTURE,
			'utf-8',
		);
		await fs.writeFile(
			path.join(repo, 'fixture-pass.test.ts'),
			PASS_FIXTURE,
			'utf-8',
		);
		const { status, output } = runBattery(
			['fixture-fail.test.ts', 'fixture-pass.test.ts'],
			repo,
		);
		expect(status).toBe(1);
		expect(output).toContain('fixture-fail');
		expect(output).toContain('BATTERY pass=1 fail=1');
	}, 180_000);

	test('zero on all-pass with a summary and a tree receipt bound to the fixture repo', async () => {
		const repo = makeFixtureRepo('receipt-repo');
		await fs.writeFile(
			path.join(repo, 'fixture-pass.test.ts'),
			PASS_FIXTURE,
			'utf-8',
		);
		const receiptOut = path.join(directory, 'receipt.json');
		const { status, output } = runBattery(
			['fixture-pass.test.ts', '--receipt-out', receiptOut],
			repo,
		);
		expect(status).toBe(0);
		expect(output).toContain('BATTERY pass=1 fail=0');
		expect(output).toContain('battery-tree-receipt:');
		const receipt = JSON.parse(await fs.readFile(receiptOut, 'utf-8')) as {
			head: string;
			dirty: string;
			files: string[];
		};
		expect(receipt.head).toMatch(/^[0-9a-f]{40}$/);
		expect(typeof receipt.dirty).toBe('string');
		expect(receipt.dirty.length).toBeGreaterThan(0); // fixture file is untracked content
		expect(Array.isArray(receipt.files)).toBe(true);
		expect(receipt.files).toEqual(['fixture-pass.test.ts']);
	}, 180_000);

	test('default receipt path is used when --receipt-out is absent (TF-5)', async () => {
		const repo = makeFixtureRepo('default-receipt-repo');
		await fs.writeFile(
			path.join(repo, 'fixture-pass.test.ts'),
			PASS_FIXTURE,
			'utf-8',
		);
		const { status, output } = runBattery(['fixture-pass.test.ts'], repo);
		expect(status).toBe(0);
		expect(output).toContain('battery-tree-receipt:');
		const defaultReceipt = path.join(
			repo,
			'.swarm',
			'evidence',
			'battery',
			'battery-tree-receipt.json',
		);
		const receipt = JSON.parse(await fs.readFile(defaultReceipt, 'utf-8')) as {
			head: string;
		};
		expect(receipt.head).toMatch(/^[0-9a-f]{40}$/);
	}, 120_000);

	test('a stale receipt-shaped target is removed on a failed run; a non-receipt target is preserved and refused (TF-4/18, F-17)', async () => {
		const repo = makeFixtureRepo('stale-repo');
		await fs.writeFile(
			path.join(repo, 'fixture-fail.test.ts'),
			FAIL_FIXTURE,
			'utf-8',
		);
		await fs.writeFile(
			path.join(repo, 'fixture-pass.test.ts'),
			PASS_FIXTURE,
			'utf-8',
		);

		// Stale receipt from an earlier passing run on this same target.
		const staleTarget = path.join(directory, 'stale-receipt.json');
		await fs.writeFile(
			staleTarget,
			'{"head": "a".repeat(0), "dirty": "", "files": []}\n'.replace(
				'"a".repeat(0)',
				'"aaaaaaaaaa"',
			),
			'utf-8',
		);
		const failed = runBattery(
			['fixture-fail.test.ts', '--receipt-out', staleTarget],
			repo,
		);
		expect(failed.status).toBe(1);
		expect(fsSync.existsSync(staleTarget)).toBe(false); // stale receipt gone

		// A target that exists but is NOT receipt-shaped must be refused, not
		// deleted (F-17 data-loss fix).
		const unrelatedTarget = path.join(directory, 'unrelated.json');
		await fs.writeFile(unrelatedTarget, 'unrelated user data\n', 'utf-8');
		const passing = runBattery(
			['fixture-pass.test.ts', '--receipt-out', unrelatedTarget],
			repo,
		);
		expect(passing.status).toBe(1);
		expect(passing.output).toContain('not a battery receipt');
		const preserved = await fs.readFile(unrelatedTarget, 'utf-8');
		expect(preserved).toBe('unrelated user data\n'); // not overwritten
	}, 180_000);

	test('--receipt-out inside the repo without git-ignore is refused (self-poison guard)', async () => {
		const repo = makeFixtureRepo('poison-repo');
		await fs.writeFile(
			path.join(repo, 'fixture-pass.test.ts'),
			PASS_FIXTURE,
			'utf-8',
		);
		const { status, output } = runBattery(
			['fixture-pass.test.ts', '--receipt-out', 'in-repo-receipt.json'],
			repo,
		);
		expect(status).toBe(1);
		expect(output).toContain('self-poison the tree digest');
	}, 60_000);
});

describe('assertBatteryAccounting seam', () => {
	// Pure-function import through the source file (absolute path keeps the
	// module graph identical to the script's own resolution).
	test('equal sets pass; disagreeing counts and missing members throw', async () => {
		const mod = await import(path.join(ROOT, 'scripts/ci/run-test-battery.ts'));
		const seam = mod.assertBatteryAccounting as (
			a: readonly string[],
			b: readonly string[],
		) => void;
		expect(() => seam(['a', 'b'], ['a', 'b'])).not.toThrow();
		expect(() => seam(['a'], ['a', 'b'])).toThrow(/executed count disagrees/);
		expect(() => seam(['a', 'b'], ['a', 'c'])).toThrow(
			/executed set is missing/,
		);
	}, 30_000);
});
