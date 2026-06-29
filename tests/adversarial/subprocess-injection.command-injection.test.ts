/**
 * SC-003.1 Command injection tests (split from subprocess-injection.test.ts).
 *
 * Attack vector: args with `;`, `|`, backticks, `$(...)` must not execute injected payloads.
 * Uses array-form spawn — no shell interpretation.
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
const isWindows = process.platform === 'win32';

afterEach(() => {
	cleanupTestScripts();
});

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
