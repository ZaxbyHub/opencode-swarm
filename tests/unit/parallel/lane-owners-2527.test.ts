/**
 * Issue #2527 (PARALLEL-3) — durable live-lane owner records
 * (`src/parallel/lane-owners.ts`).
 *
 * Liveness = owning PID alive AND startedAt within the 24h claim window.
 * GC-on-read drops records whose lanePath is gone or whose claim window
 * expired; a fresh-but-dead-PID record is KEPT (not live, not reaped). The
 * store is bounded (256 entries / 128 KiB). All clock and pid access is
 * driven through the module's `_internals` seam — no module mocks and no raw
 * wall-clock reads in this file (pinned constant timestamps only).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	clearLiveLaneOwner,
	LIVE_LANE_OWNER_CLAIM_WINDOW_MS,
	listLiveLaneOwners,
	recordLiveLaneOwner,
} from '../../../src/parallel/lane-owners';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** Pinned, deterministic clock constant (ms epoch). No Date.now in tests. */
const PINNED_NOW = 1_800_000_000_000;

interface StoreShape {
	schemaVersion: number;
	entries: Array<{
		lanePath: string;
		ownerPid: number;
		startedAt: number;
		[string]: unknown;
	}>;
}

function readStore(dir: string): StoreShape {
	return JSON.parse(
		readFileSync(path.join(dir, '.swarm', 'live-lane-owners.json'), 'utf-8'),
	) as StoreShape;
}

const realNow = _internals.now;
const realProcess = _internals.process;
const realKill = _internals.kill;

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('laneowners-2527-');
	_internals.now = () => PINNED_NOW;
});

afterEach(() => {
	_internals.now = realNow;
	_internals.process = realProcess;
	_internals.kill = realKill;
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// Best-effort teardown.
	}
});

function record(
	lanePath: string,
	sessionId = 'ses_test0000000000000001',
): void {
	recordLiveLaneOwner(dir, {
		lanePath,
		branchName: 'swarm/lane/test/lane-1',
		sessionId,
		taskId: 'task-1',
	});
}

