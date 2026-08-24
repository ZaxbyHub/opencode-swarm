/**
 * Issue #2037 — bounded storage + bounded reads for context-map telemetry.
 *
 * Exercises the single-file bounded store in src/context-map/telemetry.ts:
 * hard on-disk byte/entry/age ceilings, bounded (non-whole-history) reads,
 * no double-count across compaction, corrupt/partial-tail tolerance,
 * multi-project isolation, disk-pressure fail-open, close/finalize cut, and
 * the canonical health event emission.
 *
 * Tests override `_internals.limits` (small budgets) and `_internals.emitHealth`
 * and restore them in `afterEach` (the `_internals` DI seam is file-scoped and
 * leak-free across Bun's shared test-runner process).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	_resetMaintenanceCounters,
	CONTEXT_TELEMETRY_LIMITS,
	type ContextTelemetryLimits,
	finalizeContextTelemetry,
	getTelemetrySummary,
	readTelemetry,
	recordTelemetry,
	type TelemetryEntry,
} from '../../../src/context-map/telemetry';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeEntry(overrides: Partial<TelemetryEntry> = {}): TelemetryEntry {
	return {
		timestamp: '2026-01-01T00:00:00.000Z',
		task_id: '1.1',
		agent_role: 'coder',
		delegation_reason: 'context_requested',
		token_estimate: 1000,
		cache_hits: 5,
		cache_misses: 2,
		stale_entries: 0,
		recommended_reads: 3,
		skipped_reads: 7,
		success: true,
		...overrides,
	};
}

function mkTempDir(): string {
	return canonicalMkdtemp('ctx-telemetry-bounded-');
}

interface HealthCapture {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	payloads: any[];
}

describe('context-map telemetry bounded store (issue #2037)', () => {
	let dir: string;
	const originalEmitHealth = _internals.emitHealth;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let health: HealthCapture;

	/** Override limits with tiny budgets so compaction triggers quickly. */
	/** `ageMaxMs` is disabled (huge) so budget-prune tests are not clock-coupled. */
	function tinyLimits(): ContextTelemetryLimits {
		return {
			...CONTEXT_TELEMETRY_LIMITS,
			activeMaxBytes: 4 * 1024,
			activeMaxEntries: 8,
			compactMaxBytes: 2 * 1024,
			checkInterval: 1, // run maintenance on every write
			ageMaxMs: Number.MAX_SAFE_INTEGER, // never age-prune in budget tests
		};
	}

	beforeEach(() => {
		dir = mkTempDir();
		health = { payloads: [] };
		_internals.emitHealth = ((
			_directory: string,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			payload: any,
		) => {
			health.payloads.push(payload);
		}) as typeof _internals.emitHealth;
	});

	afterEach(() => {
		_internals.limits = CONTEXT_TELEMETRY_LIMITS as typeof _internals.limits;
		_internals.emitHealth = originalEmitHealth;
		_resetMaintenanceCounters();
		fs.rmSync(dir, { force: true, recursive: true });
	});

	describe('hard on-disk bounds under sustained writes', () => {
		test('file bytes/entries stay within tight ceilings and totals are preserved (no double count)', () => {
			_internals.limits = tinyLimits() as typeof _internals.limits;
			for (let i = 0; i < 200; i += 1) {
				recordTelemetry(
					makeEntry({
						task_id: `${i}.1`,
						token_estimate: 100,
						cache_hits: 1,
						cache_misses: 1,
						success: i % 2 === 0,
					}),
					dir,
				);
			}

			const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
			const onDisk = fs.statSync(filePath).size;
			// Hard ceilings (+ oversized-record allowance + header).
			expect(onDisk).toBeLessThanOrEqual(
				_internals.limits.activeMaxBytes +
					_internals.limits.headerMaxBytes +
					2048,
			);

			const summary = getTelemetrySummary(dir);
			// Lifetime totals are exact (no double count, nothing lost).
			expect(summary.total_delegations).toBe(200);
			expect(summary.total_cache_hits).toBe(200);
			expect(summary.total_cache_misses).toBe(200);
			expect(summary.total_recommended_reads).toBe(3 * 200);
			expect(summary.success_rate).toBe(50);
			expect(summary.avg_token_estimate).toBe(100);
			// Health was emitted on compaction passes.
			expect(health.payloads.length).toBeGreaterThan(0);
			// Σ per-pass compacted (budget folds, dropped=0 here) + retained + the
			// cumulative dropped figure == lifetime. We sum ONLY `compacted` here
			// and add `summary.dropped_entries` separately so an age-pruned run
			// could never double-count `dropped` (which is both per-pass and
			// cumulative).
			const compactedTotal = health.payloads.reduce(
				(acc: number, p) => acc + (p.compacted ?? 0),
				0,
			);
			expect(
				compactedTotal + summary.retained_entries + summary.dropped_entries,
			).toBe(200);
		});

		test('budget-pruned older records stay accounted in totals (folded + retained = lifetime)', () => {
			_internals.limits = tinyLimits() as typeof _internals.limits;
			for (let i = 0; i < 150; i += 1) {
				recordTelemetry(makeEntry({ task_id: `${i}.1` }), dir);
			}
			const summary = getTelemetrySummary(dir);
			expect(summary.total_delegations).toBe(150);
			// Some records must have been compacted away (folded), some retained.
			expect(summary.folded_entries).toBeGreaterThan(0);
			expect(summary.retained_entries).toBeGreaterThan(0);
			expect(summary.folded_entries + summary.retained_entries).toBe(150);
		});

		test('age-pruned records are dropped from the raw window but kept in lifetime totals', () => {
			_internals.limits = {
				...tinyLimits(),
				// Age-prune after ~1 ms of simulated age: every record is stale.
				ageMaxMs: 1,
			} as typeof _internals.limits;
			// Use far-future timestamps that are GUARANTEED older than ageMaxMs
			// relative to the current test clock by a wide margin.
			const oldTs = '2000-01-01T00:00:00.000Z';
			for (let i = 0; i < 10; i += 1) {
				recordTelemetry(
					makeEntry({ task_id: `${i}.1`, timestamp: oldTs }),
					dir,
				);
			}
			const summary = getTelemetrySummary(dir);
			expect(summary.total_delegations).toBe(10); // totals preserved
			expect(summary.dropped_entries).toBeGreaterThan(0);
			// Raw window no longer carries the stale records.
			expect(readTelemetry(dir).length).toBeLessThan(10);
		});
	});

	describe('bounded reads with arbitrarily large legacy history', () => {
		test('read path never exceeds its documented bound and discloses partial coverage', () => {
			_internals.limits = {
				...tinyLimits(),
				// Make readMaxBytes small (2 KiB) so a legacy file exceeds it.
				readMaxBytes: 2048,
			} as typeof _internals.limits;
			// Seed a legacy header-less file MUCH larger than the read bound.
			const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const lines: string[] = [];
			for (let i = 0; i < 5000; i += 1) {
				lines.push(
					JSON.stringify(
						makeEntry({
							task_id: `${i}.1`,
							timestamp: '2026-01-01T00:00:00.000Z',
						}),
					),
				);
			}
			fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
			expect(fs.statSync(filePath).size).toBeGreaterThan(2048);

			let maxReadBytes = 0;
			const realReadSync = _internals.readSync;
			// Instrument every bounded read to prove it stays within the bound.
			_internals.readSync = ((
				fd: number,
				buf: Buffer,
				offset: number,
				length: number,
				position: number | null,
			) => {
				maxReadBytes = Math.max(maxReadBytes, length);
				return realReadSync(fd, buf, offset, length, position);
			}) as typeof _internals.readSync;

			try {
				const summary = getTelemetrySummary(dir);
				// Never read more than the documented bound in a single call.
				expect(maxReadBytes).toBeLessThanOrEqual(2048);
				// Legacy exceeded the bound → partial coverage disclosed.
				expect(summary.coverage).toBe('partial-unmigrated');
				// It is a partial, not a complete-looking, number.
				expect(summary.total_delegations).toBeLessThan(5000);
			} finally {
				_internals.readSync = realReadSync;
			}
		});

		test('legacy file within the bound folds to complete coverage', () => {
			const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const lines: string[] = [];
			for (let i = 0; i < 5; i += 1) {
				lines.push(JSON.stringify(makeEntry({ task_id: `${i}.1` })));
			}
			fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
			const summary = getTelemetrySummary(dir);
			expect(summary.coverage).toBe('complete');
			expect(summary.total_delegations).toBe(5);
		});

		test('legacy history drains in bounded passes, not one huge fold', () => {
			_internals.limits = {
				...tinyLimits(),
				// 6 KiB per maintenance pass (well under the seeded legacy size).
				compactMaxBytes: 6 * 1024,
			} as typeof _internals.limits;
			const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const legacy: string[] = [];
			const legacyCount = 400;
			for (let i = 0; i < legacyCount; i += 1) {
				legacy.push(JSON.stringify(makeEntry({ task_id: `${i}.1` })));
			}
			fs.writeFileSync(filePath, legacy.join('\n') + '\n', 'utf-8');
			const seededBytes = fs.statSync(filePath).size;
			expect(seededBytes).toBeGreaterThan(_internals.limits.compactMaxBytes);

			// Each write (checkInterval=1) is one maintenance pass. After the
			// FIRST pass the legacy must NOT all be folded at once — only a
			// bounded prefix of it. This is the plan's "migrates incrementally
			// in bounded passes" guarantee (issue #2037).
			recordTelemetry(makeEntry({ task_id: 't0.1' }), dir);
			const afterOne = getTelemetrySummary(dir);
			expect(afterOne.total_delegations).toBe(legacyCount + 1); // no loss/double-count
			expect(afterOne.folded_entries).toBeGreaterThan(0);
			expect(afterOne.folded_entries).toBeLessThan(legacyCount);
			expect(afterOne.retained_entries).toBeGreaterThan(0);

			// Drain the tail across many bounded passes until it settles within
			// the hard window budget.
			const moreWrites = 200;
			for (let i = 1; i <= moreWrites; i += 1) {
				recordTelemetry(makeEntry({ task_id: `t${i}.1` }), dir);
			}
			const finalSummary = getTelemetrySummary(dir);
			// 400 legacy + t0 + the 200 loop records = 601 total, none lost/duplicated.
			expect(finalSummary.total_delegations).toBe(legacyCount + moreWrites + 1);
			const onDisk = fs.statSync(filePath).size;
			expect(onDisk).toBeLessThanOrEqual(
				_internals.limits.activeMaxBytes +
					_internals.limits.headerMaxBytes +
					2048,
			);
		});

		test("header'd store exceeding the read bound (mid-drain) discloses partial-unmigrated, never complete", () => {
			_internals.limits = {
				...tinyLimits(),
				readMaxBytes: 2048,
			} as typeof _internals.limits;
			// A header + a raw window large enough to exceed the (tiny) read
			// bound models the mid-migration state where a legacy tail is still
			// on disk beyond the bounded read — totals are INCOMPLETE.
			const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const header = JSON.stringify({
				v: 2,
				type: 'ctx-telemetry-manifest',
				schemaVersion: 2,
				folded: {
					delegations: 0,
					successCount: 0,
					cacheHits: 0,
					cacheMisses: 0,
					staleEntries: 0,
					tokenSum: 0,
					recommendedReads: 0,
					skippedReads: 0,
					corrupt: 0,
					dropped: 0,
					oldestTimestamp: null,
					newestTimestamp: null,
				},
				updatedAt: '',
			});
			const body: string[] = [];
			for (let i = 0; i < 500; i += 1) {
				body.push(JSON.stringify(makeEntry({ task_id: `${i}.1` })));
			}
			fs.writeFileSync(filePath, `${header}\n${body.join('\n')}\n`, 'utf-8');
			expect(fs.statSync(filePath).size).toBeGreaterThan(2048);
			const summary = getTelemetrySummary(dir);
			// The completeness of magnitudes is unknown until migration finishes;
			// must not present a complete-looking lifetime figure.
			expect(summary.coverage).toBe('partial-unmigrated');
			expect(summary.total_delegations).toBeLessThan(500);
		});

		test('readers never call readFileSync — only the bounded readBoundedChunk', () => {
			_internals.limits = tinyLimits() as typeof _internals.limits;
			// Seed a valid header'd store (bounded raw window) via the public writer.
			for (let i = 0; i < 3; i += 1) {
				recordTelemetry(makeEntry({ task_id: `${i}.1` }), dir);
			}
			// Regression guard for issue #2037: if a future refactor makes the READ
			// path fall back to a whole-file readFileSync, this fails loudly.
			const realReadFileSync = _internals.readFileSync;
			_internals.readFileSync = (() => {
				throw new Error('READ PATH MUST NOT USE readFileSync');
			}) as typeof _internals.readFileSync;
			try {
				const summary = getTelemetrySummary(dir);
				expect(summary.total_delegations).toBe(3);
				const entries = readTelemetry(dir);
				expect(entries.length).toBe(3);
			} finally {
				_internals.readFileSync = realReadFileSync;
			}
		});
	});

	describe('multi-project isolation', () => {
		test('two project roots never cross-talk', () => {
			const dirB = mkTempDir();
			try {
				recordTelemetry(
					makeEntry({ task_id: 'a.1', token_estimate: 100 }),
					dir,
				);
				recordTelemetry(
					makeEntry({ task_id: 'b.1', token_estimate: 200 }),
					dirB,
				);
				expect(getTelemetrySummary(dir).total_delegations).toBe(1);
				expect(getTelemetrySummary(dir).total_cache_hits).toBe(5);
				expect(getTelemetrySummary(dirB).total_delegations).toBe(1);
				expect(getTelemetrySummary(dirB).total_cache_hits).toBe(5);
				expect(
					fs.existsSync(path.join(dir, '.swarm', 'context-telemetry.jsonl')),
				).toBe(true);
				expect(
					fs.existsSync(path.join(dirB, '.swarm', 'context-telemetry.jsonl')),
				).toBe(true);
			} finally {
				fs.rmSync(dirB, { force: true, recursive: true });
			}
		});
	});

	describe('fail-open on disk pressure', () => {
		test('append failure returns false and does not throw', () => {
			// Create the store first so a subsequent write exercises the APPEND
			// branch (the first write uses the atomic writeFileSync+rename path).
			expect(recordTelemetry(makeEntry({ task_id: 'seed' }), dir)).toBe(true);
			const realAppend = _internals.appendFileSync;
			_internals.appendFileSync = (() => {
				throw new Error('ENOSPC: no space left on device');
			}) as typeof _internals.appendFileSync;
			try {
				expect(recordTelemetry(makeEntry({ task_id: 'full' }), dir)).toBe(
					false,
				);
			} finally {
				_internals.appendFileSync = realAppend;
			}
		});
	});

	describe('close/finalize cut', () => {
		test('finalize folds the retained tail atomically and leaves active state usable', () => {
			_internals.limits = tinyLimits() as typeof _internals.limits;
			for (let i = 0; i < 40; i += 1) {
				recordTelemetry(makeEntry({ task_id: `${i}.1` }), dir);
			}
			const before = getTelemetrySummary(dir);
			expect(before.total_delegations).toBe(40);

			finalizeContextTelemetry(dir);
			const after = getTelemetrySummary(dir);
			expect(after.total_delegations).toBe(40);
			// Finalize must emit a health event carrying the 'close' trigger (not
			// just any health emission — the 40 writes already emitted 'compaction'
			// events, so length>0 alone would pass for the wrong reason).
			expect(
				health.payloads.some(
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					(p: any) => p.trigger === 'close',
				),
			).toBe(true);
			// The file remains valid (single complete store) and readable.
			const entries = readTelemetry(dir);
			expect(Array.isArray(entries)).toBe(true);
			// Frozen-clock summary path: reopened store still yields the same totals.
			expect(getTelemetrySummary(dir).total_delegations).toBe(40);
		});

		test('finalize on a fresh/empty project is a safe no-op', () => {
			expect(() => finalizeContextTelemetry(dir)).not.toThrow();
		});
	});

	describe('readTelemetry header-aware window', () => {
		test('returns only records after the manifest header', () => {
			recordTelemetry(makeEntry({ task_id: '1.1' }), dir);
			recordTelemetry(makeEntry({ task_id: '1.2' }), dir);
			const entries = readTelemetry(dir);
			expect(entries.map((e) => e.task_id)).toEqual(['1.1', '1.2']);
		});
	});
});
