/**
 * Issue #3283: repository-root classification. Split from
 * check-pending-fragment-git.test.ts when that file crossed the FR-006
 * 500-line cap — the infra-failure legs stayed with the diff semantics; the
 * root-classification battery (positive marker-absence pass, broken-marker
 * infra failures, positive ref-absence pass, and the git discovery-override
 * regression) lives here.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _internals, main } from '../../../scripts/check-pending-fragment.ts';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cpf-root-')));
	git(dir, 'init', '-b', 'main');
	git(dir, 'config', 'user.email', 't@t');
	git(dir, 'config', 'user.name', 't');
	writeFileSync(join(dir, 'README.md'), 'base\n');
	git(dir, 'add', '.');
	git(dir, 'commit', '-m', 'base');
	return dir;
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

describe('check-pending-fragment classifyRepoRoot — repository classification (#3283)', () => {
	// Pin the hatch for every leg (F11): a developer shell exporting
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
	test('T7 a git discovery override (GIT_DIR) outside the ancestry still evaluates that repository', () => {
		// PR #3472 review feedback: the marker walk must not read a
		// GIT_DIR-pointed repository as marker-free and take the non-repo
		// pass — base resolved the external repo and reported its VIOLATION.
		const external = violationRepo();
		const markerFree = canonicalMkdtemp('cpf-gitdir-');
		const prevGitDir = process.env.GIT_DIR;
		const real = _internals.spawnSync;
		try {
			process.env.GIT_DIR = join(external, '.git');
			// Bun.spawnSync does not propagate a runtime process.env mutation
			// to the child on Windows, so inject it at the production seam
			// (the same seam every git spawn already routes through).
			_internals.spawnSync = ((options: Parameters<typeof real>[0]) =>
				real({
					...options,
					env: { ...process.env },
				})) as typeof _internals.spawnSync;
			const { code, text } = captureStderr(() => main(markerFree));
			expect(code).toBe(1);
			expect(text).not.toContain('no base branch found');
			expect(text).toContain('VIOLATION');
		} finally {
			_internals.spawnSync = real;
			if (prevGitDir === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = prevGitDir;
			rmSync(markerFree, { recursive: true, force: true });
			rmSync(external, { recursive: true, force: true });
		}
	});

	test('T5 plain non-repository directory keeps the documented pass', () => {
		const dir = canonicalMkdtemp('cpf-nongit-');
		try {
			const original = console.log;
			const chunks: string[] = [];
			console.log = (...args: unknown[]) => {
				chunks.push(args.map(String).join(' '));
			};
			try {
				expect(main(dir)).toBe(0);
			} finally {
				console.log = original;
			}
			expect(chunks.join('\n')).toContain('no base branch found');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('T5 empty .git directory is a broken repository, not a non-repo pass', () => {
		const dir = canonicalMkdtemp('cpf-emptygit-');
		try {
			mkdirSync(join(dir, '.git'));
			const { code, text } = captureStderr(() => main(dir));
			expect(code).toBe(1);
			expect(text).toContain('unusable');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('T5 malformed .git file is a broken repository, not a non-repo pass', () => {
		const dir = canonicalMkdtemp('cpf-brokengit-');
		try {
			writeFileSync(join(dir, '.git'), 'not a valid gitdir pointer\n');
			const { code, text } = captureStderr(() => main(dir));
			expect(code).toBe(1);
			expect(text).toContain('unusable');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('T8 a bare repository directory is repository context, not the non-repo pass', () => {
		// PR #3472 review feedback: a bare clone has no `.git` marker, so the
		// marker walk alone would read it as marker-free and pass — while
		// base (which delegated to git's cwd discovery) reported the
		// repository's VIOLATION. The walk now recognizes the bare layout.
		const dir = canonicalMkdtemp('cpf-bare-');
		try {
			const git = (...args: string[]) => {
				const proc = Bun.spawnSync({
					cmd: ['git', ...args],
					cwd: dir,
					stdin: 'ignore',
					stdout: 'pipe',
					stderr: 'pipe',
					timeout: 30_000,
				});
				if (proc.exitCode !== 0) {
					throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`);
				}
			};
			git('init', '--bare', '-b', 'main');
			// A bare repo cannot hold a worktree index, so evaluation is
			// expected to fail closed on the work-tree resolution — what
			// matters is that it does NOT take the non-repository pass.
			const { code, text } = captureStderr(() => main(dir));
			expect(code).toBe(1);
			expect(text).not.toContain('no base branch found');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('T5 valid repository with both candidates positively absent passes', () => {
		const dir = canonicalMkdtemp('cpf-trunk-');
		try {
			git(dir, 'init', '-b', 'trunk');
			git(dir, 'config', 'user.email', 't@t');
			git(dir, 'config', 'user.name', 't');
			writeFileSync(join(dir, 'README.md'), 'base\n');
			git(dir, 'add', '.');
			git(dir, 'commit', '-m', 'base');
			// Neither origin/main nor main exists (rc 1 = positive absence).
			const original = console.log;
			const chunks: string[] = [];
			console.log = (...args: unknown[]) => {
				chunks.push(args.map(String).join(' '));
			};
			try {
				expect(main(dir)).toBe(0);
			} finally {
				console.log = original;
			}
			expect(chunks.join('\n')).toContain('no base branch found');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
