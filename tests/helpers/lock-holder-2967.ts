/**
 * Shared fixture harness for the J20 lock-substrate suites (#2967/#2969 —
 * plan 05 v8 §1.4): real child-process lock holders (see
 * tests/fixtures/owner-lock-holder-2967.ts), provably-dead pids, hand-seeded
 * `.lck`/`.breaking` artifacts, and a flush-barrier telemetry reader.
 *
 * Each test suite creates ONE fixture via createLockFixture() and calls
 * dispose() in afterEach (kills surviving children, removes scratch dirs,
 * restores the file-locks _internals seam).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OwnerLockPayload } from '../../src/parallel/file-locks.js';
import { _internals as fileLocksInternals } from '../../src/parallel/file-locks.js';
import { emit, initTelemetry } from '../../src/telemetry.js';
import { canonicalMkdtemp, removeTreeWithRetry } from './tmpdir.js';

export const REPO_ROOT = path.resolve(import.meta.dir, '../..');
export const HOLDER_SCRIPT = path.resolve(
	import.meta.dir,
	'../fixtures/owner-lock-holder-2967.ts',
);
export const SIX_MIN_AGO = () => new Date(Date.now() - 6 * 60 * 1000);
export const TWO_MIN_AGO_MS = 120_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(
	pred: () => boolean,
	timeoutMs: number,
	label: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pred()) return;
		await sleep(25);
	}
	throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${label}`);
}

/** Seed a `.lck` owner lock by hand (payload or raw string) with optional
 *  backdated mtime. Returns the exact bytes written. */
export function seedOwnerLock(
	lck: string,
	payload: OwnerLockPayload | string,
	mtime?: Date,
): string {
	fs.mkdirSync(path.dirname(lck), { recursive: true });
	const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
	fs.writeFileSync(lck, raw, 'utf-8');
	if (mtime) fs.utimesSync(lck, mtime, mtime);
	return raw;
}

/** Seed a `<lock>.breaking` marker with the given breaker pid and age. */
export function seedMarker(
	lck: string,
	breakerPid: number,
	ageMs: number,
	nonce: string,
): string {
	const raw = JSON.stringify({
		v: 1,
		breakerPid,
		nonce,
		createdAtMs: Date.now() - ageMs,
	});
	fs.writeFileSync(`${lck}.breaking`, raw, 'utf-8');
	return raw;
}

/** A minimal valid v1 owner payload with overrides. */
export function makePayload(o: Partial<OwnerLockPayload>): OwnerLockPayload {
	return {
		v: 1,
		nonce: 'n',
		ownerPid: process.pid,
		startBoundMs: 0,
		agent: 'a',
		taskId: 't',
		acquiredAtMs: 1,
		...o,
	};
}

export interface LockFixture {
	scratch: (prefix: string) => string;
	spawnHolder: (args: string[]) => ChildProcess;
	waitReady: (readyFile: string) => Promise<number>;
	/** SIGKILL via the OS primitive, then wait for exit AND pid reaping. */
	killAndAwait: (child: ChildProcess) => Promise<void>;
	/** A real, provably-dead pid for payload seeding (no pid-inference). */
	acquireDeadPid: () => Promise<number>;
	/** Flush-barrier read of `store_lock_stale_broken` lines in root's
	 *  stream: a sentinel emit (unique store tag) orders AFTER every prior
	 *  event on the same stream, so once its line is visible all earlier
	 *  events are too. The caller MUST initTelemetry(root) BEFORE the action
	 *  under test — events emitted with no live stream are dropped. */
	readBreakEvents: (root: string) => Promise<Record<string, unknown>[]>;
	/** The real process.kill captured before any test wrapper — counting
	 *  wrappers installed on fileLocksInternals.kill delegate to this. */
	realKill: (pid: number, signal?: number | string) => void;
	restoreKill: () => void;
	dispose: () => void;
}

export function createLockFixture(): LockFixture {
	const dirs: string[] = [];
	const children: ChildProcess[] = [];
	const originalKill = fileLocksInternals.kill;
	let flushSeq = 0;

	const scratch = (prefix: string): string => {
		const dir = canonicalMkdtemp(prefix);
		dirs.push(dir);
		return dir;
	};

	const spawnHolder = (args: string[]): ChildProcess => {
		const child = spawn(process.execPath, [HOLDER_SCRIPT, ...args], {
			cwd: REPO_ROOT,
			stdio: 'ignore',
			windowsHide: true,
		});
		children.push(child);
		return child;
	};

	const waitReady = async (readyFile: string): Promise<number> => {
		await waitUntil(
			() => fs.existsSync(readyFile),
			20_000,
			`ready ${readyFile}`,
		);
		const { pid } = JSON.parse(fs.readFileSync(readyFile, 'utf-8')) as {
			pid: number;
		};
		if (!Number.isInteger(pid)) throw new Error(`bad ready file pid: ${pid}`);
		return pid;
	};

	const killAndAwait = async (child: ChildProcess): Promise<void> => {
		const pid = child.pid;
		if (pid === undefined) return;
		process.kill(pid, 'SIGKILL');
		if (child.exitCode === null && child.signalCode === null) {
			// Feedback PRR-024: bound the exit await — SIGKILL cannot be
			// ignored, so a non-exit here means the event was missed (or the
			// pid left the process table before the listener attached); the
			// liveness wait below is the authoritative check.
			await new Promise<void>((r) => {
				const t = setTimeout(r, 10_000);
				child.once('exit', () => {
					clearTimeout(t);
					r();
				});
			});
		}
		await waitUntil(
			() => {
				try {
					process.kill(pid, 0);
					return false;
				} catch {
					return true;
				}
			},
			10_000,
			`pid ${pid} dead`,
		);
	};

	const acquireDeadPid = async (): Promise<number> => {
		const child = spawn(
			process.execPath,
			['-e', 'setInterval(() => {}, 1000);'],
			{ cwd: REPO_ROOT, stdio: 'ignore', windowsHide: true },
		);
		children.push(child);
		const pid = child.pid!;
		await waitUntil(
			() => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			},
			10_000,
			'scratch child alive',
		);
		await killAndAwait(child);
		return pid;
	};

	const readBreakEvents = async (
		root: string,
	): Promise<Record<string, unknown>[]> => {
		initTelemetry(root);
		flushSeq += 1;
		const tag = `__flush_${process.pid}_${flushSeq}`;
		emit('store_lock_stale_broken', { store: tag, ageMs: 0 });
		const readAll = (): string => {
			try {
				return fs.readFileSync(
					path.join(root, '.swarm', 'telemetry.jsonl'),
					'utf-8',
				);
			} catch {
				return '';
			}
		};
		await waitUntil(() => readAll().includes(tag), 10_000, 'telemetry flush');
		return readAll()
			.split('\n')
			.filter((l) => l.trim() !== '')
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter(
				(e) =>
					e.event === 'store_lock_stale_broken' &&
					typeof e.store === 'string' &&
					!e.store.startsWith('__flush_'),
			);
	};

	const restoreKill = (): void => {
		fileLocksInternals.kill = originalKill;
	};

	const dispose = (): void => {
		restoreKill();
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill('SIGKILL');
				} catch {
					/* already gone */
				}
			}
		}
		children.length = 0;
		const leaked = dirs.splice(0, dirs.length);
		for (const dir of leaked) removeTreeWithRetry(dir);
	};

	return {
		scratch,
		spawnHolder,
		waitReady,
		killAndAwait,
		acquireDeadPid,
		readBreakEvents,
		realKill: originalKill,
		restoreKill,
		dispose,
	};
}
