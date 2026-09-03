import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnUtf8 } from '../../../scripts/gate-utils';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function timeoutProbe(markerPath: string, aliveDelayMs: number): string[] {
	return [
		Bun.which('node') ?? process.execPath,
		'-e',
		[
			"const fs = require('node:fs');",
			'const marker = process.argv[process.argv.length - 1];',
			'fs.writeFileSync(marker + ".started", "started");',
			`setTimeout(() => fs.writeFileSync(marker, "alive"), ${aliveDelayMs});`,
			'setInterval(() => {}, 1000);',
		].join(' '),
		markerPath,
	];
}

describe('gate-utils subprocess ownership', () => {
	test('timeout returns boundedly and terminates the child', async () => {
		const markerDir = canonicalMkdtemp('gate-utils-');
		const markerPath = path.join(markerDir, 'child-alive.txt');
		try {
			const started = performance.now();
			// Use the same Node probe and the same 2s timeout budget on every
			// platform. The non-Windows leg used to probe with 200ms, which
			// raced child cold-start under merge-group load: the .started
			// marker requires the child to have executed its first statement
			// before the kill, and 200ms is not a safe boot budget on shared
			// runners. Windows already carried 2s for exactly this cold-start
			// class; unify on it (issue #2478).
			const timeoutMs = 2_000;
			const aliveDelayMs = timeoutMs + 250;
			// Contract-derived bound (issue #2478): the kill fires at
			// timeoutMs and close handling is bounded by spawnUtf8's 1s kill
			// grace (KILL_GRACE_MS, scripts/gate-utils.ts). +2s of slack
			// absorbs runner stalls without weakening the "returns boundedly,
			// not hanging" guarantee the previous platform-specific magic
			// numbers attempted.
			const maxElapsedMs = timeoutMs + 1_000 + 2_000;
			const result = await spawnUtf8(
				timeoutProbe(markerPath, aliveDelayMs),
				process.cwd(),
				timeoutMs,
			);

			expect(result.exitCode).toBe(1);
			expect(performance.now() - started).toBeLessThan(maxElapsedMs);
			// The marker is deliberately scheduled after the timeout. Waiting past
			// its deadline makes the assertion falsify a child that survived the
			// timeout instead of merely proving that spawnUtf8 returned promptly.
			await new Promise((resolve) => setTimeout(resolve, aliveDelayMs + 250));
			expect(fs.existsSync(`${markerPath}.started`)).toBe(true);
			expect(fs.existsSync(markerPath)).toBe(false);
		} finally {
			safeRmRecursive(markerDir);
		}
	});

	test('FB-005 regression: preserves UTF-8 across subprocess chunk boundaries', async () => {
		const result = await spawnUtf8(
			[
				process.execPath,
				'-e',
				"const bytes = Buffer.from('€'); process.stdout.write(bytes.subarray(0, 1)); setImmediate(() => process.stdout.write(bytes.subarray(1)));",
			],
			process.cwd(),
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('€');
	});

	test('captures stdout and stderr without a shell', async () => {
		const result = await spawnUtf8(
			[
				process.execPath,
				'-e',
				"process.stdout.write('out'); process.stderr.write('err')",
			],
			process.cwd(),
		);

		expect(result).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err' });
	});
});
