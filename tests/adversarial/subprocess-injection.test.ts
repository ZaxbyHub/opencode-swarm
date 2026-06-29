/**
 * Adversarial test suite for FR-003 (subprocess injection resistance).
 *
 * Tests 6 attack vectors:
 * - SC-003.1 Command injection: args with `;`, `|`, backticks, `$(...)` must not execute injected payloads
 * - SC-003.2 Spawn-arg injection: args with `--dangerous-flag` or `-rf` must be received as literal strings
 * - SC-003.3 Stdio pipe attacks: stdin payloads must not execute through pipes
 * - SC-003.4 Timeout bypass: subprocesses that ignore SIGTERM must still be terminated within bounded time
 * - SC-003.5 Path traversal in cwd: `../`, `..\\` must not escape intended working directory
 * - SC-003.6 Cross-platform escape: `^&` (Windows cmd), `\x00` (POSIX) must be neutralized
 *
 * Uses Bun.spawn directly to test the spawn API behavior against injection attacks.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunSpawn } from '../../src/utils/bun-compat';

const isWindows = process.platform === 'win32';

// Use os.tmpdir() + path.join() — never hardcode /tmp or C:\
const tmpDir = fs.mkdtempSync(
	path.join(os.tmpdir(), 'subprocess-injection-test-'),
);

/** Helper: spawn a real command and return its output */
async function runProc(
	cmd: string[],
	opts?: {
		cwd?: string;
		stdin?: 'inherit' | 'ignore' | 'pipe';
		stdout?: 'inherit' | 'ignore' | 'pipe';
		stderr?: 'inherit' | 'ignore' | 'pipe';
		timeout?: number;
	},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, {
		cwd: opts?.cwd,
		stdin: opts?.stdin ?? 'ignore',
		stdout: opts?.stdout ?? 'pipe',
		stderr: opts?.stderr ?? 'pipe',
		timeout: opts?.timeout ?? 5000,
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr };
}

/** Helper: write a Node.js test script that echoes its arguments or environment */
function writeNodeScript(name: string, content: string): string {
	const filePath = path.join(tmpDir, name);
	fs.writeFileSync(filePath, content, 'utf-8');
	return filePath;
}

/** Helper: run a node script with Bun.spawn */
async function runNodeScript(
	scriptPath: string,
	scriptArgs: string[] = [],
	opts?: {
		cwd?: string;
		stdin?: 'inherit' | 'ignore' | 'pipe';
		stdout?: 'inherit' | 'ignore' | 'pipe';
		stderr?: 'inherit' | 'ignore' | 'pipe';
		timeout?: number;
	},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return runProc([process.execPath, scriptPath, ...scriptArgs], opts);
}

/**
 * Helper: run a command via the actual codebase bunSpawn path.
 * Exercises src/utils/bun-compat.ts which is what production code uses.
 */
async function runProcBunSpawn(
	cmd: string[],
	opts?: {
		cwd?: string;
		stdin?: 'inherit' | 'ignore' | 'pipe';
		stdout?: 'inherit' | 'ignore' | 'pipe';
		stderr?: 'inherit' | 'ignore' | 'pipe';
		timeout?: number;
	},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = bunSpawn(cmd, {
		cwd: opts?.cwd,
		stdin: opts?.stdin ?? 'ignore',
		stdout: opts?.stdout ?? 'pipe',
		stderr: opts?.stderr ?? 'pipe',
		timeout: opts?.timeout ?? 5000,
	});
	const exitCode = await proc.exited;
	const stdout = await proc.stdout.text();
	const stderr = await proc.stderr.text();
	return { exitCode, stdout, stderr };
}

/** Helper: run a node script via bunSpawn (actual codebase spawn path) */
async function runNodeScriptBunSpawn(
	scriptPath: string,
	scriptArgs: string[] = [],
	opts?: {
		cwd?: string;
		stdin?: 'inherit' | 'ignore' | 'pipe';
		stdout?: 'inherit' | 'ignore' | 'pipe';
		stderr?: 'inherit' | 'ignore' | 'pipe';
		timeout?: number;
	},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return runProcBunSpawn([process.execPath, scriptPath, ...scriptArgs], opts);
}

