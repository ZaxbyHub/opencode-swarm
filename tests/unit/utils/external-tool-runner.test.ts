import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import {
	_internals,
	resolveExecutableFromPath,
	runExternalTool,
} from '../../../src/utils/external-tool-runner';

const realBunSpawn = _internals.bunSpawn;

function streamFromText(text: string): BunCompatSubprocess['stdout'] {
	const bytes = new TextEncoder().encode(text);
	return {
		async text() {
			return text;
		},
		async bytes() {
			return bytes;
		},
		getReader() {
			let done = false;
			return new ReadableStream<Uint8Array>({
				pull(controller) {
					if (done) {
						controller.close();
						return;
					}
					done = true;
					controller.enqueue(bytes);
				},
			}).getReader();
		},
	};
}

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
});

describe('external-tool-runner', () => {
	test('rejects non-absolute cwd before spawning', async () => {
		let spawned = false;
		_internals.bunSpawn = (() => {
			spawned = true;
			throw new Error('should not spawn');
		}) as typeof realBunSpawn;

		const result = await runExternalTool({
			executable: 'tool',
			args: [],
			cwd: 'relative',
			timeoutMs: 10,
			maxStdoutBytes: 10,
			maxStderrBytes: 10,
		});

		expect(result.status).toBe('spawn-error');
		expect(result.message).toContain('cwd must be absolute');
		expect(spawned).toBe(false);
	});

	test('passes bounded subprocess options and kills in cleanup', async () => {
		const calls: Array<{ cmd: string[]; options: unknown }> = [];
		let killCount = 0;
		_internals.bunSpawn = ((cmd, options) => {
			calls.push({ cmd, options });
			return {
				stdout: streamFromText('ok'),
				stderr: streamFromText(''),
				exited: Promise.resolve(0),
				exitCode: 0,
				kill: () => {
					killCount++;
				},
			};
		}) as typeof realBunSpawn;

		const cwd = realpathSync(os.tmpdir());
		const result = await runExternalTool({
			executable: 'tool',
			args: ['--flag'],
			cwd,
			timeoutMs: 1000,
			maxStdoutBytes: 100,
			maxStderrBytes: 100,
		});

		expect(result.status).toBe('completed');
		expect(result.stdout).toBe('ok');
		expect(calls[0].cmd).toEqual(['tool', '--flag']);
		expect(calls[0].options).toMatchObject({
			cwd,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 1000,
		});
		expect(killCount).toBe(1);
	});

	test('returns timeout and kills a never-exiting process', async () => {
		let killCount = 0;
		_internals.bunSpawn = (() => ({
			stdout: streamFromText(''),
			stderr: streamFromText(''),
			exited: new Promise<number>(() => {}),
			exitCode: null,
			kill: () => {
				killCount++;
			},
		})) as typeof realBunSpawn;

		const result = await runExternalTool({
			executable: 'slow-tool',
			args: [],
			cwd: realpathSync(os.tmpdir()),
			timeoutMs: 5,
			maxStdoutBytes: 100,
			maxStderrBytes: 100,
		});

		expect(result.status).toBe('timeout');
		expect(killCount).toBeGreaterThanOrEqual(1);
	});

	test('resolves platform executable names from PATH lazily', () => {
		const tmpDir = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), 'external-runner-')),
		);
		try {
			const rgExe = path.join(tmpDir, 'rg.exe');
			writeFileSync(rgExe, '');
			expect(resolveExecutableFromPath(['rg'], tmpDir, 'win32')).toBe(rgExe);

			const sg = path.join(tmpDir, 'sg');
			writeFileSync(sg, '');
			expect(resolveExecutableFromPath(['sg'], tmpDir, 'linux')).toBe(sg);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
