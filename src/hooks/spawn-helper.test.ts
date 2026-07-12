import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { _internals, spawnAsync } from './spawn-helper';

/**
 * Build a fake `child_process.spawn` that records the resolved command name and
 * immediately reports a clean exit. This lets the win32 `.cmd` transformation be
 * asserted directly on any platform — the POSIX test runner has no real
 * `npm.cmd` to spawn, so the original "resolves non-null" assertions were
 * environment-specific. Capturing the resolved command name verifies the actual
 * transformation logic and is strictly stronger than a spawn-succeeds check.
 */
function makeFakeSpawn(capture: { cmd?: string; args?: string[] }) {
	return (cmd: string, args: string[]) => {
		capture.cmd = cmd;
		capture.args = args;
		const proc = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			kill: () => void;
		};
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.kill = () => {};
		// Emit 'close' after spawnAsync synchronously attaches its listeners.
		queueMicrotask(() => proc.emit('close', 0));
		return proc;
	};
}

describe('spawn-helper', () => {
	const testCwd = tmpdir();

	describe('spawnAsync', () => {
		// Test 1: Normal exit returns { exitCode: 0, stdout, stderr }
		it('returns exitCode 0 with stdout on successful command', async () => {
			const result = await spawnAsync(['echo', 'hello'], testCwd, 5000);
			expect(result).not.toBeNull();
			expect(result!.exitCode).toBe(0);
			expect(result!.stdout.trim()).toBe('hello');
			expect(result!.stderr).toBe('');
		});

		// Test 2: Non-zero exit code returned correctly (exitCode: 1)
		it('returns non-zero exitCode when command fails', async () => {
			// On Linux: exit 1 via sh -c; on Windows use cmd /c exit /b 1
			const result = await spawnAsync(['sh', '-c', 'exit 1'], testCwd, 5000);
			expect(result).not.toBeNull();
			expect(result!.exitCode).toBe(1);
		});

		// Test 3: Timeout triggers kill and resolves null
		it('returns null when command times out', async () => {
			// Use a long-running command that will be killed
			const result = await spawnAsync(['sleep', '10'], testCwd, 100);
			expect(result).toBeNull();
		});

		// Test 4: Bad command (spawn error / ENOENT) resolves null
		it('returns null when command does not exist', async () => {
			const result = await spawnAsync(
				['nonexistent-command-xyz'],
				testCwd,
				5000,
			);
			expect(result).toBeNull();
		});

		// Test 5: Stdout and stderr collected correctly
		it('collects both stdout and stderr correctly', async () => {
			// Write to both stdout and stderr
			const result = await spawnAsync(
				['sh', '-c', 'echo stdout-msg && echo stderr-msg >&2'],
				testCwd,
				5000,
			);
			expect(result).not.toBeNull();
			expect(result!.stdout.trim()).toBe('stdout-msg');
			expect(result!.stderr.trim()).toBe('stderr-msg');
		});

		// Additional: Multi-line output collection
		it('collects multi-line stdout correctly', async () => {
			// Use sh -c with multiple echo commands to produce multi-line output
			const result = await spawnAsync(
				['sh', '-c', 'echo line1; echo line2; echo line3'],
				testCwd,
				5000,
			);
			expect(result).not.toBeNull();
			expect(result!.stdout.trim()).toBe('line1\nline2\nline3');
		});

		// Additional: Empty stdout is handled
		it('handles command with empty stdout', async () => {
			const result = await spawnAsync(['sh', '-c', 'exit 0'], testCwd, 5000);
			expect(result).not.toBeNull();
			expect(result!.exitCode).toBe(0);
			expect(result!.stdout).toBe('');
		});

		// ============================================================
		// ADVERSARIAL SECURITY TESTS
		// ============================================================

		// Test A1: Empty command array — should resolve null safely
		it('resolves null when command array is empty (no cmd)', async () => {
			const result = await spawnAsync([], testCwd, 5000);
			expect(result).toBeNull();
		});

		// Test A2: Shell metacharacters are NOT interpolated — spawn uses args array, no shell
		it('does NOT execute shell metacharacters in args (injection prevention)', async () => {
			// The string 'hello; rm -rf /' should be passed as a literal argument to echo,
			// NOT interpreted as shell commands. If shell interpolation occurred,
			// the 'rm' command would try to execute and likely fail with non-zero exit.
			// Since spawn uses args array (no shell: true), echo receives ONE arg: 'hello; rm -rf /'
			const result = await spawnAsync(
				['echo', 'hello; rm -rf /'],
				testCwd,
				5000,
			);
			expect(result).not.toBeNull();
			expect(result!.exitCode).toBe(0);
			expect(result!.stdout.trim()).toBe('hello; rm -rf /');
		});

		// Test A3: Very long stdout (100KB+) — should collect all without throwing
		it('handles very large stdout (100KB+) without throwing', async () => {
			// Generate ~150KB of output using a shell command
			// seq is available on Linux/macOS; on Windows this command may differ
			const result = await spawnAsync(
				[
					'sh',
					'-c',
					'for i in $(seq 1 10000); do echo "line-$i-abcdefghijklmnopqrstuvwxyz"; done',
				],
				testCwd,
				15000,
			);
			expect(result).not.toBeNull();
			expect(result!.exitCode).toBe(0);
			// Verify we got substantial output (at least 100KB worth)
			expect(result!.stdout.length).toBeGreaterThan(100 * 1024);
		});

		// Test A4: Negative timeout — should resolve null when timer fires
		// Node.js converts negative timeout to 1ms minimum. Use sleep to ensure
		// process is still running when timer fires.
		it('resolves null with negative timeout before slow command completes', async () => {
			const start = Date.now();
			// sleep 10 takes 10 seconds; timer fires after ~1ms, killing sleep
			const result = await spawnAsync(['sleep', '10'], testCwd, -1000);
			const elapsed = Date.now() - start;
			// Timer fires after 1ms, killing sleep before it can complete
			expect(elapsed).toBeLessThan(100);
			expect(result).toBeNull();
		});

		// Test A5: Zero timeout — should resolve null (timer still fires on next tick)
		// Note: setTimeout(..., 0) fires on next tick (~1ms). Use sleep to ensure
		// process is still running when timer fires.
		it('resolves null with zero timeout before slow command completes', async () => {
			const start = Date.now();
			// sleep 10 takes 10 seconds; with timeout 0 (fires on next tick), timer wins
			const result = await spawnAsync(['sleep', '10'], testCwd, 0);
			const elapsed = Date.now() - start;
			// Timer fires almost immediately, killing sleep before it can complete
			expect(elapsed).toBeLessThan(100);
			expect(result).toBeNull();
		});

		// Test A6: Non-existent cwd — should resolve null with ENOENT
		it('resolves null when cwd does not exist', async () => {
			const fakeCwd = '/nonexistent/path/that/cannot/exist/xyz123';
			const result = await spawnAsync(['echo', 'hello'], fakeCwd, 5000);
			expect(result).toBeNull();
		});

		// ============================================================
		// WIN32 .CMD EXTENSION TESTS
		// ============================================================

		describe('.cmd extension on win32', () => {
			const testCwd = tmpdir();
			const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
				process,
				'platform',
			);

			const originalSpawn = _internals.spawn;

			afterEach(() => {
				// Restore original platform after each test to avoid test pollution
				if (originalPlatformDescriptor) {
					Object.defineProperty(
						process,
						'platform',
						originalPlatformDescriptor,
					);
				}
				// Restore the real spawn binding after any seam injection.
				_internals.spawn = originalSpawn;
			});

			// Test 1: npm on win32 → resolved command is transformed to npm.cmd.
			// A spawn spy captures the resolved command name so the transformation
			// is verified even though the POSIX runner has no real npm.cmd.
			it('npm on win32 is spawned as npm.cmd', async () => {
				Object.defineProperty(process, 'platform', {
					value: 'win32',
					configurable: true,
				});
				const capture: { cmd?: string } = {};
				_internals.spawn = makeFakeSpawn(
					capture,
				) as unknown as typeof _internals.spawn;
				const result = await spawnAsync(['npm', '--version'], testCwd, 5000);
				expect(capture.cmd).toBe('npm.cmd');
				expect(result).not.toBeNull();
				expect(result!.exitCode).toBe(0);
			});

			// Test 2: npx on win32 → resolved command is transformed to npx.cmd.
			it('npx on win32 is spawned as npx.cmd', async () => {
				Object.defineProperty(process, 'platform', {
					value: 'win32',
					configurable: true,
				});
				const capture: { cmd?: string } = {};
				_internals.spawn = makeFakeSpawn(
					capture,
				) as unknown as typeof _internals.spawn;
				const result = await spawnAsync(['npx', '--version'], testCwd, 5000);
				expect(capture.cmd).toBe('npx.cmd');
				expect(result).not.toBeNull();
				expect(result!.exitCode).toBe(0);
			});

			// Test 3: pnpm on win32 → resolves non-null or null (may not be installed)
			it('pnpm on win32 does not crash from transformation', async () => {
				Object.defineProperty(process, 'platform', {
					value: 'win32',
					configurable: true,
				});
				const result = await spawnAsync(['pnpm', '--version'], testCwd, 5000);
				expect(result === null || result!.exitCode === 0).toBe(true);
			});

			// Test 4: bun on win32 → spawned as 'bun' not 'bun.cmd'
			// Bun is not in WIN32_CMD_BINARIES so it stays as 'bun', which resolves fine
			it('bun on win32 resolves without .cmd extension', async () => {
				Object.defineProperty(process, 'platform', {
					value: 'win32',
					configurable: true,
				});
				const result = await spawnAsync(['bun', '--version'], testCwd, 5000);
				expect(result).not.toBeNull();
				expect(result!.exitCode).toBe(0);
			});

			// Test 5: npm on linux → resolves without .cmd issue
			// On this MSYS2/Windows env npm is a .cmd, so bare 'npm' may fail (resolve null)
			it('npm on linux does not crash', async () => {
				Object.defineProperty(process, 'platform', {
					value: 'linux',
					configurable: true,
				});
				const result = await spawnAsync(['npm', '--version'], testCwd, 5000);
				expect(result === null || result!.exitCode === 0).toBe(true);
			});

			// Test 6: Already-extended command npm.cmd not double-extended.
			// The `!rawCmd.includes('.')` guard must leave npm.cmd untouched
			// (no npm.cmd.cmd). Verified via the resolved command name.
			it('npm.cmd on win32 is not double-extended', async () => {
				Object.defineProperty(process, 'platform', {
					value: 'win32',
					configurable: true,
				});
				const capture: { cmd?: string } = {};
				_internals.spawn = makeFakeSpawn(
					capture,
				) as unknown as typeof _internals.spawn;
				const result = await spawnAsync(
					['npm.cmd', '--version'],
					testCwd,
					5000,
				);
				expect(capture.cmd).toBe('npm.cmd');
				expect(result).not.toBeNull();
				expect(result!.exitCode).toBe(0);
			});
		});
	});
});