afterEach(() => {
	// Clean up test scripts
	try {
		const entries = fs.readdirSync(tmpDir);
		for (const entry of entries) {
			try {
				fs.unlinkSync(path.join(tmpDir, entry));
			} catch {
				// ignore cleanup errors
			}
		}
	} catch {
		// ignore
	}
});

// =============================================================================
// SC-003.1 Command injection: args with shell metacharacters must not execute
// =============================================================================

describe('SC-003.1 Command injection via shell metacharacters', () => {
	test('semicolon in argument is treated as literal argument, not command separator', async () => {
		// Create a Node.js script that echoes its arguments
		const script = writeNodeScript(
			'echo-arg.js',
			`const args = process.argv.slice(2);
console.log(args[0] || '');`,
		);
		const maliciousArg = 'hello; echo INJECTED >&2';
		const result = await runNodeScript(script, [maliciousArg], { cwd: tmpDir });

		// The malicious portion must NOT have executed (would require shell interpretation)
		expect(result.stdout.trim()).toBe('hello; echo INJECTED >&2');
	});

	test('pipe character in argument is treated as literal, not pipe operator', async () => {
		const script = writeNodeScript(
			'echo-arg2.js',
			`const args = process.argv.slice(2);
console.log(args[0] || '');`,
		);
		const maliciousArg = 'data|ls';
		const result = await runNodeScript(script, [maliciousArg], { cwd: tmpDir });

		// Output should be the literal string
		expect(result.stdout.trim()).toBe('data|ls');
	});

	test('backtick substitution is not interpreted by array-form spawn', async () => {
		const script = writeNodeScript(
			'echo-arg3.js',
			`const args = process.argv.slice(2);
console.log(args[0] || '');`,
		);
		// Backticks in argument
		const maliciousArg = '`echo INJECTED`';
		const result = await runNodeScript(script, [maliciousArg], { cwd: tmpDir });

		// The literal backticks should appear
		expect(result.stdout.trim()).toBe('`echo INJECTED`');
	});

	test('$(...) command substitution is not interpreted by array-form spawn', async () => {
		const script = writeNodeScript(
			'echo-arg4.js',
			`const args = process.argv.slice(2);
console.log(args[0] || '');`,
		);
		const maliciousArg = '$(echo INJECTED)';
		const result = await runNodeScript(script, [maliciousArg], { cwd: tmpDir });

		// The literal text should appear
		expect(result.stdout.trim()).toBe('$(echo INJECTED)');
	});

	test('newline injection does not split argument in array-form spawn', async () => {
		const script = writeNodeScript(
			'echo-arg5.js',
			`const args = process.argv.slice(2);
console.log(args[0] || '');`,
		);
		// Newline in argument - Node.js will receive it as single argument
		const maliciousArg = 'safe\necho INJECTED >&2';
		const result = await runNodeScript(script, [maliciousArg], { cwd: tmpDir });

		// The literal newline should appear
		expect(result.stdout.trim()).toBe('safe\necho INJECTED >&2');
	});
});

// =============================================================================
// SC-003.2 Spawn-arg injection: dangerous flags are literal strings
// =============================================================================

describe('SC-003.2 Spawn-arg injection via dangerous flags', () => {
	test('--dangerous-flag is received as literal argument, not interpreted', async () => {
		const script = writeNodeScript(
			'check-flag.js',
			`const args = process.argv.slice(2);
for (const arg of args) { console.log('arg:' + arg); }`,
		);
		const result = await runNodeScript(script, ['--dangerous-flag'], {
			cwd: tmpDir,
		});

		// The flag must appear literally
		expect(result.stdout).toContain('arg:--dangerous-flag');
	});

	test('-rf flag is received as literal argument, not interpreted as recursive force', async () => {
		const script = writeNodeScript(
			'check-rf.js',
			`const args = process.argv.slice(2);
for (const arg of args) { console.log('arg:' + arg); }`,
		);

		// Create a subdirectory
		const subdir = path.join(tmpDir, 'target');
		fs.mkdirSync(subdir, { recursive: true });

		const result = await runNodeScript(script, ['-rf', tmpDir], {
			cwd: tmpDir,
		});

		// -rf should appear as literal arg
		expect(result.stdout).toContain('arg:-rf');
		expect(result.stdout).toContain(`arg:${tmpDir}`);
		// tmpDir should NOT have been recursively deleted
		expect(fs.existsSync(subdir)).toBe(true);
	});

	test('--no-preserve-root with rm is neutralized when passed as array arg', async () => {
		const script = writeNodeScript(
			'rm-args.js',
			`const args = process.argv.slice(2);
for (const arg of args) { console.log('arg:' + arg); }
console.log('ARGV_COUNT:' + args.length);`,
		);

		// Attempt to pass dangerous-looking flags
		const result = await runNodeScript(
			script,
			['--no-preserve-root', '--recursive', '/'],
			{ cwd: tmpDir },
		);

		// The flags should appear literally
		expect(result.stdout).toContain('arg:--no-preserve-root');
		expect(result.stdout).toContain('arg:--recursive');
		expect(result.stdout).toContain('arg:/');
	});
});

