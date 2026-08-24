/**
 * Issue #2037 — corrupt / partial tail tolerance for the bounded
 * context-map telemetry store.
 *
 * Split out of telemetry-bounded.test.ts to keep every test file under the
 * FR-006 500-line cap. Covers: corrupt/torn-tail lines never throwing,
 * all-corrupt legacy yielding zeroed numerics (never NaN), non-finite
 * (Infinity) records being rejected as corrupt, and corrupt disclosure
 * surviving a compaction durably in the manifest.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	_internals,
	_resetMaintenanceCounters,
	CONTEXT_TELEMETRY_LIMITS,
	type ContextTelemetryLimits,
	getTelemetrySummary,
	readTelemetry,
	recordTelemetry,
	type TelemetryEntry,
} from '../../../src/context-map/telemetry';

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
	return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-telemetry-corrupt-'));
}

describe('context-map telemetry corruption tolerance (issue #2037)', () => {
	let dir: string;

	/** Tiny budgets so a compaction/maintenance pass triggers on the next write. */
	function tinyLimits(): ContextTelemetryLimits {
		return {
			...CONTEXT_TELEMETRY_LIMITS,
			activeMaxBytes: 4 * 1024,
			activeMaxEntries: 8,
			compactMaxBytes: 2 * 1024,
			checkInterval: 1, // run maintenance on every write
			ageMaxMs: Number.MAX_SAFE_INTEGER, // never age-prune in corruption tests
		};
	}

	beforeEach(() => {
		dir = mkTempDir();
	});

	afterEach(() => {
		_internals.limits = CONTEXT_TELEMETRY_LIMITS as typeof _internals.limits;
		_resetMaintenanceCounters();
		fs.rmSync(dir, { force: true, recursive: true });
	});

	test('corrupt middle line and partial final line never throw; disclosed as corrupt', () => {
		_internals.limits = tinyLimits() as typeof _internals.limits;
		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		// A header + a good record, then a corrupt middle line and a torn tail.
		fs.writeFileSync(
			filePath,
			`${JSON.stringify({ v: 2, type: 'ctx-telemetry-manifest', schemaVersion: 2, folded: { delegations: 1, successCount: 1, cacheHits: 5, cacheMisses: 2, staleEntries: 0, tokenSum: 1000, recommendedReads: 3, skippedReads: 7, corrupt: 0, dropped: 0, oldestTimestamp: '2026-01-01T00:00:00.000Z', newestTimestamp: '2026-01-01T00:00:00.000Z' }, updatedAt: '' })}\n`,
			'utf-8',
		);
		fs.appendFileSync(filePath, '{broken json\nnot-json-at-all\n', 'utf-8');

		// Neither readTelemetry nor summary throws.
		const entries = readTelemetry(dir);
		const summary = getTelemetrySummary(dir);
		expect(Array.isArray(entries)).toBe(true);
		expect(summary.total_delegations).toBe(1);
		expect(summary.corrupt_entries).toBeGreaterThan(0);
	});

	test('all-corrupt legacy file yields zeroed numerics (no NaN) and discloses corrupt', () => {
		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, 'not-json\n{broken\n', 'utf-8');
		const summary = getTelemetrySummary(dir);
		expect(summary.total_delegations).toBe(0);
		expect(summary.corrupt_entries).toBeGreaterThan(0);
		// Never NaN (issue #2037): average/success must be guarded on total 0.
		expect(Number.isNaN(summary.avg_token_estimate)).toBe(false);
		expect(Number.isNaN(summary.success_rate)).toBe(false);
		expect(summary.avg_token_estimate).toBe(0);
		expect(summary.success_rate).toBe(0);
	});

	test('a non-finite numeric record (Infinity) is rejected as corrupt, never folded', () => {
		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		// Hostile hand-edited line: JSON.parse('1e309') === Infinity, which
		// typeof-number accepts but Number.isFinite rejects (issue #2037).
		fs.writeFileSync(
			filePath,
			`{"timestamp":"2026-01-01T00:00:00.000Z","task_id":"evil.1","agent_role":"coder","delegation_reason":"ctx","token_estimate":1e309,"cache_hits":5,"cache_misses":2,"stale_entries":0,"recommended_reads":3,"skipped_reads":7,"success":true}\n`,
			'utf-8',
		);
		const summary = getTelemetrySummary(dir);
		expect(summary.total_delegations).toBe(0); // never counted
		expect(summary.corrupt_entries).toBeGreaterThan(0);
		expect(Number.isFinite(summary.avg_token_estimate)).toBe(true);
	});

	test('corrupt disclosure survives a compaction (durably folded into the manifest)', () => {
		_internals.limits = tinyLimits() as typeof _internals.limits;
		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, 'not-json\n', 'utf-8');
		// A subsequent write triggers maintenance, which folds the corrupt
		// legacy line durably into the manifest's folded.corrupt counter.
		recordTelemetry(makeEntry({ task_id: '0.1' }), dir);
		const accounted = getTelemetrySummary(dir);
		expect(accounted.corrupt_entries).toBeGreaterThan(0);
		// A fresh read (window now clean) still reports it from the header.
		expect(getTelemetrySummary(dir).corrupt_entries).toBeGreaterThan(0);
	});
});
