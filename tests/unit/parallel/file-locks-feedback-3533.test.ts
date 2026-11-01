// PR #3533 feedback round — substrate arms closed by the review round
// (3533-review2-20261101). Complements file-locks-stale-owner.test.ts
// (which may not grow past the FR-006 cap) with the feedback-specific
// contracts. One describe block; see each arm's doc-comment. Arms:
// F1/F1b (PRR-002 self-heal + never-break-live), F2 (PRR-021 cooldown
// expiry), F3/F3b (unparsable marker never takeover; unaged dead-marker
// waits), F4 (no `.cand.` residue), F5 (marker sweep), F6a/F6b (PRR-007
// legacy pairing: dir lock keeps bookkeeping, bare sentinel drops it),
// F8 (PRR-012 win32 base64-lowercased alias). PRR-005 meta retention is
// pinned by stale-owner arm 14; PRR-013/016 are code-path defensive.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import {
	acquireLaneLocks,
	breakStaleLockIfOwnerDead,
	cleanupExpiredLocks,
	getOwnerLockPath,
	LOCK_TIMEOUT_MS,
	_internals as lockInternals,
	releaseLaneLocks,
	tryAcquireLock,
} from '../../../src/parallel/file-locks.js';
import {
	createLockFixture,
	type LockFixture,
	makePayload,
	seedMarker,
	seedOwnerLock,
} from '../../helpers/lock-holder-2967.js';

let fx: LockFixture;

const lckPath = (dir: string, rel: string): string =>
	getOwnerLockPath(dir, rel);

/** Convert a lane lock's artifact set to its pre-upgrade legacy shape:
 *  `.lck` removed, `.lock` sentinel + proper-lockfile dir lock written.
 *  The dir lock is a plain directory (existence is what the pairing gate
 *  reads — a same-process lockfile.lock is NOT the production shape, which
 *  is cross-process and thus un-unlockable; review Finding 2). */
async function seedLegacyLane(
	dir: string,
	rel: string,
	laneId: string,
): Promise<string> {
	const lane = await acquireLaneLocks(dir, laneId, [rel], 'a', 't', 's');
	expect(lane.acquired).toBe(true);
	if (!lane.acquired) throw new Error('fixture acquire failed');
	await lane.locks[0]!._release?.();
	const stem = lckPath(dir, rel).replace(/\.lck$/, '');
	fs.writeFileSync(`${stem}.lock`, '', 'utf-8');
	fs.mkdirSync(`${stem}.lock.lock`);
	return stem;
}

beforeEach(() => {
	fx = createLockFixture();
});

afterEach(() => {
	fx.dispose();
});

