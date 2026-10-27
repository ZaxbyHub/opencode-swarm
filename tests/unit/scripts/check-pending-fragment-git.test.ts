/**
 * BOT-M1 regression: the gate's diff must be merge-base-relative. A two-dot
 * `base HEAD` diff blames a PR for main-side commits that landed after the
 * branch diverged (false-positive block on ordinary base drift). These tests
 * build real scratch git repos and assert both directions:
 *   - a test-only PR is NOT flagged when main advanced with user-visible files
 *   - a user-visible PR without a fragment IS still flagged (gate not defanged)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _internals, main } from '../../../scripts/check-pending-fragment.ts';

function git(dir: string, ...args: string[]): void {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd: dir,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	if (proc.exitCode !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: ${proc.stderr.toString()} ${proc.stdout.toString()}`,
		);
	}
}

function scratchRepo(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cpf-git-')));
	git(dir, 'init', '-b', 'main');
	git(dir, 'config', 'user.email', 't@t');
	git(dir, 'config', 'user.name', 't');
	writeFileSync(join(dir, 'README.md'), 'base\n');
	git(dir, 'add', '.');
	git(dir, 'commit', '-m', 'base');
	return dir;
}

describe('check-pending-fragment main() — merge-base diff (BOT-H1/M1)', () => {
	// Pin the hatch for this describe's fail-closed leg (F11): an ambient
	// FRAGMENT_CHECK_ENFORCE=0 must not turn "gate not defanged" green.
	let prevEnforce: string | undefined;
	beforeEach(() => {
		prevEnforce = process.env.FRAGMENT_CHECK_ENFORCE;
		delete process.env.FRAGMENT_CHECK_ENFORCE;
	});
	afterEach(() => {
		if (prevEnforce === undefined) delete process.env.FRAGMENT_CHECK_ENFORCE;
		else process.env.FRAGMENT_CHECK_ENFORCE = prevEnforce;
	});
	test('test-only PR is NOT flagged when main advanced with user-visible files', () => {
		const dir = scratchRepo();
		try {
			// Branch point: create PR branch from current main.
			git(dir, 'checkout', '-b', 'pr-branch');
			mkdirSync(join(dir, 'tests'), { recursive: true });
			writeFileSync(join(dir, 'tests', 'a.test.ts'), 'test {}\n');
			git(dir, 'add', '.');
			git(dir, 'commit', '-m', 'test only');
			// Simulate origin/main advancing past the merge-base with an
			// unrelated USER-VISIBLE change (with its own fragment).
			git(dir, 'checkout', 'main');
			mkdirSync(join(dir, 'src'), { recursive: true });
			writeFileSync(
				join(dir, 'src', 'newfeature.ts'),
				'export const mainSideFeature = unrelatedContent();\n',
			);
			mkdirSync(join(dir, 'docs', 'releases', 'pending'), { recursive: true });
			writeFileSync(
				join(dir, 'docs', 'releases', 'pending', 'main-side.md'),
				'# main-side fragment\n',
			);
			git(dir, 'add', '.');
			git(dir, 'commit', '-m', 'main-side user-visible change');
			// Simulate CI's fresh origin/main pointing at advanced main.
			git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
			git(dir, 'checkout', 'pr-branch');
			// OLD two-dot behavior: exit 1 blaming src/newfeature.ts.
			expect(main(dir)).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('user-visible PR without a fragment IS flagged (gate not defanged)', () => {
		const dir = scratchRepo();
		try {
			git(dir, 'checkout', '-b', 'pr-branch');
			mkdirSync(join(dir, 'src'));
			writeFileSync(join(dir, 'src', 'feature.ts'), 'export {};\n');
			git(dir, 'add', '.');
			git(dir, 'commit', '-m', 'user-visible only');
			git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
			expect(main(dir)).toBe(1);
			// And the escape hatch soft-warns.
			const prev = process.env.FRAGMENT_CHECK_ENFORCE;
			process.env.FRAGMENT_CHECK_ENFORCE = '0';
			try {
				expect(main(dir)).toBe(0);
			} finally {
				if (prev === undefined) delete process.env.FRAGMENT_CHECK_ENFORCE;
				else process.env.FRAGMENT_CHECK_ENFORCE = prev;
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('user-visible PR WITH a fragment passes', () => {
		const dir = scratchRepo();
		try {
			git(dir, 'checkout', '-b', 'pr-branch');
			mkdirSync(join(dir, 'src'), { recursive: true });
			writeFileSync(join(dir, 'src', 'feature.ts'), 'export {}\n');
			mkdirSync(join(dir, 'docs', 'releases', 'pending'), { recursive: true });
			writeFileSync(
				join(dir, 'docs', 'releases', 'pending', 'my-feature.md'),
				'# my feature\n',
			);
			git(dir, 'add', '.');
			git(dir, 'commit', '-m', 'user-visible with fragment');
			git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
			expect(main(dir)).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * Issue #3283: "cannot determine" must FAIL the gate, never pass it. The
 * pre-fix main() returned 0 on merge-base/diff failures and timeouts, and
 * manufactured a VIOLATION out of an added-diff failure. These tests pin the
 * fail-closed shape end to end: exit 1, an infrastructure-labeled message,
 * and never the author-facing VIOLATION label on an infra path.
 *
 * Coverage note (mock tiers): the spawn seam (`_internals.spawnSync`) is
 * exercised ONLY for outcomes real git cannot produce deterministically in a
 * unit test — a killed spawn (exitCode null, the timeout shape) and a
 * per-call failure targeted at exactly one git invocation. All other legs
 * run REAL git in scratch repositories through the same seam.
 */
