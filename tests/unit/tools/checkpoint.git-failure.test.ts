/**
 * Git-failure handling tests for src/tools/checkpoint.ts
 *
 * #3427 rewrite: the entry preflight rides the shared async reader
 * (`readGitRepositoryStatusAsync`) instead of the local sync `isGitRepo`
 * helper, so preflight legs stub the READER (a spread-real module mock of
 * `git-status-read`) and assert the uniform not-a-repository refusal with
 * ZERO sync spawns. The local `gitExec` retry/classification contract is
 * unchanged and still covered — through the `save` action's `handleSave`
 * body, which retains the sync gitExec chain (stageAllExcludingSwarm is its
 * first git call).
 *
 * These tests MUST run in isolation from checkpoint.test.ts (real git tests)
 * because they mock spawnSync globally. They are in a separate file to avoid
 * contaminating the real-git test suite.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type * as child_process from 'node:child_process';

// Track call count across all spawnSync invocations
let callCount = 0;
let returnValues: Array<child_process.SpawnSyncReturns<string>> = [];

const mockSpawnSync = mock(
	(
		_command: string,
		_args: string[],
		_options: Record<string, unknown>,
	): child_process.SpawnSyncReturns<string> => {
		const result =
			returnValues[callCount] ??
			({
				status: 0,
				stdout: '',
				stderr: '',
				error: undefined,
			} as child_process.SpawnSyncReturns<string>);
		callCount++;
		return result;
	},
);

// Mock node:child_process BEFORE importing checkpoint
import * as realChildProcess from 'node:child_process';

mock.module('node:child_process', () => ({
	...realChildProcess,
	spawnSync: mockSpawnSync,
}));

// #3427 feedback (PRR-011): the reader probes are stubbed through the
// _internals seams by PROPERTY ASSIGNMENT (restored in afterEach) — the
// previous mock.module registration on the git-status-read module was
// process-global and poisoned co-run files. `setupReader` arms both seams:
// the preflight reads the DETAILED twin (#3442 cause-specific refusal), the
// save probe reads the boolean-ok twin.
let repoProbeResult = false;
let readerCalls = 0;

// Import checkpoint BEFORE installing seam stubs (property assignment needs
// the live _internals object).
const { checkpoint, _internals } = await import(
	'../../../src/tools/checkpoint'
);

const originalReadGitStatusAsync = _internals.readGitStatusAsync;
const originalReadDetailed = _internals.readGitRepositoryStatusDetailedAsync;

// Issue #2236 hardening: `gitExec` resolves the git executable via
// `_internals.resolveGitExecutable()` before spawning. Left un-stubbed, that
// resolver's own candidate-probing loop would consume calls from the SAME
// mocked `spawnSync` this file uses to drive `gitExec`'s retry/classification
// logic, throwing off the `callCount` assertions below. Stubbed to a fixed
// value so only `gitExec`'s own spawn calls are counted.
const originalResolveGitExecutable = _internals.resolveGitExecutable;

function setupMock(...values: Array<child_process.SpawnSyncReturns<string>>) {
	callCount = 0;
	returnValues = values;
	mockSpawnSync.mockClear();
}

function setupReader(isRepo: boolean) {
	repoProbeResult = isRepo;
	readerCalls = 0;
	_internals.readGitRepositoryStatusDetailedAsync = (async () => {
		readerCalls += 1;
		return isRepo
			? { isRepo: true as const }
			: {
					isRepo: false as const,
					reason: 'not_git_repo' as const,
					message: 'fatal: not a git repository',
				};
	}) as unknown as typeof _internals.readGitRepositoryStatusDetailedAsync;
	_internals.readGitStatusAsync = (async () => {
		readerCalls += 1;
		return isRepo
			? { ok: true as const, stdout: '.git' }
			: { ok: false as const, code: null, status: 1, stderrTail: '' };
	}) as unknown as typeof _internals.readGitStatusAsync;
}

beforeEach(() => {
	_internals.resolveGitExecutable = () => 'git';
});

// Restore every property-assignment seam (the node:child_process mock.module
// below stays for the file's lifetime — its isolation constraint is the
// file-header note, unchanged from base).
afterEach(() => {
	mock.restore();
	_internals.resolveGitExecutable = originalResolveGitExecutable;
	_internals.readGitStatusAsync = originalReadGitStatusAsync;
	_internals.readGitRepositoryStatusDetailedAsync = originalReadDetailed;
});

// =============================================================================
// Entry preflight — async reader (#3427)
// =============================================================================

describe('entry preflight rides the async reader', () => {
	test('reader-false directory refuses with the uniform message and ZERO sync spawns', async () => {
		setupReader(false);
		setupMock();

		const result = await checkpoint.execute({ action: 'list' });

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		// Uniform refusal — the old sync probe's retry-chain warning texts
		// ("git probe failed after retry exhaustion - …") died with the
		// removed local isGitRepo helper.
		expect(parsed.error).toBe(
			'not a git repository - checkpoint tools require a git repository',
		);
		expect(parsed.error).toContain('checkpoint tools require a git repository');
		// The preflight crossed the reader, never a sync spawn.
		expect(readerCalls).toBe(1);
		expect(callCount).toBe(0);
	});

	test('reader-true preflight proceeds to the action without sync spawns (list)', async () => {
		setupReader(true);
		setupMock();

		const result = await checkpoint.execute({ action: 'list' });

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(readerCalls).toBe(1);
		// list is read-only filesystem work — no git spawn at all.
		expect(callCount).toBe(0);
	});
});

// =============================================================================
// Entry guard blocks save action on a reader-false directory
// =============================================================================

describe('entry guard blocks save on reader-false directory', () => {
	test('save action returns the uniform refusal before any mutation', async () => {
		setupReader(false);
		// If the guard leaked, handleSave's first gitExec call would consume
		// this permanent-failure value — the assertion surface below proves
		// it never ran.
		setupMock({
			status: 128,
			stdout: '',
			stderr: 'fatal: not a git repository',
			error: undefined,
		});

		const result = await checkpoint.execute({
			action: 'save',
			label: 'should-not-save',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(
			'not a git repository - checkpoint tools require a git repository',
		);
		expect(readerCalls).toBe(1);
		expect(callCount).toBe(0);
	});
});

// =============================================================================
// gitExec transient retry — via the save action's handleSave body
// =============================================================================

describe('gitExec transient retry (via handleSave)', () => {
	/**
	 * The preflight passes (reader true), so handleSave runs and its first
	 * git call — stageAllExcludingSwarm — exercises the local gitExec
	 * retry/classification contract under the mocked spawnSync.
	 */
	const etimedoutError = {
		status: null as number | null,
		stdout: '',
		stderr: '',
		error: {
			code: 'ETIMEDOUT',
			message: 'spawn ETIMEDOUT',
		} as NodeJS.ErrnoException,
	};

	test('retries on ETIMEDOUT up to the retry ceiling, then fails the save', async () => {
		setupReader(true);
		// Enough ETIMEDOUT values to exhaust every retry attempt.
		setupMock(
			etimedoutError,
			etimedoutError,
			etimedoutError,
			etimedoutError,
			etimedoutError,
		);

		const result = await checkpoint.execute({
			action: 'save',
			label: 'retry-exhaustion-probe',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toMatch(/ETIMEDOUT|save failed/);
		// 5 calls = first attempt + retries exhausted.
		expect(callCount).toBe(5);
	});

	test('permanent (non-zero exit) error throws immediately without retry', async () => {
		setupReader(true);
		setupMock({
			status: 128,
			stdout: '',
			stderr: 'fatal: bad object HEAD',
			error: undefined,
		});

		const result = await checkpoint.execute({
			action: 'save',
			label: 'permanent-failure-probe',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('fatal: bad object HEAD');
		// Exactly 1 call — no retry for permanent errors.
		expect(callCount).toBe(1);
	});

	test('non-ETIMEDOUT spawn error (EACCES) throws immediately', async () => {
		setupReader(true);
		setupMock({
			status: null as number | null,
			stdout: '',
			stderr: '',
			error: {
				code: 'EACCES',
				message: 'spawn EACCES',
			} as NodeJS.ErrnoException,
		});

		const result = await checkpoint.execute({
			action: 'save',
			label: 'spawn-error-probe',
		});

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toMatch(/EACCES|save failed/);
		// Exactly 1 call — no retry for non-ETIMEDOUT permanent spawn errors.
		expect(callCount).toBe(1);
	});
});

// NOTE (coverage map): saveCheckpointRecord's reader-backed probe and its
// empty-SHA guard are exercised in
// tests/unit/tools/checkpoint-preflight-async-3317.test.ts (the #3427
// dedicated suite); restore-path git failures stay covered by
// checkpoint-restore-gate.test.ts / checkpoint-restore-cause-3275.test.ts.
