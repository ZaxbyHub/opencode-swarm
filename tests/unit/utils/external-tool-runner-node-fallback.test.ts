import { describe, expect, test } from 'bun:test';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

describe('external-tool-runner Node fallback', () => {
	test('reports a real ENOENT as typed spawn-error instead of completed exit 1', () => {
		const tempDir = realpathSync(
			mkdtempSync(
				path.join(realpathSync(os.tmpdir()), 'external-runner-node-'),
			),
		);
		try {
			const bundlePath = path.join(tempDir, 'external-tool-runner.mjs');
			const build = nodeSpawnSync(
				process.execPath,
				[
					'build',
					path.resolve('src/utils/external-tool-runner.ts'),
					'--target',
					'node',
					'--format',
					'esm',
					'--outfile',
					bundlePath,
				],
				{
					cwd: process.cwd(),
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
					timeout: 10_000,
					maxBuffer: 1024 * 1024,
				},
			);
			expect(build.status).toBe(0);

			const moduleUrl = pathToFileURL(bundlePath).href;
			const script = `
				const { runExternalTool } = await import(${JSON.stringify(moduleUrl)});
				const result = await runExternalTool({
					executable: 'opencode-swarm-definitely-missing-2097',
					args: [],
					cwd: process.cwd(),
					timeoutMs: 1000,
					maxStdoutBytes: 100,
					maxStderrBytes: 100,
				});
				console.log(JSON.stringify(result));
			`;
			const run = nodeSpawnSync('node', ['--input-type=module', '-e', script], {
				cwd: process.cwd(),
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
			});
			expect(run.status).toBe(0);
			const result = JSON.parse(run.stdout.trim()) as {
				status: string;
				exitCode: number | null;
				message?: string;
			};
			expect(result.status).toBe('spawn-error');
			expect(result.exitCode).toBeNull();
			expect(result.message).toContain('ENOENT');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
