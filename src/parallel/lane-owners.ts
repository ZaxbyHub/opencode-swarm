/**
 * Issue #2527 (PARALLEL-3): durable live-lane owner records.
 *
 * Every cross-process liveness signal that existed before this module
 * expired after five minutes regardless of the lane's actual state: lane
 * lock metas are stamped once (`file-locks.ts` LOCK_TIMEOUT_MS) with no
 * renewal path, and provisioning owners are leased for five minutes and
 * then dropped by init orphan recovery. A lane that legitimately ran longer
 * became invisible to a second process and was reclaimed as an "orphan".
 *
 * This store gives a lane a durable owner signal whose lifetime is the
 * LANE's, not a lock TTL:
 *
 *  - recorded at lane provisioning (lean runner AND standard worktree
 *    isolation — one primitive for both lane types, F3/A3);
 *  - cleared when the worktree is removed (`removeWorktree` in
 *    `src/worktree/core.ts`, both success returns) and by GC-on-read for
 *    any record whose lane path no longer exists (crashes, manual removal,
 *    every non-git deletion path);
 *  - liveness = owning PID exists AND the record's `startedAt` is within a
 *    24-hour claim window. The window bounds PID-reuse blindness: a record
 *    older than 24h is stale regardless of what now lives at that PID
 *    (dispatch deadlines are minutes, so a genuinely-running lane never
 *    approaches it; a >24h CLEAN lane being reclaimed is the low-harm case
 *    — a >24h DIRTY lane still survives via git's own refusal, F2).
 *    `process.kill(pid, 0)` EPERM ⇒ alive (fail-closed on Windows ACLs).
 *
 * Store pattern mirrors `dead-lane-reclaim.ts`: a bounded JSON file under
 * `.swarm/`, written via `atomicWriteSwarmFileSync`, never grown past the
 * entry/byte caps.
 */
import * as fs from 'node:fs';
import { validateSwarmPath } from '../hooks/utils';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';
import { canonicalRootKeyFresh } from '../utils/canonical-root';
import * as logger from '../utils/logger.js';

// validateSwarmPath joins `.swarm/` itself — keep this filename-only.
const LIVE_LANE_OWNERS_PATH = 'live-lane-owners.json';
const MAX_LIVE_LANE_OWNERS = 256;
const MAX_LIVE_LANE_OWNERS_BYTES = 128 * 1024;
/** Plan-critic round-1 item 5: PID-recency witness bound (24h). */
export const LIVE_LANE_OWNER_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LiveLaneOwnerEntry {
	lanePath: string;
	branchName: string;
	sessionId: string;
	taskId: string;
	ownerPid: number;
	startedAt: number;
}

interface LiveLaneOwnerStore {
	schemaVersion: 1;
	entries: LiveLaneOwnerEntry[];
}

export interface LiveLaneOwnersView {
	/** Records whose owner process is alive within the claim window. */
	live: LiveLaneOwnerEntry[];
	/** Records dropped this read: path gone, or past the claim window. */
	reaped: LiveLaneOwnerEntry[];
}

export const _internals = {
	readFileSync: fs.readFileSync as (p: string, enc: BufferEncoding) => string,
	rmSync: fs.rmSync.bind(fs),
	statSync: fs.statSync as (p: string) => unknown,
	atomicWriteSwarmFileSync,
	now: (): number => Date.now(),
	// Real existence probe: process.kill(pid, 0) throws ESRCH for a dead
	// PID (EPERM for a live PID owned by another user). Final-critic F1:
	// a constant-true stub here would make every record an unconditional
	// 24h claim — the dead-PID branch must be reachable in production.
	kill: (pid: number, signal: 0) => {
		process.kill(pid, signal);
		return true as const;
	},
	process: { pid: process.pid },
};

function storePath(directory: string): string {
	return validateSwarmPath(directory, LIVE_LANE_OWNERS_PATH);
}

function isLiveLaneOwnerEntry(value: unknown): value is LiveLaneOwnerEntry {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const c = value as Record<string, unknown>;
	return (
		typeof c.lanePath === 'string' &&
		c.lanePath.length > 0 &&
		typeof c.branchName === 'string' &&
		typeof c.sessionId === 'string' &&
		typeof c.taskId === 'string' &&
		typeof c.ownerPid === 'number' &&
		Number.isInteger(c.ownerPid) &&
		c.ownerPid > 0 &&
		typeof c.startedAt === 'number' &&
		Number.isFinite(c.startedAt)
	);
}

function readStore(directory: string): LiveLaneOwnerStore {
	try {
		const raw = _internals.readFileSync(storePath(directory), 'utf-8');
		if (raw.length > MAX_LIVE_LANE_OWNERS_BYTES) {
			return { schemaVersion: 1, entries: [] };
		}
		const parsed = JSON.parse(raw) as Partial<LiveLaneOwnerStore>;
		if (
			!parsed ||
			parsed.schemaVersion !== 1 ||
			!Array.isArray(parsed.entries)
		) {
			return { schemaVersion: 1, entries: [] };
		}
		return {
			schemaVersion: 1,
			entries: parsed.entries.filter(isLiveLaneOwnerEntry),
		};
	} catch {
		return { schemaVersion: 1, entries: [] };
	}
}

