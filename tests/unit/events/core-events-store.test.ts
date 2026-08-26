/**
 * Issue #2039 — bounded core event store for `.swarm/events.jsonl` (store).
 *
 * Store-level contract of src/events/core-events.ts (the #2037
 * telemetry.ts house pattern applied to the shared event bus):
 * atomic first write (manifest + event), byte-exact line preservation for
 * BOTH `event:` and `type:` discriminators, coverage disclosure, lifetime
 * counting (folded + window), byte/entry/age budget compaction with the
 * authority-set age exemption, torn-tail re-framing, dedupe opt-in absence,
 * typed oversize/lock errors, check-interval maintenance, and the legacy
 * header-less migration in bounded passes.
 *
 * Tests override `_internals.limits` (small budgets) and `_internals.emitHealth`
 * and restore them in `afterEach` (the `_internals` DI seam is file-scoped and
 * leak-free across Bun's shared test-runner process).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { withFrozenClock } from '../../helpers/test-clock.js';

/** Deterministic fixture timestamp (test-clock lint, issue #1782). */
const FIXED_TS = withFrozenClock(() => new Date().toISOString());

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	_resetMaintenanceCounters,
	appendCoreEventSync,
	CORE_EVENT_LIMITS,
	type CoreEventLimits,
	compactCoreEvents,
	getCoreEventCoverage,
	getCoreEventLifetimeCount,
	readCoreEvents,
} from '../../../src/events/core-events';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function mkTempDir(): string {
	return canonicalMkdtemp('core-events-store-');
}

function eventsFile(dir: string): string {
	return path.join(dir, '.swarm', 'events.jsonl');
}

function rawLines(dir: string): string[] {
	return fs
		.readFileSync(eventsFile(dir), 'utf-8')
		.split('\n')
		.filter((l) => l.trim() !== '');
}

function manifestOf(dir: string): {
	folded: {
		totalEvents: number;
		byType: Record<string, number>;
		corrupt: number;
		dropped: number;
	};
	schemaVersion: number;
	type: string;
} {
	return JSON.parse(rawLines(dir)[0] ?? '{}');
}

function windowSeqs(dir: string): number[] {
	return rawLines(dir)
		.slice(1)
		.map((l) => JSON.parse(l) as { seq: number })
		.map((e) => e.seq);
}

/** Small budgets, clock-decoupled (ageMaxMs disabled), maintenance manual. */
function tinyLimits(over: Partial<CoreEventLimits> = {}): CoreEventLimits {
	return {
		...CORE_EVENT_LIMITS,
		ageMaxMs: Number.MAX_SAFE_INTEGER,
		checkInterval: 1_000_000,
		...over,
	};
}

function opEvent(seq: number, pad = 80): Record<string, unknown> {
	return {
		type: 'op',
		seq,
		pad: 'x'.repeat(pad),
		timestamp: '2026-01-01T00:00:00.000Z',
	};
}

