/**
 * Issue #2236 — `gitExec` (src/git/branch.ts) classifies a spawn failure with
 * the `cwd` it already holds, and its "git is missing" error is actionable.
 *
 * Two defects are pinned here:
 *
 * 1. `isGitBinaryMissing(result.error)` was called WITHOUT `cwd`, so every
 *    `ENOENT` — including the one libuv reports when the working directory has
 *    been torn down — was reported as "git executable is not available on
 *    PATH". That is the exact misdiagnosis this issue exists to eliminate, and
 *    it was still live on the primary git path.
 *
 * 2. `describeGitResolution()` (src/utils/git-executable.ts) had no production
 *    caller. `gitExec` now builds the thrown `GitBinaryMissingError` message
 *    from it, so a genuinely blocked user is told which candidates were tried,
 *    why each was rejected, and which override to set.
 *
 * `branch.test.ts` is far over the FR-006 500-line cap (may only shrink), and
 * `branch.gitexec-resolver-routing.test.ts` is scoped by its own docstring to
 * resolver routing — hence a new file.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals as branchInternals } from '../../../src/git/branch';
import { _internals as bunCompatInternals } from '../../../src/utils/bun-compat';
import { GitBinaryMissingError } from '../../../src/utils/git-binary-missing-error';
import {
	__seedGitExecutableForTests,
	GIT_BINARY_ENV_VAR,
	_internals as gitExecutableInternals,
	resetGitExecutableCache,
	resolveGitExecutable,
} from '../../../src/utils/git-executable';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ORIGINAL_BRANCH = { ...branchInternals };
const ORIGINAL_BUN_COMPAT = { ...bunCompatInternals };
const ORIGINAL_RESOLVER = { ...gitExecutableInternals };

const roots: string[] = [];

function tempRoot(label: string): string {
	const dir = canonicalMkdtemp(`gitexec-cwd-${label}-`);
	roots.push(dir);
	return dir;
}

/** A spawnSync stub that reports `code` and never actually spawns anything. */
function failingSpawn(code: string): typeof branchInternals.spawnSync {
	return (() => ({
		status: null,
		stdout: '',
		stderr: '',
		error: Object.assign(new Error(`spawn git ${code}`), { code }),
	})) as unknown as typeof branchInternals.spawnSync;
}

/**
 * Drives one REAL probe cycle in which every candidate is rejected, so
 * `describeGitResolution()` has a populated attempt list for the assertions
 * below. Platform/env come from the resolver's own DI seam, so the POSIX
 * branch executes on this Windows host rather than being skipped.
 *
 * The global preload (tests/preload/executable-resolver-pin.ts) pre-seeds the
 * resolver; this resets it explicitly rather than removing the preload, and
 * `afterEach` restores the seeded state.
 */
function seedRejectedResolutionAttempts(env: NodeJS.ProcessEnv): string[] {
	resetGitExecutableCache();
	// Drive the WINDOWS candidate branch against a ProgramFiles root that
	// provably does not exist on ANY host.
	//
	// The POSIX branch must NOT be used here. Its candidates are the absolute
	// paths '/usr/bin/git', '/usr/local/bin/git' and '/bin/git', which are
	// absent on this Windows dev box but PRESENT on ubuntu-latest — where
	// /usr/bin/git exists and answers `git --version`, so `probeCycle` returns
	// 'accepted' and this helper's toThrow() inverts. That is a test whose
	// result depends on the author's host: green locally, red in CI on every
	// PR (.github/workflows/ci.yml runs `unit` on ubuntu-latest). It is the
	// same false-green class #2236 exists to eliminate, so it is designed out
	// rather than commented around.
	const absentRoot = path.join(tempRoot('nogit'), 'absent');
	const candidates = [
		`${absentRoot}\\Git\\cmd\\git.exe`,
		`${absentRoot}\\Git\\bin\\git.exe`,
	];
	// Self-verifying precondition: if these ever exist, the assertions below
	// would silently pass for the wrong reason.
	for (const candidate of candidates) {
		expect(fs.existsSync(candidate)).toBe(false);
	}
	gitExecutableInternals.platform = () => 'win32';
	gitExecutableInternals.env = () => ({
		...env,
		ProgramFiles: absentRoot,
		'ProgramFiles(x86)': undefined,
		LOCALAPPDATA: undefined,
	});
	expect(() => resolveGitExecutable()).toThrow(GitBinaryMissingError);
	return candidates;
}

