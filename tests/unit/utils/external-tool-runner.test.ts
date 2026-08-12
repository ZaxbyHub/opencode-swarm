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
const realPlatform = _internals.platform;
const realNow = _internals.now;
const realSetTimeout = _internals.setTimeout;
const realClearTimeout = _internals.clearTimeout;

function streamFromText(text: string): BunCompatSubprocess['stdout'] {
	return streamFromChunks([text]);
}

function streamFromChunks(chunks: string[]): BunCompatSubprocess['stdout'] {
	const encodedChunks = chunks.map((chunk) => new TextEncoder().encode(chunk));
	const text = chunks.join('');
	const bytes = new TextEncoder().encode(text);
	return {
		async text() {
			return text;
		},
		async bytes() {
			return bytes;
		},
		getReader() {
			let index = 0;
			return new ReadableStream<Uint8Array>({
				pull(controller) {
					const chunk = encodedChunks[index];
					if (!chunk) {
						controller.close();
						return;
					}
					index += 1;
					controller.enqueue(chunk);
				},
			}).getReader();
		},
	};
}

function neverSettlingStream(): BunCompatSubprocess['stdout'] {
	const pending = new Promise<never>(() => {});
	return {
		async text() {
			return pending;
		},
		async bytes() {
			return pending;
		},
		getReader() {
			return {
				read: () => pending,
				cancel: () => pending,
				releaseLock: () => {},
			} as unknown as ReturnType<BunCompatSubprocess['stdout']['getReader']>;
		},
	};
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPendingProcess(
	onKill?: (
		signal: NodeJS.Signals | number | undefined,
		resolveExit: (code: number) => void,
	) => void,
): {
	proc: BunCompatSubprocess;
	signals: Array<NodeJS.Signals | number | undefined>;
	resolveExit: (code: number) => void;
} {
	let resolveExit!: (code: number) => void;
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const signals: Array<NodeJS.Signals | number | undefined> = [];
	return {
		proc: {
			stdout: streamFromText(''),
			stderr: streamFromText(''),
			exited,
			exitCode: null,
			kill: (signal?: NodeJS.Signals | number) => {
				signals.push(signal);
				onKill?.(signal, resolveExit);
			},
		},
		signals,
		resolveExit,
	};
}

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	_internals.platform = realPlatform;
	_internals.now = realNow;
	_internals.setTimeout = realSetTimeout;
	_internals.clearTimeout = realClearTimeout;
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

	test('passes bounded subprocess options without killing after clean exit', async () => {
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
			timeout: _internals.computeSpawnTimeoutMs(1000),
			killProcessTree: true,
		});
		expect(killCount).toBe(0);
	});

	test('best-effort kills an active child when runner setup throws', async () => {
		let killCount = 0;
		const brokenStream = {
			getReader() {
				throw new Error('stream setup failed');
			},
		} as unknown as BunCompatSubprocess['stdout'];
		_internals.bunSpawn = (() => ({
			stdout: brokenStream,
			stderr: streamFromText(''),
			exited: new Promise<number>(() => {}),
			exitCode: null,
			kill: () => {
				killCount++;
			},
		})) as typeof realBunSpawn;

		const result = await runExternalTool({
			executable: 'broken-tool',
			args: [],
			cwd: realpathSync(os.tmpdir()),
			timeoutMs: 100,
			maxStdoutBytes: 100,
			maxStderrBytes: 100,
		});

		expect(result.status).toBe('spawn-error');
		expect(result.message).toContain('stream setup failed');
		expect(killCount).toBe(1);
	});

	test('waits for exit confirmation before returning timeout', async () => {
		const pendingProc = createPendingProcess();
		let resolved = false;
		_internals.bunSpawn = (() => pendingProc.proc) as typeof realBunSpawn;

		const pending = runExternalTool({
			executable: 'slow-tool',
			args: [],
			cwd: realpathSync(os.tmpdir()),
			timeoutMs: 5,
			maxStdoutBytes: 100,
			maxStderrBytes: 100,
		}).then((result) => {
			resolved = true;
			return result;
		});

		await wait(45);
		expect(resolved).toBe(false);
		expect(pendingProc.signals.slice(0, 2)).toEqual(['SIGTERM', 'SIGKILL']);

		pendingProc.resolveExit(143);
		const result = await pending;

		expect(result.status).toBe('timeout');
		expect(result.exitCode).toBe(143);
	});

	test('starts timeout escalation with SIGTERM on Windows', async () => {
		const pendingProc = createPendingProcess();
		_internals.platform = () => 'win32';
		_internals.bunSpawn = (() => pendingProc.proc) as typeof realBunSpawn;

		const pending = runExternalTool({
			executable: 'slow-tool',
			args: [],
			cwd: realpathSync(os.tmpdir()),
			timeoutMs: 5,
			maxStdoutBytes: 100,
			maxStderrBytes: 100,
		});

		await wait(15);
		expect(pendingProc.signals[0]).toBe('SIGTERM');
		pendingProc.resolveExit(143);
		const result = await pending;

		expect(result.status).toBe('timeout');
		expect(pendingProc.signals).toContain('SIGTERM');
	});

	test('waits for exit confirmation before returning cancellation', async () => {
		const controller = new AbortController();
		const pendingProc = createPendingProcess();
		let resolved = false;
		_internals.bunSpawn = (() => pendingProc.proc) as typeof realBunSpawn;
		const pending = runExternalTool({
			executable: 'slow-tool',
			args: [],
			cwd: realpathSync(os.tmpdir()),
			timeoutMs: 10_000,
			maxStdoutBytes: 100,
			maxStderrBytes: 100,
			abortSignal: controller.signal,
		}).then((result) => {
			resolved = true;
			return result;
		});
		controller.abort();

		await wait(10);
		expect(resolved).toBe(false);
		expect(pendingProc.signals[0]).toBe('SIGTERM');

		pendingProc.resolveExit(130);
		const result = await pending;

		expect(result.status).toBe('cancelled');
		expect(result.exitCode).toBe(130);
	});

	test('closes the abort race when cancellation happens during spawn', async () => {
		const controller = new AbortController();
		const pendingProc = createPendingProcess((signal, resolveExit) => {
			if (signal === 'SIGTERM') {
				resolveExit(130);
			}
		});
		_internals.bunSpawn = (() => {
			controller.abort();
			return pendingProc.proc;
		}) as typeof realBunSpawn;

		const result = await runExternalTool({
			executable: 'race-tool',
			args: [],
			cwd: realpathSync(os.tmpdir()),
			timeoutMs: 25,
			maxStdoutBytes: 100,
			maxStderrBytes: 100,
			abortSignal: controller.signal,
		});

		expect(result.status).toBe('cancelled');
		expect(pendingProc.signals[0]).toBe('SIGTERM');
	});

	test('truncates stdout across multiple chunks', async () => {
		_internals.bunSpawn = (() => ({
			stdout: streamFromChunks(['abc', 'defgh']),
			stderr: streamFromText(''),
			exited: Promise.resolve(0),
			exitCode: 0,
			kill: () => {},
		})) as typeof realBunSpawn;

		const result = await runExternalTool({
			executable: 'chunky-tool',
			args: [],
			cwd: realpathSync(os.tmpdir()),
			timeoutMs: 1000,
			maxStdoutBytes: 6,
			maxStderrBytes: 100,
		});

		expect(result.status).toBe('completed');
		expect(result.stdout).toBe('abcdef');
		expect(result.stdoutTruncated).toBe(true);
	});

	test('returns spawn-error when timeout escalation cannot confirm exit', async () => {
		const pendingProc = createPendingProcess();
		let spawnTimeout: number | undefined;
		_internals.bunSpawn = ((cmd, options) => {
			void cmd;
			spawnTimeout = (options as { timeout?: number }).timeout;
			return pendingProc.proc;
		}) as typeof realBunSpawn;

		const startedAt = _internals.now();
		const result = await runExternalTool({
			executable: 'hung-tool',
			args: [],
			cwd: realpathSync(os.tmpdir()),
			timeoutMs: 5,
			maxStdoutBytes: 100,
			maxStderrBytes: 100,
		});
		const elapsedMs = _internals.now() - startedAt;

		expect(spawnTimeout).toBe(_internals.computeSpawnTimeoutMs(5));
		expect(elapsedMs).toBeGreaterThanOrEqual(55);
		expect(result.status).toBe('spawn-error');
		expect(result.message).toContain('termination could not be confirmed');
		expect(pendingProc.signals.slice(0, 2)).toEqual(['SIGTERM', 'SIGKILL']);
	});

	test('keeps cancellation bounded when termination cannot be confirmed', async () => {
		const controller = new AbortController();
		const pendingProc = createPendingProcess();
		_internals.bunSpawn = (() => pendingProc.proc) as typeof realBunSpawn;

		const startedAt = _internals.now();
		const pending = runExternalTool({
			executable: 'hung-tool',
			args: [],
			cwd: realpathSync(os.tmpdir()),
			timeoutMs: 5,
			maxStdoutBytes: 100,
			maxStderrBytes: 100,
			abortSignal: controller.signal,
		});
		controller.abort();

		const result = await pending;
		const elapsedMs = _internals.now() - startedAt;

		expect(elapsedMs).toBeGreaterThanOrEqual(55);
		expect(result.status).toBe('spawn-error');
		expect(result.message).toContain('termination could not be confirmed');
		expect(pendingProc.signals.slice(0, 2)).toEqual(['SIGTERM', 'SIGKILL']);
	});

	test('keeps the fallback spawn timeout strictly after runner escalation at overflow', async () => {
		let timeout: number | undefined;
		_internals.bunSpawn = ((cmd, options) => {
			void cmd;
			timeout = (options as { timeout?: number }).timeout;
			return {
				stdout: streamFromText('ok'),
				stderr: streamFromText(''),
				exited: Promise.resolve(0),
				exitCode: 0,
				kill: () => {},
			};
		}) as typeof realBunSpawn;

		await runExternalTool({
			executable: 'tool',
			args: [],
			cwd: realpathSync(os.tmpdir()),
			timeoutMs: Number.MAX_SAFE_INTEGER,
			maxStdoutBytes: 100,
			maxStderrBytes: 100,
		});

		expect(timeout).toBe(2_147_483_647);
		expect(timeout).toBeGreaterThan(
			_internals.clampTimeoutMs(Number.MAX_SAFE_INTEGER),
		);
	});

	test('clears the runner timeout after a clean exit', async () => {
		let killCount = 0;
		_internals.bunSpawn = (() => ({
			stdout: streamFromText('ok'),
			stderr: streamFromText(''),
			exited: Promise.resolve(0),
			exitCode: 0,
			kill: () => {
				killCount++;
			},
		})) as typeof realBunSpawn;

		const result = await runExternalTool({
			executable: 'fast-tool',
			args: [],
			cwd: realpathSync(os.tmpdir()),
			timeoutMs: 5,
			maxStdoutBytes: 100,
			maxStderrBytes: 100,
		});
		await wait(40);

		expect(result.status).toBe('completed');
		expect(killCount).toBe(0);
	});

	test('fails safely when an exited parent leaves descendant output pipes open', async () => {
		let killCount = 0;
		_internals.bunSpawn = (() => ({
			stdout: neverSettlingStream(),
			stderr: neverSettlingStream(),
			exited: Promise.resolve(0),
			exitCode: 0,
			kill: () => {
				killCount++;
			},
		})) as typeof realBunSpawn;

		const startedAt = _internals.now();
		const result = await runExternalTool({
			executable: 'pipe-inheriting-tool',
			args: [],
			cwd: realpathSync(os.tmpdir()),
			timeoutMs: 10_000,
			maxStdoutBytes: 100,
			maxStderrBytes: 100,
		});

		expect(_internals.now() - startedAt).toBeLessThan(1_000);
		expect(result.status).toBe('spawn-error');
		expect(result.message).toContain('output cleanup did not complete');
		expect(result.stdoutTruncated).toBe(true);
		expect(result.stderrTruncated).toBe(true);
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
