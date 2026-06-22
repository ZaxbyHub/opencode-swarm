/**
 * Git-failure handling tests for src/tools/checkpoint.ts
 *
 * These tests verify:
 * 1. gitExec transient retry on ETIMEDOUT
 * 2. gitExec immediate throw on permanent (non-zero exit) errors
 * 3. isGitRepo warning on permanent git failure (surfaces via entry guard)
 * 4. Entry guard surfaces specific warning instead of generic message
 *
 * NOTE: saveCheckpointRecord's "empty SHA warning" is NOT reachable via
 * checkpoint.execute('save') — handleSave throws when getCurrentSha throws,
 * propagating to execute() error path. saveCheckpointRecord is internal-only.
 * The entry guard (isGitRepo warning) is the testable surface for git failures.
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
mock.module('node:child_process', () => ({
	spawnSync: mockSpawnSync,
}));

// Import checkpoint AFTER mock is set up
const { checkpoint } = await import('../../../src/tools/checkpoint');

function setupMock(...values: Array<child_process.SpawnSyncReturns<string>>) {
	callCount = 0;
	returnValues = values;
	mockSpawnSync.mockClear();
}

// Undo the module mock after all tests in this file
afterEach(() => {
	mock.restore();
});

// =============================================================================
// gitExec transient retry
// =============================================================================

describe('gitExec transient retry', () => {
	/**
	 * Test that gitExec retries on ETIMEDOUT errors.
	 *
	 * The 'list' action triggers isGitRepo (one gitExec call).
	 * We make it return ETIMEDOUT so gitExec retries MAX_TRANSIENT_RETRIES
	 * times, then throws. The entry guard catches this and returns a
	 * transient failure warning.
	 */
	test('retries on ETIMEDOUT and surfaces transient failure warning via entry guard', async () => {
		// All calls return ETIMEDOUT — gitExec will retry up to
		// MAX_TRANSIENT_RETRIES (5) times, then throw.
		const etimedoutError = {
			status: null as number | null,
			stdout: '',
			stderr: '',
			error: {
				code: 'ETIMEDOUT',
				message: 'spawn ETIMEDOUT',
			} as NodeJS.ErrnoException,
		};

		// Provide enough ETIMEDOUT values to exhaust all retry attempts.
		// isGitRepo makes 1 call that retried 5 times = 5 total calls.
		setupMock(
			etimedoutError,
			etimedoutError,
			etimedoutError,
			etimedoutError,
			etimedoutError,
		);

		const result = await checkpoint.execute({ action: 'list' });

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		// Entry guard surfaces the transient failure warning from isGitRepo
		expect(parsed.error).toMatch(/transient|ETIMEDOUT|timed out/i);
		// 5 calls = 1st attempt + 4 retries exhausted
		expect(callCount).toBe(5);
	});

	test('permanent (non-zero exit) error throws immediately without retry', async () => {
		// Non-zero exit status is a permanent error — should throw on FIRST call.
		// isGitRepo catches it and returns { isRepo: false, warning }.
		setupMock({
			status: 128,
			stdout: '',
			stderr: 'fatal: not a git repository',
			error: undefined,
		});

		const result = await checkpoint.execute({ action: 'list' });

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		// isGitRepo permanent failure warning
		expect(parsed.error).toMatch(/git probe failed|not a git repository/);
		// MUST be exactly 1 call — no retry for permanent errors
		expect(callCount).toBe(1);
	});

	test('non-ETIMEDOUT spawn error without ENOENT pattern throws immediately', async () => {
		// ENOENT is classified as transient by isGitRepo (matches /ENOENT/i).
		// Use a different error code to test the permanent spawn-error path.
		setupMock({
			status: null as number | null,
			stdout: '',
			stderr: '',
			error: {
				code: 'EACCES',
				message: 'spawn EACCES',
			} as NodeJS.ErrnoException,
		});

		const result = await checkpoint.execute({ action: 'list' });

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		// Should be the permanent failure warning (EACCES is NOT transient)
		expect(parsed.error).toMatch(/git probe failed|EACCES/);
		// Exactly 1 call — no retry for non-ETIMEDOUT permanent spawn errors
		expect(callCount).toBe(1);
	});
});

// =============================================================================
// isGitRepo warning on permanent failure
// =============================================================================

