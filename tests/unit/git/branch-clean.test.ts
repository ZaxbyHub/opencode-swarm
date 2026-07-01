/**
 * Regression test for FR-013: aggressive git alignment must use `git clean -fdX`
 * (remove only gitignored build artifacts), not `git clean -fd` (removes ALL
 * untracked files including user-created source files).
 *
 * Uses the _internals DI seam to capture gitExec args. A minimal node:child_process
 * mock handles getCurrentBranch (which calls gitExec directly, not via _internals).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock node:child_process for getCurrentBranch (not in _internals seam)
// ---------------------------------------------------------------------------

import * as realChildProcess from 'node:child_process';

const spawnCalls: { command: string; args: string[]; cwd: string }[] = [];

const mockSpawnSync = mock(
	(command: string, args: string[], options: { cwd: string }) => {
		spawnCalls.push({ command, args: args as string[], cwd: options.cwd });
		// Default success — specific commands are handled via _internals stub
		return { status: 0, stdout: '', stderr: '' };
	},
);

mock.module('node:child_process', () => ({
	...realChildProcess,
	spawnSync: mockSpawnSync,
}));

// ---------------------------------------------------------------------------
// Import branch module AFTER mock setup
// ---------------------------------------------------------------------------

const branch = await import('../../../src/git/branch');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testCwd = path.join(os.tmpdir(), 'branch-clean-test');

function setup(): {
	capturedArgs: string[][];
	restore: () => void;
} {
	const capturedArgs: string[][] = [];
	const originalGitExec = branch._internals.gitExec;
	const originalDetectDefaultRemoteBranch =
		branch._internals.detectDefaultRemoteBranch;

	spawnCalls.length = 0;
	mockSpawnSync.mockClear();

	// Stub _internals.gitExec to capture args and return canned values
	branch._internals.gitExec = ((args: string[], cwd: string): string => {
		capturedArgs.push([...args]);

		// Return values based on command
		if (args[0] === 'log') return '';
		if (args[0] === 'fetch') return '';
		if (args[0] === 'checkout' && args[1] === '--' && args[2] === '.')
			return '';
		if (args[0] === 'checkout') return '';
		if (args[0] === 'reset' && args[1] === '--hard') return '';
		if (args[0] === 'clean') return '';
		if (args[0] === 'branch' && args[1] === '--merged') return '  feat/x\n';
		if (args[0] === 'branch' && args[1] === '-d') return '';
		if (
			args[0] === 'rev-parse' &&
			args[1] === '--abbrev-ref' &&
			args[2] === 'HEAD'
		) {
			// getCurrentBranch path — return via spawnSync mock instead
			// This branch shouldn't be hit since getCurrentBranch calls gitExec directly
			return 'feat/x';
		}
		if (args[0] === 'rev-parse' && args[1] === '--git-dir') return '';
		if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main';

		return '';
	}) as typeof branch._internals.gitExec;

	// Stub detectDefaultRemoteBranch to avoid real git calls
	branch._internals.detectDefaultRemoteBranch = () => 'main';

	return {
		capturedArgs,
		restore: () => {
			branch._internals.gitExec = originalGitExec;
			branch._internals.detectDefaultRemoteBranch =
				originalDetectDefaultRemoteBranch;
		},
	};
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('resetToMainAfterMerge — FR-013: git clean -fdX regression', () => {
	beforeEach(() => {
		spawnCalls.length = 0;
		mockSpawnSync.mockClear();
	});

	afterEach(() => {
		mock.restore();
	});

	test('aggressive reset uses git clean -fdX (not -fd)', async () => {
		const { capturedArgs, restore } = setup();

		// Stub getCurrentBranch via spawnSync mock
		mockSpawnSync.mockImplementation(
			(command: string, args: string[], options: { cwd: string }) => {
				spawnCalls.push({ command, args: args as string[], cwd: options.cwd });
				if (
					args[0] === 'rev-parse' &&
					args[1] === '--abbrev-ref' &&
					args[2] === 'HEAD'
				) {
					return { status: 0, stdout: 'feat/x\n', stderr: '' };
				}
				return { status: 0, stdout: '', stderr: '' };
			},
		);

		try {
			await branch.resetToMainAfterMerge(testCwd);
		} catch {
			// ignore — we're just capturing args
		}

		restore();

		// Assert: the clean command uses -fdX AND is scoped to the build-artifact
		// allowlist via a `--` pathspec — NOT a bare `-fd` and NOT a blanket `-fdX`
		// (which would also delete the gitignored `.swarm/` knowledge store).
		const cleanCalls = capturedArgs.filter((args) => args[0] === 'clean');
		expect(cleanCalls.length).toBeGreaterThan(0);

		for (const cleanArgs of cleanCalls) {
			expect(cleanArgs).toEqual([
				'clean',
				'-fdX',
				'--',
				...branch.GITIGNORED_BUILD_ARTIFACTS,
			]);
		}
	});

	test('regression: clean is scoped to an allowlist and never wipes .swarm/ (blanket -fdX)', async () => {
		// Prior bug: `git clean -fdX` with no pathspec removed EVERY gitignored path,
		// including `.swarm/knowledge.jsonl`, silently defeating the finalize clean
		// stage's deliberate preservation of cumulative knowledge.
		const { capturedArgs, restore } = setup();

		mockSpawnSync.mockImplementation(
			(command: string, args: string[], options: { cwd: string }) => {
				spawnCalls.push({ command, args: args as string[], cwd: options.cwd });
				if (
					args[0] === 'rev-parse' &&
					args[1] === '--abbrev-ref' &&
					args[2] === 'HEAD'
				) {
					return { status: 0, stdout: 'feat/x\n', stderr: '' };
				}
				return { status: 0, stdout: '', stderr: '' };
			},
		);

		try {
			await branch.resetToMainAfterMerge(testCwd);
		} catch {
			// ignore — capturing args only
		}

		restore();

		const cleanCalls = capturedArgs.filter((args) => args[0] === 'clean');
		expect(cleanCalls.length).toBeGreaterThan(0);
		for (const cleanArgs of cleanCalls) {
			// Must include a `--` pathspec separator (i.e. scoped, not blanket).
			expect(cleanArgs).toContain('--');
			const sepIndex = cleanArgs.indexOf('--');
			const pathspec = cleanArgs.slice(sepIndex + 1);
			// Must clean at least one path, and none may be `.swarm/`, `.swarm`, or a
			// blanket `.` that would recurse into `.swarm/`.
			expect(pathspec.length).toBeGreaterThan(0);
			for (const p of pathspec) {
				expect(p).not.toBe('.');
				expect(p.replace(/[\\/]+$/, '')).not.toBe('.swarm');
			}
		}
	});

	test('clean command is NOT called with -fd', async () => {
		const { capturedArgs, restore } = setup();

		mockSpawnSync.mockImplementation(
			(command: string, args: string[], options: { cwd: string }) => {
				spawnCalls.push({ command, args: args as string[], cwd: options.cwd });
				if (
					args[0] === 'rev-parse' &&
					args[1] === '--abbrev-ref' &&
					args[2] === 'HEAD'
				) {
					return { status: 0, stdout: 'feat/x\n', stderr: '' };
				}
				return { status: 0, stdout: '', stderr: '' };
			},
		);

		try {
			await branch.resetToMainAfterMerge(testCwd);
		} catch {
			// ignore
		}

		restore();

		// Assert: no clean call uses bare -fd
		const badCleanCalls = capturedArgs.filter(
			(args) => args[0] === 'clean' && args[1] === '-fd' && args.length === 2,
		);
		expect(badCleanCalls).toEqual([]);
	});
});
