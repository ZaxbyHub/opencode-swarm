/**
 * Issue #2236 F0c — three-way spawn-failure classification.
 *
 * The reported bug survived four days because `ENOENT` from a spawn was read
 * as "git is not on PATH". Under Bun a genuinely missing binary short-circuits
 * with `Executable not found in $PATH: "git"`; a nonexistent `cwd` produces
 * `ENOENT: no such file or directory, <syscall> 'git'`. Same code, opposite
 * cause. These tests pin the discriminator (the caller's `cwd`) and the fact
 * that "cannot tell" is its own state rather than being folded into either
 * definite bucket.
 *
 * Filesystem state is real wherever the host allows it. The one branch this
 * Windows host cannot produce natively — an `EACCES` stat — is driven through
 * the `_internals.statSync` seam rather than skipped with an
 * `if (isWindows) return;` guard, which would make every assertion below
 * trivially pass locally.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/utils/bun-compat';
import {
	classifySpawnFailure,
	describeSpawnCwdFailure,
	GitBinaryMissingError,
	inspectSpawnCwd,
	isGitBinaryMissing,
	isSpawnCwdMissing,
	isSpawnCwdUnreadable,
	SpawnCwdMissingError,
} from '../../../src/utils/git-binary-missing-error';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realStatSync = _internals.statSync;
const roots: string[] = [];

function tempRoot(label: string): string {
	const dir = canonicalMkdtemp(`spawn-cwd-${label}-`);
	roots.push(dir);
	return dir;
}

/** The exact error shape libuv produces for both causes (captured on Bun 1.3.14). */
function enoentSpawnError(): NodeJS.ErrnoException {
	const err = new Error(
		"ENOENT: no such file or directory, uv_spawn 'git'",
	) as NodeJS.ErrnoException;
	err.code = 'ENOENT';
	return err;
}

function statError(code: string): NodeJS.ErrnoException {
	const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
	err.code = code;
	return err;
}

