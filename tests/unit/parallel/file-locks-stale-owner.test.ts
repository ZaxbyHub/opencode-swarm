/**
 * J20 lock-substrate suite (#2967/#2969) — plan 05 v8 §1.4 arms, pinning the
 * critic-round 3-7 interleavings. Real child processes play dead/live owners;
 * a marker file plays live release; hand-seeded `.lck`/`.breaking` artifacts
 * pin the fenced breaker's classification gates. Shared holder/child/telemetry
 * harness: tests/helpers/lock-holder-2967.ts + fixtures/owner-lock-holder-2967.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	EvidenceLockTimeoutError,
	withEvidenceLock,
} from '../../../src/evidence/lock.js';
import {
	acquireLaneLocks,
	breakStaleLockIfOwnerDead,
	cleanupExpiredLocks,
	_internals as fileLocksInternals,
	getOwnerLockPath,
	listActiveLocks,
	type OwnerLockPayload,
	releaseLaneLocks,
	releaseOwnerLock,
	tryAcquireLock,
} from '../../../src/parallel/file-locks.js';
import {
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';
import {
	createLockFixture,
	type LockFixture,
	makePayload,
	SIX_MIN_AGO,
	seedMarker,
	seedOwnerLock,
	sleep,
	TWO_MIN_AGO_MS,
	waitUntil,
} from '../../helpers/lock-holder-2967.js';

let fx: LockFixture;

// Compact call-shapes used by nearly every arm.
const breakDeadOwner = (lck: string) =>
	breakStaleLockIfOwnerDead(lck, { class: 'dead-owner', store: 'evidence' });
const tryLock = (dir: string, rel: string) =>
	tryAcquireLock(dir, rel, 'agent', 'task');
const withEv = (
	dir: string,
	rel: string,
	ms: number,
	fn: () => Promise<string>,
) => withEvidenceLock(dir, rel, 'a', 't', fn, ms);

beforeEach(() => {
	resetTelemetryForTesting();
	fx = createLockFixture();
});

afterEach(() => {
	fx.dispose();
	resetTelemetryForTesting();
});

describe('file-locks — stale owner substrate (#2967 plan 05 v8 §1.4)', () => {
	test('arm 1: dead-owner recovery is bounded with exactly ONE telemetry event', async () => {
		const dir = fx.scratch('lock-arm1-');
		initTelemetry(dir);
		const rel = 'evidence/arm1.json';
		const ready = path.join(dir, 'ready.json');
		const child = fx.spawnHolder(['--evidence', dir, rel, '--ready', ready]);
		expect(await fx.waitReady(ready)).toBe(child.pid);
		await fx.killAndAwait(child);

		const t0 = performance.now(); // elapsed bound idiom (check:test-clock)
		expect(await withEv(dir, rel, 4000, async () => 'recovered')).toBe(
			'recovered',
		);
		expect(performance.now() - t0).toBeLessThan(4000);

		const breaks = (await fx.readBreakEvents(dir)).filter(
			(e) => e.store === 'evidence',
		);
		expect(breaks).toHaveLength(1);
		// Identifier-free payload class (plan §1.3): no paths, no pids.
		expect(Object.keys(breaks[0]!).sort()).toEqual([
			'ageMs',
			'event',
			'store',
			'timestamp',
		]);
	}, 20_000);

	test('arm 2: live owner times out intact, then marker-file release re-acquires', async () => {
		const dir = fx.scratch('lock-arm2-');
		const rel = 'evidence/arm2.json';
		const ready = path.join(dir, 'ready.json');
		const marker = path.join(dir, 'release.txt');
		fx.spawnHolder([
			'--evidence',
			dir,
			rel,
			'--ready',
			ready,
			'--release-on-marker',
			marker,
		]);
		await fx.waitReady(ready);
		const lck = getOwnerLockPath(dir, rel);

		let timedOut: unknown;
		try {
			await withEv(dir, rel, 1500, async () => 'must-not-run');
		} catch (err) {
			timedOut = err;
		}
		expect(timedOut).toBeInstanceOf(EvidenceLockTimeoutError);
		// Holder still holds — the live lock was never touched.
		expect(fs.existsSync(lck)).toBe(true);

		fs.writeFileSync(marker, 'go');
		await waitUntil(
			() => fs.existsSync(`${ready}.released`),
			10_000,
			'holder released',
		);
		expect(await withEv(dir, rel, 4000, async () => 'reacquired')).toBe(
			'reacquired',
		);
	}, 20_000);

	test('arm 3: genuinely-live pid is NEVER broken regardless of age/mtime', async () => {
		const dir = fx.scratch('lock-arm3-');
		initTelemetry(dir);
		const lck = getOwnerLockPath(dir, 'live-forever.ts');
		const raw = seedOwnerLock(
			lck,
			makePayload({ ownerPid: process.pid }),
			SIX_MIN_AGO(),
		);
		expect(breakDeadOwner(lck)).toBe('live');
		expect(fs.readFileSync(lck, 'utf-8')).toBe(raw);
		expect(await fx.readBreakEvents(dir)).toHaveLength(0);
	});

	test('arm 4: identity-fenced release — foreign triple never unlinks', () => {
		const dir = fx.scratch('lock-arm4-');
		const lck = getOwnerLockPath(dir, 'fence.ts');
		const ours =
			performance.timeOrigin +
			performance.now() -
			Math.floor(process.uptime() * 1000); // startBoundMs derivation without a raw clock read
		const self = { ownerPid: process.pid, startBoundMs: ours, nonce: 'x' };
		seedOwnerLock(
			lck,
			makePayload({ nonce: 'foreign', ownerPid: 3_000_003, startBoundMs: 42 }),
		);
		releaseOwnerLock(lck, self);
		expect(fs.existsSync(lck)).toBe(true);

		seedOwnerLock(lck, makePayload(self));
		releaseOwnerLock(lck, self);
		expect(fs.existsSync(lck)).toBe(false);
	});

	test('arm 5: live owner beyond TTL stays listed + uncleaned INDEFINITELY', async () => {
		const dir = fx.scratch('lock-arm5-');
		const lck = getOwnerLockPath(dir, 'live-stale.ts');
		seedOwnerLock(
			lck,
			makePayload({ ownerPid: process.pid, agent: 'live-agent' }),
			SIX_MIN_AGO(),
		);
		const listed = () => listActiveLocks(dir).filter((l) => l.filePath === lck);
		expect(listed()).toHaveLength(1);
		expect(listed()[0]!.agent).toBe('live-agent');
		// Live heartbeat: active with no expiry horizon (r7-#2).
		expect(listed()[0]!.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
		expect(cleanupExpiredLocks(dir)).toBe(0);
		expect(fs.existsSync(lck)).toBe(true);
		expect(listed()).toHaveLength(1);
	});

	test('arm 6: ownerless past-TTL recovers via ttl-cleanup; fresh times out (AC4)', async () => {
		const dir = fx.scratch('lock-arm6-');
		initTelemetry(dir);
		seedOwnerLock(
			getOwnerLockPath(dir, 'ownerless-old.json'),
			'',
			SIX_MIN_AGO(),
		);
		seedOwnerLock(getOwnerLockPath(dir, 'ownerless-fresh.json'), '');

		const t0 = performance.now(); // elapsed bound idiom (check:test-clock)
		expect(
			await withEv(dir, 'ownerless-old.json', 4000, async () => 'ok'),
		).toBe('ok');
		expect(performance.now() - t0).toBeLessThan(4000);
		expect(
			(await fx.readBreakEvents(dir)).filter((e) => e.store === 'evidence'),
		).toHaveLength(1);

		let timedOut: unknown;
		try {
			await withEv(dir, 'ownerless-fresh.json', 800, async () => 'no');
		} catch (err) {
			timedOut = err;
		}
		expect(timedOut).toBeInstanceOf(EvidenceLockTimeoutError);
	}, 20_000);

	test('arm 7: cooldown — one event and one liveness probe per target/window', async () => {
		const dir = fx.scratch('lock-arm7-');
		initTelemetry(dir);
		const lck = getOwnerLockPath(dir, 'cooldown.ts');
		const deadPid = await fx.acquireDeadPid();
		// Counting liveness-probe wrapper delegating to the REAL kill.
		let killCalls = 0;
		fileLocksInternals.kill = (pid: number, signal?: number | string) => {
			killCalls += 1;
			return fx.realKill(pid, signal);
		};

		seedOwnerLock(lck, makePayload({ ownerPid: deadPid }));
		expect(breakDeadOwner(lck)).toBe('broken');
		// The one break probes liveness twice (read-only pre-validation +
		// the final pre-unlink recheck — review round-2 hardening).
		expect(killCalls).toBe(2);
		// A second dead-owner generation on the SAME target inside the
		// cooldown window: classified 'live' with no probe, no event.
		seedOwnerLock(lck, makePayload({ ownerPid: deadPid, nonce: 'second' }));
		expect(breakDeadOwner(lck)).toBe('live');
		expect(killCalls).toBe(2);
		expect(
			(await fx.readBreakEvents(dir)).filter((e) => e.store === 'evidence'),
		).toHaveLength(1);
	}, 20_000);

	test('arm 8: contention leaves no residue — the holder file always parses', async () => {
		const dir = fx.scratch('lock-arm8-');
		const rel = 'residue.ts';
		const lck = getOwnerLockPath(dir, rel);
		const held = await tryLock(dir, rel);
		expect(held.acquired).toBe(true);
		if (!held.acquired) return;
		const original = fs.readFileSync(lck, 'utf-8');
		const holderNonce = (JSON.parse(original) as OwnerLockPayload).nonce;

		const contention = Promise.all([
			tryAcquireLock(dir, rel, 'loser-a', 't'),
			tryAcquireLock(dir, rel, 'loser-b', 't'),
			tryAcquireLock(dir, rel, 'loser-c', 't'),
		]);
		const t0 = performance.now(); // elapsed bound idiom (check:test-clock)
		let reads = 0;
		while (performance.now() - t0 < 500) {
			const parsed = JSON.parse(
				fs.readFileSync(lck, 'utf-8'),
			) as OwnerLockPayload;
			expect(parsed.v).toBe(1);
			expect(parsed.nonce).toBe(holderNonce);
			reads += 1;
			await sleep(10);
		}
		const results = await contention;
		expect(results.every((r) => r.acquired === false)).toBe(true);
		expect(reads).toBeGreaterThan(10);
		// Exactly one artifact survives: the holder's, byte-identical.
		expect(fs.readdirSync(path.dirname(lck))).toHaveLength(1);
		expect(fs.readFileSync(lck, 'utf-8')).toBe(original);
		await held.lock._release?.();
		expect(fs.readdirSync(path.dirname(lck))).toHaveLength(0);
	}, 20_000);

	test('arm 9: two-phase acquire — a LIVE breaker marker blocks without residue', async () => {
		const dir = fx.scratch('lock-arm9-');
		const rel = 'twophase.ts';
		const lck = getOwnerLockPath(dir, rel);
		fs.mkdirSync(path.dirname(lck), { recursive: true });
		seedMarker(lck, process.pid, 0, 'live-breaker');
		expect((await tryLock(dir, rel)).acquired).toBe(false);
		// Phase-3 self-release: no `.lck` was created (or it was removed).
		expect(fs.existsSync(lck)).toBe(false);
		// The marker is the breaker's property — untouched by the loser.
		expect(fs.existsSync(`${lck}.breaking`)).toBe(true);
	}, 10_000);

	test('arm 10: break succeeds; a DEAD breaker marker past 60s is takeable', async () => {
		const dir = fx.scratch('lock-arm10-');
		const deadPid = await fx.acquireDeadPid();
		const lckA = getOwnerLockPath(dir, 'plain-break.ts');
		seedOwnerLock(lckA, makePayload({ ownerPid: deadPid }));
		expect(breakDeadOwner(lckA)).toBe('broken');
		expect(fs.existsSync(lckA)).toBe(false);

		// Distinct target => independent cooldown entry.
		const lckB = getOwnerLockPath(dir, 'takeover.ts');
		seedOwnerLock(lckB, makePayload({ ownerPid: deadPid }));
		seedMarker(lckB, deadPid, TWO_MIN_AGO_MS, 'stale-marker');
		expect(breakDeadOwner(lckB)).toBe('broken');
		expect(fs.existsSync(lckB)).toBe(false);
		// Takeover executed: the stale marker was consumed, our marker was
		// removed in the finally, and no `.take.` residue remains.
		expect(fs.readdirSync(path.dirname(lckB))).toHaveLength(0);
	}, 20_000);

	test('arm 11: paused-LIVE breaker is untouchable regardless of marker age', async () => {
		const dir = fx.scratch('lock-arm11-');
		const lck = getOwnerLockPath(dir, 'paused-breaker.ts');
		const lockRaw = seedOwnerLock(lck, makePayload({ ownerPid: 3_000_011 }));
		const markerRaw = seedMarker(
			lck,
			process.pid,
			TWO_MIN_AGO_MS,
			'paused-live',
		);
		expect(breakDeadOwner(lck)).toBe('live');
		expect(fs.readFileSync(lck, 'utf-8')).toBe(lockRaw);
		expect(fs.readFileSync(`${lck}.breaking`, 'utf-8')).toBe(markerRaw);
	});

	test('arm 12: legacy probe — live legacy holder excludes; released sentinel does not wedge', async () => {
		const dir = fx.scratch('lock-arm12-');
		const heldRel = 'legacy-held.ts';
		const sentinel = getOwnerLockPath(dir, heldRel).replace(/\.lck$/, '.lock');
		fs.mkdirSync(path.dirname(sentinel), { recursive: true });
		fs.writeFileSync(sentinel, '', 'utf-8');
		const ready = path.join(dir, 'legacy-ready.json');
		const child = fx.spawnHolder(['--legacy-held', sentinel, '--ready', ready]);
		await fx.waitReady(ready);

		expect((await tryLock(dir, heldRel)).acquired).toBe(false);
		// The probe rejection released our `.lck` — no residue.
		expect(fs.existsSync(getOwnerLockPath(dir, heldRel))).toBe(false);
		await fx.killAndAwait(child);

		// Released legacy sentinel: file present, no dir => probe passes.
		const freeRel = 'legacy-free.ts';
		const freed = getOwnerLockPath(dir, freeRel).replace(/\.lck$/, '.lock');
		fs.writeFileSync(freed, '', 'utf-8');
		const ok = await tryLock(dir, freeRel);
		expect(ok.acquired).toBe(true);
		if (ok.acquired) await ok.lock._release?.();
	}, 20_000);

	test('arm 13: lane-vs-plain mutual exclusion on a shared target', async () => {
		const dir = fx.scratch('lock-arm13-');
		const rel = 'shared-target.ts';
		const lane = await acquireLaneLocks(
			dir,
			'lane-13',
			[rel],
			'agent',
			'task',
			'session',
		);
		expect(lane.acquired).toBe(true);
		expect((await tryLock(dir, rel)).acquired).toBe(false);
		expect(await releaseLaneLocks(dir, 'lane-13')).toBe(1);
		const after = await tryLock(dir, rel);
		expect(after.acquired).toBe(true);
		if (after.acquired) await after.lock._release?.();
	}, 10_000);

	test('arm 14: lane release exact-generation — corrupted payload survives release', async () => {
		const dir = fx.scratch('lock-arm14-');
		const rel = 'generation.ts';
		const deadPid = await fx.acquireDeadPid();
		const lane = await acquireLaneLocks(
			dir,
			'lane-14',
			[rel],
			'agent',
			'task',
			'session',
		);
		expect(lane.acquired).toBe(true);
		const lck = getOwnerLockPath(dir, rel);
		const metaPath = lck.replace(/\.lck$/, '.meta');
		expect(fs.existsSync(metaPath)).toBe(true);

		// Replace the payload with a FOREIGN generation before release.
		const foreignRaw = seedOwnerLock(
			lck,
			makePayload({ nonce: 'foreign', ownerPid: deadPid }),
		);
		// Feedback PRR-005: the fence refuses (foreign generation), and the
		// meta sidecar is RETAINED — bookkeeping for the still-held live
		// `.lck` — instead of orphaning a lock with zero bookkeeping.
		expect(await releaseLaneLocks(dir, 'lane-14')).toBe(0);
		expect(fs.existsSync(metaPath)).toBe(true);
		expect(fs.existsSync(lck)).toBe(true);
		expect(fs.readFileSync(lck, 'utf-8')).toBe(foreignRaw);
	}, 20_000);

	test('arm 15: multiprocess barrier — 2 children + parent, 3 acquisitions, zero double-hold', async () => {
		const dir = fx.scratch('lock-arm15-');
		const rel = 'barrier.ts';
		const go = path.join(dir, 'go.json');
		const readyA = path.join(dir, 'ready-a.json');
		const readyB = path.join(dir, 'ready-b.json');
		const resultA = path.join(dir, 'result-a.json');
		const resultB = path.join(dir, 'result-b.json');
		fx.spawnHolder(['--race', dir, rel, go, resultA, '--ready', readyA]);
		fx.spawnHolder(['--race', dir, rel, go, resultB, '--ready', readyB]);
		await fx.waitReady(readyA);
		await fx.waitReady(readyB);
		fs.writeFileSync(go, 'go');

		const lck = getOwnerLockPath(dir, rel);
		let parentAcquired = 0;
		let parentVerified = false;
		const deadline = performance.now() + 30_000;
		while (parentAcquired < 1 && performance.now() < deadline) {
			const result = await tryAcquireLock(dir, rel, 'parent', 'race');
			if (result.acquired) {
				const payload = JSON.parse(
					fs.readFileSync(lck, 'utf-8'),
				) as OwnerLockPayload;
				parentVerified = payload.ownerPid === process.pid;
				parentAcquired += 1;
				await sleep(25);
				await result.lock._release?.();
			} else {
				await sleep(5);
			}
		}
		expect(parentAcquired).toBe(1);
		expect(parentVerified).toBe(true);

		const read = async (file: string) => {
			await waitUntil(() => fs.existsSync(file), 30_000, `result ${file}`);
			return JSON.parse(fs.readFileSync(file, 'utf-8')) as {
				acquired: number;
				verified: boolean;
			};
		};
		const ra = await read(resultA);
		const rb = await read(resultB);
		expect(ra.acquired + rb.acquired + parentAcquired).toBe(3);
		expect(ra.verified).toBe(true);
		expect(rb.verified).toBe(true);
		// No residue once every acquire-hold-release cycle finished.
		await waitUntil(
			() => fs.readdirSync(path.dirname(lck)).length === 0,
			10_000,
			'barrier lock dir drained',
		);
	}, 40_000);
});