describe('isGitRepo warning on permanent failure', () => {
	test('returns warning when git probe fails permanently', async () => {
		setupMock({
			status: 128,
			stdout: '',
			stderr: 'fatal: not a git repository',
			error: undefined,
		});

		const result = await checkpoint.execute({ action: 'list' });

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		// Error includes the specific warning from isGitRepo's catch block
		expect(parsed.error).toMatch(/git probe failed|not a git repository/);
		expect(callCount).toBe(1);
	});

	test('transient ETIMEDOUT in isGitRepo surfaces retry-exhaustion warning', async () => {
		// When all retries are exhausted for ETIMEDOUT, isGitRepo catches
		// the throw and returns a transient failure warning.
		const etimedoutError = {
			status: null as number | null,
			stdout: '',
			stderr: '',
			error: {
				code: 'ETIMEDOUT',
				message: 'spawn ETIMEDOUT',
			} as NodeJS.ErrnoException,
		};
		setupMock(
			etimedoutError,
			etimedoutError,
			etimedoutError,
			etimedoutError,
			etimedoutError,
		);

		const result = await checkpoint.execute({ action: 'list' });

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		// Should be the transient failure warning from isGitRepo's catch block
		expect(parsed.error).toMatch(/transient|ETIMEDOUT|timed out/i);
	});
});

// =============================================================================
// Entry guard warning specificity
// =============================================================================

describe('Entry guard warning specificity', () => {
	test('error includes specific isGitRepo warning, not generic message', async () => {
		// Permanent failure — isGitRepo catch block returns:
		// { isRepo: false, warning: 'git probe failed — directory may not be a git repository' }
		setupMock({
			status: 128,
			stdout: '',
			stderr: 'fatal: not a git repository',
			error: undefined,
		});

		const result = await checkpoint.execute({ action: 'list' });

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		// Error should include the specific warning from isGitRepo
		expect(parsed.error).toContain('git probe failed');
		// And the suffix about requiring a git repository
		expect(parsed.error).toContain('checkpoint tools require a git repository');
	});

	test('transient ETIMEDOUT error includes retry-exhaustion specific message', async () => {
		const etimedoutError = {
			status: null as number | null,
			stdout: '',
			stderr: '',
			error: {
				code: 'ETIMEDOUT',
				message: 'spawn ETIMEDOUT',
			} as NodeJS.ErrnoException,
		};
		setupMock(
			etimedoutError,
			etimedoutError,
			etimedoutError,
			etimedoutError,
			etimedoutError,
		);

		const result = await checkpoint.execute({ action: 'list' });

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		// Should surface the specific transient failure warning, not generic message
		expect(parsed.error).toContain('transient failure');
		expect(parsed.error).toContain('checkpoint tools require a git repository');
	});
});

// =============================================================================
// saveCheckpointRecord empty SHA — NOT directly testable via execute('save')
// =============================================================================

describe('saveCheckpointRecord — unreachable via execute (internal only)', () => {
	/**
	 * saveCheckpointRecord is NOT exported — it's internal to checkpoint.ts.
	 *
	 * The warning "no git restore target — checkpoint recorded without a SHA"
	 * is set inside saveCheckpointRecord when sha is empty. However:
	 *
	 * - checkpoint.execute('save') calls handleSave, NOT saveCheckpointRecord
	 * - handleSave throws when getCurrentSha throws, so the warning is not returned
	 * - The warning is only returned by saveCheckpointRecord itself
	 *
	 * This code path is NOT reachable via the public execute() interface.
	 * Recorded here as documentation of the limitation.
	 */
	test.skip('saveCheckpointRecord warning is internal-only and not testable via execute', () => {
		// This test is a no-op marker documenting that the warning path
		// inside saveCheckpointRecord cannot be exercised through execute('save').
		// The function is internal (not exported) and handleSave throws instead
		// of returning the warning when getCurrentSha throws.
	});
});

// =============================================================================
// Entry guard blocks save action on non-git directory
// =============================================================================

describe('Entry guard blocks save on non-git directory', () => {
	test('save action returns error with specific warning when not a git repo', async () => {
		// First call: isGitRepo probe → permanent failure
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
		expect(parsed.error).toMatch(/git probe failed|not a git repository/);
		expect(parsed.error).toContain('checkpoint tools require a git repository');
	});
});
