/**
 * Real child-process lock holder for the #2967/#2969 stale-lock test suites
 * (J20 — plan 05 v8 §1.4).
 *
 * One fixture serves every holder shape the suites need. The parent test
 * spawns it with `process.execPath` (bun), waits for the ready-marker file
 * (which carries the child's pid), and then either SIGKILLs the child
 * (dead-owner arms) or writes the release-marker file (live-owner arms — the
 * marker-file release protocol) and waits for the child to release and exit.
 *
 * Modes:
 *   --evidence <dir> <relPath>          hold the wx owner lock for a target
 *                                       via tryAcquireLock (the same substrate
 *                                       withEvidenceLock acquires)
 *   --events <dir>                      hold .swarm/events.lock via
 *                                       withCoreEventStoreLock (busy-hold
 *                                       inside the sync callback)
 *   --lane <dir> <relPath>              hold via acquireLaneLocks
 *   --legacy-held <sentinelPath>        hold a legacy sentinel via
 *                                       proper-lockfile.lock directly
 *                                       (old-version holder simulation)
 *   --race <dir> <relPath> <goMarker> <resultFile>
 *                                       multiprocess barrier participant:
 *                                       wait for the go marker, loop
 *                                       tryAcquireLock until acquired once,
 *                                       verify the payload names OUR pid while
 *                                       holding (zero double-hold), write the
 *                                       result file, release, exit
 *
 * Common flags:
 *   --ready <readyFile>                 write {pid, mode} after the lock is
 *                                       held (parent's readiness signal)
 *   --release-on-marker <markerPath>    live-release protocol: poll for the
 *                                       marker (bounded), release cleanly,
 *                                       write <readyFile>.released, exit 0.
 *                                       Without it: hold until killed.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { withCoreEventStoreLock } from '../../src/events/core-events.js';
import {
	acquireLaneLocks,
	getOwnerLockPath,
	tryAcquireLock,
} from '../../src/parallel/file-locks.js';

const argv = process.argv.slice(2);

function argValue(flag: string): string | undefined {
	const idx = argv.indexOf(flag);
	return idx >= 0 ? argv[idx + 1] : undefined;
}

function argAfter(flag: string): string[] {
	const idx = argv.indexOf(flag);
	if (idx < 0) return [];
	const count = Number(argv[idx + 1]);
	void count;
	// positional variadic: everything after the flag up to the next flag
	const rest: string[] = [];
	for (let i = idx + 1; i < argv.length; i += 1) {
		if (argv[i]!.startsWith('--')) break;
		rest.push(argv[i]!);
	}
	return rest;
}

const READY_FILE = argValue('--ready');
const RELEASE_MARKER = argValue('--release-on-marker');
const HOLD_BUDGET_MS = 120_000;
const POLL_MS = 20;

/** Synchronous bounded sleep (keeps the events-store lock callback sync). */
function syncSleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeReady(mode: string): void {
	if (!READY_FILE) return;
	fs.mkdirSync(path.dirname(READY_FILE), { recursive: true });
	fs.writeFileSync(READY_FILE, JSON.stringify({ pid: process.pid, mode }));
}

function writeReleased(): void {
	if (!READY_FILE) return;
	try {
		fs.writeFileSync(
			`${READY_FILE}.released`,
			JSON.stringify({ pid: process.pid }),
		);
	} catch {
		/* best-effort signal */
	}
}

/** Hold until the release marker appears (or the bounded budget elapses).
 *  Returns true when released via marker, false when the budget ran out. */
function holdUntilReleased(): boolean {
	if (!RELEASE_MARKER) {
		const deadline = Date.now() + HOLD_BUDGET_MS;
		while (Date.now() < deadline) syncSleep(200);
		return false;
	}
	const deadline = Date.now() + HOLD_BUDGET_MS;
	while (Date.now() < deadline) {
		if (fs.existsSync(RELEASE_MARKER)) return true;
		syncSleep(POLL_MS);
	}
	return false;
}

