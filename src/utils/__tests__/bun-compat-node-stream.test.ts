import { describe, expect, test } from 'bun:test';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

describe('bunSpawn Node fallback stream consumption', () => {
	test('preserves asynchronous Node spawn errors', () => {
		const moduleUrl = pathToFileURL(
			path.resolve('src/utils/bun-compat.ts'),
		).href;
		const script = `
			const { bunSpawn } = await import(${JSON.stringify(moduleUrl)});
			const proc = bunSpawn(['opencode-swarm-definitely-missing-2097'], {
				cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
			});
			const code = await proc.exited;
			console.log(JSON.stringify({
				code,
				exitCode: proc.exitCode,
				spawnErrorCode: proc.spawnError?.code,
			}));
		`;
		const result = nodeSpawnSync(
			'node',
			['--experimental-strip-types', '--input-type=module', '-e', script],
			{
				cwd: process.cwd(),
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
			},
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({
			code: 1,
			exitCode: null,
			spawnErrorCode: 'ENOENT',
		});
	});

	test('preserves signal termination instead of reporting exit zero', () => {
		const moduleUrl = pathToFileURL(
			path.resolve('src/utils/bun-compat.ts'),
		).href;
		const script = `
			const { bunSpawn } = await import(${JSON.stringify(moduleUrl)});
			const proc = bunSpawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
				cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
			});
			proc.kill('SIGTERM');
			const code = await proc.exited;
			console.log(JSON.stringify({ code, exitCode: proc.exitCode, signalCode: proc.signalCode }));
		`;
		const result = nodeSpawnSync(
			'node',
			['--experimental-strip-types', '--input-type=module', '-e', script],
			{
				cwd: process.cwd(),
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
			},
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({
			code: -1,
			exitCode: null,
			signalCode: 'SIGTERM',
		});
	});

	test('bounded readers do not also activate the full-output collector', () => {
		const moduleUrl = pathToFileURL(
			path.resolve('src/utils/bun-compat.ts'),
		).href;
		const script = `
			const { bunSpawn } = await import(${JSON.stringify(moduleUrl)});
			const payload = "process.stdout.write('x'.repeat(8 * 1024 * 1024))";
			const proc = bunSpawn([process.execPath, '-e', payload], {
				cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
				timeout: 5000, killProcessTree: true,
			});
			const reader = proc.stdout.getReader();
			let observed = 0;
			while (observed < 64 * 1024) {
				const { done, value } = await reader.read();
				if (done) break;
				observed += value?.byteLength ?? 0;
			}
			await reader.cancel();
			reader.releaseLock();
			let fullCollectorRejected = false;
			try { await proc.stdout.text(); } catch { fullCollectorRejected = true; }
			try { proc.kill('SIGKILL'); } catch {}
			await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 1000))]);
			console.log(JSON.stringify({ observed, fullCollectorRejected }));
		`;
		const result = nodeSpawnSync(
			'node',
			['--experimental-strip-types', '--input-type=module', '-e', script],
			{
				cwd: process.cwd(),
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
			},
		);
		expect(result.status).toBe(0);
		const receipt = JSON.parse(result.stdout.trim()) as {
			observed: number;
			fullCollectorRejected: boolean;
		};
		expect(receipt.observed).toBeGreaterThan(0);
		expect(receipt.observed).toBeLessThan(1024 * 1024);
		expect(receipt.fullCollectorRejected).toBe(true);
	});
});