function writeStore(directory: string, store: LiveLaneOwnerStore): void {
	// Bound on BOTH axes — newest records kept, oldest dropped — so the
	// on-disk file never exceeds the byte cap the bounded read enforces.
	let entries = store.entries.slice(-MAX_LIVE_LANE_OWNERS);
	for (;;) {
		const serialized = JSON.stringify({ schemaVersion: 1, entries }, null, 2);
		if (
			serialized.length <= MAX_LIVE_LANE_OWNERS_BYTES ||
			entries.length === 0
		) {
			if (entries.length < store.entries.length) {
				logger.log(
					`[lane-owners] store bound dropped ${
						store.entries.length - entries.length
					} oldest entries (caps: ${MAX_LIVE_LANE_OWNERS} entries / ${MAX_LIVE_LANE_OWNERS_BYTES} bytes)`,
				);
			}
			if (entries.length === 0) {
				// Empty store: remove the file entirely (mirrors dead-lane-reclaim).
				try {
					_internals.rmSync(storePath(directory), { force: true });
				} catch {
					// Best-effort; an empty-stale file reads as the empty store.
				}
				return;
			}
			_internals.atomicWriteSwarmFileSync(storePath(directory), serialized);
			return;
		}
		entries = entries.slice(1);
	}
}

/** Record (or refresh) the durable owner of a live lane. Never throws. */
export function recordLiveLaneOwner(
	directory: string,
	entry: {
		lanePath: string;
		branchName: string;
		sessionId: string;
		taskId: string;
	},
): void {
	try {
		const store = readStore(directory);
		const filtered = store.entries.filter(
			(e) =>
				e.lanePath !== entry.lanePath &&
				canonicalRootKeyFresh(e.lanePath) !==
					canonicalRootKeyFresh(entry.lanePath),
		);
		filtered.push({
			...entry,
			ownerPid: _internals.process.pid,
			startedAt: _internals.now(),
		});
		writeStore(directory, { schemaVersion: 1, entries: filtered });
	} catch (error) {
		logger.log(
			`[lane-owners] could not record live lane owner ${entry.lanePath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/** Clear the durable owner record for one lane path. Never throws. */
export function clearLiveLaneOwner(directory: string, lanePath: string): void {
	try {
		const store = readStore(directory);
		const canonical = canonicalRootKeyFresh(lanePath);
		const filtered = store.entries.filter(
			(e) =>
				e.lanePath !== lanePath &&
				canonicalRootKeyFresh(e.lanePath) !== canonical,
		);
		if (filtered.length === store.entries.length) return;
		writeStore(directory, { schemaVersion: 1, entries: filtered });
	} catch (error) {
		logger.log(
			`[lane-owners] could not clear live lane owner ${lanePath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function pidAlive(pid: number): boolean {
	try {
		_internals.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// EPERM: process exists but belongs to another user — alive (fail-closed).
		return code === 'EPERM';
	}
}

function pathExists(target: string): boolean {
	try {
		_internals.statSync(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read the live-lane-owner view, GC-ing records whose lane path no longer
 * exists (universal clear fallback: every removal path that bypassed
 * `removeWorktree` — manual rm, /swarm close sweeps, future tooling — is
 * healed on the next read) and records past the 24h claim window.
 */
export function listLiveLaneOwners(directory: string): LiveLaneOwnersView {
	const store = readStore(directory);
	const now = _internals.now();
	const live: LiveLaneOwnerEntry[] = [];
	const reaped: LiveLaneOwnerEntry[] = [];
	const kept: LiveLaneOwnerEntry[] = [];
	for (const entry of store.entries) {
		if (!pathExists(entry.lanePath)) {
			reaped.push(entry); // lane directory is gone — record is stale
			continue;
		}
		if (now - entry.startedAt > LIVE_LANE_OWNER_CLAIM_WINDOW_MS) {
			reaped.push(entry); // past the PID-recency claim window
			continue;
		}
		if (!pidAlive(entry.ownerPid)) {
			// Owning process is dead: not live, but KEEP the record (its
			// startedAt is fresh — a just-crashed host's lanes should not be
			// re-recorded; the next claim-window tick reaps it). It does not
			// protect the lane.
			kept.push(entry);
			continue;
		}
		live.push(entry);
		kept.push(entry);
	}
	if (reaped.length > 0) {
		try {
			writeStore(directory, { schemaVersion: 1, entries: kept });
		} catch (error) {
			logger.log(
				`[lane-owners] could not persist reap: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	return { live, reaped };
}