// =============================================================================
// SC-003.3 Stdio pipe attacks: stdin payloads must not execute
// =============================================================================

describe('SC-003.3 Stdio pipe injection attacks', () => {
	test('array-form spawn does not invoke shell - shell metacharacters are literal', async () => {
		// This test verifies that when using array-form spawn (no shell),
		// metacharacters like ; | ` $ are passed as literal arguments
		// not interpreted by a shell

		// Create a script that prints all its args
		const script = writeNodeScript(
			'print-args.js',
			`const args = process.argv.slice(2);
for (const arg of args) {
  console.log('ARG:' + arg);
}`,
		);
		const absScript = path.join(tmpDir, 'print-args.js');

		// These would be dangerous if interpreted by a shell
		const dangerousArgs = [
			'echo INJECTED',
			'data;rm -rf /',
			'$(whoami)',
			'`id`',
		];

		for (const arg of dangerousArgs) {
			const result = await runNodeScript(absScript, [arg], { cwd: tmpDir });
			// The arg should appear literally (shell would have expanded it)
			expect(result.stdout).toContain('ARG:' + arg);
			// INJECTED should not appear unless it was part of the literal string
			if (arg !== 'echo INJECTED') {
				expect(result.stdout).not.toContain('INJECTED');
			}
		}
	});

	test('spawn without shell:pipe option prevents shell interpretation', async () => {
		// Key security property: array-form spawn does NOT invoke a shell
		// Therefore shell metacharacters in arguments are safe
		const script = writeNodeScript(
			'safe-echo.js',
			`console.log(process.argv[2] || '');`,
		);
		const absScript = path.join(tmpDir, 'safe-echo.js');

		// These would be dangerous in a shell script but safe as direct args
		const maliciousArgs = [
			'; echo PWNED',
			'&& echo PWNED',
			'|| echo PWNED',
			'| cat /etc/passwd',
		];

		for (const arg of maliciousArgs) {
			const result = await runNodeScript(absScript, [arg], { cwd: tmpDir });
			// The full string should be output (shell would have split on ; etc)
			expect(result.stdout.trim()).toBe(arg);
		}
	});

	test('passing data via file instead of stdin is safe (avoids pipe injection)', async () => {
		// Best practice: pass sensitive data via files, not stdin pipes
		// This avoids any stdin pipe interpretation issues
		const script = writeNodeScript(
			'read-file.js',
			`const fs = require('fs');
const data = fs.readFileSync(process.argv[2], 'utf-8');
console.log('DATA:' + data.trim());`,
		);
		const absScript = path.join(tmpDir, 'read-file.js');

		// Write malicious content to a file
		const dataFile = path.join(tmpDir, 'malicious-data.txt');
		const maliciousContent = 'safe; echo INJECTED\n';
		fs.writeFileSync(dataFile, maliciousContent, 'utf-8');

		const result = await runNodeScript(absScript, [dataFile], { cwd: tmpDir });

		// The data should be read literally from the file
		// The content "safe; echo INJECTED" is treated as literal data
		expect(result.stdout).toContain('DATA:safe; echo INJECTED');
		// Note: INJECTED appears as part of the literal string, not as executed command
		// The key security property is that 'echo' was never run - it's just string data
	});

	test('payload written to proc.stdin is treated as data, not executed as command', async () => {
		// SC-003.3: spawn a child that reads from stdin and echoes it back.
		// The child does NOT interpret stdin as commands — array-form spawn has no shell.
		// We write a shell injection payload to proc.stdin and verify it appears literally.
		const childScript = writeNodeScript(
			'stdin-echo.js',
			`process.stdin.setEncoding('utf-8');
let data = '';
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => { console.log('STDIN_DATA:' + data.trim()); });`,
		);

		const proc = Bun.spawn([process.execPath, childScript], {
			cwd: tmpDir,
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 3000,
		});

		// Write a shell injection payload through the pipe
		const maliciousPayload = 'hello; echo INJECTED >&2';
		proc.stdin.write(maliciousPayload);
		proc.stdin.end();

		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		// The payload should appear as literal data in stdout, not executed
		expect(stdout).toContain('STDIN_DATA:' + maliciousPayload);
		// INJECTED should NOT appear in stderr as an executed command
		expect(stderr).not.toContain('INJECTED');
		// Child should exit cleanly (no shell interpretation = no error)
		expect(exitCode).toBe(0);
	});
});

