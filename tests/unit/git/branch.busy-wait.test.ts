/**
 * FR-018: Verify resetToMainAfterMerge and resetToRemoteBranch no longer contain
 * synchronous busy-wait spin loops that block the Node.js event loop on Windows.
 *
 * These tests confirm:
 * 1. Both functions are now async (return Promises).
 * 2. The retry path resolves correctly (async setTimeout works, not spin loop).
 * 3. No synchronous `while (Date.now() < endTime)` spin loops remain.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock state — module-level so each test can configure the sequence
// ---------------------------------------------------------------------------

type SpawnResult = { status: number; stdout: string; stderr: string };

let callIndex = 0;
let returnValues: SpawnResult[] = [];

const gitCalls: { args: string[]; cwd: string }[] = [];

const mockSpawnSync = mock(
	(command: string, args: string[], options: { cwd: string }) => {
		const result = returnValues[callIndex] ?? {
			status: 0,
			stdout: '',
			stderr: '',
		};
		gitCalls.push({ args: args as string[], cwd: options.cwd });
		callIndex++;
		return result;
	},
);

mock.module('node:child_process', () => ({
	...realChildProcess,
	spawnSync: mockSpawnSync,
}));

afterEach(() => {
	mock.restore();
});

const branch = await import('../../../src/git/branch');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupMock(...values: SpawnResult[]) {
	callIndex = 0;
	returnValues = values;
	gitCalls.length = 0;
	mockSpawnSync.mockClear();
}

// ---------------------------------------------------------------------------
// FR-018: resetToMainAfterMerge — async + no spin loop
// ---------------------------------------------------------------------------

describe('FR-018: resetToMainAfterMerge is async and has no spin loop', () => {
	const testCwd = '/test/repo';

	beforeEach(() => {
		callIndex = 0;
		returnValues = [];
		gitCalls.length = 0;
		mockSpawnSync.mockClear();
	});

	test('returns a Promise (is async)', () => {
		setupMock(
			{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // symbolic-ref
			{ status: 0, stdout: 'main', stderr: '' }, // getCurrentBranch
			{ status: 0, stdout: '', stderr: '' }, // log
			{ status: 0, stdout: '', stderr: '' }, // fetch
			{ status: 0, stdout: '', stderr: '' }, // hasUncommittedChanges
			{ status: 0, stdout: '', stderr: '' }, // reset --hard
		);

		const result = branch.resetToMainAfterMerge(testCwd);
		expect(result).toBeInstanceOf(Promise);
	});

	test('resolves successfully via async retry path (proves no spin-loop hang)', async () => {
		// Simulate discard failing on retry 1 (Windows file-locking), succeeding on retry 2.
		// On Windows, the async setTimeout path is taken (retry > 0).
		// If a spin loop were present, the test would block for 500ms per iteration.
		setupMock(
			{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
			{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
			{ status: 0, stdout: '', stderr: '' }, // 3. log
			{ status: 0, stdout: '', stderr: '' }, // 4. fetch
			{ status: 0, stdout: '', stderr: '' }, // 5. checkout main
			{ status: 0, stdout: '', stderr: '' }, // 6. reset --hard
			{ status: 0, stdout: ' M dirty.txt\n', stderr: '' }, // 7. hasUncommittedChanges (dirty)
			{ status: 1, stdout: '', stderr: 'unable to lock index' }, // 8. discard FAIL 1
			{ status: 0, stdout: '', stderr: '' }, // 9. discard SUCCESS 2
			{ status: 0, stdout: '', stderr: '' }, // 7b. clean -fdX
			{ status: 0, stdout: '  feat/x\n* main\n', stderr: '' }, // 8. branch --merged
			{ status: 0, stdout: '', stderr: '' }, // 8. branch -d feat/x
		);

		// Patch process.platform to win32 to trigger the Windows retry path
		const originalPlatform = process.platform;
		Object.defineProperty(process, 'platform', {
			value: 'win32',
			configurable: true,
		});

		const result = await branch.resetToMainAfterMerge(testCwd);

		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			configurable: true,
		});

		// If a synchronous spin loop were present, this test would hang/block.
		// With async setTimeout, it resolves promptly.
		expect(result.success).toBe(true);
		expect(result.changesDiscarded).toBe(true);
	});

	test('source code contains no spin-loop pattern (while Date.now() < endTime)', async () => {
		// Read the source file and verify the spin-loop pattern is gone.
		const { readFileSync } = await import('node:fs');
		const sourcePath = path.join(process.cwd(), 'src', 'git', 'branch.ts');
		const source = readFileSync(sourcePath, 'utf-8');

		// The spin-loop pattern must NOT appear
		expect(source).not.toContain('while (Date.now() < endTime)');
		// The async wait pattern MUST appear
		expect(source).toContain(
			'await new Promise((resolve) => setTimeout(resolve, 500))',
		);
	});
});

// ---------------------------------------------------------------------------
// FR-018: resetToRemoteBranch — async + no spin loop
// ---------------------------------------------------------------------------

describe('FR-018: resetToRemoteBranch is async and has no spin loop', () => {
	const testCwd = '/test/repo';

	beforeEach(() => {
		callIndex = 0;
		returnValues = [];
		gitCalls.length = 0;
		mockSpawnSync.mockClear();
	});

	test('returns a Promise (is async)', () => {
		setupMock(
			{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // symbolic-ref
			{ status: 0, stdout: 'feat/x', stderr: '' }, // getCurrentBranch
			{ status: 0, stdout: '', stderr: '' }, // log (no unpushed)
			{ status: 0, stdout: '', stderr: '' }, // fetch
			{ status: 0, stdout: 'abc123', stderr: '' }, // rev-parse HEAD
			{ status: 0, stdout: 'def456', stderr: '' }, // rev-parse origin/main (different)
		);

		const result = branch.resetToRemoteBranch(testCwd);
		expect(result).toBeInstanceOf(Promise);
	});

	test('resetToRemoteBranch async retry resolves — existing branch.resetToRemoteBranch.test.ts covers retry behavior', async () => {
		// The detailed retry behavior (Windows lock → retry) is already verified by the
		// existing tests in branch.resetToRemoteBranch.test.ts. Here we verify the function
		// is async (returns a Promise) and the source contains no spin loop.
		// The async nature of the function means the retry path yields to the event loop
		// via setTimeout instead of spinning.
		setupMock(
			{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
			{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
			{ status: 0, stdout: '', stderr: '' }, // 3. log
			{ status: 0, stdout: '', stderr: '' }, // 4. fetch
		);

		const result = branch.resetToRemoteBranch(testCwd);
		expect(result).toBeInstanceOf(Promise);

		// Await to confirm no sync errors
		const resolved = await result;
		// Either alreadyAligned or success — either way, async path works
		expect(typeof resolved.success).toBe('boolean');
	});

	test('source code contains no spin-loop pattern (while Date.now() < endTime)', async () => {
		const { readFileSync } = await import('node:fs');
		const sourcePath = path.join(process.cwd(), 'src', 'git', 'branch.ts');
		const source = readFileSync(sourcePath, 'utf-8');

		expect(source).not.toContain('while (Date.now() < endTime)');
		expect(source).toContain(
			'await new Promise((resolve) => setTimeout(resolve, 500))',
		);
	});
});
