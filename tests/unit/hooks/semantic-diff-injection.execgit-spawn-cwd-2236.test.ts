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
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/hooks/semantic-diff-injection.js';
import { _internals as bunCompatInternals } from '../../../src/utils/bun-compat.js';
import { GitBinaryMissingError } from '../../../src/utils/git-binary-missing-error.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalExecFile = _internals.execFile;
const originalResolveGitExecutable = _internals.resolveGitExecutable;
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
