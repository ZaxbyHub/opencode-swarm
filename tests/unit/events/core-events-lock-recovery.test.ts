/**
 * J20 events-store lock recovery (#2967) — plan 05 v8 §1.4 core-events arms.
 * The store lock (`.swarm/events.lock`) rides the shared wx owner-payload
 * state machine: a dead holder is broken ms-scale with one audited event; a
 * live holder keeps the historical fail-fast; an ownerless legacy lock keeps
 * AC4's TTL-only semantics; the break cooldown bounds liveness probes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	appendCoreEventSync,
	CORE_EVENT_LOCKED,
	coreEventsFilePath,
} from '../../../src/events/core-events.js';
import { _internals as fileLocksInternals } from '../../../src/parallel/file-locks.js';
import {
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';
import {
	createLockFixture,
	type LockFixture,
	makePayload,
	seedOwnerLock,
} from '../../helpers/lock-holder-2967.js';

let fx: LockFixture;

const eventsLockPath = (dir: string) => path.join(dir, '.swarm', 'events.lock');
const probeEvent = (id: string) => ({
	type: 'lock-recovery-probe',
	probeId: id,
	at: '2026-10-31T12:00:00.000Z', // literal fixture timestamp (house convention; inert field)
});

beforeEach(() => {
	resetTelemetryForTesting();
	fx = createLockFixture();
});

afterEach(() => {
	fx.dispose();
	resetTelemetryForTesting();
});

describe('core-events store lock recovery (#2967)', () => {
	test('dead owner: append lands, ms-scale recovery, ONE store:events event', async () => {
		const dir = fx.scratch('ev-rec-dead-');
		initTelemetry(dir);
		const ready = path.join(dir, 'ready.json');
		const child = fx.spawnHolder(['--events', dir, '--ready', ready]);
		expect(await fx.waitReady(ready)).toBe(child.pid);
		await fx.killAndAwait(child);

		const t0 = performance.now(); // elapsed bound: performance.now is the house idiom for duration assertions
		expect(() =>
			appendCoreEventSync(dir, probeEvent('dead-owner')),
		).not.toThrow();
		const elapsed = performance.now() - t0;
		// Dead-owner recovery is ms-scale (C2), not a 5-minute TTL wedge.
		expect(elapsed).toBeLessThan(1500);

		const store = fs.readFileSync(coreEventsFilePath(dir), 'utf-8');
		expect(store).toContain('"probeId":"dead-owner"');
		expect(
			(await fx.readBreakEvents(dir)).filter((e) => e.store === 'events'),
		).toHaveLength(1);
	}, 20_000);

	test('empty legacy lock with fresh mtime: CORE_EVENT_STORE_LOCKED (AC4)', async () => {
		const dir = fx.scratch('ev-rec-empty-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(eventsLockPath(dir), '', 'utf-8');
		expect(() => appendCoreEventSync(dir, probeEvent('fresh-empty'))).toThrow(
			CORE_EVENT_LOCKED,
		);
		expect(fs.existsSync(coreEventsFilePath(dir))).toBe(false);
	}, 10_000);

	test('live owner: fail-fast unchanged, well under 1 s', async () => {
		const dir = fx.scratch('ev-rec-live-');
		seedOwnerLock(
			eventsLockPath(dir),
			makePayload({ ownerPid: process.pid, agent: 'core-events' }),
		);
		const t0 = performance.now(); // elapsed bound: performance.now is the house idiom for duration assertions
		expect(() => appendCoreEventSync(dir, probeEvent('live-owner'))).toThrow(
			CORE_EVENT_LOCKED,
		);
		// ~100 ms budget (20 rounds x 5 ms + one breaker probe) pinned
		// behaviorally under the single-attempt policy (r5-#3).
		expect(performance.now() - t0).toBeLessThan(1000);
		expect(fs.existsSync(coreEventsFilePath(dir))).toBe(false);
	});

	test('cooldown: two immediate dead-owner contentions — one probe, one event', async () => {
		const dir = fx.scratch('ev-rec-cool-');
		initTelemetry(dir);
		const lockPath = eventsLockPath(dir);
		const deadPid = await fx.acquireDeadPid();
		let killCalls = 0;
		fileLocksInternals.kill = (pid: number, signal?: number | string) => {
			killCalls += 1;
			return fx.realKill(pid, signal);
		};

		seedOwnerLock(lockPath, makePayload({ ownerPid: deadPid }));
		expect(() =>
			appendCoreEventSync(dir, probeEvent('cooldown-first')),
		).not.toThrow();

		// Second dead-owner generation on the SAME lock path, still inside
		// the cooldown window: classified 'live' with no liveness probe.
		seedOwnerLock(lockPath, makePayload({ ownerPid: deadPid, nonce: 'b' }));
		expect(() =>
			appendCoreEventSync(dir, probeEvent('cooldown-second')),
		).toThrow(CORE_EVENT_LOCKED);

		// Deterministic cooldown block => exactly one probe (spec bound 2).
		expect(killCalls).toBe(1);
		expect(
			(await fx.readBreakEvents(dir)).filter((e) => e.store === 'events'),
		).toHaveLength(1);
		const store = fs.readFileSync(coreEventsFilePath(dir), 'utf-8');
		expect(store).toContain('"probeId":"cooldown-first"');
		expect(store).not.toContain('"probeId":"cooldown-second"');
	}, 20_000);
});
