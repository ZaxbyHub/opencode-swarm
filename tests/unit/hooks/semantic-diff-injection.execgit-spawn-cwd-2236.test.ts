/**
 * Issue #2236 follow-up — `execGit` in `src/hooks/semantic-diff-injection.ts`
 * classifies a spawn failure using the `cwd` it already holds, instead of
 * folding every `ENOENT` into "git binary is not available".
 *
 * `buildSemanticDiffBlock` (the file's only export) swallows every
 * classification outcome to `null` — this file's documented "failure mode:
 * silent" — so the classified message is not observable through that
 * function's return value. `execGit` is exposed on `_internals` (test seam
 * only; `buildSemanticDiffBlock` still calls the module-scope `execGit`
 * directly, so production behaviour is unchanged) so these tests can invoke
 * the three-way classification directly and assert on the thrown message.
 *
 * Real filesystem state is used for the discriminator wherever the host
 * allows it: a deleted `canonicalMkdtemp` directory for cwd-missing, a real
 * live directory for the binary-missing case. The one branch this Windows
 * host cannot produce natively — an `EACCES` stat — is driven through the
 * `bun-compat` `_internals.statSync` seam rather than skipped, per the "no
 * platform skip" rule.
 *
 * The second describe block pins the CONSUMER half of the same contract.
 * `execGit`'s classification went three-way in #2236 while
 * `buildSemanticDiffBlock`'s inner catch stayed two-way (`instanceof
 * GitBinaryMissingError`), so a cwd fault fell through to the else branch and
 * was reinterpreted as "this path is not in HEAD" — fabricating
 * `oldContent = ''` and reporting the entire file as newly added. Those tests
 * assert the abort for all three "git never ran" states AND, as the negative
 * control that keeps them from being vacuous, that a git process which
 * genuinely RAN and reported "not in HEAD" still takes the new-file path.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	buildSemanticDiffBlock,
} from '../../../src/hooks/semantic-diff-injection.js';
import { _internals as bunCompatInternals } from '../../../src/utils/bun-compat.js';
import { GitBinaryMissingError } from '../../../src/utils/git-binary-missing-error.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalExecFile = _internals.execFile;
const originalResolveGitExecutable = _internals.resolveGitExecutable;
const originalGetCachedGraph = _internals.getCachedGraph;
const originalComputeASTDiff = _internals.computeASTDiff;
const originalStatSync = bunCompatInternals.statSync;

const roots: string[] = [];

function tempRoot(label: string): string {
	const dir = canonicalMkdtemp(`semantic-diff-execgit-${label}-`);
	roots.push(dir);
	return dir;
}

/** Injects a spawn failure with the given errno `code` on every `execFile` call. */
function failingExecFile(code: string): typeof _internals.execFile {
	return ((
		_file: string,
		_args: string[],
		_options: unknown,
		callback: (
			error: child_process.ExecFileException | null,
			stdout: string,
			stderr: string,
		) => void,
	) => {
		const err = new Error(
			`${code}: no such file or directory, uv_spawn 'git'`,
		) as child_process.ExecFileException;
		err.code = code;
		callback(err, '', '');
		return {} as child_process.ChildProcess;
	}) as unknown as typeof _internals.execFile;
}

beforeEach(() => {
	// Fixed so the resolver's own candidate-probing loop does not consume
	// calls from the injected `execFile` mock these tests assert against.
	// Mirrors tests/unit/tools/checkpoint-spawn-classification-2236.test.ts.
	_internals.resolveGitExecutable = () => 'git';
});

