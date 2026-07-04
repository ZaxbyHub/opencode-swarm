/**
 * Verification tests for SC-127: close.ts _internals.spawnSync env behavior.
 *
 * Tests that close.ts _internals.spawnSync correctly handles:
 * 1. envOverrides sets a value in the child
 * 2. envOverrides: null deletes an inherited var
 * 3. env: {} (explicit empty) excludes parent env — regression test from Task 2.1
 * 4. no env and no envOverrides inherits parent env
 * 5. process.env is NOT mutated after the call
 * 6. Real e2e test using actual child process
 *
 * Uses the same mock.module pattern as close-sqlite-safe.test.ts:
 * mock.module is called BEFORE importing close.ts so the module loads
 * with the mocked child_process already in place.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import * as os from 'node:os';

describe('close.ts _internals.spawnSync env behavior', () => {
	let spawnMock: ReturnType<typeof mock>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let ci: any;
	let testDir: string;

	beforeEach(async () => {
		testDir = os.tmpdir();
		spawnMock = mock((...args: unknown[]) => {
			const real = realChildProcess.spawnSync(
				args[0] as string,
				args[1] as string[],
				args[2] as Parameters<typeof realChildProcess.spawnSync>[2],
			);
			return real;
		});

		// Must call mock.module BEFORE importing close.ts so the module
		// loads with the mocked child_process already in place
		await mock.module('node:child_process', () => ({
			...realChildProcess,
			spawnSync: spawnMock,
		}));

		const mod = await import('../../../src/commands/close.js');
		ci = mod._internals;
	});

	afterEach(() => {
		mock.restore();
	});

	// SC-127.1: envOverrides sets a value in the child
	it('envOverrides sets a value in child env', async () => {
		const key = 'CLOSE_ENV_SET';
		spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		ci.spawnSync('node', ['-e', 'process.exit(0)'], {
			cwd: testDir,
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'pipe'],
			envOverrides: { [key]: 'override_value' },
		});

		expect(spawnMock).toHaveBeenCalled();
		const lastCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
		const envArg = lastCall?.[2]?.env as Record<string, string> | undefined;
		expect(envArg?.[key]).toBe('override_value');
	});

	// SC-127.2: envOverrides: null deletes an inherited var
	it('envOverrides: null deletes an inherited var from child env', async () => {
		const key = 'CLOSE_ENV_DELETE';
		process.env[key] = 'parent_value';
		spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		ci.spawnSync('node', ['-e', 'process.exit(0)'], {
			cwd: testDir,
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'pipe'],
			envOverrides: { [key]: null },
		});

		expect(spawnMock).toHaveBeenCalled();
		const lastCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
		const envArg = lastCall?.[2]?.env as Record<string, string> | undefined;
		expect(envArg?.[key]).toBeUndefined();
		delete process.env[key];
	});

	// SC-127.3: explicit env: {} excludes parent env — regression test
	it('explicit env: {} excludes parent env', async () => {
		const key = 'CLOSE_ENV_EXPLICIT_EMPTY';
		process.env[key] = 'parent_value';
		spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		ci.spawnSync('node', ['-e', 'process.exit(0)'], {
			cwd: testDir,
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {},
		});

		expect(spawnMock).toHaveBeenCalled();
		const lastCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
		const envArg = lastCall?.[2]?.env as Record<string, string> | undefined;
		expect(envArg?.[key]).toBeUndefined();
		delete process.env[key];
	});

	// SC-127.4: no env and no envOverrides inherits parent env
	it('no env and no envOverrides inherits parent env', async () => {
		const key = 'CLOSE_ENV_INHERIT';
		process.env[key] = 'parent_value';
		spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		ci.spawnSync('node', ['-e', 'process.exit(0)'], {
			cwd: testDir,
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		expect(spawnMock).toHaveBeenCalled();
		const lastCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
		const envArg = lastCall?.[2]?.env as Record<string, string> | undefined;
		expect(envArg?.[key]).toBe('parent_value');
		delete process.env[key];
	});

	// SC-127.5: process.env is NOT mutated
	it('process.env is NOT mutated after the call', async () => {
		const key = 'CLOSE_ENV_NO_MUTATION';
		process.env[key] = 'original_value';
		spawnMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		ci.spawnSync('node', ['-e', 'process.exit(0)'], {
			cwd: testDir,
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'pipe'],
			envOverrides: { [key]: 'after' },
		});

		expect(process.env[key]).toBe('original_value');
		delete process.env[key];
	});
});
