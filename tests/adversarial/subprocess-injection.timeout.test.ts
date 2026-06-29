/**
 * SC-003.4 Timeout bypass tests (split from subprocess-injection.test.ts).
 *
 * Attack vector: subprocesses that ignore SIGTERM must still be terminated within bounded time.
 * Tests verify bunSpawn's timeout mechanism works correctly.
 *
 * All helpers route through bunSpawn (FB-010) to exercise the production spawn shim.
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

		const proc = bunSpawn([process.execPath, scriptPath], {
			cwd: tmpDir,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: TIMEOUT_MS,
		});

		await Bun.sleep(500);

		const stdout = await proc.stdout.text();
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
		// Must be killed by timeout's SIGKILL even though SIGTERM was trapped
		expect(exitCode).not.toBe(0);
	}, 10_000);
});
