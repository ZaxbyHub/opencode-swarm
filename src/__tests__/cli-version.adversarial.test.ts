/**
 * Adversarial security tests for CLI --version flag handling
 * Tests attack vectors: homograph, injection, boundary violations, malformed inputs
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

describe('ADVERSARIAL: --version flag attack vectors', () => {
	async function runCli(args: string[]): Promise<{
		stdout: string;
		stderr: string;
		exitCode: number;
	}> {
		return new Promise((resolve) => {
			const proc = spawn(
				'bun',
				[path.join(import.meta.dir, '../cli/index.ts'), ...args],
				{
					stdio: ['ignore', 'pipe', 'pipe'],
					timeout: 5000,
				},
			);
			let stdout = '';
			let stderr = '';
			proc.stdout?.on('data', (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on('data', (data) => {
				stderr += data.toString();
			});
			proc.on('close', (code) => {
				resolve({ stdout, stderr, exitCode: code ?? 0 });
			});
			proc.on('error', (err) => {
				resolve({ stdout: '', stderr: err.message, exitCode: 1 });
			});
		});
	}

	// =====================================================================
	// 1. BOUNDARY: Very long argument strings (1000+ chars)
	// =====================================================================
	it('ADVERSARIAL: long argument string should not cause crash or hang', async () => {
		const longArg = 'v' + 'a'.repeat(10000);
		const result = await runCli([`--${longArg}`]);
		// Should NOT crash - should treat as unknown command
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unknown command');
	});

	it('ADVERSARIAL: very long -v variant should be handled safely', async () => {
		const longV = '-v' + 'v'.repeat(5000);
		const result = await runCli([longV]);
		// Should be rejected, not matched as -v
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unknown command');
	});

	// =====================================================================
	// 2. HOMOGRAPH ATTACKS: Unicode lookalikes for --version
	// =====================================================================
	it('ADVERSARIAL: homograph attack with ï (U+00EF) should NOT match --version', async () => {
		// --versïon with i-diaeresis
		const result = await runCli(['--versïon']);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unknown command');
		expect(result.stdout).not.toContain('opencode-swarm');
	});

	it('ADVERSARIAL: homograph attack with Cyrillic е (U+0435) should NOT match --version', async () => {
		// --vеrsion with Cyrillic e
		const result = await runCli(['--vеrsion']);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unknown command');
		expect(result.stdout).not.toContain('opencode-swarm');
	});

	it('ADVERSARIAL: homograph attack with Cyrillic а (U+0430) should NOT match --version', async () => {
		// --versioп with Cyrillic n - actually using Cyrillic п (U+043F)
		const result = await runCli(['--versioп']);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unknown command');
	});

	it('ADVERSARIAL: full-width v character should NOT match -v', async () => {
		// Full-width latin small letter v (U+FF56)
		const result = await runCli(['\uff56']);
		// Should be treated as unknown command, not -v
		expect(result.exitCode).toBe(1);
	});

	// =====================================================================
	// 3. Multiple -v flags
	// =====================================================================
	it('ADVERSARIAL: multiple -v flags should print version once', async () => {
		const result = await runCli(['-v', '-v', '-v']);
		expect(result.exitCode).toBe(0);
		// Should output version only once (not 3 times)
		const versionLines = result.stdout
			.trim()
			.split('\n')
			.filter((l) => l.includes('opencode-swarm'));
		expect(versionLines.length).toBe(1);
	});

	it('ADVERSARIAL: multiple --version flags should print version once', async () => {
		const result = await runCli(['--version', '--version']);
		expect(result.exitCode).toBe(0);
		const versionLines = result.stdout
			.trim()
			.split('\n')
			.filter((l) => l.includes('opencode-swarm'));
		expect(versionLines.length).toBe(1);
	});

	// =====================================================================
	// 4. --version combined with invalid commands
	// =====================================================================
	it('ADVERSARIAL: --version with invalid command should print version', async () => {
		const result = await runCli([
			'--version',
			' definitely-not-a-real-command',
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('opencode-swarm');
	});

	it('ADVERSARIAL: invalid command with --version should print version', async () => {
		const result = await runCli(['fake-command', '--version']);
		// --version is checked BEFORE command parsing
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('opencode-swarm');
	});

	// =====================================================================
	// 5. ATTACK SURFACE: --version=value format (equals syntax)
	// =====================================================================
	it('ADVERSARIAL: --version=value format should NOT match as version flag', async () => {
		const result = await runCli(['--version=1.0.0']);
		// This is a security concern - --version=value should not be recognized
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unknown command');
	});

	it('ADVERSARIAL: --version= with empty value should NOT match', async () => {
		const result = await runCli(['--version=']);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unknown command');
	});

	it('ADVERSARIAL: -v=value format should NOT match', async () => {
		const result = await runCli(['-v=1.0.0']);
		// This should be treated as unknown argument
		expect(result.exitCode).toBe(1);
	});

	// =====================================================================
	// 6. Empty args after version flag
	// =====================================================================
	it('ADVERSARIAL: --version with empty string arg should still work', async () => {
		const result = await runCli(['--version', '']);
		// The empty string is filtered out or ignored
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('opencode-swarm');
	});

	// =====================================================================
	// 7. CASE VARIATIONS: Security hardening - case sensitivity
	// =====================================================================
	it('ADVERSARIAL: --Version (capital V) should NOT match --version', async () => {
		const result = await runCli(['--Version']);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unknown command');
	});

	it('ADVERSARIAL: --VERSION (all caps) should NOT match --version', async () => {
		const result = await runCli(['--VERSION']);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unknown command');
	});

	it('ADVERSARIAL: --version (lowercase) SHOULD match', async () => {
		const result = await runCli(['--version']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('opencode-swarm');
	});

	// =====================================================================
	// 8. SPECIAL CHARACTERS: Injection attempts and edge cases
	// =====================================================================
	it('ADVERSARIAL: --version with shell metacharacters should not execute', async () => {
		const result = await runCli(['--version', ';', 'rm', '-rf', '/']);
		expect(result.exitCode).toBe(0);
		// Should just print version, not execute the injection
		expect(result.stdout).toContain('opencode-swarm');
		expect(result.stderr).not.toContain('No such file or directory');
	});

	it('ADVERSARIAL: --version with newlines should not cause injection', async () => {
		const result = await runCli(['--version', '-h\nmalicious-command']);
		expect(result.exitCode).toBe(0);
		// Should print version, not interpret the newline
		expect(result.stdout).toContain('opencode-swarm');
	});

	it('ADVERSARIAL: --version with null byte should be handled', async () => {
		// Node.js spawn itself rejects null bytes - this is correct behavior
		// The test verifies it doesn't crash the test runner itself
		try {
			const result = await runCli(['--version\0']);
			// Should not reach here since spawn throws
			expect(result.exitCode).toBe(1);
		} catch (err: unknown) {
			// Node.js correctly rejects null bytes before even spawning
			expect((err as Error).message).toContain('null bytes');
		}
	});

	it('ADVERSARIAL: tab character after --version should be handled', async () => {
		const result = await runCli(['--version\t']);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unknown command');
	});

	it('ADVERSARIAL: backspace character in arg should not cause crash', async () => {
		const result = await runCli(['--versio\u0008']); // \b backspace
		expect(result.exitCode).toBe(1);
	});

	it('ADVERSARIAL: ANSI escape codes should be stripped/not executed', async () => {
		const result = await runCli(['--version', '\x1b[31mRED\x1b[0m']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('opencode-swarm');
		// Should not interpret ANSI codes
		expect(result.stdout).not.toContain('RED');
	});

	// =====================================================================
	// 9. COMBINATION ATTACKS
	// =====================================================================
	it('ADVERSARIAL: mixed case version flags should not match', async () => {
		const result = await runCli(['-V', '--Version', '-v']);
		// Only lowercase -v should match
		expect(result.exitCode).toBe(0);
	});

	it('ADVERSARIAL: -v with unicode spaces should not match', async () => {
		const result = await runCli(['\u2009v\u2009']); // thin space around v
		expect(result.exitCode).toBe(1);
	});

	it('ADVERSARIAL: emoji in version flag position should not crash', async () => {
		const result = await runCli(['--version💣']);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unknown command');
	});

	it('ADVERSARIAL: zero-width joiner sequence should not match', async () => {
		// v + ZWJ + v = "v‌v" (with zero-width joiner)
		const result = await runCli(['--v\u200dversion']);
		expect(result.exitCode).toBe(1);
	});
});