afterEach(() => {
	branchInternals.spawnSync = ORIGINAL_BRANCH.spawnSync;
	branchInternals.resolveGitExecutable = ORIGINAL_BRANCH.resolveGitExecutable;
	bunCompatInternals.statSync = ORIGINAL_BUN_COMPAT.statSync;
	gitExecutableInternals.platform = ORIGINAL_RESOLVER.platform;
	gitExecutableInternals.env = ORIGINAL_RESOLVER.env;
	// Restore the preload's seeded resolver state for any later test.
	resetGitExecutableCache();
	__seedGitExecutableForTests('git');
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('gitExec spawn-failure classification uses the cwd it holds (#2236)', () => {
	test('a nonexistent cwd does NOT report git as unavailable — it names the directory', () => {
		const missingCwd = path.join(tempRoot('missing'), 'torn-down-lane');
		branchInternals.spawnSync = failingSpawn('ENOENT');

		let thrown: unknown;
		try {
			branchInternals.gitExec(['rev-parse', '--git-dir'], missingCwd);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(GitBinaryMissingError);
		const message = (thrown as Error).message;
		expect(message).toContain(missingCwd);
		expect(message).toContain('working directory no longer exists');
		expect(message).not.toContain('not available');
		expect(message).not.toContain('PATH');
	});

	test('a cwd that exists but is a FILE is classified as cwd-missing, not binary-missing', () => {
		const fileCwd = path.join(tempRoot('file'), 'not-a-directory.txt');
		fs.writeFileSync(fileCwd, 'x');
		branchInternals.spawnSync = failingSpawn('ENOENT');

		expect(() =>
			branchInternals.gitExec(['status', '--porcelain'], fileCwd),
		).toThrow(/working directory no longer exists/);
		expect(() =>
			branchInternals.gitExec(['status', '--porcelain'], fileCwd),
		).not.toThrow(GitBinaryMissingError);
	});

	test('an uninspectable cwd (EACCES) is its own state — never "git is not available"', () => {
		const guardedCwd = tempRoot('eacces');
		bunCompatInternals.statSync = () => {
			throw Object.assign(new Error('EACCES: permission denied'), {
				code: 'EACCES',
			});
		};
		branchInternals.spawnSync = failingSpawn('EACCES');

		let thrown: unknown;
		try {
			branchInternals.gitExec(['rev-parse', '--git-dir'], guardedCwd);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).not.toBeInstanceOf(GitBinaryMissingError);
		const message = (thrown as Error).message;
		expect(message).toContain(guardedCwd);
		expect(message).toContain('could not be inspected');
	});

	test('getGitRepositoryStatus reports a torn-down cwd as git_error, not git_unavailable', () => {
		const missingCwd = path.join(tempRoot('status'), 'gone');
		branchInternals.spawnSync = failingSpawn('ENOENT');

		const result = branchInternals.getGitRepositoryStatus(missingCwd);

		expect(result.isRepo).toBe(false);
		if (!result.isRepo) {
			expect(result.reason).toBe('git_error');
			expect(result.message).toContain(missingCwd);
		}
	});
});

describe('gitExec surfaces describeGitResolution() in its missing-git error (#2236 F5)', () => {
	test('names every candidate tried, why it was rejected, and the override to set', () => {
		const candidates = seedRejectedResolutionAttempts({ PATH: '' });
		// Resolution is stubbed to succeed so the run reaches the SPAWN, which
		// is the failure this message must explain; the resolver's recorded
		// attempt list is what `describeGitResolution()` reads.
		branchInternals.resolveGitExecutable = () => '/opt/stale/bin/git';
		branchInternals.spawnSync = failingSpawn('ENOENT');

		let thrown: unknown;
		try {
			// A cwd that really exists — so this genuinely is binary-missing.
			branchInternals.gitExec(['rev-parse', '--git-dir'], process.cwd());
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(GitBinaryMissingError);
		const message = (thrown as Error).message;
		// Every candidate, with its source tag and its rejection reason.
		expect(message).toContain('Candidates tried:');
		for (const candidate of candidates) {
			expect(message).toContain(`[platform] ${candidate}`);
		}
		expect(message).toContain('no such file');
		// The actionable escape hatches.
		expect(message).toContain(GIT_BINARY_ENV_VAR);
		expect(message).toContain('git.binary');
		// The cwd fact that rules the #2236 misdiagnosis out.
		expect(message).toContain(process.cwd());
	});

	test('names a configured override when one is in effect', () => {
		const bogusOverride = '/nowhere/custom-git';
		seedRejectedResolutionAttempts({
			PATH: '',
			[GIT_BINARY_ENV_VAR]: bogusOverride,
		});
		branchInternals.resolveGitExecutable = () => '/opt/stale/bin/git';
		branchInternals.spawnSync = failingSpawn('ENOENT');

		let thrown: unknown;
		try {
			branchInternals.gitExec(['rev-parse', '--git-dir'], process.cwd());
		} catch (err) {
			thrown = err;
		}

		const message = (thrown as Error).message;
		expect(message).toContain(`[override] ${bogusOverride}`);
		expect(message).toContain(`(env) "${bogusOverride}"`);
		expect(message).toContain(GIT_BINARY_ENV_VAR);
	});

	test('degrades to a sensible sentence when no probe results are recorded', () => {
		// The preload-seeded state: resolution succeeded with zero attempts.
		branchInternals.resolveGitExecutable = () => 'git';
		branchInternals.spawnSync = failingSpawn('ENOENT');

		let thrown: unknown;
		try {
			branchInternals.gitExec(['rev-parse', '--git-dir'], process.cwd());
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(GitBinaryMissingError);
		const message = (thrown as Error).message;
		expect(message).not.toContain('Candidates tried:');
		expect(message).toContain('No candidate probe results are recorded');
		expect(message).toContain(GIT_BINARY_ENV_VAR);
	});
});