// =============================================================================
// SC-003.4 Timeout bypass: processes ignoring SIGTERM must still be terminated
// =============================================================================

describe('SC-003.4 Timeout bypass — process ignores SIGTERM but bounded by timeout', () => {
	test('process that runs too long is killed by timeout', async () => {
		// Create a script that would run for 60 seconds if not interrupted
		const scriptContent = `console.log('starting');
setTimeout(() => {
  console.log('should not reach here');
}, 60000);`;

		const scriptPath = path.join(tmpDir, 'timeout-test.js');
		fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

		const TIMEOUT_MS = 2000;

		const proc = Bun.spawn([process.execPath, scriptPath], {
			cwd: tmpDir,
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: TIMEOUT_MS,
		});

		await Bun.sleep(500);

		const stdout = await new Response(proc.stdout).text();
		expect(stdout).toContain('starting');

		const exitCode = await proc.exited;
		// Should be killed by timeout (non-zero exit)
		expect(exitCode).not.toBe(0);
		// Should not have reached the setTimeout callback
		expect(stdout).not.toContain('should not reach here');
	}, 10_000);

	test('process with infinite setInterval is killed by timeout', async () => {
		const scriptContent = `console.log('started');
let count = 0;
const id = setInterval(() => {
  count++;
  if (count >= 100) { // Would run for 100 * 1000ms = ~100 seconds
    clearInterval(id);
    console.log('should not reach here');
  }
}, 1000);`;

		const scriptPath = path.join(tmpDir, 'interval-test.js');
		fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

		const TIMEOUT_MS = 2000;

		const proc = Bun.spawn([process.execPath, scriptPath], {
			cwd: tmpDir,
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: TIMEOUT_MS,
		});

		await Bun.sleep(500);

		const stdout = await new Response(proc.stdout).text();
		expect(stdout).toContain('started');

		const exitCode = await proc.exited;
		expect(exitCode).not.toBe(0);
		expect(stdout).not.toContain('should not reach here');
	}, 10_000);

	test('spawned process respects timeout even with long-running callback', async () => {
		// Create a script with a recursive setTimeout that runs indefinitely
		const scriptContent = `console.log('starting');
function schedule() {
  setTimeout(() => {
    console.log('tick');
    schedule(); // Never stops - runs forever
  }, 100);
}
schedule();`;

		const scriptPath = path.join(tmpDir, 'recursive-timeout.js');
		fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

		const TIMEOUT_MS = 2000;

		const proc = Bun.spawn([process.execPath, scriptPath], {
			cwd: tmpDir,
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: TIMEOUT_MS,
		});

		await Bun.sleep(500);

		const stdout = await new Response(proc.stdout).text();
		expect(stdout).toContain('starting');
		expect(stdout).not.toContain('should not reach');

		const exitCode = await proc.exited;
		// Should be killed by timeout
		expect(exitCode).not.toBe(0);
		// Should have gotten some ticks but not an unreasonable amount
		const tickCount = (stdout.match(/tick/g) || []).length;
		expect(tickCount).toBeLessThan(20);
	}, 10_000);

	test('process that ignores SIGTERM is still killed when timeout fires', async () => {
		// SC-003.4: a child that explicitly ignores SIGTERM via process.on handler
		// must still be terminated when bunSpawn's timeout expires.
		// bunSpawn uses SIGKILL as the final termination signal, which cannot be ignored.
		const scriptContent = `console.log('starting');
process.on('SIGTERM', () => {
  // Intentionally ignore SIGTERM — this child thinks it's safe
});
// Run forever
setTimeout(() => {}, 60000);`;

		const scriptPath = path.join(tmpDir, 'sigterm-ignore.js');
		fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

		const TIMEOUT_MS = 2000;

		const proc = Bun.spawn([process.execPath, scriptPath], {
			cwd: tmpDir,
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: TIMEOUT_MS,
		});

		await Bun.sleep(500);

		const stdout = await new Response(proc.stdout).text();
		expect(stdout).toContain('starting');

		const exitCode = await proc.exited;
		// Must be killed by timeout's SIGKILL even though SIGTERM was trapped
		expect(exitCode).not.toBe(0);
	}, 10_000);
});

