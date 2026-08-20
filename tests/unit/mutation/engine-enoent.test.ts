import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import type { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockSpawnSync = vi.fn<
	[string, string[], unknown?],
	ReturnType<typeof spawnSync>
>();

import { _internals, executeMutation } from '../../../src/mutation/engine';

const mockPatch = {
	id: 'test-mutation-1',
	filePath: '/fake/path/test.ts',
	functionName: 'testFn',
	mutationType: 'Logical',
	patch:
		'--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-exports.fn = () => 1;\n+exports.fn = () => 2;\n',
};

function makeErrorENOENT(): ReturnType<typeof spawnSync> {
	const error = new Error('spawnSync ENOENT') as NodeJS.ErrnoException;
	error.code = 'ENOENT';
	return {
		pid: 0,
		output: ['', '', ''],
		stdout: Buffer.from(''),
		stderr: Buffer.from(''),
		status: null,
		error,
		signal: null,
	};
}

function makeSuccess(): ReturnType<typeof spawnSync> {
	return {
		pid: 0,
		output: ['', '', ''],
		stdout: Buffer.from(''),
		stderr: Buffer.from(''),
		status: 0,
		error: undefined,
		signal: null,
	};
}

function makeGitApplyFailed(status: number): ReturnType<typeof spawnSync> {
	return {
		pid: 0,
		output: ['', '', ''],
		stdout: Buffer.from(''),
		stderr: Buffer.from('fatal: git apply failed'),
		status,
		error: undefined,
		signal: null,
	};
}

describe('executeMutation — ENOENT error handling', () => {
	let mockWorkingDir: string;
	let savedSpawnSync: typeof _internals.spawnSync;
	const savedResolveGitExecutable = _internals.resolveGitExecutable;

	beforeEach(() => {
		vi.clearAllMocks();
		savedSpawnSync = _internals.spawnSync;
		_internals.spawnSync =
			mockSpawnSync as unknown as typeof _internals.spawnSync;
		// Issue #2236 hardening (lane C1b): executeMutation's git apply/revert
		// sites resolve the git binary via resolveGitExecutable() instead of a
		// bare 'git' literal. Stub it so the `cmd === 'git'` routing below
		// (and the "git is not installed" message text) stay deterministic.
		_internals.resolveGitExecutable = () => 'git';
		mockWorkingDir = realpathSync(
			mkdtempSync(join(tmpdir(), 'mutation-enoent-')),
		);
		mockSpawnSync.mockReturnValue(makeSuccess());
	});

	afterEach(() => {
		_internals.spawnSync = savedSpawnSync;
		_internals.resolveGitExecutable = savedResolveGitExecutable;
		rmSync(mockWorkingDir, { recursive: true, force: true });
	});

	describe('git apply ENOENT', () => {
		test('returns error result with descriptive message about git not installed', async () => {
			mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
					return makeErrorENOENT();
				}
				return makeSuccess();
			});

			const result = await executeMutation(
				mockPatch,
				['npm', 'test'],
				[],
				mockWorkingDir,
			);

			expect(result.outcome).toBe('error');
			expect(result.error).toContain(
				'git is not installed or not found in PATH',
			);
			expect(result.error).toContain('Git apply failed');
		});
	});

	describe('git revert ENOENT', () => {
		test('revertError contains ENOENT message, NOT overwritten by status-null message', async () => {
			let callCount = 0;
			mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
				callCount++;
				if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
					return makeSuccess();
				}
				if (cmd === 'git' && args.includes('-R')) {
					return makeErrorENOENT();
				}
				return makeSuccess();
			});

			const result = await executeMutation(
				mockPatch,
				['npm', 'test'],
				[],
				mockWorkingDir,
			);

			expect(result.outcome).toBe('error');
			expect(result.error).toContain(
				'git is not installed or not found in PATH',
			);
			// Should NOT contain a status-null message — that would indicate revertError was overwritten
			expect(result.error).not.toContain('status null');
		});
	});

	describe('git apply succeeds, test runs, revert ENOENT', () => {
		test('result has combined error from both', async () => {
			let callCount = 0;
			mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
				callCount++;
				if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
					return makeSuccess();
				}
				if (cmd === 'npm') {
					return makeSuccess();
				}
				if (cmd === 'git' && args.includes('-R')) {
					return makeErrorENOENT();
				}
				return makeSuccess();
			});

			const result = await executeMutation(
				mockPatch,
				['npm', 'test'],
				[],
				mockWorkingDir,
			);

			expect(result.outcome).toBe('error');
			expect(result.error).toContain(
				'git is not installed or not found in PATH',
			);
		});
	});

	describe('normal git operations', () => {
		test('apply + revert both succeed', async () => {
			let callCount = 0;
			mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
				callCount++;
				if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
					return makeSuccess();
				}
				if (cmd === 'npm') {
					return makeSuccess();
				}
				if (cmd === 'git' && args.includes('-R')) {
					return makeSuccess();
				}
				return makeSuccess();
			});

			const result = await executeMutation(
				mockPatch,
				['npm', 'test'],
				[],
				mockWorkingDir,
			);

			expect(result.outcome).toBe('survived');
			expect(result.error).toBeUndefined();
		});
	});

	describe('revert path uses else-if to prevent ENOENT overwrite', () => {
		test('ENOENT error is not overwritten by status check', async () => {
			mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
					return makeSuccess();
				}
				if (cmd === 'npm') {
					return makeSuccess();
				}
				if (cmd === 'git' && args.includes('-R')) {
					// git revert: ENOENT error present AND status is non-zero
					// This tests that the code uses else-if, not two separate ifs
					const result = makeGitApplyFailed(1);
					const error = new Error('spawnSync ENOENT') as NodeJS.ErrnoException;
					error.code = 'ENOENT';
					result.error = error;
					result.status = 1; // non-zero status alongside ENOENT
					return result;
				}
				return makeSuccess();
			});

			const result = await executeMutation(
				mockPatch,
				['npm', 'test'],
				[],
				mockWorkingDir,
			);

			// The ENOENT error message should be present, not the status error message
			expect(result.error).toContain(
				'git is not installed or not found in PATH',
			);
			// Should NOT contain the status-based error message (which would indicate overwrite)
			expect(result.error).not.toContain('git apply -R failed with status');
		});
	});
});
