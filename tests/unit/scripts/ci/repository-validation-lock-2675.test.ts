import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
	_internals,
	TERMINAL_STATUSES,
	type ValidationReport,
	writeValidationReport,
} from '../../../../scripts/ci/repository-validation';
import { withFrozenClock } from '../../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const FIXED_ISO_NOW = '2026-01-01T00:00:00.000Z';

function isoNow(): string {
	return withFrozenClock(() => new Date().toISOString(), {
		fixedNow: 1_767_225_600_000,
		isoNow: FIXED_ISO_NOW,
	});
}

function report(root: string, durationMs = 0): ValidationReport {
	return {
		schemaVersion: 1,
		status: 'passed',
		mode: 'full',
		root,
		diffBase: 'origin/main',
		runtime: {
			bunVersion: 'test',
			platform: process.platform,
			arch: process.arch,
		},
		inventory: ['unit'],
		bounds: {
			testTimeoutMs: 120,
			perItemTimeoutMs: 180,
			suiteTimeoutMs: 900,
			maxOutputBytes: 64,
		},
		terminalStatuses: [...TERMINAL_STATUSES],
		summary: {
			discovered: 0,
			started: 0,
			completed: 0,
			passed: 0,
			failed: 0,
			crashed: 0,
			timedOut: 0,
			missing: 0,
			skipped: 0,
		},
		results: [],
		startedAt: isoNow(),
		endedAt: isoNow(),
		durationMs,
	};
}

async function withTempRoot(
	run: (root: string, destination: string) => Promise<void>,
): Promise<void> {
	const root = canonicalMkdtemp('repository-validation-2675-');
	const destination = path.join(root, '.swarm', 'repository-validation.json');
	try {
		await run(root, destination);
	} finally {
		await fsp.rm(root, { recursive: true, force: true });
	}
}

