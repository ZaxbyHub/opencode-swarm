/**
 * Verification tests for SC-127: url-security.ts _internals.spawnSync env behavior.
 *
 * Tests that url-security.ts _internals.spawnSync correctly handles:
 * 1. envOverrides sets a value in the child
 * 2. envOverrides: null deletes an inherited var
 * 3. env: {} (explicit empty) excludes parent env — regression test from Task 2.1
 * 4. no env and no envOverrides inherits parent env
 * 5. process.env is NOT mutated after the call
 * 6. Real e2e test for the seam
 *
 * url-security.ts exposes _internals.spawnSync publicly so it can be tested
 * directly without touching child_process internals.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as child_process from 'node:child_process';
import * as os from 'node:os';
import { _internals as urlSecurityInternals } from '../../../src/commands/_shared/url-security';

describe('url-security.ts _internals.spawnSync env behavior', () => {
	let mockSpawnSync: ReturnType<typeof spyOn>;

	beforeEach(() => {
		mockSpawnSync = spyOn(child_process, 'spawnSync').mockImplementation(
			() => ({ status: 0, stdout: '', stderr: '' }),
		);
	});

	afterEach(() => {
		if (mockSpawnSync) {
			mockSpawnSync.mockRestore();
		}
	});

	// SC-127.1: envOverrides sets a value in the child
	it('envOverrides sets a value in child env', () => {
		const key = 'URL_SEC_SPAWN_SET';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		urlSecurityInternals.spawnSync('node', ['-e', 'process.exit(0)'], {
			cwd: os.tmpdir(),
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'pipe'] as any,
			envOverrides: { [key]: 'override_value' },
		});

		expect(mockSpawnSync).toHaveBeenCalled();
		const lastCall =
			mockSpawnSync.mock.calls[mockSpawnSync.mock.calls.length - 1];
		const envArg = lastCall?.[2]?.env as Record<string, string> | undefined;
		expect(envArg?.[key]).toBe('override_value');
		mockSpawnSync.mockClear();
	});

	// SC-127.2: envOverrides: null deletes an inherited var
	it('envOverrides: null deletes an inherited var from child env', () => {
		const key = 'URL_SEC_SPAWN_DELETE';
		process.env[key] = 'parent_value';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		urlSecurityInternals.spawnSync('node', ['-e', 'process.exit(0)'], {
			cwd: os.tmpdir(),
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'pipe'] as any,
			envOverrides: { [key]: null },
		});

		expect(mockSpawnSync).toHaveBeenCalled();
		const lastCall =
			mockSpawnSync.mock.calls[mockSpawnSync.mock.calls.length - 1];
		const envArg = lastCall?.[2]?.env as Record<string, string> | undefined;
		expect(envArg?.[key]).toBeUndefined();
		delete process.env[key];
		mockSpawnSync.mockClear();
	});

	// SC-127.3: explicit env: {} excludes parent env — regression test
	it('explicit env: {} excludes parent env', () => {
		const key = 'URL_SEC_SPAWN_EXPLICIT_EMPTY';
		process.env[key] = 'parent_value';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		urlSecurityInternals.spawnSync('node', ['-e', 'process.exit(0)'], {
			cwd: os.tmpdir(),
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'pipe'] as any,
			env: {},
		});

		expect(mockSpawnSync).toHaveBeenCalled();
		const lastCall =
			mockSpawnSync.mock.calls[mockSpawnSync.mock.calls.length - 1];
		const envArg = lastCall?.[2]?.env as Record<string, string> | undefined;
		expect(envArg?.[key]).toBeUndefined();
		delete process.env[key];
		mockSpawnSync.mockClear();
	});

	// SC-127.4: no env and no envOverrides inherits parent env
	it('no env and no envOverrides inherits parent env', () => {
		const key = 'URL_SEC_SPAWN_INHERIT';
		process.env[key] = 'parent_value';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		urlSecurityInternals.spawnSync('node', ['-e', 'process.exit(0)'], {
			cwd: os.tmpdir(),
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'pipe'] as any,
		});

		expect(mockSpawnSync).toHaveBeenCalled();
		const lastCall =
			mockSpawnSync.mock.calls[mockSpawnSync.mock.calls.length - 1];
		const envArg = lastCall?.[2]?.env as Record<string, string> | undefined;
		expect(envArg?.[key]).toBe('parent_value');
		delete process.env[key];
		mockSpawnSync.mockClear();
	});

	// SC-127.5: process.env is NOT mutated
	it('process.env is NOT mutated after the call', () => {
		const key = 'URL_SEC_SPAWN_NO_MUTATION';
		process.env[key] = 'original_value';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		urlSecurityInternals.spawnSync('node', ['-e', 'process.exit(0)'], {
			cwd: os.tmpdir(),
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'pipe'] as any,
			envOverrides: { [key]: 'after' },
		});

		expect(process.env[key]).toBe('original_value');
		delete process.env[key];
		mockSpawnSync.mockRestore();
	});
});

// ============================================================================
// url-security.ts e2e test — no spyOn, uses real spawnSync
// ============================================================================
describe('url-security.ts _internals.spawnSync env e2e (no mock)', () => {
	// SC-127.6: Real e2e test — child process actually sees the injected var
	// Uses real spawnSync (no spyOn) so the actual child process is spawned
	it('real e2e: child process sees injected env var', () => {
		const key = 'URL_SEC_E2E_INJECTED';
		const injectedValue = 'injected_' + Date.now();

		const result = urlSecurityInternals.spawnSync(
			'node',
			['-e', `console.log(process.env.${key})`],
			{
				cwd: os.tmpdir(),
				encoding: 'utf-8',
				timeout: 5000,
				stdio: ['ignore', 'pipe', 'pipe'] as any,
				envOverrides: { [key]: injectedValue },
			},
		);

		const stdout = (result as any).stdout as string;
		expect(stdout.trim()).toBe(injectedValue);
		delete process.env[key];
	});
});
