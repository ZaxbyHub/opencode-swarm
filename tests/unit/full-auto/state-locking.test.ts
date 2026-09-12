import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	disarmFullAutoRun,
	FullAutoStateLockError,
	incrementFullAutoCounter,
	loadFullAutoRunState,
	markFullAutoStateLockFailure,
	startFullAutoRun,
} from '../../../src/full-auto/state';
import {
	type BunCompatSubprocess,
	bunSpawn,
} from '../../../src/utils/bun-compat';
import { withTimeout } from '../../../src/utils/timeout';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const workerPath = path.resolve(
	process.cwd(),
	'tests/fixtures/full-auto-state-lock-worker.ts',
);
let tempDir: string;
const originalLockfile = _internals.lockfile;
const originalReadPersisted = _internals.readPersisted;

function waitForFile(filePath: string, timeoutMs = 5_000): void {
	const deadline = performance.now() + timeoutMs;
	while (!fs.existsSync(filePath)) {
		if (performance.now() >= deadline) {
			throw new Error(`Timed out waiting for ${filePath}`);
		}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
}

function readJson(filePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
		string,
		unknown
	>;
}

function startWorker(
	role: 'a' | 'b',
	mode: 'fixed' | 'bypass' = 'fixed',
): BunCompatSubprocess {
	return bunSpawn([process.execPath, workerPath, tempDir, role, mode], {
		cwd: process.cwd(),
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
		timeout: 10_000,
		killProcessTree: true,
	});
}

async function finishWorkers(
	workers: BunCompatSubprocess[],
): Promise<number[]> {
	try {
		return await withTimeout(
			Promise.all(workers.map((worker) => worker.exited)),
			5_000,
			new Error('Timed out waiting for Full-Auto lock workers'),
		);
	} finally {
		for (const worker of workers) {
			try {
				worker.kill();
			} catch {
				// The worker already exited.
			}
		}
	}
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('full-auto-lock-');
	_internals.lockfile = originalLockfile;
	_internals.readPersisted = originalReadPersisted;
});

afterEach(() => {
	_internals.lockfile = originalLockfile;
	_internals.readPersisted = originalReadPersisted;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup after a bounded worker timeout.
	}
});

