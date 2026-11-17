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

// Shared guarded read (#3262 2026-11-12 detection, run 43115686414): emit()
// writes through an async stream, so the FIRST waitUntil poll (which runs
// before any sleep) can hit the telemetry file before it exists — an ENOENT
// there must read as absence, not throw out of the predicate (the fixture's
// own readBreakEvents guards the identical read the same way). Every other
// error (EACCES, EIO, …) PROPAGATES — this is ENOENT-only, not a blanket
// swallow.
function readTelemetryOrEmpty(root: string): string {
	try {
		// biome-ignore format: the frozen C6 check requires catch within 3 lines of this guarded read
		return fs.readFileSync(path.join(root, '.swarm', 'telemetry.jsonl'), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
		throw error;
	}
}

function recoveredLines(root: string): string[] {
	return readTelemetryOrEmpty(root)
		.split('\n')
		.filter((l) => l.includes('"event":"evidence_lock_stale_recovered"'));
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
				readTelemetryOrEmpty(dir).includes('"event":"store_lock_stale_broken"'),
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
			() => readTelemetryOrEmpty(dir).includes('__flush_probe'),
			10_000,
			'sentinel flush',
		);
		expect(recoveredLines(dir)).toEqual([]);
	}, 20_000);
});

describe('guarded telemetry reader (#3262 detection, ENOENT-only)', () => {
	test('a missing telemetry file reads as absence (first-poll ENOENT tolerance)', () => {
		const dir = fx.scratch('ev-enoent-');
		// No initTelemetry: .swarm/telemetry.jsonl does not exist yet — exactly
		// the first-poll shape of run 43115686414.
		expect(readTelemetryOrEmpty(dir)).toBe('');
		expect(recoveredLines(dir)).toEqual([]);
	});

	test('non-ENOENT read errors propagate out of the reader', () => {
		const dir = fx.scratch('ev-eacces-');
		// A DIRECTORY at the telemetry path makes the guarded read fail with
		// EISDIR — a non-ENOENT error that must NOT be swallowed.
		fs.mkdirSync(path.join(dir, '.swarm', 'telemetry.jsonl'), {
			recursive: true,
		});
		expect(() => readTelemetryOrEmpty(dir)).toThrow();
	});
});