afterEach(() => {
	_internals.execFile = originalExecFile;
	_internals.resolveGitExecutable = originalResolveGitExecutable;
	_internals.getCachedGraph = originalGetCachedGraph;
	_internals.computeASTDiff = originalComputeASTDiff;
	bunCompatInternals.statSync = originalStatSync;
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('semantic-diff-injection execGit spawn-failure classification (#2236)', () => {
	test('a deleted cwd names the directory and is NOT reported as a missing git binary', async () => {
		const gone = path.join(tempRoot('missing'), 'torn-down-lane');
		expect(fs.existsSync(gone)).toBe(false);

		_internals.execFile = failingExecFile('ENOENT');

		let thrown: unknown;
		try {
			await _internals.execGit(gone, ['cat-file', '-e', 'HEAD:x.ts']);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(GitBinaryMissingError);
		const message = (thrown as Error).message;
		expect(message).toContain(gone);
		expect(message).toContain('no longer exists');
		expect(message).not.toContain('git binary is not available');
		expect(message).not.toContain('is not available on PATH');
	});

	test('an EACCES cwd is reported as permission-denied, not folded into either bucket', async () => {
		const guarded = tempRoot('eacces');
		bunCompatInternals.statSync = () => {
			const err = new Error(
				'EACCES: permission denied',
			) as NodeJS.ErrnoException;
			err.code = 'EACCES';
			throw err;
		};
		_internals.execFile = failingExecFile('ENOENT');

		let thrown: unknown;
		try {
			await _internals.execGit(guarded, ['cat-file', '-e', 'HEAD:x.ts']);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(GitBinaryMissingError);
		const message = (thrown as Error).message;
		expect(message).toContain(guarded);
		expect(message).toContain('could not be inspected (permission denied)');
		expect(message).not.toContain('git binary is not available');
		expect(message).not.toContain('is not available on PATH');
		expect(message).not.toContain('no longer exists');
	});

	test('a genuinely missing binary with a live cwd still reports GitBinaryMissingError', async () => {
		const live = tempRoot('binary-missing');
		expect(fs.existsSync(live)).toBe(true);

		_internals.execFile = failingExecFile('ENOENT');

		let thrown: unknown;
		try {
			await _internals.execGit(live, ['cat-file', '-e', 'HEAD:x.ts']);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(GitBinaryMissingError);
		const message = (thrown as Error).message;
		expect(message).toContain('is not available on PATH');
		expect(message).toContain(live);
		expect(message).not.toContain('no longer exists');
	});
});

/**
 * Builds a live lane directory holding one real source file, and pins the
 * remaining `buildSemanticDiffBlock` collaborators so the only variable under
 * test is how a spawn failure is classified and consumed.
 *
 * `realpathSync` is deliberately NOT stubbed: the real one must succeed at the
 * top of `buildSemanticDiffBlock` for the fixture to represent the production
 * window, which is "the directory was present on entry and was torn down
 * before the first `git cat-file`".
 */
function liveLane(label: string): {
	dir: string;
	astCalls: () => number;
	lastOldContent: () => string | undefined;
} {
	const dir = tempRoot(label);
	fs.writeFileSync(path.join(dir, 'src.ts'), 'export function a() {}\n');

	let calls = 0;
	let oldContent: string | undefined;
	_internals.getCachedGraph = (async () =>
		null) as unknown as typeof _internals.getCachedGraph;
	_internals.computeASTDiff = (async (_filePath: string, previous: string) => {
		calls++;
		oldContent = previous;
		return null;
	}) as unknown as typeof _internals.computeASTDiff;

	return { dir, astCalls: () => calls, lastOldContent: () => oldContent };
}

/** Makes the `cwd` discriminator report `state` for `dir` only. */
function statCwdAs(dir: string, state: 'missing' | 'unreadable'): void {
	const real = originalStatSync;
	bunCompatInternals.statSync = ((target: string) => {
		if (path.resolve(target) === path.resolve(dir)) {
			const err = new Error(
				state === 'missing'
					? `ENOENT: no such file or directory, stat '${target}'`
					: `EACCES: permission denied, stat '${target}'`,
			) as NodeJS.ErrnoException;
			err.code = state === 'missing' ? 'ENOENT' : 'EACCES';
			throw err;
		}
		return real(target);
	}) as typeof bunCompatInternals.statSync;
}

describe('buildSemanticDiffBlock aborts on every "git never ran" state (#2236)', () => {
	test('a cwd torn down mid-block aborts instead of fabricating a new-file diff', async () => {
		const lane = liveLane('block-cwd-missing');
		// Present for the entry `realpathSync`, gone by the first `cat-file`.
		statCwdAs(lane.dir, 'missing');
		_internals.execFile = failingExecFile('ENOENT');

		const result = await buildSemanticDiffBlock(lane.dir, ['src.ts']);

		expect(result).toBeNull();
		// The regression: a cwd fault used to fall through to `fileExistsInHead
		// = false`, so the file was diffed against a fabricated empty HEAD.
		expect(lane.astCalls()).toBe(0);
	});

	test('a cwd that cannot be inspected aborts rather than guessing', async () => {
		const lane = liveLane('block-cwd-unreadable');
		statCwdAs(lane.dir, 'unreadable');
		_internals.execFile = failingExecFile('ENOENT');

		const result = await buildSemanticDiffBlock(lane.dir, ['src.ts']);

		expect(result).toBeNull();
		expect(lane.astCalls()).toBe(0);
	});

	test('a missing binary with a live cwd still aborts (unchanged behaviour)', async () => {
		const lane = liveLane('block-binary-missing');
		expect(fs.existsSync(lane.dir)).toBe(true);
		_internals.execFile = failingExecFile('ENOENT');

		const result = await buildSemanticDiffBlock(lane.dir, ['src.ts']);

		expect(result).toBeNull();
		expect(lane.astCalls()).toBe(0);
	});

	test('git that RAN and reported "not in HEAD" still takes the new-file path', async () => {
		const lane = liveLane('block-not-in-head');
		// A real `git cat-file -e` miss exits non-zero: `code` is the numeric
		// exit status, not an errno string, so it classifies as `other` and the
		// "this path is new" inference is legitimate. This is the negative
		// control — without it the three aborts above would also pass if the
		// consumer simply aborted on every error.
		_internals.execFile = ((
			_file: string,
			_args: string[],
			_options: unknown,
			callback: (
				error: child_process.ExecFileException | null,
				stdout: string,
				stderr: string,
			) => void,
		) => {
			const err = new Error(
				'Command failed: git cat-file -e HEAD:src.ts',
			) as child_process.ExecFileException;
			err.code = 1;
			callback(err, '', '');
			return {} as child_process.ChildProcess;
		}) as unknown as typeof _internals.execFile;

		const result = await buildSemanticDiffBlock(lane.dir, ['src.ts']);

		expect(result).toBeNull(); // stubbed computeASTDiff yields no diffs
		expect(lane.astCalls()).toBe(1);
		expect(lane.lastOldContent()).toBe('');
	});
});