describe('Full-Auto state lock acquisition', () => {
	test('creates and updates first-run state while holding a supported lock', () => {
		const state = startFullAutoRun(tempDir, 'shared-session', {
			enabled: true,
		});
		incrementFullAutoCounter(tempDir, 'shared-session', 'toolCalls');
		expect(state.status).toBe('running');
		expect(
			loadFullAutoRunState(tempDir, 'shared-session')?.counters.toolCalls,
		).toBe(1);
		expect(
			fs.existsSync(path.join(tempDir, '.swarm', 'full-auto-state.json.lock')),
		).toBe(false);
	});

	test('reads an external same-size, same-mtime update fresh under the lock', () => {
		startFullAutoRun(tempDir, 'shared-session', { enabled: true });
		const statePath = path.join(tempDir, '.swarm', 'full-auto-state.json');
		const initial = fs.statSync(statePath);
		fs.utimesSync(
			statePath,
			initial.atime,
			new Date(Math.floor(initial.mtimeMs)),
		);
		expect(
			loadFullAutoRunState(tempDir, 'shared-session')?.counters.toolCalls,
		).toBe(0);
		const before = fs.statSync(statePath);
		const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
			sessions: Record<string, { counters: { toolCalls: number } }>;
		};
		persisted.sessions['shared-session'].counters.toolCalls = 9;
		const replacement = `${JSON.stringify(persisted, null, 2)}\n`;
		expect(replacement.length).toBe(fs.readFileSync(statePath, 'utf8').length);
		fs.writeFileSync(statePath, replacement, 'utf8');
		fs.utimesSync(statePath, before.atime, before.mtime);
		const after = fs.statSync(statePath);
		expect(after.size).toBe(before.size);
		expect(after.mtimeMs).toBe(before.mtimeMs);

		const updated = incrementFullAutoCounter(
			tempDir,
			'shared-session',
			'toolCalls',
		);
		expect(updated?.counters.toolCalls).toBe(10);
	});

	test('returns bounded typed contention when a live lock is held', () => {
		startFullAutoRun(tempDir, 'shared-session', { enabled: true });
		const statePath = path.join(tempDir, '.swarm', 'full-auto-state.json');
		const lockPath = `${statePath}.lock`;
		fs.mkdirSync(lockPath);
		const startedAt = performance.now();
		try {
			try {
				incrementFullAutoCounter(tempDir, 'shared-session', 'toolCalls');
				throw new Error('expected lock contention');
			} catch (error) {
				expect(error).toBeInstanceOf(FullAutoStateLockError);
				expect((error as FullAutoStateLockError).category).toBe('contention');
				expect((error as FullAutoStateLockError).code).toBe(
					'FULL_AUTO_STATE_LOCK_CONTENTION',
				);
				expect((error as Error).message).toContain('lock contention');
				expect((error as FullAutoStateLockError).cause).toMatchObject({
					code: 'ELOCKED',
				});
			}
		} finally {
			fs.rmSync(lockPath, { recursive: true, force: true });
		}
		const elapsed = performance.now() - startedAt;
		expect(elapsed).toBeLessThan(2_000);
		expect(
			loadFullAutoRunState(tempDir, 'shared-session')?.counters.toolCalls,
		).toBe(0);
	});

	test('clears an in-process lock-failure pause only after an authoritative status mutation', () => {
		startFullAutoRun(tempDir, 'shared-session', { enabled: true });
		markFullAutoStateLockFailure(tempDir, 'shared-session');
		expect(loadFullAutoRunState(tempDir, 'shared-session')?.status).toBe(
			'paused',
		);
		incrementFullAutoCounter(tempDir, 'shared-session', 'toolCalls');
		expect(loadFullAutoRunState(tempDir, 'shared-session')?.status).toBe(
			'paused',
		);
		disarmFullAutoRun(tempDir, 'shared-session', 'user disabled');
		expect(loadFullAutoRunState(tempDir, 'shared-session')?.status).toBe(
			'idle',
		);
	});

	test('classifies lock option rejection as configuration without invoking the callback', () => {
		let readCalls = 0;
		_internals.readPersisted = (directory) => {
			readCalls += 1;
			return originalReadPersisted(directory);
		};
		_internals.lockfile = {
			lockSync: () => {
				throw Object.assign(new Error('Cannot use retries with the sync api'), {
					code: 'ESYNC',
				});
			},
		};
		try {
			incrementFullAutoCounter(tempDir, 'shared-session', 'toolCalls');
			throw new Error('expected configuration failure');
		} catch (error) {
			expect(error).toBeInstanceOf(FullAutoStateLockError);
			expect((error as FullAutoStateLockError).category).toBe('configuration');
			expect((error as FullAutoStateLockError).code).toBe(
				'FULL_AUTO_STATE_LOCK_CONFIGURATION',
			);
			expect((error as FullAutoStateLockError).cause).toMatchObject({
				code: 'ESYNC',
			});
		}
		expect(readCalls).toBe(0);
	});

	test('classifies non-contention acquisition failure as storage', () => {
		_internals.lockfile = {
			lockSync: () => {
				throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
			},
		};
		try {
			incrementFullAutoCounter(tempDir, 'shared-session', 'toolCalls');
			throw new Error('expected lock acquisition to fail');
		} catch (error) {
			expect(error).toBeInstanceOf(FullAutoStateLockError);
			expect((error as FullAutoStateLockError).category).toBe('storage');
			expect((error as FullAutoStateLockError).cause).toMatchObject({
				code: 'EACCES',
			});
		}
	});

	test('surfaces release failure as typed storage after a successful callback', () => {
		startFullAutoRun(tempDir, 'shared-session', { enabled: true });
		_internals.lockfile = {
			lockSync: () => () => {
				throw Object.assign(new Error('release failed'), { code: 'EIO' });
			},
		};
		try {
			incrementFullAutoCounter(tempDir, 'shared-session', 'toolCalls');
			throw new Error('expected release failure');
		} catch (error) {
			expect(error).toBeInstanceOf(FullAutoStateLockError);
			expect((error as FullAutoStateLockError).category).toBe('storage');
			expect((error as FullAutoStateLockError).cause).toMatchObject({
				code: 'EIO',
			});
		}
	});

	test('preserves callback failure when release also fails', () => {
		startFullAutoRun(tempDir, 'shared-session', { enabled: true });
		const callbackError = new Error('callback read failed');
		let callbackEntered = false;
		_internals.readPersisted = () => {
			callbackEntered = true;
			throw callbackError;
		};
		_internals.lockfile = {
			lockSync: () => () => {
				throw Object.assign(new Error('release failed'), { code: 'EIO' });
			},
		};
		try {
			incrementFullAutoCounter(tempDir, 'shared-session', 'toolCalls');
			throw new Error('expected callback failure');
		} catch (error) {
			expect(error).toBe(callbackError);
		}
		expect(callbackEntered).toBe(true);
	});
});

