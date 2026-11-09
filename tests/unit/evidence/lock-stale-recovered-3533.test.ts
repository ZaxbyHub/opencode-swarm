// PR #3533 feedback (PRR-010/029): the evidence_lock_stale_recovered emit
// gate now keys on the breaker's confirmed-break flag alone — the old
// `attempt > 0` conjunct suppressed the event on exactly the primary
// recovery path (the break's `continue` skips the attempt increment).
// Presence arm: a dead owner + successful recovery MUST produce the event.
// Absence arm: plain success-after-contention is NOT stale recovery — no
// event without a confirmed break (and never on a fresh acquire).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withEvidenceLock } from '../../../src/evidence/lock.js';
import { emit, initTelemetry } from '../../../src/telemetry.js';
import {
	createLockFixture,
	type LockFixture,
	waitUntil,
} from '../../helpers/lock-holder-2967.js';

let fx: LockFixture;

beforeEach(() => {
	fx = createLockFixture();
});

afterEach(() => {
	fx.dispose();
});

function recoveredLines(root: string): string[] {
	try {
		return fs
			.readFileSync(path.join(root, '.swarm', 'telemetry.jsonl'), 'utf-8')
			.split('\n')
			.filter((l) => l.includes('"event":"evidence_lock_stale_recovered"'));
	} catch {
		return [];
	}
}

describe('evidence lock — stale_recovered emit gate (feedback PRR-010/029)', () => {
	test('presence: dead-owner recovery emits evidence_lock_stale_recovered on the primary path', async () => {
		const dir = fx.scratch('ev-recover-');
		initTelemetry(dir);
		const rel = 'evidence/recovered.json';
		const ready = path.join(dir, 'ready.json');
		const child = fx.spawnHolder(['--evidence', dir, rel, '--ready', ready]);
		expect(await fx.waitReady(ready)).toBe(child.pid);
		await fx.killAndAwait(child);

		const out = await withEvidenceLock(
			dir,
			rel,
			'a',
			't',
			async () => 'ok',
			8000,
		);
		expect(out).toBe('ok');

		// Flush barrier: the break event orders after the recovered event on
		// the same stream — once visible, the recovered line is too.
		await waitUntil(
			() =>
				fs
					.readFileSync(path.join(dir, '.swarm', 'telemetry.jsonl'), 'utf-8')
					.includes('"event":"store_lock_stale_broken"'),
			10_000,
			'break event flush',
		);
		expect(recoveredLines(dir)).toHaveLength(1);
	}, 20_000);

	test('absence: a fresh uncontended acquire never emits stale_recovered', async () => {
		const dir = fx.scratch('ev-fresh-');
		initTelemetry(dir);
		const out = await withEvidenceLock(
			dir,
			'fresh.json',
			'a',
			't',
			async () => 'ok',
			4000,
		);
		expect(out).toBe('ok');
		// Force a flush with a sentinel break-store value (identifier-free
		// operational payload — same class as production emissions).
		emit('store_lock_stale_broken', { store: '__flush_probe', ageMs: 0 });
		await waitUntil(
			() =>
				fs
					.readFileSync(path.join(dir, '.swarm', 'telemetry.jsonl'), 'utf-8')
					.includes('__flush_probe'),
			10_000,
			'sentinel flush',
		);
		expect(recoveredLines(dir)).toEqual([]);
	}, 20_000);
});