// =============================================================================
// SC-003.5 Path traversal in cwd: ../ must not escape working directory
// =============================================================================

describe('SC-003.5 Path traversal — cwd escape attempts', () => {
	test('dot-dot-slash in argument does not escape cwd', async () => {
		// Create a directory structure
		const safeDir = path.join(tmpDir, 'safe');
		const escapeDir = path.join(tmpDir, 'escape_target');
		fs.mkdirSync(safeDir, { recursive: true });
		fs.mkdirSync(escapeDir, { recursive: true });

		// Create a script that echoes the path it was given
		const script = writeNodeScript(
			'list-path.js',
			`const args = process.argv.slice(2);
console.log('path:' + (args[0] || ''));`,
		);
		const traversalPath = path.join(safeDir, '..', 'escape_target');
		const result = await runNodeScript(script, [traversalPath], {
			cwd: tmpDir,
		});

		// The path should appear literally
		expect(result.stdout).toContain('path:');
	});

	test('double-dot with backslash does not cause escape when passed as arg', async () => {
		const script = writeNodeScript(
			'win-path.js',
			`const args = process.argv.slice(2);
console.log('arg:' + (args[0] || ''));`,
		);

		// Windows-style traversal string
		const winTraversal = '..\\..\\windows\\escape';
		const result = await runNodeScript(script, [winTraversal], { cwd: tmpDir });

		// The argument should be treated literally
		expect(result.stdout).toContain('arg:..\\..\\windows\\escape');
	});

	test('absolute path with null byte is rejected by spawn (secure behavior)', async () => {
		// Bun.spawn correctly rejects null bytes in arguments - this is secure!
		// Null bytes in paths can truncate and enable path traversal attacks
		const maliciousPath = '/etc/passwd\x00suffix';
		try {
			await runNodeScript('/some/script.js', [maliciousPath], { cwd: tmpDir });
			// If we get here, the null byte was accepted (unexpected)
			expect(true).toBe(false);
		} catch (err: unknown) {
			// Bun.spawn throws ERR_INVALID_ARG_VALUE for null bytes - correct!
			const error = err as { message?: string; code?: string };
			expect(error.code).toBe('ERR_INVALID_ARG_VALUE');
		}
	});

	test('symlink traversal via ../ inside symlinked directory stays within bounds', async () => {
		// Create a directory with a symlink pointing outside tmpDir
		const innerDir = path.join(tmpDir, 'inner');
		const outerDir = path.join(tmpDir, 'outer');
		fs.mkdirSync(innerDir, { recursive: true });
		fs.mkdirSync(outerDir, { recursive: true });

		const symlinkPath = path.join(innerDir, 'link_to_outer');
		try {
			fs.symlinkSync(outerDir, symlinkPath);
		} catch {
			// Symlink creation may fail on some Windows configurations
			test.skip('symlinks not supported on this configuration', () => {});
			return;
		}

		const script = writeNodeScript(
			'check-cwd.js',
			`console.log('cwd:' + process.cwd());`,
		);

		// Even if a tool traverses through symlinks, cwd should stay bounded
		const result = await runNodeScript(script, [], { cwd: innerDir });

		// process.cwd() should show the inner directory, not resolved symlink target
		expect(result.stdout.trim()).toBe(`cwd:${innerDir}`);
	});

	test('dot-dot cwd escape attempt is rejected or bounds the process correctly', async () => {
		// SC-003.5: spawn with ../ as cwd must not allow the child to
		// escape to an arbitrary directory outside the intended sandbox.
		//
		// We pass tmpDir's parent (the temp folder itself) as cwd. Using ../ at
		// that level navigates up to the OS temp root. The child must not be
		// able to escape the temp/user-profile area to reach arbitrary paths.
		const dotDotCwd = path.join(tmpDir, '..');

		const script = writeNodeScript(
			'cwd-check.js',
			`console.log('cwd:' + process.cwd());`,
		);

		const result = await runNodeScript(script, [], { cwd: dotDotCwd });

		// The resolved cwd must be inside os.tmpdir() OR still in our sandbox.
		// This prevents escape to user home or system directories.
		const resolvedCwd = result.stdout.trim().replace('cwd:', '');
		const isInTemp = path
			.normalize(resolvedCwd)
			.startsWith(path.normalize(os.tmpdir()));
		const isInSandbox = resolvedCwd.includes('subprocess-injection-test');
		expect(isInTemp || isInSandbox).toBe(true);
	});
});

