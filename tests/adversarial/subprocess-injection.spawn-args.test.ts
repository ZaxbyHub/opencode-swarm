/**
 * SC-003.2 Spawn-arg injection tests (split from subprocess-injection.test.ts).
 *
 * Attack vector: args with `--dangerous-flag` or `-rf` must be received as literal strings.
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

afterEach(() => {
	cleanupTestScripts();
});

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
