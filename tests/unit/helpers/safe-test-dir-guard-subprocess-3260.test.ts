/**
 * #3260-D run-wide restorer-guard subprocess probe. The preload wiring in
 * tests/preload/prod-store-tripwire.ts must fail a `bun test` run whose suite
 * leaves a safe-test-dir `_internals` member swapped (the leak fixture under
 * tests/fixtures/preload/), and must keep an otherwise-identical restoring run
 * green (the control fixture). Nonzero exit alone would admit
 * fixture/module-resolution false positives — the leak leg additionally
 * asserts the output names the internals-restoration guard and `wait`, and
 * the control leg asserts exit 0.
 *
 * Spawn controls per AGENTS.md invariant 3: array-form args, explicit repo
 * cwd, stdin ignored, timeout, bounded output, best-effort kill in finally.
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');

interface ProbeResult {
	code: number | null;
	output: string;
}

function runBunFixture(fixture: string): Promise<ProbeResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			['test', `tests/fixtures/preload/${fixture}`],
			{
				cwd: REPO_ROOT,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			},
		);
		let output = '';
		let settled = false;
		const chunks: Buffer[] = [];
		// Bounded output consumption (cap ~256 KiB); never leave streams unattended.
		const record = (chunk: Buffer): void => {
			chunks.push(chunk);
			const total = chunks.reduce((sum, c) => sum + c.length, 0);
			if (total <= 256 * 1024) {
				output += chunk.toString('utf-8');
			}
		};
		child.stdout.on('data', record);
		child.stderr.on('data', record);
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill();
				reject(new Error(`fixture ${fixture} timed out after 60 s`));
			}
		}, 60_000);
		child.on('error', (error) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(error);
			}
		});
		child.on('close', (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ code, output });
			}
		});
	});
}

describe('run-wide internals restorer guard (3260-D)', () => {
	test('a leaked _internals.wait fails the run and the guard names it', async () => {
		const leak = await runBunFixture('internals-leak-fixture.test.ts');
		expect(leak.code).not.toBe(0);
		expect(leak.output).toContain('internals-restoration guard');
		expect(leak.output).toContain('wait');
	}, 90_000);

	test('the restoring control run stays green', async () => {
		const control = await runBunFixture('internals-restore-control.test.ts');
		expect(control.code).toBe(0);
	}, 90_000);
});