describe('core event store — bounded store contract (issue #2039)', () => {
	let dir: string;
	const originalEmitHealth = _internals.emitHealth;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let health: { payloads: any[] };

	beforeEach(() => {
		dir = mkTempDir();
		health = { payloads: [] };
		_resetMaintenanceCounters();
		_internals.emitHealth = ((
			_directory: string,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			payload: any,
		) => {
			health.payloads.push(payload);
		}) as typeof _internals.emitHealth;
	});

	afterEach(() => {
		_internals.limits = CORE_EVENT_LIMITS as typeof _internals.limits;
		_internals.emitHealth = originalEmitHealth;
		_resetMaintenanceCounters();
		fs.rmSync(dir, { force: true, recursive: true });
	});

	describe('first write + byte preservation', () => {
		test('first append atomically creates manifest + event; lines are byte-exact for both discriminators', () => {
			_internals.limits = tinyLimits();
			const byEvent = { event: 'tool_call', seq: 1, ok: true };
			const byType = { type: 'phase_complete', seq: 2, phase: 'implement' };

			appendCoreEventSync(dir, byEvent);
			const lines = rawLines(dir);
			expect(lines.length).toBe(2);
			const manifest = manifestOf(dir);
			expect(manifest.type).toBe('swarm-events-manifest');
			expect(manifest.schemaVersion).toBe(1);
			expect(manifest.folded.totalEvents).toBe(0);
			// Byte-exact: the store never normalizes producer schemas.
			expect(lines[1]).toBe(JSON.stringify(byEvent));

			appendCoreEventSync(dir, byType);
			const linesAfter = rawLines(dir);
			expect(linesAfter.length).toBe(3);
			expect(linesAfter[1]).toBe(JSON.stringify(byEvent)); // untouched
			expect(linesAfter[2]).toBe(JSON.stringify(byType));

			expect(readCoreEvents(dir).coverage).toBe('complete');
			expect(readCoreEvents(dir).text).toContain(JSON.stringify(byEvent));
			expect(getCoreEventLifetimeCount(dir)).toBe(2);
		});
	});

	describe('coverage + lifetime disclosure', () => {
		test('coverage states: empty (missing file), complete (bounded store), truncated (legacy file over the read bound)', () => {
			_internals.limits = tinyLimits();
			// Missing file -> empty.
			expect(readCoreEvents(dir)).toEqual({
				text: '',
				truncated: false,
				coverage: 'empty',
			});
			expect(getCoreEventCoverage(dir)).toBe('empty');
			expect(getCoreEventLifetimeCount(dir)).toBe(0);

			// Bounded store -> complete.
			for (let i = 0; i < 3; i += 1) appendCoreEventSync(dir, opEvent(i));
			expect(readCoreEvents(dir).coverage).toBe('complete');
			expect(readCoreEvents(dir).truncated).toBe(false);
			expect(getCoreEventCoverage(dir)).toBe('complete');

			// Legacy header-less file larger than a small read bound -> truncated.
			const legacyDir = mkTempDir();
			try {
				fs.mkdirSync(path.join(legacyDir, '.swarm'), { recursive: true });
				const legacy: string[] = [];
				for (let i = 0; i < 10; i += 1) {
					legacy.push(JSON.stringify(opEvent(i)));
				}
				fs.writeFileSync(
					eventsFile(legacyDir),
					`${legacy.join('\n')}\n`,
					'utf-8',
				);
				expect(fs.statSync(eventsFile(legacyDir)).size).toBeGreaterThan(500);
				_internals.limits = tinyLimits({ readMaxBytes: 500 });
				const result = readCoreEvents(legacyDir);
				expect(result.coverage).toBe('truncated');
				expect(result.truncated).toBe(true);
				expect(result.text.length).toBeGreaterThan(0);
				expect(getCoreEventCoverage(legacyDir)).toBe('truncated');
			} finally {
				fs.rmSync(legacyDir, { force: true, recursive: true });
			}
		});

		test('lifetime count = folded (manifest) + retained window count', () => {
			_internals.limits = tinyLimits({ activeMaxEntries: 2 });
			for (let i = 0; i < 6; i += 1) appendCoreEventSync(dir, opEvent(i));
			compactCoreEvents(dir);
			const manifest = manifestOf(dir);
			const windowCount = rawLines(dir).length - 1;
			expect(manifest.folded.totalEvents).toBe(4);
			expect(windowCount).toBe(2);
			expect(getCoreEventLifetimeCount(dir)).toBe(
				manifest.folded.totalEvents + windowCount,
			);
			expect(getCoreEventLifetimeCount(dir)).toBe(6);
		});
	});

	describe('budget compaction', () => {
		test('byte-cap compaction folds the OLDEST lines into the manifest (totals + byType preserved)', () => {
			// Append first, then derive a byte budget that fits EXACTLY the
			// newest 6 lines (+ manifest) so the test is not fragile to exact
			// serialized sizes. Maintenance is manual (checkInterval huge).
			for (let i = 0; i < 8; i += 1) appendCoreEventSync(dir, opEvent(i));
			const lineBytes = Buffer.byteLength(`${JSON.stringify(opEvent(0))}\n`);
			const manifestBytes = Buffer.byteLength(rawLines(dir)[0] ?? '');
			const budget = manifestBytes + 6 * lineBytes + Math.floor(lineBytes / 2);
			_internals.limits = tinyLimits({ activeMaxBytes: budget });
			compactCoreEvents(dir);
			expect(windowSeqs(dir)).toEqual([2, 3, 4, 5, 6, 7]); // newest retained
			const manifest = manifestOf(dir);
			expect(manifest.folded.totalEvents).toBe(2);
			expect(manifest.folded.byType.op).toBe(2);
			expect(getCoreEventLifetimeCount(dir)).toBe(8);
		});

		test('entry-cap compaction retains only the newest N lines', () => {
			_internals.limits = tinyLimits({ activeMaxEntries: 2 });
			for (let i = 0; i < 6; i += 1) appendCoreEventSync(dir, opEvent(i));
			compactCoreEvents(dir);
			expect(windowSeqs(dir)).toEqual([4, 5]);
			const manifest = manifestOf(dir);
			expect(manifest.folded.totalEvents).toBe(4);
			expect(manifest.folded.byType.op).toBe(4);
			expect(getCoreEventLifetimeCount(dir)).toBe(6);
		});

		test('age-cap folds old OPERATIONAL events but never ages the authority set; authority lines still obey byte/count budgets', () => {
			// Phase A: generous budgets — the old authority line must stay in the
			// window even though its timestamp is ancient; the old operational
			// line is folded and counted dropped.
			_internals.limits = tinyLimits({ ageMaxMs: 60_000 });
			const oldTs = '2000-01-01T00:00:00.000Z';
			appendCoreEventSync(dir, { type: 'op_old', seq: 0, timestamp: oldTs });
			appendCoreEventSync(dir, {
				type: 'task_workflow_repaired',
				taskId: 'T1',
				transitionId: 'tr-1',
				timestamp: oldTs,
			});
			appendCoreEventSync(dir, {
				type: 'op_fresh',
				seq: 1,
				timestamp: FIXED_TS,
			});
			compactCoreEvents(dir);
			let manifest = manifestOf(dir);
			expect(manifest.folded.totalEvents).toBe(1); // only op_old folded
			expect(manifest.folded.byType.op_old).toBe(1);
			expect(manifest.folded.dropped).toBe(1);
			const types = rawLines(dir)
				.slice(1)
				.map((l) => (JSON.parse(l) as { type: string }).type);
			expect(types).toEqual(['task_workflow_repaired', 'op_fresh']);
			expect(getCoreEventLifetimeCount(dir)).toBe(3);

			// Phase B: zero entry budget — authority lines DO participate in the
			// byte/count budgets and leave the window (their correctness lives
			// in the index, asserted in core-events-authority-index.test.ts).
			_internals.limits = tinyLimits({
				activeMaxEntries: 0,
				compactMaxBytes: 65_536,
			});
			compactCoreEvents(dir);
			manifest = manifestOf(dir);
			expect(rawLines(dir).length).toBe(1); // manifest only
			expect(manifest.folded.totalEvents).toBe(3);
			expect(getCoreEventLifetimeCount(dir)).toBe(3);
		});
	});

	describe('torn tails + duplicates + typed errors', () => {
		test('torn tail is re-framed by the next append and counted corrupt at compaction', () => {
			_internals.limits = tinyLimits();
			appendCoreEventSync(dir, opEvent(1));
			fs.appendFileSync(eventsFile(dir), '{"partial":', 'utf-8'); // crash-torn
			appendCoreEventSync(dir, opEvent(2));
			const content = fs.readFileSync(eventsFile(dir), 'utf-8');
			expect(content).toContain('{"partial":\n'); // re-framed with \n
			expect(() => readCoreEvents(dir)).not.toThrow();
			// Both valid events survived the torn tail (parse-safely: the
			// corrupt partial line is still present at this point).
			const seqs = rawLines(dir)
				.slice(1)
				.map((l) => {
					try {
						return (JSON.parse(l) as { seq?: number }).seq;
					} catch {
						return undefined;
					}
				})
				.filter((s) => s !== undefined);
			expect(seqs).toEqual([1, 2]);

			compactCoreEvents(dir);
			const manifest = manifestOf(dir);
			expect(manifest.folded.corrupt).toBe(1);
			expect(fs.readFileSync(eventsFile(dir), 'utf-8')).not.toContain(
				'partial',
			);
			expect(getCoreEventLifetimeCount(dir)).toBe(2); // corrupt is not an event
		});

		test('duplicate appends without the dedupe option are both stored', () => {
			_internals.limits = tinyLimits();
			const op = opEvent(1);
			appendCoreEventSync(dir, op);
			appendCoreEventSync(dir, op);
			expect(rawLines(dir).length).toBe(3); // manifest + 2 identical lines

			const repair = {
				type: 'task_workflow_repaired',
				taskId: 'T1',
				transitionId: 'tr-1',
				timestamp: '2026-01-01T00:00:00.000Z',
			};
			const repairDir = mkTempDir();
			try {
				appendCoreEventSync(repairDir, repair); // no dedupe option
				appendCoreEventSync(repairDir, repair);
				expect(rawLines(repairDir).length).toBe(3);
			} finally {
				fs.rmSync(repairDir, { force: true, recursive: true });
			}
		});

		test('oversized serialized lines fail with the typed CORE_EVENT_LINE_TOO_LARGE error', () => {
			_internals.limits = tinyLimits({ maxLineBytes: 64 });
			expect(() =>
				appendCoreEventSync(dir, { type: 'op', pad: 'x'.repeat(100) }),
			).toThrow('CORE_EVENT_LINE_TOO_LARGE');
			expect(fs.existsSync(eventsFile(dir))).toBe(false);
		});

		// Accepted gap (PRR-021): a two-process append-vs-compaction race is not
		// deterministically CI-testable; rests on the single-lock discipline (pinned
		// below) + fold-time indexing (C1 tests in the authority-index file).
		test('lock contention fails with the typed CORE_EVENT_STORE_LOCKED error (bounded retry)', () => {
			_internals.limits = tinyLimits();
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			const lockPath = path.join(dir, '.swarm', 'events.lock');
			const fd = fs.openSync(lockPath, 'wx'); // hold the exclusive lock
			try {
				expect(() => appendCoreEventSync(dir, opEvent(1))).toThrow(
					'CORE_EVENT_STORE_LOCKED',
				);
			} finally {
				fs.closeSync(fd);
				fs.unlinkSync(lockPath);
			}
			// After release the store is writable again.
			appendCoreEventSync(dir, opEvent(1));
			expect(rawLines(dir).length).toBe(2);
		});

		test('transient EPERM on the atomic rename is retried; non-retryable fails fast (PRR-003)', () => {
			_internals.limits = tinyLimits();
			const realRename = _internals.renameSync;
			type Seam = { renameSync: typeof fs.renameSync };
			let calls = 0;
			(_internals as Seam).renameSync = ((
				from: fs.PathLike,
				to: fs.PathLike,
			) => {
				calls += 1;
				if (calls === 1) {
					throw Object.assign(new Error('EPERM: AV scan lock'), {
						code: 'EPERM',
					});
				}
				return realRename(from, to);
			}) as typeof fs.renameSync;
			try {
				// First append takes the atomicReplace path (tmp + rename).
				expect(() => appendCoreEventSync(dir, opEvent(1))).not.toThrow();
				expect(calls).toBe(2); // one failed attempt + one success
				expect(rawLines(dir).length).toBe(2);
				// Non-retryable codes fail immediately. Remove the store so the
				// next append recreates it (existing-file appends skip rename).
				fs.rmSync(eventsFile(dir));
				let ncalls = 0;
				(_internals as Seam).renameSync = (() => {
					ncalls += 1;
					throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
				}) as typeof fs.renameSync;
				expect(() => appendCoreEventSync(dir, opEvent(2))).toThrow();
				expect(ncalls).toBe(1);
			} finally {
				(_internals as Seam).renameSync = realRename;
			}
		});
	});

	describe('maintenance trigger + legacy migration', () => {
		test('check-interval maintenance triggers compaction on the append path', () => {
			_resetMaintenanceCounters();
			_internals.limits = tinyLimits({
				checkInterval: 1, // run maintenance on every append
				activeMaxEntries: 3,
				activeMaxBytes: 2048,
				compactMaxBytes: 4096,
			});
			for (let i = 0; i < 30; i += 1) appendCoreEventSync(dir, opEvent(i));
			const onDisk = fs.statSync(eventsFile(dir)).size;
			expect(onDisk).toBeLessThanOrEqual(
				_internals.limits.activeMaxBytes +
					_internals.limits.headerMaxBytes +
					2048,
			);
			expect(manifestOf(dir).folded.totalEvents).toBeGreaterThan(0);
			expect(getCoreEventLifetimeCount(dir)).toBe(30); // nothing lost
			expect(health.payloads.some((p) => p.trigger === 'compaction')).toBe(
				true,
			);
		});

		test('appending to a legacy header-less file works and preserves the legacy layout until compaction', () => {
			_internals.limits = tinyLimits();
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			const legacy = [JSON.stringify(opEvent(0)), JSON.stringify(opEvent(1))];
			fs.writeFileSync(eventsFile(dir), `${legacy.join('\n')}\n`, 'utf-8');
			const third = opEvent(2);
			appendCoreEventSync(dir, third);
			const lines = rawLines(dir);
			expect(lines.length).toBe(3);
			expect(lines[0]).toBe(legacy[0]); // still no manifest at line 1
			expect(lines[2]).toBe(JSON.stringify(third));
		});

		test('legacy header-less store migrates to a manifest store in bounded compaction passes', () => {
			_internals.limits = tinyLimits({
				compactMaxBytes: 512, // bounded fold work per pass
				activeMaxBytes: 2048,
			});
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			const legacy: string[] = [];
			for (let i = 0; i < 40; i += 1) legacy.push(JSON.stringify(opEvent(i)));
			fs.writeFileSync(eventsFile(dir), `${legacy.join('\n')}\n`, 'utf-8');

			compactCoreEvents(dir); // first pass is bounded, not one huge fold
			let manifest = manifestOf(dir);
			expect(manifest.type).toBe('swarm-events-manifest');
			expect(manifest.folded.totalEvents).toBeGreaterThan(0);
			expect(manifest.folded.totalEvents).toBeLessThan(40);
			expect(rawLines(dir).length - 1).toBeGreaterThan(0);
			expect(getCoreEventLifetimeCount(dir)).toBe(40);

			// Drain across bounded passes until the store settles in budget.
			for (let pass = 0; pass < 100; pass += 1) {
				if (
					fs.statSync(eventsFile(dir)).size <=
					_internals.limits.activeMaxBytes +
						_internals.limits.headerMaxBytes +
						2048
				) {
					break;
				}
				compactCoreEvents(dir);
			}
			manifest = manifestOf(dir);
			expect(manifest.type).toBe('swarm-events-manifest');
			expect(getCoreEventLifetimeCount(dir)).toBe(40); // no loss/double count
			expect(getCoreEventCoverage(dir)).toBe('complete');
		});
	});

	describe('legacy bounded read window', () => {
		// The tail-read bug this test caught (head read + inverted framing
		// drop) was fixed by reading from max(0, size - readMaxBytes).
		test('legacy header-less file: readCoreEvents returns the newest readMaxBytes window', () => {
			_internals.limits = tinyLimits({ readMaxBytes: 500 });
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			const legacy: string[] = [];
			for (let i = 0; i < 10; i += 1) legacy.push(JSON.stringify(opEvent(i)));
			fs.writeFileSync(eventsFile(dir), `${legacy.join('\n')}\n`, 'utf-8');

			const result = readCoreEvents(dir);
			expect(result.truncated).toBe(true);
			const seqs = result.text
				.split('\n')
				.filter((l) => l.trim() !== '')
				.map((l) => (JSON.parse(l) as { seq: number }).seq);
			// Intended contract (docstring: "the newest readMaxBytes of event
			// lines"): the window carries the newest complete lines and never a
			// torn one.
			expect(seqs.length).toBeGreaterThan(0);
			expect(seqs[0]).toBeGreaterThanOrEqual(5);
			expect(seqs.every((s) => s <= 9)).toBe(true);
			expect(seqs).not.toContain(0);
			expect(seqs).not.toContain(1);
		});
	});
});