describe('Full-Auto state cross-process RMW', () => {
	test('retains both updates from independent workers after serialized reads', async () => {
		startFullAutoRun(tempDir, 'shared-session', { enabled: true });
		const workers = [startWorker('a')];
		try {
			waitForFile(path.join(tempDir, 'a.read'));
			workers.push(startWorker('b'));
			waitForFile(path.join(tempDir, 'b.ready'));
			expect(fs.existsSync(path.join(tempDir, 'b.read'))).toBe(false);
			fs.writeFileSync(path.join(tempDir, 'release-a'), 'release', 'utf8');
			const exits = await finishWorkers(workers);
			expect(exits).toEqual([0, 0]);
			expect(readJson(path.join(tempDir, 'a.read')).intercepted).toBe(true);
			expect(readJson(path.join(tempDir, 'b.read')).intercepted).toBe(true);
			expect(readJson(path.join(tempDir, 'a.read')).lockPresent).toBe(true);
			expect(readJson(path.join(tempDir, 'b.read')).lockPresent).toBe(true);
			expect(
				loadFullAutoRunState(tempDir, 'shared-session')?.counters.toolCalls,
			).toBe(2);
			expect(
				fs.existsSync(
					path.join(tempDir, '.swarm', 'full-auto-state.json.lock'),
				),
			).toBe(false);
		} finally {
			for (const worker of workers) {
				try {
					worker.kill();
				} catch {
					// Already exited.
				}
			}
		}
	});

	test('bypass probe observes both callbacks reading one snapshot', async () => {
		startFullAutoRun(tempDir, 'shared-session', { enabled: true });
		const workers = [startWorker('a', 'bypass'), startWorker('b', 'bypass')];
		try {
			waitForFile(path.join(tempDir, 'a.read'));
			waitForFile(path.join(tempDir, 'b.read'));
			fs.writeFileSync(path.join(tempDir, 'release-bypass'), 'release', 'utf8');
			waitForFile(path.join(tempDir, 'a.done'));
			fs.writeFileSync(
				path.join(tempDir, 'allow-bypass-write'),
				'allow',
				'utf8',
			);
			const exits = await finishWorkers(workers);
			expect(exits).toEqual([0, 0]);
			expect(
				loadFullAutoRunState(tempDir, 'shared-session')?.counters.toolCalls,
			).toBe(1);
		} finally {
			for (const worker of workers) {
				try {
					worker.kill();
				} catch {
					// Already exited.
				}
			}
		}
	});
});
