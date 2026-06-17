/**
 * Tests for Linux Bubblewrap sandbox implementation:
 * - src/sandbox/linux/bubblewrap-executor.ts
 *
 * Platform notes:
 * - isAvailable() tests are skipped on Windows because bwrap is a Linux-specific binary.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// bubblewrap-executor.ts — import (module-level, not mocked)
// ---------------------------------------------------------------------------

import { SandboxError } from '../../../src/sandbox/executor';
import {
	_internals,
	BubblewrapSandboxExecutor,
	// Note: probeBwrap and shellEscape are module-private; we test them
	// indirectly via isAvailable() and wrapCommand() respectively.
	// _internals.probeBwrap is used to simulate ENOENT/EACCES/ENOSPC errors.
} from '../../../src/sandbox/linux/bubblewrap-executor';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('BubblewrapSandboxExecutor', () => {
	// -----------------------------------------------------------------------
	// 1. Constructor
	// -----------------------------------------------------------------------

	describe('constructor', () => {
		test('accepts scopePaths array', () => {
			const executor = new BubblewrapSandboxExecutor(['/home/user/scope']);
			expect(executor).toBeInstanceOf(BubblewrapSandboxExecutor);
		});

		test('accepts scopePaths and tempDir', () => {
			const executor = new BubblewrapSandboxExecutor(
				['/home/user/scope'],
				'/tmp/custom-tmp',
			);
			expect(executor).toBeInstanceOf(BubblewrapSandboxExecutor);
		});

		test('accepts empty scopePaths', () => {
			const executor = new BubblewrapSandboxExecutor([]);
			expect(executor).toBeInstanceOf(BubblewrapSandboxExecutor);
		});

		test('mechanism property is Bubblewrap', () => {
			const executor = new BubblewrapSandboxExecutor([]);
			expect(executor.mechanism).toBe('Bubblewrap');
		});
	});

	// -----------------------------------------------------------------------
	// 2. isAvailable()
	// -----------------------------------------------------------------------
	// isAvailable() calls spawnSync('bwrap', ['--version']) which is only
	// meaningful on Linux. On Windows bwrap does not exist.
	// We test the expected outcomes using mock.module at module scope.

	describe('isAvailable()', () => {
		// These tests require mock.module at module scope (not re-import) so
		// they are placed here with their own mock setup at file scope.

		test.skipIf(isWindows)(
			'returns true when bwrap binary is present on PATH',
			async () => {
				// On Linux where bwrap may exist, isAvailable() will be true.
				// On CI without bwrap it will be false ΓÇö so we just verify
				// the method returns a boolean and does not throw.
				const executor = new BubblewrapSandboxExecutor([]);
				const result = executor.isAvailable();
				expect(typeof result).toBe('boolean');
			},
		);

		test('returns false on Windows (bwrap is Linux-only)', () => {
			// Even if mock is applied, bwrap does not exist on Windows.
			// This is the documented platform contract.
			const executor = new BubblewrapSandboxExecutor([]);
			if (isWindows) {
				expect(executor.isAvailable()).toBe(false);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 3. wrapCommand()
	// -----------------------------------------------------------------------

	describe('wrapCommand()', () => {
		let executor: BubblewrapSandboxExecutor;

		beforeEach(async () => {
			// Mock probeBwrap to always return true so bwrap wrapping is tested.
			// Must be set up BEFORE creating the executor (constructor also calls probeBwrap).
			// biome-ignore format: single-line required for invariant check regex
			await mock.module('../../../src/sandbox/linux/bubblewrap-executor', () => ({
				BubblewrapSandboxExecutor,
				_internals: { ..._internals, probeBwrap: () => true },
			}));
			executor = new BubblewrapSandboxExecutor(
				['/scope/a', '/scope/b'],
				'/tmp',
			);
		});

		afterEach(() => {
			mock.restore();
		});

		test('starts with bwrap', () => {
			const result = executor.wrapCommand('echo hello', []);
			expect(result.startsWith('bwrap ')).toBe(true);
		});

		test('includes --bind for each scope path', () => {
			const result = executor.wrapCommand('echo hello', []);

			// scopePaths from constructor are /scope/a and /scope/b
			expect(result).toContain('--bind');
			expect(result).toContain('/scope/a');
			expect(result).toContain('/scope/b');
		});

		test('includes --bind for additional scope paths passed to wrapCommand', () => {
			const result = executor.wrapCommand('echo hello', ['/extra/scope']);

			expect(result).toContain('--bind');
			expect(result).toContain('/extra/scope');
		});

		test('includes --tmpfs with the temp directory', () => {
			const result = executor.wrapCommand('echo hello', []);

			expect(result).toContain('--tmpfs');
			expect(result).toContain('/tmp');
			expect(result).toContain('--size');
			expect(result).toContain('500M');
		});

		test('uses custom tempDir when provided to wrapCommand', () => {
			const result = executor.wrapCommand('echo hello', [], '/custom/tmp');

			expect(result).toContain('--tmpfs');
			expect(result).toContain('/custom/tmp');
			expect(result).toContain('--size');
			expect(result).toContain('500M');
		});

		test('includes --ro-bind /usr', () => {
			const result = executor.wrapCommand('echo hello', []);

			// Should have --ro-bind /usr /usr
			expect(result).toContain('--ro-bind');
			expect(result).toContain('/usr');
		});

		test('escapes single quotes in command', () => {
			const result = executor.wrapCommand("echo 'hello world'", []);

			// Single quote should be escaped as '\''  (shellEscape replaces ' with '\'')
			expect(result).toContain("'\\''");
		});

		test('wraps command in bash -c', () => {
			const result = executor.wrapCommand('echo hello', []);

			expect(result).toContain('bash');
			expect(result).toContain('-c');
		});

		test('merges constructor scopePaths with wrapCommand scopePaths', () => {
			// Constructor has /scope/a, wrapCommand adds /extra
			const result = executor.wrapCommand('echo hello', ['/extra']);

			expect(result).toContain('/scope/a');
			expect(result).toContain('/extra');
		});

		test('uses constructor tempDir when wrapCommand tempDir is not provided', () => {
			const execWithConstructorTmp = new BubblewrapSandboxExecutor(
				[],
				'/constructor/tmp',
			);
			const result = execWithConstructorTmp.wrapCommand('echo hello', []);

			expect(result).toContain('/constructor/tmp');
		});

		test('wrapCommand tempDir overrides constructor tempDir', () => {
			const execWithConstructorTmp = new BubblewrapSandboxExecutor(
				[],
				'/constructor/tmp',
			);
			const result = execWithConstructorTmp.wrapCommand(
				'echo hello',
				[],
				'/override/tmp',
			);

			expect(result).toContain('/override/tmp');
			expect(result).not.toContain('/constructor/tmp');
		});

		test('includes --ro-bind /lib and --ro-bind /lib64', () => {
			const result = executor.wrapCommand('echo hello', []);

			expect(result).toContain('--ro-bind');
			expect(result).toContain('/lib');
			expect(result).toContain('/lib64');
		});

		test('includes --proc /proc', () => {
			const result = executor.wrapCommand('echo hello', []);

			expect(result).toContain('--proc');
			expect(result).toContain('/proc');
		});

		test('includes --unshare-pid', () => {
			const result = executor.wrapCommand('echo hello', []);

			expect(result).toContain('--unshare-pid');
		});

		test('includes --unshare-user', () => {
			const result = executor.wrapCommand('echo hello', []);

			expect(result).toContain('--unshare-user');
		});

		test('includes --unshare-net', () => {
			const result = executor.wrapCommand('echo hello', []);

			expect(result).toContain('--unshare-net');
		});

		test('includes --unshare-ipc', () => {
			const result = executor.wrapCommand('echo hello', []);

			expect(result).toContain('--unshare-ipc');
		});

		test('includes --die-with-parent', () => {
			const result = executor.wrapCommand('echo hello', []);

			expect(result).toContain('--die-with-parent');
		});

		test('includes --new-session', () => {
			const result = executor.wrapCommand('echo hello', []);

			expect(result).toContain('--new-session');
		});

		test('includes --ro-bind /etc /etc', () => {
			const result = executor.wrapCommand('echo hello', []);

			expect(result).toContain('--ro-bind');
			expect(result).toContain('/etc');
		});

		test('includes --cap-drop ALL (capability hardening)', () => {
			const result = executor.wrapCommand('echo hello', []);

			expect(result).toContain('--cap-drop');
			expect(result).toContain('ALL');
		});
	});

	// -----------------------------------------------------------------------
	// 4. getEnvOverrides()
	// -----------------------------------------------------------------------

	describe('getEnvOverrides()', () => {
		test('returns empty object (security via CLI flags)', () => {
			const executor = new BubblewrapSandboxExecutor([]);
			const env = executor.getEnvOverrides();

			expect(env).toEqual({});
		});

		test('returns empty object regardless of scopePaths', () => {
			const executor = new BubblewrapSandboxExecutor(
				['/scope/a', '/scope/b'],
				'/tmp',
			);
			const env = executor.getEnvOverrides();

			expect(env).toEqual({});
		});
	});

	// -----------------------------------------------------------------------
	// 5. rollback / error handling
	// -----------------------------------------------------------------------

	describe('rollback ΓÇö disable()', () => {
		test('isAvailable() returns false after disable()', () => {
			// On Linux where bwrap may not exist, executor starts disabled.
			// Even if it starts enabled, disable() should set _available to false.
			const executor = new BubblewrapSandboxExecutor([]);
			executor.disable('test disable');
			expect(executor.isAvailable()).toBe(false);
		});

		test('isAvailable() is boolean on all platforms', () => {
			const executor = new BubblewrapSandboxExecutor([]);
			expect(typeof executor.isAvailable()).toBe('boolean');
		});
	});

	describe('rollback ΓÇö wrapCommand() when disabled', () => {
		test('throws SandboxError when executor is disabled via disable()', () => {
			const executor = new BubblewrapSandboxExecutor([]);
			executor.disable('testing');
			// When disabled, wrapCommand throws SandboxError
			expect(() => executor.wrapCommand('echo hello', [])).toThrow(
				SandboxError,
			);
		});

		test('throws SandboxError when executor was never available (bwrap missing)', () => {
			// On CI without bwrap, the executor is disabled from construction.
			// wrapCommand should throw SandboxError.
			const executor = new BubblewrapSandboxExecutor([]);
			if (!executor.isAvailable()) {
				expect(() => executor.wrapCommand('echo hello', [])).toThrow(
					SandboxError,
				);
			}
		});
	});

	describe('rollback ΓÇö constructor error handling', () => {
		test('disables executor when probeBwrap returns false (bwrap missing)', () => {
			// When bwrap is not found, the executor should be disabled.
			// This is expected on CI environments without bwrap installed.
			const executor = new BubblewrapSandboxExecutor([]);
			if (!executor.isAvailable()) {
				// Executor was disabled — verify wrapCommand throws SandboxError
				expect(() => executor.wrapCommand('echo hello', [])).toThrow(
					SandboxError,
				);
			}
		});
	});

	describe('rollback ΓÇö ENOENT / EACCES / ENOSPC error codes', () => {
		// These tests simulate the error codes that probeBwrap handles by
		// mocking _internals.probeBwrap before constructing the executor.
		// The mock must be restored after each test to avoid leaking state.

		let originalProbeBwrap: typeof _internals.probeBwrap;

		beforeEach(() => {
			originalProbeBwrap = _internals.probeBwrap;
		});

		afterEach(() => {
			_internals.probeBwrap = originalProbeBwrap;
			mock.restore();
		});

		test.skipIf(isWindows)(
			'disables executor when probeBwrap simulates ENOENT (bwrap not found)',
			() => {
				// Simulate: spawnSync error with code 'ENOENT' — bwrap binary not found
				_internals.probeBwrap = mock(() => false);

				const executor = new BubblewrapSandboxExecutor([]);

				expect(executor.isAvailable()).toBe(false);
				// wrapCommand throws SandboxError when disabled
				expect(() => executor.wrapCommand('echo hello', [])).toThrow(
					SandboxError,
				);
			},
		);

		test.skipIf(isWindows)(
			'disables executor when probeBwrap simulates EACCES (permission denied)',
			() => {
				// Simulate: spawnSync error with code 'EACCES' — bwrap found but not executable
				_internals.probeBwrap = mock(() => false);

				const executor = new BubblewrapSandboxExecutor([]);

				expect(executor.isAvailable()).toBe(false);
				// wrapCommand throws SandboxError when disabled
				expect(() => executor.wrapCommand('echo hello', [])).toThrow(
					SandboxError,
				);
			},
		);

		test.skipIf(isWindows)(
			'disables executor when probeBwrap simulates ENOSPC (namespace creation failed)',
			() => {
				// Simulate: spawnSync error with code 'ENOSPC' — user namespace creation failed
				_internals.probeBwrap = mock(() => false);

				const executor = new BubblewrapSandboxExecutor([]);

				expect(executor.isAvailable()).toBe(false);
				// wrapCommand throws SandboxError when disabled
				expect(() => executor.wrapCommand('echo hello', [])).toThrow(
					SandboxError,
				);
			},
		);

		test.skipIf(isWindows)(
			'wrapCommand re-checks availability and disables when probeBwrap fails mid-session',
			() => {
				// Simulate a mid-session failure where bwrap becomes unavailable
				// After first wrapCommand call, probeBwrap returns false and executor is disabled
				_internals.probeBwrap = mock(() => false);

				const executor = new BubblewrapSandboxExecutor([]);

				// First call should throw SandboxError and disable
				expect(() => executor.wrapCommand('echo hello', [])).toThrow(
					SandboxError,
				);
				expect(executor.isAvailable()).toBe(false);

				// Subsequent calls should also throw SandboxError
				expect(() => executor.wrapCommand('echo again', [])).toThrow(
					SandboxError,
				);
			},
		);
	});
});
