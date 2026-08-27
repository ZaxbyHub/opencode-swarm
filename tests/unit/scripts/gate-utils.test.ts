import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnUtf8 } from '../../../scripts/gate-utils';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function timeoutProbe(markerPath: string): string[] {
	if (process.platform === 'win32') {
		return [
			'powershell',
			'-NoProfile',
			'-Command',
			[
				'Start-Sleep -Milliseconds 250',
				'[System.IO.File]::WriteAllText($args[0], "alive")',
				'while ($true) { Start-Sleep -Seconds 1 }',
			].join('; '),
			markerPath,
		];
	}

	return [
		Bun.which('node') ?? process.execPath,
		'-e',
		[
			"const fs = require('node:fs');",
			'const marker = process.argv[process.argv.length - 1];',
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
			const result = await spawnUtf8(
				timeoutProbe(markerPath),
				process.cwd(),
				50,
			);

			expect(result.exitCode).toBe(1);
			expect(performance.now() - started).toBeLessThan(2_000);
			await new Promise((resolve) => setTimeout(resolve, 350));
			expect(fs.existsSync(markerPath)).toBe(false);
		} finally {
			fs.rmSync(markerDir, { recursive: true, force: true });
		}
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
