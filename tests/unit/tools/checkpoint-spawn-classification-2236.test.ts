/**
 * Issue #2236 F0d — `checkpoint.ts` stops formatting a raw spawn errno into
 * user-visible text.
 *
 * `gitExec` threw `git failed to start: ENOENT - ENOENT: no such file or
 * directory, posix_spawn 'git'`. That is the same leak class as the reported
 * bug at `update-task-status.ts`: an ENOENT whose real cause is a torn-down
 * `cwd`, presented to the user as a missing git binary.
 *
 * Classification lives INSIDE the throw branch, after the transient-retry
 * decision, so the retry set is untouched — the "no retry" assertions below
 * pin that.
 *
 * The first two cases use a real filesystem and a real spawn: no mock can
 * misrepresent what libuv actually returns for a missing or non-directory
 * `cwd`. The remaining cases need an error shape this host cannot produce on
 * demand and drive it through the mocked spawn seam.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let mockResult: child_process.SpawnSyncReturns<string> | null = null;
let callCount = 0;

import * as realChildProcess from 'node:child_process';

// Captured BEFORE mock.module replaces the namespace binding. Reading
// `realChildProcess.spawnSync` inside the mock would resolve to the mock
// itself (mock.module mutates the live namespace object) and recurse forever.
const actualSpawnSync = realChildProcess.spawnSync;

const mockSpawnSync = mock(
	(
		command: string,
		args: string[],
		options: Record<string, unknown>,
	): child_process.SpawnSyncReturns<string> => {
		callCount++;
		if (mockResult) return mockResult;
		return actualSpawnSync(
			command,
			args,
			options as never,
		) as child_process.SpawnSyncReturns<string>;
	},
);

mock.module('node:child_process', () => ({
	...realChildProcess,
	spawnSync: mockSpawnSync,
}));

const { _internals } = await import('../../../src/tools/checkpoint');
const { GitBinaryMissingError } = await import(
	'../../../src/utils/git-binary-missing-error'
);

const roots: string[] = [];

function tempRoot(label: string): string {
	const dir = canonicalMkdtemp(`checkpoint-spawn-${label}-`);
	roots.push(dir);
	return dir;
}

function spawnError(code: string): child_process.SpawnSyncReturns<string> {
	const err = new Error(
		`${code}: no such file or directory, posix_spawn 'git'`,
	) as NodeJS.ErrnoException;
	err.code = code;
	return {
		pid: 0,
		output: [],
		stdout: '',
		stderr: '',
		status: null,
		signal: null,
		error: err,
	} as unknown as child_process.SpawnSyncReturns<string>;
}

const originalResolveGitExecutable = _internals.resolveGitExecutable;

beforeEach(() => {
	mockResult = null;
	callCount = 0;
	mockSpawnSync.mockClear();
	// Issue #2236 hardening: `gitExec` resolves the git executable via
	// `_internals.resolveGitExecutable()` before spawning. Stubbed to a fixed
	// value so the resolver's own candidate-probing loop does not consume
	// calls from the same mocked `spawnSync` these tests assert `callCount`
	// against, and does not pick up an injected `mockResult` failure meant
	// for the call under test. Mirrors `src/git/branch.ts`'s
	// `_internals.resolveGitExecutable` test convention.
	_internals.resolveGitExecutable = () => 'git';
});

afterEach(() => {
	// MUST clear here, not only in beforeEach: the node:child_process mock is
	// registered at file-LOAD time and stays live for the rest of a shared
	// test-runner process. Leaving a canned error payload behind would make
	// every later file's spawnSync fail — invisible to a per-file run loop.
	mockResult = null;
	_internals.resolveGitExecutable = originalResolveGitExecutable;
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('checkpoint gitExec spawn-failure classification', () => {
	test('real spawn, deleted cwd: names the working directory, not the errno', () => {
		const gone = path.join(tempRoot('deleted'), 'gone');

		expect(() => _internals.gitExec(['rev-parse', 'HEAD'], gone)).toThrow(
			/working directory no longer exists/,
		);
		try {
			_internals.gitExec(['rev-parse', 'HEAD'], gone);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toContain(gone);
			expect(message).not.toContain('posix_spawn');
			expect(message).not.toContain('uv_spawn');
			expect(message).not.toContain('git failed to start');
		}
	});

	test('real spawn, cwd is a FILE: still a cwd problem, not a missing binary', () => {
		const file = path.join(tempRoot('file'), 'a-file');
		fs.writeFileSync(file, 'x');

		expect(() => _internals.gitExec(['rev-parse', 'HEAD'], file)).toThrow(
			/working directory no longer exists/,
		);
	});

	test('ENOENT with a live cwd is reported as a missing git binary', () => {
		const root = tempRoot('binary-missing');
		mockResult = spawnError('ENOENT');

		let caught: unknown;
		try {
			_internals.gitExec(['rev-parse', 'HEAD'], root);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(GitBinaryMissingError);
		expect((caught as Error).message).toContain('not available on PATH');
		// ENOENT is not transient — exactly one attempt, no retry.
		expect(callCount).toBe(1);
	});

	test('an EACCES stat on the cwd is surfaced as its own state', async () => {
		const root = tempRoot('unreadable');
		const bunCompat = await import('../../../src/utils/bun-compat');
		const realStat = bunCompat._internals.statSync;
		bunCompat._internals.statSync = () => {
			const err = new Error(
				'EACCES: permission denied',
			) as NodeJS.ErrnoException;
			err.code = 'EACCES';
			throw err;
		};
		mockResult = spawnError('ENOENT');
		try {
			expect(() => _internals.gitExec(['rev-parse', 'HEAD'], root)).toThrow(
				/could not be inspected \(permission denied\)/,
			);
		} finally {
			bunCompat._internals.statSync = realStat;
		}
	});

	test('an unclassifiable spawn error keeps the original message', () => {
		const root = tempRoot('other');
		mockResult = spawnError('EMFILE');

		expect(() => _internals.gitExec(['rev-parse', 'HEAD'], root)).toThrow(
			/git failed to start: EMFILE/,
		);
		expect(callCount).toBe(1);
	});
});