async function holdUntilReleasedAsync(): Promise<boolean> {
	if (!RELEASE_MARKER) {
		await new Promise((resolve) => setTimeout(resolve, HOLD_BUDGET_MS));
		return false;
	}
	const deadline = Date.now() + HOLD_BUDGET_MS;
	while (Date.now() < deadline) {
		if (fs.existsSync(RELEASE_MARKER)) return true;
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	return false;
}

function sha256Sentinel(directory: string, relPath: string): string {
	const normalized = path.resolve(directory, relPath);
	const pathForHash =
		process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	const hash = crypto.createHash('sha256').update(pathForHash).digest('hex');
	return path.join(directory, '.swarm', 'locks', `${hash}.lock`);
}

async function main(): Promise<number> {
	// ---- multiprocess barrier participant -------------------------------
	if (argv.includes('--race')) {
		const [dir, relPath, goMarker, resultFile] = argAfter('--race');
		if (!dir || !relPath || !goMarker || !resultFile) {
			process.stderr.write('race mode requires 4 arguments\n');
			return 2;
		}
		// Ready BEFORE the go-wait: the parent must see both participants
		// staged before opening the barrier.
		writeReady('race-waiting');
		const goDeadline = Date.now() + 60_000;
		while (!fs.existsSync(goMarker)) {
			if (Date.now() > goDeadline) {
				fs.writeFileSync(resultFile, JSON.stringify({ error: 'go-timeout' }));
				return 1;
			}
			syncSleep(POLL_MS);
		}
		const acquireDeadline = Date.now() + 30_000;
		for (;;) {
			const result = await tryAcquireLock(dir, relPath, 'race-agent', 'race');
			if (result.acquired) {
				// Zero-double-hold verification: while WE hold the lock, the
				// artifact payload must name OUR pid and carry the nonce we
				// wrote — a second concurrent holder is impossible if every
				// participant verifies this.
				let verified = false;
				try {
					const payload = JSON.parse(
						fs.readFileSync(getOwnerLockPath(dir, relPath), 'utf-8'),
					) as { ownerPid?: number; v?: number };
					verified = payload.v === 1 && payload.ownerPid === process.pid;
				} catch {
					verified = false;
				}
				fs.writeFileSync(
					resultFile,
					JSON.stringify({ acquired: 1, verified, pid: process.pid }),
				);
				// Brief hold so the third participant genuinely contends
				// while this acquisition is live (barrier semantics).
				await new Promise((resolve) => setTimeout(resolve, 25));
				await result.lock._release?.();
				return verified ? 0 : 3;
			}
			if (Date.now() > acquireDeadline) {
				fs.writeFileSync(
					resultFile,
					JSON.stringify({ acquired: 0, error: 'acquire-timeout' }),
				);
				return 1;
			}
			syncSleep(5);
		}
	}

	// ---- events store lock holder (sync busy-hold inside the callback) --
	if (argv.includes('--events')) {
		const dir = argValue('--events');
		if (!dir) {
			process.stderr.write('events mode requires a directory\n');
			return 2;
		}
		withCoreEventStoreLock(dir, () => {
			writeReady('events');
			holdUntilReleased();
			return 'held';
		});
		writeReleased();
		return 0;
	}

	// ---- legacy proper-lockfile holder (old-version holder simulation) --
	if (argv.includes('--legacy-held')) {
		const sentinelPath = argValue('--legacy-held');
		if (!sentinelPath) {
			process.stderr.write('legacy-held mode requires a sentinel path\n');
			return 2;
		}
		const release = await lockfile.lock(sentinelPath, {
			stale: 300_000,
			retries: { retries: 0 },
			realpath: false,
		});
		writeReady('legacy');
		await holdUntilReleasedAsync();
		try {
			await release();
		} catch {
			/* already released by staleness — best-effort */
		}
		writeReleased();
		return 0;
	}

	// ---- wx owner-lock holders (evidence target or lane) ---------------
	const evidenceArgs = argAfter('--evidence');
	const laneArgs = argAfter('--lane');
	if (evidenceArgs.length >= 2 || laneArgs.length >= 2) {
		const isLane = laneArgs.length >= 2;
		const dir = (isLane ? laneArgs[0] : evidenceArgs[0])!;
		const relPath = (isLane ? laneArgs[1] : evidenceArgs[1])!;
		if (isLane) {
			const lane = await acquireLaneLocks(
				dir,
				'holder-lane-2967',
				[relPath],
				'holder-agent',
				'holder-task',
				'holder-session',
			);
			if (!lane.acquired) {
				process.stderr.write('lane acquire failed\n');
				return 1;
			}
			writeReady('lane');
			await holdUntilReleasedAsync();
			await lane.locks[0]?._release?.();
		} else {
			const result = await tryAcquireLock(
				dir,
				relPath,
				'holder-agent',
				'holder-task',
			);
			if (!result.acquired) {
				process.stderr.write('evidence acquire failed\n');
				return 1;
			}
			writeReady('evidence');
			await holdUntilReleasedAsync();
			await result.lock._release?.();
		}
		writeReleased();
		return 0;
	}

	process.stderr.write('no mode flag given\n');
	return 2;
}

process.exit(await main());
