import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnUtf8 } from '../../../scripts/gate-utils';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function timeoutProbe(markerPath: string): string[] {
	const startedPath = `${markerPath}.started`;
	if (process.platform === 'win32') {
		const escapePowerShellLiteral = (value: string) =>
			`'${value.replace(/'/g, "''")}'`;
		return [
			'powershell',
			'-NoProfile',
			'-Command',
			`[System.IO.File]::WriteAllText(${escapePowerShellLiteral(startedPath)}, 'started'); Start-Sleep -Milliseconds 1500; [System.IO.File]::WriteAllText(${escapePowerShellLiteral(markerPath)}, 'alive'); while ($true) { Start-Sleep -Seconds 1 }`,
		];
	}

	return [
		Bun.which('node') ?? process.execPath,
		'-e',
		[
			"const fs = require('node:fs');",
			'const marker = process.argv[process.argv.length - 1];',
			'fs.writeFileSync(marker + ".started", "started");',
			'setTimeout(() => fs.writeFileSync(marker, "alive"), 250);',
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
			const timeoutMs = process.platform === 'win32' ? 500 : 50;
			const result = await spawnUtf8(
				timeoutProbe(markerPath),
				process.cwd(),
				timeoutMs,
			);

			expect(result.exitCode).toBe(1);
			expect(performance.now() - started).toBeLessThan(2_000);
			await new Promise((resolve) => setTimeout(resolve, 350));
			expect(fs.existsSync(`${markerPath}.started`)).toBe(true);
			expect(fs.existsSync(markerPath)).toBe(false);
		} finally {
			fs.rmSync(markerDir, { recursive: true, force: true });
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