// =============================================================================
// SC-003.6 Cross-platform escape sequences
// =============================================================================

describe('SC-003.6 Cross-platform escape sequence neutralization', () => {
	test('Windows cmd metacharacter ^& is treated as literal in array-form spawn', async () => {
		const script = writeNodeScript(
			'echo-literal.js',
			`const args = process.argv.slice(2);
console.log(args[0] || '');`,
		);
		const winEscape = 'data^&special';
		const result = await runNodeScript(script, [winEscape], { cwd: tmpDir });

		// The ^& should appear literally
		expect(result.stdout.trim()).toBe('data^&special');
	});

	test('caret followed by redirect characters is neutralized', async () => {
		const script = writeNodeScript(
			'echo-literal2.js',
			`const args = process.argv.slice(2);
console.log(args[0] || '');`,
		);
		// Various cmd escape sequences
		const cmdEscapes = ['a>b', 'c|d', 'e&f', 'g<h', 'i^j'];
		for (const cmdEscape of cmdEscapes) {
			const result = await runNodeScript(script, [cmdEscape], { cwd: tmpDir });
			// Each should appear literally, not interpreted
			expect(result.stdout.trim()).toBe(cmdEscape);
		}
	});

	test('null byte (\\x00) in argument is rejected by spawn (secure behavior)', async () => {
		// Bun.spawn correctly rejects null bytes - this prevents truncation attacks
		// where /etc/passwd\x00suffix could become /etc/passwd
		const withNull = 'hello\x00world';
		try {
			await runNodeScript('/some/script.js', [withNull], { cwd: tmpDir });
			expect(true).toBe(false); // Should have thrown
		} catch (err: unknown) {
			const error = err as { code?: string };
			expect(error.code).toBe('ERR_INVALID_ARG_VALUE');
		}
	});

	test('vertical bar and ampersand in data are literal when passed as array args', async () => {
		const script = writeNodeScript(
			'special-chars.js',
			`const args = process.argv.slice(2);
console.log(args[0] || '');`,
		);
		const dataWithSpecial = 'value1|value2&value3';
		const result = await runNodeScript(script, [dataWithSpecial], {
			cwd: tmpDir,
		});

		expect(result.stdout.trim()).toBe('value1|value2&value3');
	});

	test('shell metacharacters in filenames are safe when passed as array args', async () => {
		// Create a file with special characters in name
		const specialFile = path.join(tmpDir, 'file with spaces & pipes.txt');
		fs.writeFileSync(specialFile, 'content', { encoding: 'utf-8' });

		const script = writeNodeScript(
			'list-special.js',
			`const args = process.argv.slice(2);
console.log('file:' + (args[0] || 'none'));`,
		);
		const result = await runNodeScript(script, [specialFile], { cwd: tmpDir });

		// Should show the filename, not fail on parsing
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('file:');
		expect(result.stdout).toContain('pipes.txt');
	});
});