describe('check-pending-fragment main() — git infrastructure failures fail closed (#3283)', () => {
	// Pin the hatch for every leg: a developer shell exporting
	// FRAGMENT_CHECK_ENFORCE=0 must not turn fail-closed assertions green.
	let prevEnforce: string | undefined;
	beforeEach(() => {
		prevEnforce = process.env.FRAGMENT_CHECK_ENFORCE;
		delete process.env.FRAGMENT_CHECK_ENFORCE;
	});
	afterEach(() => {
		if (prevEnforce === undefined) delete process.env.FRAGMENT_CHECK_ENFORCE;
		else process.env.FRAGMENT_CHECK_ENFORCE = prevEnforce;
	});
	/** git() but returns trimmed stdout and tolerates nonzero exits. */
	function gitRaw(
		dir: string,
		...args: string[]
	): { exitCode: number; stdout: string } {
		const proc = Bun.spawnSync({
			cmd: ['git', ...args],
			cwd: dir,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 30_000,
		});
		return {
			exitCode: proc.exitCode ?? 1,
			stdout: proc.stdout.toString().trim(),
		};
	}

	/** Runs fn with console.error captured (for message-shape assertions). */
	function captureStderr(fn: () => number): { code: number; text: string } {
		const original = console.error;
		const chunks: string[] = [];
		console.error = (...args: unknown[]) => {
			chunks.push(args.map(String).join(' '));
		};
		try {
			return { code: fn(), text: chunks.join('\n') };
		} finally {
			console.error = original;
		}
	}

	/** Runs fn with _internals.spawnSync forcing `forced` for matching cmds. */
	function withForcedSpawn(
		match: (cmd: string[]) => boolean,
		forced: { exitCode: number | null; stdout?: string },
		fn: () => number,
	): number {
		const real = _internals.spawnSync;
		_internals.spawnSync = ((options: Parameters<typeof real>[0]) => {
			const cmd = ((options as { cmd?: string[] }).cmd ?? []) as string[];
			if (match(cmd)) {
				return {
					exitCode: forced.exitCode,
					stdout: Buffer.from(forced.stdout ?? '', 'utf8'),
					stderr: Buffer.from('', 'utf8'),
				} as ReturnType<typeof real>;
			}
			return real(options);
		}) as typeof _internals.spawnSync;
		try {
			return fn();
		} finally {
			_internals.spawnSync = real;
		}
	}

	/** A PR branch with a user-visible change and NO fragment, off main. */
	function violationRepo(): string {
		// Self-cleaning: a setup failure must not leak the scratch repo (the
		// callers' try/finally only covers a successfully returned dir).
		let dir: string | undefined;
		try {
			dir = scratchRepo();
			git(dir, 'checkout', '-b', 'pr-branch');
			mkdirSync(join(dir, 'src'), { recursive: true });
			writeFileSync(join(dir, 'src', 'feature.ts'), 'export {}\n');
			git(dir, 'add', '.');
			git(dir, 'commit', '-m', 'user-visible only');
			git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
			return dir;
		} catch (error) {
			if (dir) rmSync(dir, { recursive: true, force: true });
			throw error;
		}
	}

	/** A PR branch whose changes are all test/docs (no user-visible surface). */
	function cleanRepo(): string {
		let dir: string | undefined;
		try {
			dir = scratchRepo();
			git(dir, 'checkout', '-b', 'pr-branch');
			mkdirSync(join(dir, 'tests'), { recursive: true });
			writeFileSync(join(dir, 'tests', 'a.test.ts'), 'test {}\n');
			git(dir, 'add', '.');
			git(dir, 'commit', '-m', 'test only');
			git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
			return dir;
		} catch (error) {
			if (dir) rmSync(dir, { recursive: true, force: true });
			throw error;
		}
	}

	test('T1 merge-base failure (orphan history) fails closed, hatch soft-warns', () => {
		const dir = scratchRepo();
		try {
			git(dir, 'checkout', '--orphan', 'pr-branch');
			git(dir, 'rm', '-rq', '--cached', '.');
			rmSync(join(dir, 'README.md'), { force: true });
			writeFileSync(join(dir, 'orphan.txt'), 'orphan\n');
			git(dir, 'add', '.');
			git(dir, 'commit', '-m', 'orphan root');
			const { code, text } = captureStderr(() => main(dir));
			expect(code).toBe(1);
			expect(text).toContain('merge-base');
			expect(text).not.toContain('VIOLATION');
			// The documented escape hatch still soft-warns past infra failures.
			const prev = process.env.FRAGMENT_CHECK_ENFORCE;
			process.env.FRAGMENT_CHECK_ENFORCE = '0';
			try {
				expect(main(dir)).toBe(0);
			} finally {
				if (prev === undefined) delete process.env.FRAGMENT_CHECK_ENFORCE;
				else process.env.FRAGMENT_CHECK_ENFORCE = prev;
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('T2 changed-diff failure (missing tree object) fails closed', () => {
		const dir = violationRepo();
		try {
			const tree = gitRaw(dir, 'rev-parse', 'HEAD^{tree}').stdout;
			expect(tree).toMatch(/^[0-9a-f]{40}$/);
			const objectPath = join(
				dir,
				'.git',
				'objects',
				tree.slice(0, 2),
				tree.slice(2),
			);
			expect(existsSync(objectPath)).toBe(true);
			rmSync(objectPath);
			// Precondition: the changed-files diff now genuinely fails while
			// merge-base still resolves (construction assertion, not hope).
			const diffProbe = gitRaw(
				dir,
				'diff',
				'--name-only',
				'--no-renames',
				'origin/main',
				'HEAD',
			);
			expect(diffProbe.exitCode).not.toBe(0);
			const { code, text } = captureStderr(() => main(dir));
			expect(code).toBe(1);
			expect(text).toContain('git diff failed');
			expect(text).not.toContain('VIOLATION');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('T3 added-diff failure reports infra, never a manufactured VIOLATION', () => {
		const dir = violationRepo();
		try {
			// Force ONLY the --diff-filter=A call to fail; the changed-files
			// diff (which runs first) stays real and succeeds. Pre-fix this
			// leg continued with an empty added-list and reported VIOLATION.
			const { code, text } = captureStderr(() =>
				withForcedSpawn(
					(cmd) => cmd.includes('--diff-filter=A'),
					{ exitCode: 128 },
					() => main(dir),
				),
			);
			expect(code).toBe(1);
			expect(text).toContain('--diff-filter=A failed');
			expect(text).not.toContain('VIOLATION');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('T6 spawned-git timeout (exitCode null) on the changed diff fails closed', () => {
		const dir = violationRepo();
		try {
			const { code, text } = captureStderr(() =>
				withForcedSpawn(
					(cmd) => cmd.includes('diff') && cmd.includes('--name-only'),
					{ exitCode: null },
					() => main(dir),
				),
			);
			expect(code).toBe(1);
			expect(text).toContain('timed out');
			expect(text).not.toContain('VIOLATION');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('T6b a spawn exception is reported as a spawn failure, not a timeout', () => {
		// F15 (PR #3472 review feedback): runGit's catch branch is a different
		// infrastructure failure from the timeout kill; reverting the label to
		// the pre-fix always-timeout text used to leave the suite green.
		const dir = violationRepo();
		const real = _internals.spawnSync;
		try {
			// Throw only on the runGit paths (diff/verify), so the root
			// resolution still succeeds and the runGit catch branch is what
			// produces the message under test.
			_internals.spawnSync = ((options: Parameters<typeof real>[0]) => {
				const cmd = ((options as { cmd?: string[] }).cmd ?? []) as string[];
				if (cmd.includes('diff') || cmd.includes('--verify')) {
					throw new Error('simulated spawn failure (ENOMEM)');
				}
				return real(options);
			}) as typeof _internals.spawnSync;
			const { code, text } = captureStderr(() => main(dir));
			expect(code).toBe(1);
			expect(text).toContain('could not be run (spawn failed)');
			expect(text).not.toContain('timed out');
		} finally {
			_internals.spawnSync = real;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('T4 base-branch discovery failure and timeout fail closed', () => {
		const dir = violationRepo();
		try {
			// PRR-002: the matcher must not be the only thing standing between
			// this test and silence — count the forced calls so an argv
			// refactor that stops matching fails HERE instead of disarming
			// the forcing and letting the real path satisfy the assertions.
			const forcedCalls: string[][] = [];
			const matchVerify = (cmd: string[]) => {
				const isVerify = cmd.includes('rev-parse') && cmd.includes('--verify');
				if (isVerify) forcedCalls.push(cmd);
				return isVerify;
			};
			// PRR-001: assert the failure MODE, not just the exit code — the
			// infra label must be present and the author-facing VIOLATION
			// label absent (the file's contract, docblock above).
			const timeout = captureStderr(() =>
				withForcedSpawn(matchVerify, { exitCode: null }, () => main(dir)),
			);
			expect(forcedCalls.length).toBeGreaterThan(0);
			expect(timeout.code).toBe(1);
			expect(timeout.text).toContain('base');
			expect(timeout.text).not.toContain('VIOLATION');

			forcedCalls.length = 0;
			const vanished = captureStderr(() =>
				withForcedSpawn(matchVerify, { exitCode: 128 }, () => main(dir)),
			);
			// Any nonzero rc other than the positive-absence rc 1 at discovery
			// is infrastructure (e.g. a repository that vanished mid-run).
			expect(forcedCalls.length).toBeGreaterThan(0);
			expect(vanished.code).toBe(1);
			expect(vanished.text).toContain('base');
			expect(vanished.text).not.toContain('VIOLATION');

			// The clean-diff leg: with no violation to fall through to, the
			// only surviving outcomes are infra-fail-closed or the pass — the
			// pass must NOT be taken when discovery infra-fails.
			const clean = cleanRepo();
			try {
				const cleanResult = captureStderr(() =>
					withForcedSpawn(matchVerify, { exitCode: null }, () => main(clean)),
				);
				expect(cleanResult.code).toBe(1);
				expect(cleanResult.text).not.toContain('no base branch found');
			} finally {
				rmSync(clean, { recursive: true, force: true });
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('T4b a root-resolution timeout stays fatal even when later git calls would succeed', () => {
		const dir = violationRepo();
		try {
			// Only the --show-toplevel call is killed; every later git call
			// runs real (and would succeed). Pre-fix this produced an ordinary
			// verdict on a silently-degraded root resolution.
			const { code, text } = captureStderr(() =>
				withForcedSpawn(
					(cmd) => cmd.includes('--show-toplevel'),
					{ exitCode: null },
					() => main(dir),
				),
			);
			expect(code).toBe(1);
			expect(text).toContain('timed out');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
