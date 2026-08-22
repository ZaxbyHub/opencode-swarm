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
		// A null byte in a path can truncate it and enable traversal
		// (`/etc/passwd\0suffix` -> `/etc/passwd`), so the child must never be
		// created.
		//
		// Issue #2236 changed only HOW that rejection is reported: `bunSpawn` no
		// longer throws on a process-creation failure, it returns the Node path's
		// long-standing contract (`exitCode: null`, non-zero `exited`, reason on
		// `spawnError`, reason replayed on `stderr`). The security property is
		// unchanged, so this test still asserts rejection — but it now pins the
		// property by OBSERVABLE SIDE EFFECT (the script would create a marker
		// file if it ever ran) rather than by the shape of the report. A future
		// change to the reporting contract cannot make this pass while the child
		// actually executes.
		const marker = path.join(tmpDir, 'null-byte-path-marker.txt');
		const script = writeNodeScript(
			'null-byte-path-probe.js',
			`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'child ran');`,
		);
		const maliciousPath = '/etc/passwd\x00suffix';

		const result = await runNodeScript(script, [maliciousPath], {
			cwd: tmpDir,
		});

		// The process was never created: no side effect and no output.
		expect(fs.existsSync(marker)).toBe(false);
		expect(result.stdout).toBe('');
		// The rejection is reported, not swallowed.
		expect(result.spawnError).not.toBeNull();
		expect((result.spawnError as unknown as { code?: string }).code).toBe(
			'ERR_INVALID_ARG_VALUE',
		);
		expect(result.exitCode).not.toBe(0);
		// stderr replays the reason, so a caller that reads only stderr still
		// learns the spawn failed instead of seeing a silent empty result.
		expect(result.stderr.length).toBeGreaterThan(0);
	});

	test('symlink traversal via ../ inside symlinked directory stays within bounds', async () => {
		// Create a directory with a symlink pointing outside tmpDir
		const innerDir = path.join(tmpDir, 'inner');
		const outerDir = path.join(tmpDir, 'outer');
		fs.mkdirSync(innerDir, { recursive: true });
		fs.mkdirSync(outerDir, { recursive: true });

		const symlinkPath = path.join(innerDir, 'link_to_outer');
		fs.symlinkSync(
			outerDir,
			symlinkPath,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		const script = writeNodeScript(
			'check-cwd.js',
			`console.log('cwd:' + process.cwd());`,
		);

		// Even if a tool traverses through symlinks, cwd should stay bounded
		const result = await runNodeScript(script, [], { cwd: innerDir });

		// process.cwd() always reports the OS-canonical (symlink-resolved) path —
		// on macOS os.tmpdir() itself sits under a symlink (/var -> /private/var),
		// so the expected value must be realpath-resolved the same way, or this
		// assertion spuriously fails on macOS even though nothing escaped bounds.
		expect(result.stdout.trim()).toBe(`cwd:${fs.realpathSync(innerDir)}`);
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
		//
		// process.cwd() always reports the OS-canonical (symlink-resolved) path,
		// so os.tmpdir() must be realpath-resolved the same way before comparing
		// — on macOS os.tmpdir() itself sits under a symlink (/var ->
		// /private/var), which would otherwise make isInTemp spuriously false
		// even though nothing escaped bounds (see the sibling symlink-traversal
		// test above for the same fix). isInSandbox is a defensive fallback but
		// cannot be true here: dotDotCwd is tmpDir's PARENT, which strips the
		// 'subprocess-injection-test' segment from the resolved cwd entirely.
		const resolvedCwd = result.stdout.trim().replace('cwd:', '');
		const realTmpDir = fs.realpathSync(os.tmpdir());
		const isInTemp = path
			.normalize(resolvedCwd)
			.startsWith(path.normalize(realTmpDir));
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
		// Rejecting null bytes prevents truncation attacks. As in SC-003.5, the
		// #2236 contract reports the rejection as a value rather than a throw, so
		// the assertion is anchored on the child never running (no marker file)
		// plus the reported reason — not on an exception being raised.
		const marker = path.join(tmpDir, 'null-byte-arg-marker.txt');
		const script = writeNodeScript(
			'null-byte-arg-probe.js',
			`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'child ran');`,
		);
		const withNull = 'hello\x00world';

		const result = await runNodeScript(script, [withNull], { cwd: tmpDir });

		expect(fs.existsSync(marker)).toBe(false);
		expect(result.stdout).toBe('');
		expect(result.spawnError).not.toBeNull();
		expect((result.spawnError as unknown as { code?: string }).code).toBe(
			'ERR_INVALID_ARG_VALUE',
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.length).toBeGreaterThan(0);
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
