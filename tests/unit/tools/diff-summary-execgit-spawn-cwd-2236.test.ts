/**
 * Issue #2236 follow-up — `execGit` in `src/tools/diff-summary.ts` classifies
 * a spawn failure using the `cwd` it already holds, instead of folding every
 * `ENOENT` into "git binary is not available".
 *
 * The `diff_summary` tool (this file's only export) swallows every
 * classification outcome except `GitBinaryMissingError` — a plain
 * cwd-missing/cwd-unreadable `Error` is caught per-item and the file is
 * treated as new/untracked, so its message never reaches the tool's JSON
 * output. `execGit` had no DI seam at all before this test; a minimal
 * `_internals = { execFile, resolveGitExecutableAsync, execGit }` was added
 * (mirroring the existing convention in
 * `src/hooks/semantic-diff-injection.ts`) so these tests can inject the
 * spawn failure via `_internals.execFile` and invoke the three-way
 * classification directly via `_internals.execGit`, asserting on the thrown
 * message. `diff_summary` itself still calls `execGit`/`resolveGitExecutableAsync`
 * through `_internals` now too (routed, not duplicated), so production
 * behaviour is unchanged.
 *
 * Real filesystem state is used for the discriminator wherever the host
 * allows it: a deleted `canonicalMkdtemp` directory for cwd-missing, a real
 * live directory for the binary-missing case. The EACCES branch is driven
 * through the `bun-compat` `_internals.statSync` seam — no platform skip.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/tools/diff-summary.js';
import { _internals as bunCompatInternals } from '../../../src/utils/bun-compat.js';
import { GitBinaryMissingError } from '../../../src/utils/git-binary-missing-error.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalExecFile = _internals.execFile;
const originalResolveGitExecutableAsync = _internals.resolveGitExecutableAsync;
const originalStatSync = bunCompatInternals.statSync;

const roots: string[] = [];

function tempRoot(label: string): string {
	const dir = canonicalMkdtemp(`diff-summary-execgit-${label}-`);
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
	_internals.resolveGitExecutableAsync = async () => 'git';
});

afterEach(() => {
	_internals.execFile = originalExecFile;
	_internals.resolveGitExecutableAsync = originalResolveGitExecutableAsync;
	bunCompatInternals.statSync = originalStatSync;
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('diff-summary execGit spawn-failure classification (#2236)', () => {
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