describe('repository validation report lock — issue #2675', () => {
	test.skipIf(process.platform === 'win32')(
		'rejects a .swarm symlink before writing outside the root (F2; Windows junction creation requires elevated setup)',
		async () => {
			// Before this guard, lexical containment allowed mkdir/rename to follow a
			// .swarm symlink and place the report outside the project root.
			const root = canonicalMkdtemp('repository-validation-root-');
			const outside = canonicalMkdtemp('repository-validation-outside-');
			const swarmPath = path.join(root, '.swarm');
			const destination = path.join(swarmPath, 'repository-validation.json');
			try {
				await fsp.symlink(outside, swarmPath, 'dir');
				await expect(
					writeValidationReport(report(root), destination),
				).rejects.toThrow(/symlink|junction/i);
				expect(await fsp.readdir(outside)).toEqual([]);
			} finally {
				await fsp.rm(root, { recursive: true, force: true });
				await fsp.rm(outside, { recursive: true, force: true });
			}
		},
	);

	test('recovers a lock whose owner process is dead', async () => {
		await withTempRoot(async (root, destination) => {
			await fsp.mkdir(path.dirname(destination), { recursive: true });
			await fsp.writeFile(
				`${destination}.lock`,
				JSON.stringify({
					pid: 2_147_483_647,
					token: 'dead-owner',
					createdAt: withFrozenClock(() => Date.now(), {
						fixedNow: 1_767_225_600_000,
					}),
				}),
			);

			await writeValidationReport(report(root), destination);
			const saved = JSON.parse(
				await fsp.readFile(destination, 'utf8'),
			) as ValidationReport & { reportPath: string };
			expect(saved.reportPath).toBe(destination);
			expect(
				await fsp.stat(`${destination}.lock`).catch(() => null),
			).toBeNull();
		});
	});

	test('bounds malformed and oversized lock inspection without stealing uncertain state', async () => {
		await withTempRoot(async (root, destination) => {
			await fsp.mkdir(path.dirname(destination), { recursive: true });
			const lockPath = `${destination}.lock`;
			await fsp.writeFile(lockPath, 'x'.repeat(4_097), 'utf8');
			const started = performance.now();
			const inspection = await _internals.readReportLockOwner(lockPath);
			expect(performance.now() - started).toBeLessThan(1_000);
			expect(inspection).toEqual({ owner: null, allowAgeFallback: false });
		});
	});

	test('deduplicates timed-out inspections for one lock path', async () => {
		await withTempRoot(async (root, destination) => {
			const lockPath = `${destination}.lock`;
			const originalLstat = _internals.reportLockLstat;
			const originalOpen = _internals.reportLockOpen;
			let openCount = 0;
			const fakeHandle = {
				stat: async () => ({ isFile: () => true, dev: 1, ino: 1 }),
				read: async () => ({ bytesRead: 0 }),
				close: async () => undefined,
			} as unknown as fsp.FileHandle;
			try {
				_internals.reportLockLstat = async () =>
					({ isFile: () => true, size: 1, dev: 1, ino: 1 }) as fs.Stats;
				_internals.reportLockOpen = async () => {
					openCount += 1;
					await new Promise<void>((resolve) => setTimeout(resolve, 300));
					return fakeHandle;
				};

				const inspections = await Promise.all(
					Array.from({ length: 16 }, () =>
						_internals.readReportLockOwner(lockPath),
					),
				);
				expect(openCount).toBe(1);
				expect(
					inspections.every(
						(value) => value.owner === null && !value.allowAgeFallback,
					),
				).toBe(true);
				// Let the shared inspection settle and remove itself from the map before
				// the test restores the injectable filesystem functions.
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
			} finally {
				_internals.reportLockLstat = originalLstat;
				_internals.reportLockOpen = originalOpen;
			}
		});
	});

	test('fails closed once the pending inspection cap is reached', async () => {
		await withTempRoot(async (root, destination) => {
			const originalLstat = _internals.reportLockLstat;
			const originalOpen = _internals.reportLockOpen;
			let openCount = 0;
			const fakeHandle = {
				stat: async () => ({ isFile: () => true, dev: 1, ino: 1 }),
				read: async () => ({ bytesRead: 0 }),
				close: async () => undefined,
			} as unknown as fsp.FileHandle;
			try {
				_internals.reportLockLstat = async () =>
					({ isFile: () => true, size: 1, dev: 1, ino: 1 }) as fs.Stats;
				_internals.reportLockOpen = async () => {
					openCount += 1;
					await new Promise<void>((resolve) => setTimeout(resolve, 300));
					return fakeHandle;
				};

				const lockPaths = Array.from({ length: 65 }, (_, index) =>
					path.join(root, '.swarm', `lock-${index}.lock`),
				);
				const inspections = await Promise.all(
					lockPaths.map((lockPath) => _internals.readReportLockOwner(lockPath)),
				);
				expect(openCount).toBe(64);
				expect(inspections[64]).toEqual({
					owner: null,
					allowAgeFallback: false,
				});
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
			} finally {
				_internals.reportLockLstat = originalLstat;
				_internals.reportLockOpen = originalOpen;
			}
		});
	});

	test('fails closed when a lock descriptor does not match the lstat result (RV-B-003)', async () => {
		await withTempRoot(async (root, destination) => {
			const lockPath = `${destination}.lock`;
			const originalPath = path.join(root, 'original-lock');
			const redirectedPath = path.join(root, 'redirected-lock');
			await fsp.mkdir(path.dirname(destination), { recursive: true });
			await fsp.writeFile(originalPath, 'original');
			await fsp.writeFile(
				redirectedPath,
				JSON.stringify({ pid: 2_147_483_647, token: 'redirected-owner' }),
			);

			const originalLstat = _internals.reportLockLstat;
			const originalOpen = _internals.reportLockOpen;
			let openFlags: string | number | undefined;
			try {
				// Simulate the lock being swapped after lstat: the old
				// lstat-then-open implementation accepted the redirected owner.
				_internals.reportLockLstat = async (candidate) =>
					candidate === lockPath
						? originalLstat(originalPath)
						: originalLstat(candidate);
				_internals.reportLockOpen = (candidate, flags) => {
					openFlags = flags;
					return originalOpen(
						candidate === lockPath ? redirectedPath : candidate,
						flags,
					);
				};

				const inspection = await _internals.readReportLockOwner(lockPath);
				expect(inspection).toEqual({ owner: null, allowAgeFallback: false });
				expect(typeof openFlags).toBe('number');
				const constants = fs.constants as typeof fs.constants & {
					O_NOFOLLOW?: number;
					O_NONBLOCK?: number;
				};
				if (constants.O_NOFOLLOW !== undefined) {
					expect((openFlags as number) & constants.O_NOFOLLOW).toBe(
						constants.O_NOFOLLOW,
					);
				}
				if (constants.O_NONBLOCK !== undefined) {
					expect((openFlags as number) & constants.O_NONBLOCK).toBe(
						constants.O_NONBLOCK,
					);
				}
			} finally {
				_internals.reportLockLstat = originalLstat;
				_internals.reportLockOpen = originalOpen;
			}
		});
	});

	test('rejects a canonical report parent that changes before lock acquisition', async () => {
		await withTempRoot(async (root, destination) => {
			destination = path.join(
				root,
				'.swarm',
				'nested',
				path.basename(destination),
			);
			const parent = path.dirname(destination);
			const outside = canonicalMkdtemp('repository-validation-parent-swap-');
			const originalRealpath = _internals.reportPublicationRealpath;
			let parentRealpathCalls = 0;
			_internals.reportPublicationRealpath = async (candidate) => {
				const resolved = await originalRealpath(candidate);
				if (candidate === parent) {
					parentRealpathCalls += 1;
					if (parentRealpathCalls >= 2) return outside;
				}
				return resolved;
			};
			try {
				await expect(
					writeValidationReport(report(root), destination),
				).rejects.toThrow(/directory identity changed/);
				expect(await fsp.readdir(parent)).toEqual([]);
			} finally {
				_internals.reportPublicationRealpath = originalRealpath;
				await fsp.rm(outside, { recursive: true, force: true });
			}
		});
	});

	test.skipIf(process.platform === 'win32')(
		'does not open a FIFO while inspecting a lock',
		async () => {
			await withTempRoot(async (root, destination) => {
				const lockPath = `${destination}.lock`;
				await fsp.mkdir(path.dirname(destination), { recursive: true });
				const fifo = Bun.spawn(['mkfifo', lockPath], {
					cwd: root,
					stdin: 'ignore',
					stdout: 'ignore',
					stderr: 'ignore',
					timeout: 1_000,
				});
				try {
					expect(await fifo.exited).toBe(0);
				} finally {
					try {
						fifo.kill('SIGKILL');
					} catch {
						// The short-lived mkfifo process may have exited already.
					}
				}
				const started = performance.now();
				const inspection = await _internals.readReportLockOwner(lockPath);
				expect(performance.now() - started).toBeLessThan(1_000);
				expect(inspection).toEqual({ owner: null, allowAgeFallback: false });
			});
		},
	);

	test('serializes concurrent writers and leaves one complete atomic report', async () => {
		await withTempRoot(async (root, destination) => {
			const paths = await Promise.all([
				writeValidationReport(report(root, 1), destination),
				writeValidationReport(report(root, 2), destination),
			]);
			expect(paths).toEqual([destination, destination]);
			const saved = JSON.parse(
				await fsp.readFile(destination, 'utf8'),
			) as ValidationReport & { reportPath: string };
			expect(saved.reportPath).toBe(destination);
			expect([1, 2]).toContain(saved.durationMs);
			expect(
				await fsp.stat(`${destination}.lock`).catch(() => null),
			).toBeNull();
		});
	});
});
