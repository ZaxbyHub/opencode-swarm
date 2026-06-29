/**
 * SC-003.7 bunSpawn codepath tests (split from subprocess-injection.test.ts).
 *
 * These tests exercise the same attack vectors as other SC-003 tests but
 * route through the real src/utils/bun-compat.ts bunSpawn() function that
 * production code uses. This verifies the bunSpawn shim correctly propagates
 * security properties.
 *
 * All helpers route through bunSpawn (FB-010).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunSpawn } from '../../src/utils/bun-compat';
import {
	cleanupTestScripts,
	getTmpDir,
	writeNodeScript,
} from './subprocess-injection.helpers';

const tmpDir = getTmpDir();

afterEach(() => {
	cleanupTestScripts();
});

/** Run a node script via bunSpawn */
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
	const proc = bunSpawn([process.execPath, scriptPath, ...scriptArgs], {
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
