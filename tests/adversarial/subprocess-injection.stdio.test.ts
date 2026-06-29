/**
 * SC-003.3 Stdio pipe injection tests (split from subprocess-injection.test.ts).
 *
 * Attack vector: stdin payloads must not execute through pipes.
 * Tests that array-form spawn (no shell) means stdin data is treated as literal data.
 *
 * All helpers route through bunSpawn (FB-010) except the stdin-pipe test which
 * uses raw Bun.spawn because BunSpawn shim (Node child_process) does not expose stdin.
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
		//
		// NOTE: This test uses raw Bun.spawn because BunSpawn shim (Node child_process
		// on Node) does not expose proc.stdin as a writable stream. The test verifies
		// Bun-specific stdin behavior; production code uses bunSpawn without stdin writing.
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