describe('file-locks — PR #3533 feedback substrate arms', () => {
	test('F1: plain-path contention self-heals a dead owner (PRR-002)', async () => {
		const dir = fx.scratch('lock-f1-');
		const rel = 'plan/plan.json';
		const deadPid = await fx.acquireDeadPid();
		const lck = getOwnerLockPath(dir, rel);
		seedOwnerLock(
			lck,
			makePayload({ nonce: 'stale', ownerPid: deadPid, acquiredAtMs: 1 }),
		);
		const t0 = performance.now();
		const result = await tryAcquireLock(dir, rel, 'agent', 'task');
		expect(result.acquired).toBe(true);
		expect(performance.now() - t0).toBeLessThan(3000);
		const payload = JSON.parse(fs.readFileSync(lck, 'utf-8')) as {
			nonce: string;
		};
		expect(payload.nonce).not.toBe('stale');
		if (result.acquired) await result.lock._release?.();
	}, 15_000);

	test('F1b: plain-path contention against a LIVE owner never breaks (PRR-002 never-break-live rule)', async () => {
		const dir = fx.scratch('lock-f1b-');
		const rel = 'plan/live.json';
		// This test process owns the seeded pid — provably alive for the
		// whole arm, so no code path may break the artifact.
		seedOwnerLock(lckPath(dir, rel), makePayload({ nonce: 'live' }));
		const result = await tryAcquireLock(dir, rel, 'agent', 'task');
		expect(result.acquired).toBe(false);
		const onDisk = fs.readFileSync(lckPath(dir, rel), 'utf-8');
		expect(JSON.parse(onDisk).nonce).toBe('live');
	}, 15_000);

	test('F2: cooldown expiry — a published break re-admits after LOCK_TIMEOUT_MS (PRR-021)', () => {
		const dir = fx.scratch('lock-f2-');
		const lck = lckPath(dir, 'stale.json');
		const payload = makePayload({ nonce: 'cd', ownerPid: 999_999_999 });
		// Round 1: the dead-owner break publishes and records the cooldown.
		seedOwnerLock(lck, payload);
		expect(
			breakStaleLockIfOwnerDead(lck, { class: 'dead-owner', store: 'generic' }),
		).toBe('broken');
		// Restore the same artifact a successor would have re-created.
		seedOwnerLock(lck, payload);
		// Advance the clock past the cooldown window (injected clock seam;
		// restored in finally so sibling arms keep the real clock).
		// Literal far-future epoch (2027-01-15): the injected-clock seam only
		// needs a value past the cooldown recorded at real now (check:test-clock:
		// fixture epochs are literals, never raw reads).
		const fakeNow = 1_800_000_000_000 + LOCK_TIMEOUT_MS + 1000;
		const realNow = lockInternals.now;
		lockInternals.now = () => fakeNow;
		try {
			// The never-re-admit mutant returns 'live' here.
			expect(
				breakStaleLockIfOwnerDead(lck, {
					class: 'dead-owner',
					store: 'generic',
				}),
			).toBe('broken');
			expect(fs.existsSync(lck)).toBe(false);
		} finally {
			lockInternals.now = realNow;
		}
	}, 15_000);

	test('F2b: live verdicts consume NO cooldown — owner death is honored immediately (review Finding 1)', () => {
		const dir = fx.scratch('lock-f2b-');
		const lck = lckPath(dir, 'live-cd.json');
		// Live owner (this process): the verdict must be 'live' and must
		// NOT record the cooldown (read-only pre-validation order).
		seedOwnerLock(
			lck,
			makePayload({ nonce: 'live-cd', ownerPid: process.pid }),
		);
		expect(
			breakStaleLockIfOwnerDead(lck, { class: 'dead-owner', store: 'generic' }),
		).toBe('live');
		// The owner dies (payload swaps to a provably-dead pid) WITHOUT the
		// clock advancing: with the pre-Finding-1 order the consumed budget
		// pinned 'live' for the whole LOCK_TIMEOUT_MS.
		seedOwnerLock(
			lck,
			makePayload({ nonce: 'dead-now', ownerPid: 999_999_999 }),
		);
		expect(
			breakStaleLockIfOwnerDead(lck, { class: 'dead-owner', store: 'generic' }),
		).toBe('broken');
		expect(fs.existsSync(lck)).toBe(false);
	}, 15_000);

	test('F3: unparsable existing marker is never taken over (posted-review HIGH)', () => {
		const dir = fx.scratch('lock-f3-');
		const lck = lckPath(dir, 'dead.json');
		seedOwnerLock(lck, makePayload({ nonce: 'dead', ownerPid: 999_999_999 }));
		const markerPath = `${lck}.breaking`;
		// A marker mid-publish (foreign bytes) must NOT be taken over.
		fs.writeFileSync(markerPath, '{"v":1,"break', 'utf-8');
		const before = fs.readFileSync(markerPath, 'utf-8');
		expect(
			breakStaleLockIfOwnerDead(lck, { class: 'dead-owner', store: 'generic' }),
		).toBe('unknown');
		expect(fs.existsSync(markerPath)).toBe(true);
		expect(fs.readFileSync(markerPath, 'utf-8')).toBe(before);
		expect(fs.existsSync(lck)).toBe(true);
		// Marker-stage verdicts consume NO cooldown (critic condition 1): the
		// second call must reach the marker path again ('unknown'), never the
		// cooldown-blocked 'live' — kills a record-above-the-marker-stage
		// mutant.
		expect(
			breakStaleLockIfOwnerDead(lck, { class: 'dead-owner', store: 'generic' }),
		).toBe('unknown');
	}, 15_000);

	test('F3b: dead breaker + UNAGED marker stays unknown until aging (PRR-030a)', () => {
		const dir = fx.scratch('lock-f3b-');
		const lck = lckPath(dir, 'aging.json');
		seedOwnerLock(lck, makePayload({ nonce: 'aging', ownerPid: 999_999_999 }));
		// Dead breaker pid, marker created 10s ago (< MARKER_STALE_MS 60s).
		seedMarker(lck, 999_999_998, 10_000, 'young-dead');
		expect(
			breakStaleLockIfOwnerDead(lck, { class: 'dead-owner', store: 'generic' }),
		).toBe('unknown');
		expect(fs.existsSync(lck)).toBe(true);
		// Follow-up call also 'unknown' (marker-age path, no budget consumed
		// — critic condition 1).
		expect(
			breakStaleLockIfOwnerDead(lck, { class: 'dead-owner', store: 'generic' }),
		).toBe('unknown');
	}, 15_000);

	test('F4: atomic marker publish leaves no `.cand.` residue (PRR-020 marker analog)', () => {
		const dir = fx.scratch('lock-f4-');
		const lck = lckPath(dir, 'aged.json');
		seedOwnerLock(lck, makePayload({ nonce: 'aged', ownerPid: 999_999_999 }));
		expect(
			breakStaleLockIfOwnerDead(lck, { class: 'dead-owner', store: 'generic' }),
		).toBe('broken');
		const locksDir = path.join(dir, '.swarm', 'locks');
		const residue = fs
			.readdirSync(locksDir)
			.filter((n) => n.includes('.cand.') || n.includes('.take.'));
		expect(residue).toEqual([]);
	}, 15_000);

	test('F5: cleanup sweeps aged `.breaking` and `.take.` residue (PRR-006/014)', () => {
		const dir = fx.scratch('lock-f5-');
		const lckAged = lckPath(dir, 'sweep.json');
		const lckFresh = lckPath(dir, 'fresh.json');
		fs.mkdirSync(path.dirname(lckAged), { recursive: true });
		const aged = new Date('2026-09-01T00:00:00.000Z'); // literal fixture epoch (check:test-clock)
		// Aged planted marker + aged takeover residue on target A: swept.
		seedMarker(lckAged, 999_999_999, 10 * 60 * 1000, 'planted');
		fs.utimesSync(`${lckAged}.breaking`, aged, aged);
		const takeResidue = `${lckAged}.breaking.take.deadbeef`;
		fs.writeFileSync(takeResidue, 'x', 'utf-8');
		fs.utimesSync(takeResidue, aged, aged);
		// A FRESH live-breaker marker on target B (this process owns the
		// pid) survives the sweep — active protocol state is not residue.
		seedMarker(lckFresh, process.pid, 0, 'live');
		expect(cleanupExpiredLocks(dir)).toBeGreaterThanOrEqual(2);
		expect(fs.existsSync(`${lckAged}.breaking`)).toBe(false);
		expect(fs.existsSync(takeResidue)).toBe(false);
		expect(fs.existsSync(`${lckFresh}.breaking`)).toBe(true);
	}, 15_000);

	test('F6a: legacy lane pairing — live-ish dir lock keeps bookkeeping (PRR-007, review Finding 2)', async () => {
		const dir = fx.scratch('lock-f6a-');
		const rel = 'lane/legacy-a.ts';
		const stem = await seedLegacyLane(dir, rel, 'lane-legacy');
		// A legacy dir lock present (holder may be live — cross-process
		// unlock is impossible and no liveness probe exists): NOTHING is
		// unlinked, nothing counted; the acquire probe's stale window steals
		// a crashed dir on the next acquisition, the mutual-exclusion probe
		// keeps the sentinel, and the orphaned meta is disclosed residue
		// (no production sweep, doctor lists locks not metas).
		expect(await releaseLaneLocks(dir, 'lane-legacy')).toBe(0);
		expect(fs.existsSync(`${stem}.lock`)).toBe(true);
		expect(fs.existsSync(`${stem}.lock.lock`)).toBe(true);
		expect(fs.existsSync(`${stem}.meta`)).toBe(true);
	}, 15_000);

	test('F6b: legacy lane pairing — bare sentinel (dir lock gone) drops bookkeeping (PRR-007)', async () => {
		const dir = fx.scratch('lock-f6b-');
		const rel = 'lane/legacy-b.ts';
		const stem = await seedLegacyLane(dir, rel, 'lane-legacy');
		// Holder finished: the dir lock is gone; only the sentinel + meta
		// remain — stale bookkeeping.
		fs.rmSync(`${stem}.lock.lock`, { recursive: true, force: true });
		expect(await releaseLaneLocks(dir, 'lane-legacy')).toBe(1);
		expect(fs.existsSync(`${stem}.lock`)).toBe(false);
		expect(fs.existsSync(`${stem}.meta`)).toBe(false);
	}, 15_000);

	test('F8: win32 legacy probe covers the base64(lowercased) alias (PRR-012)', async () => {
		if (process.platform !== 'win32') return;
		const dir = fx.scratch('lock-f8-');
		const rel = 'Case/Sensitive.ts';
		fs.mkdirSync(path.join(dir, 'Case'), { recursive: true });
		// Era-A writers keyed the sentinel under the base64 of the FULL
		// normalized (lowercased) path — the same form getLockFilePath probes.
		const normalized = path.resolve(dir, rel);
		const alias = Buffer.from(normalized.toLowerCase())
			.toString('base64')
			.replace(/[/+=]/g, '_');
		const sentinel = path.join(dir, '.swarm', 'locks', `${alias}.lock`);
		fs.mkdirSync(path.dirname(sentinel), { recursive: true });
		fs.writeFileSync(sentinel, '', 'utf-8');
		// A live Era-A holder excludes us only if the probe SEES the alias.
		const unlock = await lockfile.lock(sentinel, {
			realpath: false,
			retries: 0,
		});
		try {
			const result = await tryAcquireLock(dir, rel, 'agent', 'task');
			expect(result.acquired).toBe(false);
		} finally {
			await unlock();
		}
		// Released sentinel does not wedge the target.
		const after = await tryAcquireLock(dir, rel, 'agent', 'task');
		expect(after.acquired).toBe(true);
		if (after.acquired) await after.lock._release?.();
	}, 15_000);
});
