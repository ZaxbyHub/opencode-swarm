import { afterEach, describe, expect, test } from 'bun:test';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import {
	_internals,
	runExternalTool,
} from '../../../src/utils/external-tool-runner';

const originalBunSpawn = _internals.bunSpawn;

function emptyStream(): BunCompatSubprocess['stdout'] {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		},
	});
	return {
		getReader: () => stream.getReader(),
		text: async () => '',
		bytes: async () => new Uint8Array(),
	};
}

function cancellableOpenStream(): BunCompatSubprocess['stdout'] {
	return {
		getReader: () => {
			let finish!: () => void;
			const read = new Promise<ReadableStreamReadResult<Uint8Array>>(
				(resolve) => {
					finish = () => resolve({ done: true, value: undefined });
				},
			);
			return {
				read: () => read,
				cancel: async () => finish(),
				releaseLock: () => undefined,
			} as unknown as ReturnType<BunCompatSubprocess['stdout']['getReader']>;
		},
		text: async () => '',
		bytes: async () => new Uint8Array(),
	};
}

afterEach(() => {
	_internals.bunSpawn = originalBunSpawn;
});

describe('external tool signal termination', () => {
	test('returns a typed abnormal outcome for a naturally signaled child', async () => {
		_internals.bunSpawn = (() => ({
			stdout: emptyStream(),
			stderr: emptyStream(),
			exited: Promise.resolve(-1),
			exitCode: null,
			signalCode: 'SIGKILL',
			kill: () => undefined,
		})) as typeof _internals.bunSpawn;

		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 1_000,
			maxStdoutBytes: 1_024,
			maxStderrBytes: 1_024,
		});

		expect(result).toMatchObject({
			status: 'spawn-error',
			exitCode: -1,
			message: 'external tool terminated by signal SIGKILL',
		});
	});

	test('F-006 waits for asynchronous tree cleanup before reporting timeout', async () => {
		let resolveExit!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		const signals: Array<NodeJS.Signals | number | undefined> = [];
		let treeSettled = false;
		_internals.bunSpawn = (() => ({
			stdout: emptyStream(),
			stderr: emptyStream(),
			exited,
			exitCode: null,
			kill: () => undefined,
			killTree: (signal) => {
				signals.push(signal);
				if (signal !== 'SIGKILL') return Promise.resolve();
				resolveExit(137);
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						treeSettled = true;
						resolve();
					}, 25);
				});
			},
		})) as typeof _internals.bunSpawn;

		const startedAt = Date.now();
		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 1,
			maxStdoutBytes: 1_024,
			maxStderrBytes: 1_024,
		});

		// Previous code returned as soon as the parent exited, while taskkill was
		// still running and descendants could remain alive.
		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(result.status).toBe('timeout');
		expect(treeSettled).toBe(true);
		expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
	});

	test('F-006 fails safe when asynchronous tree cleanup never settles', async () => {
		let resolveExit!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		_internals.bunSpawn = (() => ({
			stdout: emptyStream(),
			stderr: emptyStream(),
			exited,
			exitCode: null,
			kill: () => undefined,
			killTree: (signal) => {
				if (signal === 'SIGKILL') resolveExit(137);
				return new Promise<void>(() => undefined);
			},
		})) as typeof _internals.bunSpawn;

		const startedAt = Date.now();
		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 1,
			maxStdoutBytes: 1_024,
			maxStderrBytes: 1_024,
		});

		expect(Date.now() - startedAt).toBeLessThan(5_500);
		expect(result).toMatchObject({
			status: 'spawn-error',
			message: 'external tool process termination could not be confirmed',
		});
	}, 6_000);

	test('F-006 accepts confirmed graceful cleanup when force reports already gone', async () => {
		let resolveExit!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		_internals.bunSpawn = (() => ({
			stdout: emptyStream(),
			stderr: emptyStream(),
			exited,
			exitCode: null,
			kill: () => undefined,
			killTree: async (signal) => {
				if (signal === 'SIGTERM') return;
				resolveExit(137);
				throw new Error('tree cleanup failed');
			},
		})) as typeof _internals.bunSpawn;

		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 1,
			maxStdoutBytes: 1_024,
			maxStderrBytes: 1_024,
		});

		expect(result.status).toBe('timeout');
	});

	test('F-006 waits for both asynchronous tree-cleanup attempts to settle', async () => {
		let resolveExit!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		let gracefulSettled = false;
		_internals.bunSpawn = (() => ({
			stdout: emptyStream(),
			stderr: emptyStream(),
			exited,
			exitCode: null,
			kill: () => undefined,
			killTree: (signal) => {
				if (signal === 'SIGKILL') {
					resolveExit(137);
					return Promise.resolve();
				}
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						gracefulSettled = true;
						resolve();
					}, 50);
				});
			},
		})) as typeof _internals.bunSpawn;

		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 1,
			maxStdoutBytes: 1_024,
			maxStderrBytes: 1_024,
		});

		expect(gracefulSettled).toBe(true);
		expect(result.status).toBe('timeout');
	});

	test('F-007 forces the process group after a parent exits during grace', async () => {
		let resolveExit!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		const signals: Array<NodeJS.Signals | number | undefined> = [];
		_internals.bunSpawn = (() => ({
			stdout: emptyStream(),
			stderr: emptyStream(),
			exited,
			exitCode: null,
			kill: () => undefined,
			killTree: async (signal) => {
				signals.push(signal);
				if (signal === 'SIGTERM') resolveExit(143);
			},
		})) as typeof _internals.bunSpawn;

		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 1,
			maxStdoutBytes: 1_024,
			maxStderrBytes: 1_024,
		});

		// Previous code treated parent exit as proof that descendants were gone.
		expect(result.status).toBe('timeout');
		expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
	});

	test('F-007 waits for inherited-pipe tree cleanup after parent exit', async () => {
		let treeSettled = false;
		_internals.bunSpawn = (() => ({
			stdout: cancellableOpenStream(),
			stderr: cancellableOpenStream(),
			exited: Promise.resolve(0),
			exitCode: 0,
			kill: () => undefined,
			killTree: () =>
				new Promise<void>((resolve) => {
					setTimeout(() => {
						treeSettled = true;
						resolve();
					}, 100);
				}),
		})) as typeof _internals.bunSpawn;

		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 10_000,
			maxStdoutBytes: 1_024,
			maxStderrBytes: 1_024,
		});

		expect(treeSettled).toBe(true);
		expect(result.status).toBe('completed');
	});

	test('F-007 fails safe when inherited-pipe tree cleanup never settles', async () => {
		_internals.bunSpawn = (() => ({
			stdout: cancellableOpenStream(),
			stderr: cancellableOpenStream(),
			exited: Promise.resolve(0),
			exitCode: 0,
			kill: () => undefined,
			killTree: () => new Promise<void>(() => undefined),
		})) as typeof _internals.bunSpawn;

		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 10_000,
			maxStdoutBytes: 1_024,
			maxStderrBytes: 1_024,
		});

		expect(result).toMatchObject({
			status: 'spawn-error',
			message: 'external tool process termination could not be confirmed',
		});
	}, 6_000);

	test('F-007 terminates immediately when a bounded stream overflows', async () => {
		let resolveExit!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		let observedSignal: NodeJS.Signals | null = null;
		const overflowing = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('too much output'));
			},
		});
		_internals.bunSpawn = (() => ({
			stdout: {
				getReader: () => overflowing.getReader(),
				text: async () => '',
				bytes: async () => new Uint8Array(),
			},
			stderr: emptyStream(),
			exited,
			exitCode: null,
			get signalCode() {
				return observedSignal;
			},
			kill: () => undefined,
			killTree: async (signal) => {
				observedSignal = signal as NodeJS.Signals;
				resolveExit(137);
			},
		})) as typeof _internals.bunSpawn;

		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 10_000,
			maxStdoutBytes: 4,
			maxStderrBytes: 1_024,
		});

		// Previous code cancelled the reader but waited for the tool timeout.
		expect(observedSignal).toBe('SIGKILL');
		expect(result.status).toBe('spawn-error');
		expect(result.stdoutTruncated).toBe(true);
	});

	test('F-007 waits for overflow tree cleanup before returning', async () => {
		let treeSettled = false;
		const overflowing = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('too much output'));
			},
		});
		_internals.bunSpawn = (() => ({
			stdout: {
				getReader: () => overflowing.getReader(),
				text: async () => '',
				bytes: async () => new Uint8Array(),
			},
			stderr: emptyStream(),
			exited: Promise.resolve(137),
			exitCode: 137,
			kill: () => undefined,
			killTree: () =>
				new Promise<void>((resolve) => {
					setTimeout(() => {
						treeSettled = true;
						resolve();
					}, 100);
				}),
		})) as typeof _internals.bunSpawn;

		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 10_000,
			maxStdoutBytes: 4,
			maxStderrBytes: 1_024,
		});

		expect(treeSettled).toBe(true);
		expect(result.stdoutTruncated).toBe(true);
	});

	test('F-007 fails safe when overflow tree cleanup never settles', async () => {
		const overflowing = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('too much output'));
			},
		});
		_internals.bunSpawn = (() => ({
			stdout: {
				getReader: () => overflowing.getReader(),
				text: async () => '',
				bytes: async () => new Uint8Array(),
			},
			stderr: emptyStream(),
			exited: Promise.resolve(137),
			exitCode: 137,
			kill: () => undefined,
			killTree: () => new Promise<void>(() => undefined),
		})) as typeof _internals.bunSpawn;

		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 10_000,
			maxStdoutBytes: 4,
			maxStderrBytes: 1_024,
		});

		expect(result).toMatchObject({
			status: 'spawn-error',
			message: 'external tool process termination could not be confirmed',
		});
	}, 6_000);

	test('F-007 reuses timeout tree cleanup when output overflows later', async () => {
		let resolveExit!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		let forceCalls = 0;
		let forceSettled = false;
		const delayedOverflow = new ReadableStream<Uint8Array>({
			start(controller) {
				setTimeout(() => {
					controller.enqueue(new TextEncoder().encode('too much output'));
				}, 60);
			},
		});
		_internals.bunSpawn = (() => ({
			stdout: {
				getReader: () => delayedOverflow.getReader(),
				text: async () => '',
				bytes: async () => new Uint8Array(),
			},
			stderr: emptyStream(),
			exited,
			exitCode: null,
			kill: () => undefined,
			killTree: (signal) => {
				if (signal === 'SIGTERM') return Promise.resolve();
				forceCalls += 1;
				resolveExit(137);
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						forceSettled = true;
						resolve();
					}, 200);
				});
			},
		})) as typeof _internals.bunSpawn;

		const result = await runExternalTool({
			executable: 'fake-tool',
			args: [],
			cwd: process.cwd(),
			timeoutMs: 1,
			maxStdoutBytes: 4,
			maxStderrBytes: 1_024,
		});

		// Previous code did not memoize the timeout's forced tree kill, so the
		// later overflow launched a third unjoined cleanup attempt.
		expect(result.status).toBe('timeout');
		expect(forceCalls).toBe(1);
		expect(forceSettled).toBe(true);
	});
});
