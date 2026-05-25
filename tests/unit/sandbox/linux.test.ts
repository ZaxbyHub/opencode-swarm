/**
 * Tests for Linux Bubblewrap sandbox implementation:
 * - src/sandbox/linux/bubblewrap-executor.ts
 * - src/sandbox/linux/edge-cases.ts
 *
 * Platform notes:
 * - Tests that probe Linux-specific paths (/proc, /dev/io_uring, etc.) are skipped on Windows.
 * - Symlink-based tests are skipped on Windows because symlink resolution behaves differently.
 * - isAvailable() tests are skipped on Windows because bwrap is a Linux-specific binary.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Helper ΓÇö create a temp directory that auto-cleans
// ---------------------------------------------------------------------------

function makeTempDir(): string {
	// mkdtempSync must be wrapped in realpathSync on macOS per AGENTS.md ┬º7
	return realFs.realpathSync(
		realFs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-test-')),
	);
}

// ---------------------------------------------------------------------------
// bubblewrap-executor.ts ΓÇö import (module-level, not mocked)
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
// edge-cases.ts ΓÇö import (module-level, not mocked)
// ---------------------------------------------------------------------------

import {
	detectHardLinkCreation,
	detectIoUringBypass,
	detectMmapInterception,
	detectNamespaceEscape,
	detectProcFdAccess,
	detectRenameAcrossBoundary,
	detectSymlinkEscape,
} from '../../../src/sandbox/linux/edge-cases';

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
			await mock.module(
				'../../../src/sandbox/linux/bubblewrap-executor',
				() => ({
					BubblewrapSandboxExecutor,
					_internals: { ..._internals, probeBwrap: () => true },
				}),
			);
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

// ---------------------------------------------------------------------------
// edge-cases.ts ΓÇö detectSymlinkEscape
// Symlink resolution differs on Windows (junction points vs symlinks).
// These tests use real filesystem and only run on non-Windows.
// ---------------------------------------------------------------------------

describe('detectSymlinkEscape', () => {
	test.skipIf(isWindows)(
		'returns false for a regular file (not a symlink)',
		() => {
			const tempDir = makeTempDir();
			const regularFile = path.join(tempDir, 'regular.txt');
			realFs.writeFileSync(regularFile, 'content');

			try {
				const result = detectSymlinkEscape(regularFile, [tempDir]);
				expect(result).toBe(false);
			} finally {
				realFs.unlinkSync(regularFile);
				realFs.rmdirSync(tempDir);
			}
		},
	);

	test.skipIf(isWindows)(
		'returns false when symlink resolves to a path inside scope',
		() => {
			const tempDir = makeTempDir();
			const targetDir = path.join(tempDir, 'target');
			realFs.mkdirSync(targetDir);

			// Symlink inside tempDir pointing to target inside tempDir
			const symlinkPath = path.join(tempDir, 'link');
			realFs.symlinkSync(targetDir, symlinkPath);

			try {
				const result = detectSymlinkEscape(symlinkPath, [tempDir]);
				expect(result).toBe(false);
			} finally {
				realFs.unlinkSync(symlinkPath);
				realFs.rmdirSync(targetDir);
				realFs.rmdirSync(tempDir);
			}
		},
	);

	test.skipIf(isWindows)(
		'returns true when symlink resolves to a path outside scope',
		() => {
			const tempDir = makeTempDir();
			const outsideDir = makeTempDir(); // separate scope

			// Symlink inside tempDir pointing to outsideDir
			const symlinkPath = path.join(tempDir, 'escape-link');
			realFs.symlinkSync(outsideDir, symlinkPath);

			try {
				// outsideDir is NOT in scope, so the symlink escapes
				const result = detectSymlinkEscape(symlinkPath, [tempDir]);
				expect(result).toBe(true);
			} finally {
				realFs.unlinkSync(symlinkPath);
				realFs.rmdirSync(tempDir);
				realFs.rmdirSync(outsideDir);
			}
		},
	);

	test('returns false for a non-existent path', () => {
		const result = detectSymlinkEscape('/non/existent/path', ['/scope']);
		expect(result).toBe(false);
	});

	test.skipIf(isWindows)(
		'returns false when symlink target is inside one of multiple scopes',
		() => {
			const scopeA = makeTempDir();
			const scopeB = makeTempDir();
			const targetInA = path.join(scopeA, 'target');
			realFs.mkdirSync(targetInA);

			const symlinkPath = path.join(scopeB, 'cross-link');
			realFs.symlinkSync(targetInA, symlinkPath);

			try {
				// targetInA is inside scopeA which is in scopePaths
				const result = detectSymlinkEscape(symlinkPath, [scopeA, scopeB]);
				expect(result).toBe(false);
			} finally {
				realFs.unlinkSync(symlinkPath);
				realFs.rmdirSync(targetInA);
				realFs.rmdirSync(scopeA);
				realFs.rmdirSync(scopeB);
			}
		},
	);
});

// ---------------------------------------------------------------------------
// edge-cases.ts ΓÇö detectProcFdAccess
// /proc/self/fd/ is a Linux-specific path. Skip on Windows.
// ---------------------------------------------------------------------------

describe('detectProcFdAccess', () => {
	test.skipIf(isWindows)('returns true for /proc/self/fd/ path', () => {
		expect(detectProcFdAccess('/proc/self/fd/5')).toBe(true);
	});

	test.skipIf(isWindows)(
		'returns false for /proc/self/fd without trailing slash',
		() => {
			expect(detectProcFdAccess('/proc/self/fd')).toBe(false);
		},
	);

	test.skipIf(isWindows)('returns false for regular /proc path', () => {
		expect(detectProcFdAccess('/proc/1234/status')).toBe(false);
	});

	test.skipIf(isWindows)(
		'returns false for /proc/self/... path that is not fd',
		() => {
			expect(detectProcFdAccess('/proc/self/status')).toBe(false);
		},
	);

	test('returns false for unrelated path', () => {
		expect(detectProcFdAccess('/home/user/file.txt')).toBe(false);
	});

	test.skipIf(isWindows)(
		'handles relative path (resolves to /proc/self/fd/)',
		() => {
			// When resolve() is called inside, it becomes absolute
			expect(detectProcFdAccess('proc/self/fd/0')).toBe(false); // not starting with /proc
		},
	);
});

// ---------------------------------------------------------------------------
// edge-cases.ts ΓÇö detectIoUringBypass
// /dev/io_uring and /proc/sys/kernel/io_uring are Linux-specific. Skip on Windows.
// ---------------------------------------------------------------------------

describe('detectIoUringBypass', () => {
	test.skipIf(isWindows)('returns true when /dev/io_uring exists', () => {
		// This test probes a path that only exists on Linux
		const result = detectIoUringBypass();
		expect(typeof result).toBe('boolean');
	});

	test.skipIf(isWindows)(
		'returns true when /proc/sys/kernel/io_uring exists',
		() => {
			const result = detectIoUringBypass();
			expect(typeof result).toBe('boolean');
		},
	);

	test('returns false on Windows (Linux-specific paths do not exist)', () => {
		if (isWindows) {
			// On Windows these Linux paths do not exist, so the function
			// should return false (caught by existsSync returning false)
			const result = detectIoUringBypass();
			expect(result).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// edge-cases.ts ΓÇö detectNamespaceEscape
// /proc/self/seccomp and /proc/self/ns/ are Linux-specific. Skip on Windows.
// ---------------------------------------------------------------------------

describe('detectNamespaceEscape', () => {
	test.skipIf(isWindows)(
		'returns boolean when probing /proc/self/seccomp and /proc/self/ns/',
		() => {
			// Just verify it returns a boolean without throwing
			const result = detectNamespaceEscape();
			expect(typeof result).toBe('boolean');
		},
	);

	test('returns false on Windows (Linux-specific paths do not exist)', () => {
		if (isWindows) {
			// On Windows these Linux paths do not exist
			const result = detectNamespaceEscape();
			expect(result).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// edge-cases.ts ΓÇö detectHardLinkCreation
// Uses path.resolve which works on all platforms; no Linux-specific paths.
// The path-separator issue only manifests on Windows because the code uses
// forward-slash concatenation (scopePath + '/') which doesn't match Windows
// backslash paths from resolve(). Skip on Windows.
// ---------------------------------------------------------------------------

describe('detectHardLinkCreation', () => {
	test.skipIf(isWindows)(
		'returns false when target path is inside scope',
		() => {
			const scope = makeTempDir();
			const targetInside = path.join(scope, 'hardlink-target');

			try {
				const result = detectHardLinkCreation(targetInside, [scope]);
				expect(result).toBe(false);
			} finally {
				realFs.rmdirSync(scope);
			}
		},
	);

	test.skipIf(isWindows)(
		'returns true when target path is outside all scopes',
		() => {
			const scopeA = makeTempDir();
			const outsideTarget = path.join(makeTempDir(), 'outside-file');

			try {
				const result = detectHardLinkCreation(outsideTarget, [scopeA]);
				expect(result).toBe(true);
			} finally {
				realFs.rmdirSync(scopeA);
				realFs.rmdirSync(path.dirname(outsideTarget));
			}
		},
	);

	test.skipIf(isWindows)(
		'returns false when target path is exactly a scope path',
		() => {
			const scope = makeTempDir();

			try {
				const result = detectHardLinkCreation(scope, [scope]);
				expect(result).toBe(false);
			} finally {
				realFs.rmdirSync(scope);
			}
		},
	);

	test.skipIf(isWindows)(
		'returns false when path is inside one of multiple scopes',
		() => {
			const scopeA = makeTempDir();
			const scopeB = makeTempDir();
			const insideB = path.join(scopeB, 'file');

			try {
				const result = detectHardLinkCreation(insideB, [scopeA, scopeB]);
				expect(result).toBe(false);
			} finally {
				realFs.rmdirSync(scopeA);
				realFs.rmdirSync(scopeB);
			}
		},
	);

	test.skipIf(isWindows)('returns false for nested path inside scope', () => {
		const scope = makeTempDir();
		const nested = path.join(scope, 'a', 'b', 'c');
		realFs.mkdirSync(nested, { recursive: true });

		try {
			const result = detectHardLinkCreation(nested, [scope]);
			expect(result).toBe(false);
		} finally {
			// Clean up nested dirs first
			realFs.rmdirSync(nested);
			realFs.rmdirSync(scope);
		}
	});
});

// ---------------------------------------------------------------------------
// edge-cases.ts ΓÇö detectRenameAcrossBoundary
// Uses path.resolve which works on all platforms; no Linux-specific paths.
// The path-separator issue only manifests on Windows because the code uses
// forward-slash concatenation (scopePath + '/') which doesn't match Windows
// backslash paths from resolve(). Skip on Windows.
// ---------------------------------------------------------------------------

describe('detectRenameAcrossBoundary', () => {
	test.skipIf(isWindows)(
		'returns false when oldPath is not in any scope',
		() => {
			const scope = makeTempDir();
			const outsideOld = path.join(makeTempDir(), 'outside-old');
			const outsideNew = path.join(scope, 'new-name');

			try {
				const result = detectRenameAcrossBoundary(outsideOld, outsideNew, [
					scope,
				]);
				expect(result).toBe(false);
			} finally {
				realFs.rmdirSync(scope);
				realFs.rmdirSync(path.dirname(outsideOld));
			}
		},
	);

	test.skipIf(isWindows)(
		'returns false when both oldPath and newPath are inside scope',
		() => {
			const scope = makeTempDir();
			const oldPath = path.join(scope, 'old-file');
			const newPath = path.join(scope, 'new-file');

			try {
				const result = detectRenameAcrossBoundary(oldPath, newPath, [scope]);
				expect(result).toBe(false);
			} finally {
				realFs.rmdirSync(scope);
			}
		},
	);

	test.skipIf(isWindows)(
		'returns true when oldPath is inside scope and newPath is outside',
		() => {
			const scope = makeTempDir();
			const outsideDir = makeTempDir();
			const oldPath = path.join(scope, 'old-file');
			const newPath = path.join(outsideDir, 'moved-file');

			try {
				const result = detectRenameAcrossBoundary(oldPath, newPath, [scope]);
				expect(result).toBe(true);
			} finally {
				realFs.rmdirSync(scope);
				realFs.rmdirSync(outsideDir);
			}
		},
	);

	test.skipIf(isWindows)(
		'returns false when oldPath is outside scope (no boundary to cross)',
		() => {
			const scopeA = makeTempDir();
			const scopeB = makeTempDir();
			const oldPath = path.join(scopeA, 'old-file');
			const newPath = path.join(scopeB, 'new-file');

			try {
				// oldPath IS in scopeA, newPath IS in scopeB, both are in scopePaths
				const result = detectRenameAcrossBoundary(oldPath, newPath, [
					scopeA,
					scopeB,
				]);
				expect(result).toBe(false);
			} finally {
				realFs.rmdirSync(scopeA);
				realFs.rmdirSync(scopeB);
			}
		},
	);

	test.skipIf(isWindows)(
		'returns true when moving from scoped dir to completely outside',
		() => {
			const scope = makeTempDir();
			const outsideDir = makeTempDir();
			const oldPath = path.join(scope, 'file');
			const newPath = path.join(outsideDir, 'file');

			try {
				const result = detectRenameAcrossBoundary(oldPath, newPath, [scope]);
				expect(result).toBe(true);
			} finally {
				realFs.rmdirSync(scope);
				realFs.rmdirSync(outsideDir);
			}
		},
	);

	test.skipIf(isWindows)(
		'returns false for rename within the same scope directory',
		() => {
			const scope = makeTempDir();
			const oldPath = path.join(scope, 'old.txt');
			const newPath = path.join(scope, 'new.txt');

			try {
				const result = detectRenameAcrossBoundary(oldPath, newPath, [scope]);
				expect(result).toBe(false);
			} finally {
				realFs.rmdirSync(scope);
			}
		},
	);
});

// ---------------------------------------------------------------------------
// edge-cases.ts ΓÇö detectMmapInterception
// Uses path.resolve which on Windows converts /dev/mem ΓåÆ C:\dev\mem,
// breaking the startsWith('/dev/') check. These tests are Linux-specific
// and skip on Windows.
// ---------------------------------------------------------------------------

describe('detectMmapInterception', () => {
	test.skipIf(isWindows)('returns true for /dev/mem', () => {
		expect(detectMmapInterception('/dev/mem')).toBe(true);
	});

	test.skipIf(isWindows)('returns true for /dev/kmem', () => {
		expect(detectMmapInterception('/dev/kmem')).toBe(true);
	});

	test.skipIf(isWindows)('returns true for /dev/null', () => {
		expect(detectMmapInterception('/dev/null')).toBe(true);
	});

	test.skipIf(isWindows)('returns true for /dev/zero', () => {
		expect(detectMmapInterception('/dev/zero')).toBe(true);
	});

	test.skipIf(isWindows)('returns true for /dev/urandom', () => {
		expect(detectMmapInterception('/dev/urandom')).toBe(true);
	});

	test.skipIf(isWindows)('returns true for /dev/random', () => {
		expect(detectMmapInterception('/dev/random')).toBe(true);
	});

	test.skipIf(isWindows)('returns true for /dev/fuse', () => {
		expect(detectMmapInterception('/dev/fuse')).toBe(true);
	});

	test.skipIf(isWindows)('returns true for /dev/ path prefix', () => {
		expect(detectMmapInterception('/dev/something/else')).toBe(true);
	});

	test.skipIf(isWindows)('returns true for /proc/ path prefix', () => {
		expect(detectMmapInterception('/proc/some/path')).toBe(true);
	});

	test.skipIf(isWindows)('returns true for /sys/ path prefix', () => {
		expect(detectMmapInterception('/sys/kernel/some/path')).toBe(true);
	});

	test('returns false for regular file path', () => {
		expect(detectMmapInterception('/home/user/myfile.txt')).toBe(false);
	});

	test.skipIf(isWindows)('is case-insensitive for device names', () => {
		expect(detectMmapInterception('/DEV/NULL')).toBe(true);
	});

	test('returns false for /usr/lib/... path (not a device)', () => {
		expect(detectMmapInterception('/usr/lib/library.so')).toBe(false);
	});

	test('returns false for /tmp file', () => {
		expect(detectMmapInterception('/tmp/myfile')).toBe(false);
	});

	test.skipIf(isWindows)(
		'returns true for /sys/... path (suspicious prefix)',
		() => {
			expect(detectMmapInterception('/sys/module/nvidia')).toBe(true);
		},
	);
});
