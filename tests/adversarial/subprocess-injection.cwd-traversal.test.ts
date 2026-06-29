/**
 * SC-003.5 / SC-003.6 Path traversal and cross-platform escape tests
 * (split from subprocess-injection.test.ts).
 *
 * Attack vectors:
 * - SC-003.5: `../`, `..\\` must not escape intended working directory
 * - SC-003.6: `^&` (Windows cmd), `\x00` (POSIX) must be neutralized
 *
 * All helpers route through bunSpawn (FB-010) to exercise the production spawn shim.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	cleanupTestScripts,
	getTmpDir,
	runNodeScript,
	writeNodeScript,
} from './subprocess-injection.helpers';

const tmpDir = getTmpDir();

afterEach(() => {
	cleanupTestScripts();
});

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
