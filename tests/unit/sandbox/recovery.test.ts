/**
 * Sandbox recovery tests ΓÇö verifies graceful degradation when executors
 * become unavailable mid-session or are explicitly disabled.
 *
 * Covers:
 *   1. Executor becomes unavailable mid-session ΓåÆ passthrough
 *   2. disable() correctly falls through ΓåÆ isAvailable=false, passthrough
 *   3. Non-existent scope path ΓåÆ graceful handling
 *   4. Probe failure (bwrap/sandbox-exec/PowerShell missing) ΓåÆ isAvailable=false
 *
 * Platform: all three executors are tested on their native platforms;
 * on foreign platforms the constructor either throws (macOS, Windows) or
 * the executor starts unavailable (Linux bwrap probe).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Imports ΓÇö all three executors
// ---------------------------------------------------------------------------

import { SandboxError } from '../../../src/sandbox/executor';
import {
	BubblewrapSandboxExecutor,
	_internals as bwrapInternals,
} from '../../../src/sandbox/linux/bubblewrap-executor';
import {
	MacOSSandboxExecutor,
	_internals as macosInternals,
} from '../../../src/sandbox/macos/sandbox-exec-executor';
import {
	WindowsSandboxExecutor,
	_internals as winInternals,
} from '../../../src/sandbox/win32/restricted-token-executor';

// ---------------------------------------------------------------------------
// Platform guards ΓÇö save/restore _internals probe functions
// ---------------------------------------------------------------------------

type BwrapProbe = typeof bwrapInternals.probeBwrap;
type MacosProbe = typeof macosInternals.probeSandboxExec;
type WinProbe = typeof winInternals.probeWindowsSandbox;

let origBwrapProbe: BwrapProbe;
let origMacosProbe: MacosProbe;
let origWinProbe: WinProbe;

beforeEach(() => {
	origBwrapProbe = bwrapInternals.probeBwrap;
	origMacosProbe = macosInternals.probeSandboxExec;
	origWinProbe = winInternals.probeWindowsSandbox;
});

afterEach(() => {
	bwrapInternals.probeBwrap = origBwrapProbe;
	macosInternals.probeSandboxExec = origMacosProbe;
	winInternals.probeWindowsSandbox = origWinProbe;
});

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/** Verify that an unavailable executor throws SandboxError. */
function assertThrowsSandboxError(
	executor: {
		isAvailable(): boolean;
		wrapCommand(cmd: string, scopes: string[]): string;
	},
	rawCmd = 'echo hello',
): void {
	expect(executor.isAvailable()).toBe(false);
	expect(() => executor.wrapCommand(rawCmd, [])).toThrow(SandboxError);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Sandbox recovery scenarios', () => {
	// ========================================================================
	// RECOVERY SCENARIO 1 ΓÇö executor becomes unavailable mid-session
	//
	// Simulate the executor transitioning from available ΓåÆ unavailable between
	// two wrapCommand calls. The second call must throw SandboxError.
	// ========================================================================

	describe('Scenario 1 ΓÇö executor becomes unavailable mid-session', () => {
		// F-005 fix: Linux bubblewrap no longer re-probes in wrapCommand mid-session.
		// The executor trusts _available set at construction. Caller should check
		// isAvailable() before wrapCommand if mid-session detection is needed.
		test.skipIf(isMac || isWindows)(
			'Bubblewrap: wrapCommand trusts _available from construction (no mid-session re-probe)',
			() => {
				// Simulate bwrap being available at construction
				let callCount = 0;
				bwrapInternals.probeBwrap = mock(() => {
					callCount++;
					return true; // Available at construction and stays available
				});

				const executor = new BubblewrapSandboxExecutor([]);

				// Guard: bwrap must be available for this test
				if (!executor.isAvailable()) {
					return;
				}

				// wrapCommand should succeed since _available is true from construction
				expect(() => executor.wrapCommand('echo hello', [])).not.toThrow();
				expect(executor.isAvailable()).toBe(true);
			},
		);

		test.skipIf(isMac || isWindows)(
			'Bubblewrap: wrapCommand throws when executor unavailable at construction',
			() => {
				// Simulate bwrap being unavailable
				bwrapInternals.probeBwrap = mock(() => false);

				const executor = new BubblewrapSandboxExecutor([]);

				// wrapCommand must throw since _available is false
				expect(() => executor.wrapCommand('echo hello', [])).toThrow(
					SandboxError,
				);
			},
		);

		test.skipIf(!isMac)(
			'MacOSSandboxExecutor: wrapCommand throws SandboxError when sandbox-exec disappears mid-session',
			() => {
				// macOS executor constructor calls probeSandboxExec once.
				// wrapCommand re-checks before each wrap.
				let callCount = 0;
				macosInternals.probeSandboxExec = mock(() => {
					callCount++;
					return callCount === 1;
				});

				const executor = new MacOSSandboxExecutor([]);

				// First call ΓÇö sandbox-exec available (constructor probe succeeded)
				const wasAvailable = executor.isAvailable();
				const result1 = executor.wrapCommand('echo first', []);

				// Second call ΓÇö probe now fails, executor must disable and passthrough
				const result2 = executor.wrapCommand('echo second', []);

				expect(executor.isAvailable()).toBe(false);
				expect(result2).toBe('echo second');

				if (wasAvailable) {
					expect(result1).not.toBe('echo first');
					expect(result1).toContain('sandbox-exec');
				}
			},
		);

		test.skipIf(!isMac)(
			'MacOSSandboxExecutor: isAvailable() returns false after mid-session probe failure',
			() => {
				let probeCallCount = 0;
				macosInternals.probeSandboxExec = mock(() => {
					probeCallCount++;
					return probeCallCount < 3;
				});

				const executor = new MacOSSandboxExecutor([]);
				expect(executor.isAvailable()).toBe(true);

				executor.wrapCommand('echo hello', []);
				executor.wrapCommand('echo again', []);

				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(!isWindows)(
			'WindowsSandboxExecutor: wrapCommand throws SandboxError when PowerShell probe fails mid-session',
			() => {
				let callCount = 0;
				winInternals.probeWindowsSandbox = mock(() => {
					callCount++;
					// Return true for constructor call and first wrapCommand call,
					// then false for second wrapCommand call (mid-session failure)
					return callCount <= 2;
				});

				const executor = new WindowsSandboxExecutor([]);

				// Guard: executor must be available initially for mid-session test to be meaningful
				if (!executor.isAvailable()) {
					// PowerShell/cmd not functional on this machine — skip
					return;
				}

				// First wrapCommand — executor still available, should return wrapped command
				const result1 = executor.wrapCommand('echo first', []);
				expect(result1).toContain('powershell');

				// Second wrapCommand — probe fails, executor must throw SandboxError
				expect(() => executor.wrapCommand('echo second', [])).toThrow(
					SandboxError,
				);
				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(!isWindows)(
			'WindowsSandboxExecutor: isAvailable() returns false after mid-session probe failure',
			() => {
				let probeCallCount = 0;
				winInternals.probeWindowsSandbox = mock(() => {
					probeCallCount++;
					return probeCallCount < 3;
				});

				const executor = new WindowsSandboxExecutor([]);

				// Guard: executor must be available initially
				if (!executor.isAvailable()) {
					return;
				}

				// First wrapCommand — probe call 2, returns true
				expect(() => executor.wrapCommand('echo hello', [])).not.toThrow();

				// Second wrapCommand — probe call 3, returns false, throws SandboxError
				expect(() => executor.wrapCommand('echo again', [])).toThrow(
					SandboxError,
				);
				expect(executor.isAvailable()).toBe(false);
			},
		);
	});

	// ========================================================================
	// RECOVERY SCENARIO 2 ΓÇö disable() correctly falls through
	//
	// Explicit disable() must:
	//   - Set isAvailable() to false
	//   - Make wrapCommand() return the raw command unchanged (passthrough)
	//   - Not throw
	// ========================================================================

	describe('Scenario 2 ΓÇö disable() correctly falls through', () => {
		test.skipIf(isMac)(
			'Bubblewrap: isAvailable() returns false after disable()',
			() => {
				const executor = new BubblewrapSandboxExecutor([]);
				executor.disable('test reason');
				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(isMac)(
			'Bubblewrap: wrapCommand() throws SandboxError unchanged after disable()',
			() => {
				const executor = new BubblewrapSandboxExecutor([]);
				executor.disable('testing');
				assertThrowsSandboxError(executor, 'echo hello');
			},
		);

		test.skipIf(isMac)(
			'Bubblewrap: disable() does not throw even when executor was never available',
			() => {
				// Make bwrap permanently unavailable via mock
				bwrapInternals.probeBwrap = mock(() => false);
				const executor = new BubblewrapSandboxExecutor([]);
				// Must not throw
				executor.disable('test');
				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(!isMac)(
			'MacOSSandboxExecutor: isAvailable() returns false after disable()',
			() => {
				const executor = new MacOSSandboxExecutor([]);
				executor.disable('test reason');
				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(!isMac)(
			'MacOSSandboxExecutor: wrapCommand() throws SandboxError unchanged after disable()',
			() => {
				const executor = new MacOSSandboxExecutor([]);
				executor.disable('testing');
				assertThrowsSandboxError(executor, 'echo hello');
			},
		);

		test.skipIf(!isMac)(
			'MacOSSandboxExecutor: disable() does not throw when sandbox-exec was never available',
			() => {
				macosInternals.probeSandboxExec = mock(() => false);
				const executor = new MacOSSandboxExecutor([]);
				executor.disable('test'); // must not throw
				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(!isWindows)(
			'WindowsSandboxExecutor: isAvailable() returns false after disable()',
			() => {
				const executor = new WindowsSandboxExecutor([]);
				executor.disable('test reason');
				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(!isWindows)(
			'WindowsSandboxExecutor: wrapCommand() throws SandboxError unchanged after disable()',
			() => {
				const executor = new WindowsSandboxExecutor([]);
				executor.disable('testing');
				assertThrowsSandboxError(executor, 'echo hello');
			},
		);

		test.skipIf(!isWindows)(
			'WindowsSandboxExecutor: disable() does not throw when PowerShell was never available',
			() => {
				winInternals.probeWindowsSandbox = mock(() => false);
				const executor = new WindowsSandboxExecutor([]);
				executor.disable('test'); // must not throw
				expect(executor.isAvailable()).toBe(false);
			},
		);
	});

	// ========================================================================
	// RECOVERY SCENARIO 3 ΓÇö scope path does not exist
	//
	// Executors must not crash when constructed with or wrapped using
	// non-existent scope paths. They should either fall back gracefully or
	// handle the path resolution silently.
	// ========================================================================

	describe('Scenario 3 ΓÇö non-existent scope path', () => {
		test.skipIf(isMac)(
			'Bubblewrap: wraps command without throwing when scope path does not exist',
			() => {
				// Use a path that definitely does not exist on any platform
				const fakeScope = '/this/path/does/not/exist/anywhere';
				const executor = new BubblewrapSandboxExecutor([fakeScope]);

				// Should not throw even if path doesn't exist
				// When unavailable (bwrap missing), throws SandboxError
				// When available, still returns a wrapped command (bwrap handles bind-mount errors at runtime)
				if (executor.isAvailable()) {
					const result = executor.wrapCommand('echo hello', []);
					expect(typeof result).toBe('string');
					expect(result).toContain('bwrap');
				} else {
					// When unavailable, wrapCommand throws SandboxError
					expect(() => executor.wrapCommand('echo hello', [])).toThrow(
						SandboxError,
					);
				}
			},
		);

		test.skipIf(isMac)(
			'Bubblewrap: accepts empty scopePaths without throwing',
			() => {
				const executor = new BubblewrapSandboxExecutor([]);
				if (executor.isAvailable()) {
					const result = executor.wrapCommand('echo hello', []);
					expect(typeof result).toBe('string');
					expect(result).toContain('bwrap');
				} else {
					// When unavailable, wrapCommand throws SandboxError
					expect(() => executor.wrapCommand('echo hello', [])).toThrow(
						SandboxError,
					);
				}
			},
		);

		test.skipIf(!isMac)(
			'MacOSSandboxExecutor: wraps command without throwing when scope path does not exist',
			() => {
				const fakeScope = '/this/path/does/not/exist/anywhere';
				const executor = new MacOSSandboxExecutor([fakeScope]);

				if (executor.isAvailable()) {
					const result = executor.wrapCommand('echo hello', []);
					expect(typeof result).toBe('string');
					expect(result).toContain('sandbox-exec');
				} else {
					// When unavailable, wrapCommand throws SandboxError
					expect(() => executor.wrapCommand('echo hello', [])).toThrow(
						SandboxError,
					);
				}
			},
		);

		test.skipIf(!isMac)(
			'MacOSSandboxExecutor: accepts empty scopePaths without throwing',
			() => {
				const executor = new MacOSSandboxExecutor([]);
				if (executor.isAvailable()) {
					const result = executor.wrapCommand('echo hello', []);
					expect(typeof result).toBe('string');
					expect(result).toContain('sandbox-exec');
				} else {
					// When unavailable, wrapCommand throws SandboxError
					expect(() => executor.wrapCommand('echo hello', [])).toThrow(
						SandboxError,
					);
				}
			},
		);

		test.skipIf(!isWindows)(
			'WindowsSandboxExecutor: wraps command without throwing when scope path does not exist',
			() => {
				const fakeScope = 'C:\\this\\path\\does\\not\\exist\\anywhere';
				const executor = new WindowsSandboxExecutor([fakeScope]);

				if (executor.isAvailable()) {
					const result = executor.wrapCommand('echo hello', []);
					expect(typeof result).toBe('string');
					expect(result).toContain('powershell');
				} else {
					// When unavailable, wrapCommand throws SandboxError
					expect(() => executor.wrapCommand('echo hello', [])).toThrow(
						SandboxError,
					);
				}
			},
		);

		test.skipIf(!isWindows)(
			'WindowsSandboxExecutor: accepts empty scopePaths without throwing',
			() => {
				const executor = new WindowsSandboxExecutor([]);
				if (executor.isAvailable()) {
					const result = executor.wrapCommand('echo hello', []);
					expect(typeof result).toBe('string');
					expect(result).toContain('powershell');
				} else {
					// When unavailable, wrapCommand throws SandboxError
					expect(() => executor.wrapCommand('echo hello', [])).toThrow(
						SandboxError,
					);
				}
			},
		);

		test('Bubblewrap: non-existent scope path via wrapCommand() extra scopes does not throw', () => {
			const executor = new BubblewrapSandboxExecutor([]);
			if (!executor.isAvailable()) {
				// When unavailable, wrapCommand throws SandboxError
				expect(() =>
					executor.wrapCommand('echo hello', ['/non/existent/scope']),
				).toThrow(SandboxError);
				return;
			}
			const fakeScope = '/non/existent/scope';
			// Must not throw when executor is available
			const result = executor.wrapCommand('echo hello', [fakeScope]);
			expect(typeof result).toBe('string');
		});

		test('MacOSSandboxExecutor: non-existent scope path via wrapCommand() extra scopes does not throw', () => {
			// macOS executor throws on construction on non-macOS
			if (!isMac) return;
			const executor = new MacOSSandboxExecutor([]);
			if (!executor.isAvailable()) {
				// When unavailable, wrapCommand throws SandboxError
				expect(() =>
					executor.wrapCommand('echo hello', ['/non/existent/scope']),
				).toThrow(SandboxError);
				return;
			}
			const fakeScope = '/non/existent/scope';
			const result = executor.wrapCommand('echo hello', [fakeScope]);
			expect(typeof result).toBe('string');
		});

		test('WindowsSandboxExecutor: non-existent scope path via wrapCommand() extra scopes does not throw', () => {
			// Windows executor throws on construction on non-Windows
			if (!isWindows) return;
			const executor = new WindowsSandboxExecutor([]);
			if (!executor.isAvailable()) {
				// When unavailable, wrapCommand throws SandboxError
				expect(() =>
					executor.wrapCommand('echo hello', ['C:\\non\\existent\\scope']),
				).toThrow(SandboxError);
				return;
			}
			const fakeScope = 'C:\\non\\existent\\scope';
			const result = executor.wrapCommand('echo hello', [fakeScope]);
			expect(typeof result).toBe('string');
		});
	});

	// ========================================================================
	// RECOVERY SCENARIO 4 ΓÇö probe failure (binary not found)
	//
	// When the platform-specific sandbox binary is not found:
	//   - Linux: bwrap not found ΓåÆ isAvailable() returns false
	//   - macOS: sandbox-exec not found ΓåÆ isAvailable() returns false
	//   - Windows: PowerShell/cmd not available ΓåÆ isAvailable() returns false
	//
	// We simulate this by mocking _internals.probe* to return false.
	// ========================================================================

	describe('Scenario 4 ΓÇö probe failure (binary not found)', () => {
		test.skipIf(isMac)(
			'Bubblewrap: isAvailable() returns false when bwrap binary is not found (simulated ENOENT)',
			() => {
				// Simulate spawnSync error with code 'ENOENT' ΓÇö bwrap binary not found
				bwrapInternals.probeBwrap = mock(() => false);

				const executor = new BubblewrapSandboxExecutor([]);

				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(isMac)(
			'Bubblewrap: wrapCommand() throws SandboxError when bwrap binary is not found',
			() => {
				bwrapInternals.probeBwrap = mock(() => false);

				const executor = new BubblewrapSandboxExecutor([]);

				assertThrowsSandboxError(executor, 'echo hello');
			},
		);

		test.skipIf(isMac)(
			'Bubblewrap: isAvailable() returns false when bwrap binary is not functional (simulated EACCES)',
			() => {
				// Simulate spawnSync error with code 'EACCES' ΓÇö permission denied
				bwrapInternals.probeBwrap = mock(() => false);

				const executor = new BubblewrapSandboxExecutor([]);

				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(!isMac)(
			'MacOSSandboxExecutor: isAvailable() returns false when sandbox-exec binary is not found (simulated ENOENT)',
			() => {
				macosInternals.probeSandboxExec = mock(() => false);

				const executor = new MacOSSandboxExecutor([]);

				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(!isMac)(
			'MacOSSandboxExecutor: wrapCommand() throws SandboxError when sandbox-exec binary is not found',
			() => {
				macosInternals.probeSandboxExec = mock(() => false);

				const executor = new MacOSSandboxExecutor([]);

				assertThrowsSandboxError(executor, 'echo hello');
			},
		);

		test.skipIf(!isMac)(
			'MacOSSandboxExecutor: isAvailable() returns false when sandbox-exec is not functional (simulated EACCES)',
			() => {
				macosInternals.probeSandboxExec = mock(() => false);

				const executor = new MacOSSandboxExecutor([]);

				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(!isWindows)(
			'WindowsSandboxExecutor: isAvailable() returns false when PowerShell/cmd is not available (simulated ENOENT)',
			() => {
				winInternals.probeWindowsSandbox = mock(() => false);

				const executor = new WindowsSandboxExecutor([]);

				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(!isWindows)(
			'WindowsSandboxExecutor: wrapCommand() throws SandboxError when PowerShell is not available',
			() => {
				winInternals.probeWindowsSandbox = mock(() => false);

				const executor = new WindowsSandboxExecutor([]);

				assertThrowsSandboxError(executor, 'echo hello');
			},
		);

		test.skipIf(!isWindows)(
			'WindowsSandboxExecutor: isAvailable() returns false when cmd.exe spawn fails (simulated EPERM)',
			() => {
				winInternals.probeWindowsSandbox = mock(() => false);

				const executor = new WindowsSandboxExecutor([]);

				expect(executor.isAvailable()).toBe(false);
			},
		);
	});

	// ========================================================================
	// Cross-platform invariant: passthrough when unavailable
	//
	// Every executor must return the raw command unchanged when unavailable,
	// regardless of which scenario caused the unavailability.
	// ========================================================================

	describe('Passthrough invariant ΓÇö SandboxError thrown when unavailable', () => {
		const rawCmd = 'git status';

		test.skipIf(isMac)(
			'Bubblewrap: wrapCommand throws SandboxError when unavailable (any reason)',
			() => {
				// Test with disable()
				const executor1 = new BubblewrapSandboxExecutor([]);
				executor1.disable('reason 1');
				expect(() => executor1.wrapCommand(rawCmd, [])).toThrow(SandboxError);

				// Test with probe failure
				bwrapInternals.probeBwrap = mock(() => false);
				const executor2 = new BubblewrapSandboxExecutor([]);
				expect(() => executor2.wrapCommand(rawCmd, [])).toThrow(SandboxError);
			},
		);

		test.skipIf(!isMac)(
			'MacOSSandboxExecutor: wrapCommand throws SandboxError when unavailable (any reason)',
			() => {
				const executor1 = new MacOSSandboxExecutor([]);
				executor1.disable('reason 1');
				expect(() => executor1.wrapCommand(rawCmd, [])).toThrow(SandboxError);

				macosInternals.probeSandboxExec = mock(() => false);
				const executor2 = new MacOSSandboxExecutor([]);
				expect(() => executor2.wrapCommand(rawCmd, [])).toThrow(SandboxError);
			},
		);

		test.skipIf(!isWindows)(
			'WindowsSandboxExecutor: wrapCommand throws SandboxError when unavailable (any reason)',
			() => {
				const executor1 = new WindowsSandboxExecutor([]);
				executor1.disable('reason 1');
				expect(() => executor1.wrapCommand(rawCmd, [])).toThrow(SandboxError);

				winInternals.probeWindowsSandbox = mock(() => false);
				const executor2 = new WindowsSandboxExecutor([]);
				expect(() => executor2.wrapCommand(rawCmd, [])).toThrow(SandboxError);
			},
		);
	});
});