describe('live lane owner store (issue #2527)', () => {
	test('record/clear round-trip', () => {
		const lane = path.join(dir, 'lane-1');
		mkdirSync(lane, { recursive: true });

		record(lane);

		const storeFile = path.join(dir, '.swarm', 'live-lane-owners.json');
		expect(existsSync(storeFile)).toBe(true);
		const store = readStore(dir);
		expect(store.entries).toHaveLength(1);
		expect(store.entries[0].lanePath).toBe(lane);
		expect(store.entries[0].ownerPid).toBe(process.pid);
		expect(store.entries[0].startedAt).toBe(PINNED_NOW);

		clearLiveLaneOwner(dir, lane);
		// An emptied store removes the file entirely.
		expect(existsSync(storeFile)).toBe(false);
	});

	test('own-PID record over an existing lane path is live', () => {
		const lane = path.join(dir, 'lane-live');
		mkdirSync(lane, { recursive: true });
		record(lane);

		const view = listLiveLaneOwners(dir);

		expect(view.live).toHaveLength(1);
		expect(view.live[0].lanePath).toBe(lane);
		expect(view.reaped).toHaveLength(0);
	});

	test('record whose lanePath is gone is reaped on read', () => {
		record(path.join(dir, 'lane-gone'));

		const view = listLiveLaneOwners(dir);

		expect(view.live).toHaveLength(0);
		expect(view.reaped).toHaveLength(1);
		expect(view.reaped[0].lanePath).toBe(path.join(dir, 'lane-gone'));
		// The reap is persisted: an emptied store removes the file entirely.
		expect(existsSync(path.join(dir, '.swarm', 'live-lane-owners.json'))).toBe(
			false,
		);
	});

	test('record past the 24h claim window is reaped (PID-recency bound)', () => {
		const lane = path.join(dir, 'lane-stale');
		mkdirSync(lane, { recursive: true });
		record(lane);

		_internals.now = () => PINNED_NOW + LIVE_LANE_OWNER_CLAIM_WINDOW_MS + 1;
		const view = listLiveLaneOwners(dir);

		expect(view.live).toHaveLength(0);
		expect(view.reaped).toHaveLength(1);
	});

	test('dead-PID record with fresh startedAt is kept but not live', () => {
		const lane = path.join(dir, 'lane-crashed');
		mkdirSync(lane, { recursive: true });
		// Simulate the owner having crashed: alive PID when recorded, dead now.
		record(lane);
		_internals.kill = () => {
			throw Object.assign(new Error('no such process'), {
				code: 'ESRCH',
			});
		};

		const view = listLiveLaneOwners(dir);

		expect(view.live).toHaveLength(0);
		expect(view.reaped).toHaveLength(0);
		// KEPT on disk: its startedAt is fresh, so a just-crashed host's lane
		// is not immediately re-recordable; it does not protect the lane.
		expect(readStore(dir).entries).toHaveLength(1);
	});

	test('kill(0) EPERM is treated as alive (Windows ACL fail-closed)', () => {
		const lane = path.join(dir, 'lane-eperm');
		mkdirSync(lane, { recursive: true });
		record(lane);
		_internals.kill = () => {
			throw Object.assign(new Error('operation not permitted'), {
				code: 'EPERM',
			});
		};

		const view = listLiveLaneOwners(dir);

		expect(view.live).toHaveLength(1);
		expect(view.reaped).toHaveLength(0);
	});

	test('corrupt record with ownerPid 0 is rejected at parse (never "live")', () => {
		// Review finding: process.kill(0, 0) probes the process GROUP and
		// succeeds, so an ownerPid of 0 must never validate as a live record.
		const lane = path.join(dir, 'lane-badpid');
		mkdirSync(lane, { recursive: true });
		record(lane);
		const storeFile = path.join(dir, '.swarm', 'live-lane-owners.json');
		const raw = JSON.parse(readFileSync(storeFile, 'utf-8')) as {
			entries: Array<{ ownerPid: number }>;
		};
		raw.entries[0].ownerPid = 0;
		writeFileSync(storeFile, JSON.stringify(raw));

		const view = listLiveLaneOwners(dir);

		expect(view.live).toHaveLength(0);
	});

	test('unknown future schemaVersion reads as the empty store', () => {
		// Final-critic B14-i pin: a store written by a FUTURE version is
		// rejected wholesale (fail-open to the unprotected pre-#2527 state).
		const lane = path.join(dir, 'lane-future');
		mkdirSync(lane, { recursive: true });
		record(lane);
		const storeFile = path.join(dir, '.swarm', 'live-lane-owners.json');
		const raw = JSON.parse(readFileSync(storeFile, 'utf-8')) as {
			schemaVersion: number;
		};
		raw.schemaVersion = 2;
		writeFileSync(storeFile, JSON.stringify(raw));

		const view = listLiveLaneOwners(dir);

		expect(view.live).toHaveLength(0);
		expect(view.reaped).toHaveLength(0);
	});

	test('production kill default classifies a reaped child PID as dead', () => {
		// Final-critic F1 pin: the DEFAULT _internals.kill must be a real
		// existence probe, not a constant-true stub. Spawn a child, reap it,
		// record an owner under its (now dead) PID, and assert the record is
		// NOT live — through the production kill wiring, with no rebinding.
		const lane = path.join(dir, 'lane-reaped-pid');
		mkdirSync(lane, { recursive: true });
		const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
			stdio: 'ignore',
		});
		expect(child.status).toBe(0);
		expect(typeof child.pid).toBe('number');
		const deadPid = child.pid as number;

		_internals.process = { pid: deadPid };
		try {
			record(lane);
		} finally {
			_internals.process = realProcess;
		}

		const view = listLiveLaneOwners(dir);

		expect(view.live).toHaveLength(0);
		expect(view.reaped).toHaveLength(0);
		// Fresh startedAt + dead PID: kept on disk, but it protects nothing.
		expect(readStore(dir).entries).toHaveLength(1);
	}, 10_000);

	test('store is bounded: 256 entries / 128 KiB even after 260 records', () => {
		// The lane dirs are created so canonical-key dedup (realpath per
		// existing entry per record) resolves on the fast existing-path branch.
		// 260 records × atomic rewrite ≈ 9 s on cold-FS Windows — well over
		// bun's 5 s per-test default, so this test carries an explicit
		// budget (the base-migration-2527 precedent).
		for (let i = 0; i < 260; i++) {
			const lane = path.join(dir, 'bulk', `lane-${i}`);
			mkdirSync(lane, { recursive: true });
			record(lane);
		}

		const storeFile = path.join(dir, '.swarm', 'live-lane-owners.json');
		const store = readStore(dir);
		expect(store.entries.length).toBeLessThanOrEqual(256);
		expect(statSync(storeFile).size).toBeLessThanOrEqual(128 * 1024);
		// Newest records are the ones kept.
		expect(store.entries[store.entries.length - 1].lanePath).toBe(
			path.join(dir, 'bulk', 'lane-259'),
		);
	}, 60_000);
});