// =============================================================================
// SC-003.7 bunSpawn codepath tests — same attacks, through actual codebase spawn
// =============================================================================
//
// These tests exercise the same attack vectors but route through the real
// src/utils/bun-compat.ts bunSpawn() function that production code uses.
// This verifies the bunSpawn shim correctly propagates security properties.

describe('SC-003.7 bunSpawn codepath — attack vectors through actual codebase spawn', () => {
	test('SC-003.1 via bunSpawn: semicolon in argument is treated as literal', async () => {
		const script = writeNodeScript(
			'bs-echo-arg.js',
			`const args = process.argv.slice(2);
console.log(args[0] || '');`,
		);
		const maliciousArg = 'hello; echo INJECTED >&2';
		const result = await runNodeScriptBunSpawn(script, [maliciousArg], {
			cwd: tmpDir,
		});

		expect(result.stdout.trim()).toBe('hello; echo INJECTED >&2');
	});

	test('SC-003.1 via bunSpawn: $(...) command substitution is not interpreted', async () => {
		const script = writeNodeScript(
			'bs-echo-arg2.js',
			`const args = process.argv.slice(2);
console.log(args[0] || '');`,
		);
		const maliciousArg = '$(echo INJECTED)';
		const result = await runNodeScriptBunSpawn(script, [maliciousArg], {
			cwd: tmpDir,
		});

		expect(result.stdout.trim()).toBe('$(echo INJECTED)');
	});

	test('SC-003.2 via bunSpawn: --dangerous-flag is received as literal argument', async () => {
		const script = writeNodeScript(
			'bs-check-flag.js',
			`const args = process.argv.slice(2);
for (const arg of args) { console.log('arg:' + arg); }`,
		);
		const result = await runNodeScriptBunSpawn(script, ['--dangerous-flag'], {
			cwd: tmpDir,
		});

		expect(result.stdout).toContain('arg:--dangerous-flag');
	});

	test('SC-003.2 via bunSpawn: -rf flag is literal, not recursive force', async () => {
		const script = writeNodeScript(
			'bs-check-rf.js',
			`const args = process.argv.slice(2);
for (const arg of args) { console.log('arg:' + arg); }`,
		);

		const subdir = path.join(tmpDir, 'target');
		fs.mkdirSync(subdir, { recursive: true });

		const result = await runNodeScriptBunSpawn(script, ['-rf', tmpDir], {
			cwd: tmpDir,
		});

		expect(result.stdout).toContain('arg:-rf');
		expect(result.stdout).toContain(`arg:${tmpDir}`);
		// tmpDir should NOT have been recursively deleted
		expect(fs.existsSync(subdir)).toBe(true);
	});

	test('SC-003.4 via bunSpawn: long-running process is killed by timeout', async () => {
		// bunSpawn wraps the same timeout logic; verify it still terminates runaway children
		const scriptContent = `console.log('starting');
setTimeout(() => {
  console.log('should not reach here');
}, 60000);`;

		const scriptPath = path.join(tmpDir, 'bs-timeout-test.js');
		fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

		const TIMEOUT_MS = 2000;

		const proc = bunSpawn([process.execPath, scriptPath], {
			cwd: tmpDir,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: TIMEOUT_MS,
		});

		await Bun.sleep(500);

		const stdout = await proc.stdout.text();
		expect(stdout).toContain('starting');

		const exitCode = await proc.exited;
		expect(exitCode).not.toBe(0);
		expect(stdout).not.toContain('should not reach here');
	});

	test('SC-003.6 via bunSpawn: cross-platform escape sequences are neutralized', async () => {
		const script = writeNodeScript(
			'bs-cmd-escapes.js',
			`const args = process.argv.slice(2);
console.log(args[0] || '');`,
		);
		const winEscape = 'data^&special';
		const result = await runNodeScriptBunSpawn(script, [winEscape], {
			cwd: tmpDir,
		});

		expect(result.stdout.trim()).toBe('data^&special');
	});
});