afterEach(() => {
	_internals.statSync = realStatSync;
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('inspectSpawnCwd', () => {
	test('reports a real directory as a directory', () => {
		expect(inspectSpawnCwd(tempRoot('dir'))).toBe('directory');
	});

	test('reports a deleted path as missing', () => {
		const root = tempRoot('missing');
		expect(inspectSpawnCwd(path.join(root, 'gone'))).toBe('missing');
	});

	test('reports a regular file as not-directory, where existsSync would say true', () => {
		const root = tempRoot('file');
		const file = path.join(root, 'a-file');
		fs.writeFileSync(file, 'x');
		// The precise reason `existsSync` is the wrong primitive.
		expect(fs.existsSync(file)).toBe(true);
		expect(inspectSpawnCwd(file)).toBe('not-directory');
	});

	test('reports EACCES/EPERM as unreadable, where existsSync would say false', () => {
		const root = tempRoot('eacces');
		_internals.statSync = () => {
			throw statError('EACCES');
		};
		expect(inspectSpawnCwd(root)).toBe('unreadable');
		_internals.statSync = () => {
			throw statError('EPERM');
		};
		expect(inspectSpawnCwd(root)).toBe('unreadable');
	});

	test('reports an unexpected stat failure as unknown, never as missing', () => {
		const root = tempRoot('unknown');
		_internals.statSync = () => {
			throw statError('ENAMETOOLONG');
		};
		expect(inspectSpawnCwd(root)).toBe('unknown');
	});
});

describe('describeSpawnCwdFailure', () => {
	test('returns a typed error for a missing cwd and names the path', () => {
		const root = tempRoot('describe-missing');
		const gone = path.join(root, 'gone');
		const failure = describeSpawnCwdFailure(gone, 'git');
		expect(failure).toBeInstanceOf(SpawnCwdMissingError);
		expect(failure?.reason).toBe('missing');
		expect(failure?.cwd).toBe(gone);
		expect(failure?.executable).toBe('git');
		expect(failure?.code).toBe('ENOENT');
		expect(failure?.message).toContain(gone);
	});

	test('returns a typed error when cwd is a file', () => {
		const root = tempRoot('describe-file');
		const file = path.join(root, 'a-file');
		fs.writeFileSync(file, 'x');
		expect(describeSpawnCwdFailure(file, 'git')?.reason).toBe('not-directory');
	});

	test('returns null for a usable cwd', () => {
		expect(describeSpawnCwdFailure(tempRoot('describe-ok'), 'git')).toBeNull();
	});

	test('returns null when the cwd cannot be inspected — never refuse on "cannot tell"', () => {
		const root = tempRoot('describe-eacces');
		_internals.statSync = () => {
			throw statError('EACCES');
		};
		expect(describeSpawnCwdFailure(root, 'git')).toBeNull();
	});
});

describe('three-way classification', () => {
	test('ENOENT with a live directory cwd is a missing binary', () => {
		const root = tempRoot('binary');
		const err = enoentSpawnError();
		expect(classifySpawnFailure(err, root)).toBe('binary-missing');
		expect(isGitBinaryMissing(err, root)).toBe(true);
		expect(isSpawnCwdMissing(err, root)).toBe(false);
		expect(isSpawnCwdUnreadable(err, root)).toBe(false);
	});

	test('ENOENT with a deleted cwd is a missing cwd — the #2236 shape', () => {
		const root = tempRoot('cwd-missing');
		const gone = path.join(root, 'gone');
		const err = enoentSpawnError();
		expect(classifySpawnFailure(err, gone)).toBe('cwd-missing');
		expect(isSpawnCwdMissing(err, gone)).toBe(true);
		// The misclassification that sent the issue down the PATH path.
		expect(isGitBinaryMissing(err, gone)).toBe(false);
	});

	test('ENOENT with a cwd that is a FILE is a missing cwd, not a missing binary', () => {
		const root = tempRoot('cwd-file');
		const file = path.join(root, 'a-file');
		fs.writeFileSync(file, 'x');
		const err = enoentSpawnError();
		expect(classifySpawnFailure(err, file)).toBe('cwd-missing');
		expect(isGitBinaryMissing(err, file)).toBe(false);
	});

	test('ENOTDIR (the POSIX shape for a file cwd) classifies the same way', () => {
		const root = tempRoot('enotdir');
		const file = path.join(root, 'a-file');
		fs.writeFileSync(file, 'x');
		const err = new Error('ENOTDIR') as NodeJS.ErrnoException;
		err.code = 'ENOTDIR';
		expect(classifySpawnFailure(err, file)).toBe('cwd-missing');
	});

	test('EACCES on the cwd stat is its own state, never either definite bucket', () => {
		const root = tempRoot('unreadable');
		_internals.statSync = () => {
			throw statError('EACCES');
		};
		const err = enoentSpawnError();
		expect(classifySpawnFailure(err, root)).toBe('cwd-unreadable');
		expect(isSpawnCwdUnreadable(err, root)).toBe(true);
		expect(isSpawnCwdMissing(err, root)).toBe(false);
		expect(isGitBinaryMissing(err, root)).toBe(false);
	});

	test('an unexpected stat failure also fails closed to unreadable', () => {
		const root = tempRoot('stat-unknown');
		_internals.statSync = () => {
			throw statError('EIO');
		};
		expect(classifySpawnFailure(enoentSpawnError(), root)).toBe(
			'cwd-unreadable',
		);
	});

	test('an EACCES spawn error with a live directory is neither bucket', () => {
		const root = tempRoot('spawn-eacces');
		const err = new Error('spawn EACCES') as NodeJS.ErrnoException;
		err.code = 'EACCES';
		expect(classifySpawnFailure(err, root)).toBe('other');
		expect(isGitBinaryMissing(err, root)).toBe(false);
		expect(isSpawnCwdMissing(err, root)).toBe(false);
	});

	test('a SpawnCwdMissingError value classifies as cwd-missing on its own', () => {
		const err = new SpawnCwdMissingError('/nowhere', 'missing', 'git');
		expect(classifySpawnFailure(err, '/nowhere')).toBe('cwd-missing');
		expect(isSpawnCwdMissing(err, '/nowhere')).toBe(true);
	});

	test('a relative cwd is safe: stat and the child resolve against the same parent', () => {
		// Relative to the test process cwd, which is the repository root.
		expect(inspectSpawnCwd('src')).toBe('directory');
		expect(classifySpawnFailure(enoentSpawnError(), 'src')).toBe(
			'binary-missing',
		);
		expect(inspectSpawnCwd('src/definitely-not-here-2236')).toBe('missing');
	});

	test('a symlinked cwd is safe: statSync follows the link, as does the child', () => {
		const root = tempRoot('symlink');
		const target = path.join(root, 'target');
		const link = path.join(root, 'link');
		fs.mkdirSync(target);
		// Windows creates a junction for directory symlinks; both resolve.
		fs.symlinkSync(target, link, 'junction');
		expect(inspectSpawnCwd(link)).toBe('directory');
		expect(classifySpawnFailure(enoentSpawnError(), link)).toBe(
			'binary-missing',
		);
	});
});

describe('backwards compatibility for cwd-less callers', () => {
	test('isGitBinaryMissing without a cwd keeps the pre-#2236 ENOENT semantics', () => {
		expect(isGitBinaryMissing(enoentSpawnError())).toBe(true);
		expect(isGitBinaryMissing(new Error('some error'))).toBe(false);
		// GitBinaryMissingError itself carries no `code` — unchanged.
		expect(
			isGitBinaryMissing(
				new GitBinaryMissingError('git binary not found', {
					cause: enoentSpawnError(),
				}),
			),
		).toBe(false);
	});

	test('an empty-string cwd is treated as "no cwd offered"', () => {
		expect(isGitBinaryMissing(enoentSpawnError(), '')).toBe(true);
	});
});
