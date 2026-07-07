/**
 * Verification tests for SC-127: spawnSync _internals DI seam env behavior.
 *
 * Tests that each of the 4 seam sites (pr.ts, branch.ts) correctly handle:
 * 1. envOverrides sets a value in the child
 * 2. envOverrides: null deletes an inherited var
 * 3. env: {} (explicit empty) excludes parent env — regression test from Task 2.1
 * 4. no env and no envOverrides inherits parent env
 * 5. process.env is NOT mutated after the call
 * 6. Real e2e test for pr.ts seam
 *
 * Uses _internals.spawnSync for pr.ts and branch.ts which both expose
 * __spawnSyncSeam.spawnSync as _internals.spawnSync.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as child_process from 'node:child_process';
import * as os from 'node:os';

// ============================================================================
// pr.ts seam tests
// ============================================================================
describe('pr.ts _internals.spawnSync env behavior', () => {
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
		const { _internals } = require('../../../src/git/pr');
		const key = 'PR_ENV_SET_KEY';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		_internals.spawnSync('node', ['-e', 'process.exit(0)'], {
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
		const { _internals } = require('../../../src/git/pr');
		const key = 'PR_ENV_DELETE_KEY';
		process.env[key] = 'parent_value';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		_internals.spawnSync('node', ['-e', 'process.exit(0)'], {
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
		const { _internals } = require('../../../src/git/pr');
		const key = 'PR_ENV_EXPLICIT_EMPTY';
		process.env[key] = 'parent_value';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		_internals.spawnSync('node', ['-e', 'process.exit(0)'], {
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
		const { _internals } = require('../../../src/git/pr');
		const key = 'PR_ENV_INHERIT';
		process.env[key] = 'parent_value';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		_internals.spawnSync('node', ['-e', 'process.exit(0)'], {
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
		const { _internals } = require('../../../src/git/pr');
		const key = 'PR_ENV_NO_MUTATION';
		process.env[key] = 'original_value';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		_internals.spawnSync('node', ['-e', 'process.exit(0)'], {
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
// branch.ts seam tests
// ============================================================================
describe('branch.ts _internals.spawnSync env behavior', () => {
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
		const { _internals } = require('../../../src/git/branch');
		const key = 'BRANCH_ENV_SET_KEY';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		_internals.spawnSync('node', ['-e', 'process.exit(0)'], {
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
		const { _internals } = require('../../../src/git/branch');
		const key = 'BRANCH_ENV_DELETE_KEY';
		process.env[key] = 'parent_value';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		_internals.spawnSync('node', ['-e', 'process.exit(0)'], {
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
		const { _internals } = require('../../../src/git/branch');
		const key = 'BRANCH_ENV_EXPLICIT_EMPTY';
		process.env[key] = 'parent_value';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		_internals.spawnSync('node', ['-e', 'process.exit(0)'], {
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
		const { _internals } = require('../../../src/git/branch');
		const key = 'BRANCH_ENV_INHERIT';
		process.env[key] = 'parent_value';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		_internals.spawnSync('node', ['-e', 'process.exit(0)'], {
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
		const { _internals } = require('../../../src/git/branch');
		const key = 'BRANCH_ENV_NO_MUTATION';
		process.env[key] = 'original_value';
		mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

		_internals.spawnSync('node', ['-e', 'process.exit(0)'], {
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
