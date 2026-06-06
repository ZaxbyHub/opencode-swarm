/**
 * Tests for src/context-map/telemetry.ts
 *
 * Uses the _internals DI seam to mock filesystem operations.
 * Integration tests use real filesystem with os.tmpdir().
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	_internals,
	getTelemetrySummary,
	readTelemetry,
	recordTelemetry,
	type TelemetryEntry,
	TelemetrySummary,
} from '../../../src/context-map/telemetry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid entry for testing */
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

/** Returns a temp directory that is cleaned up after the test */
function mkTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-test-'));
	return dir;
}

// ---------------------------------------------------------------------------
// _internals DI seam
// ---------------------------------------------------------------------------

describe('_internals', () => {
	test('all expected functions are present', () => {
		expect(typeof _internals.appendFileSync).toBe('function');
		expect(typeof _internals.readFileSync).toBe('function');
		expect(typeof _internals.existsSync).toBe('function');
		expect(typeof _internals.mkdirSync).toBe('function');
	});

	test('override verification works', () => {
		const original = _internals.appendFileSync;
		const fakeAppend = mock(() => {});
		_internals.appendFileSync = fakeAppend as typeof _internals.appendFileSync;

		expect(_internals.appendFileSync).toBe(fakeAppend);

		_internals.appendFileSync = original as typeof _internals.appendFileSync;
		expect(_internals.appendFileSync).toBe(original);
	});
});

// ---------------------------------------------------------------------------
// recordTelemetry
// ---------------------------------------------------------------------------

describe('recordTelemetry', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkTempDir();
	});

	afterEach(() => {
		fs.rmSync(dir, { force: true, recursive: true });
	});

	test('returns true on success', () => {
		const entry = makeEntry();
		expect(recordTelemetry(entry, dir)).toBe(true);
	});

	test('creates .swarm/ directory if needed', () => {
		const entry = makeEntry();
		const swarmDir = path.join(dir, '.swarm');
		expect(fs.existsSync(swarmDir)).toBe(false);
		recordTelemetry(entry, dir);
		expect(fs.existsSync(swarmDir)).toBe(true);
	});

	test('appends JSONL entry to .swarm/context-telemetry.jsonl', () => {
		const entry = makeEntry({ task_id: '2.1' });
		recordTelemetry(entry, dir);

		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
		const lines = content.split('\n').filter((l) => l.trim() !== '');

		expect(lines.length).toBe(1);
		const parsed = JSON.parse(lines[0]!) as TelemetryEntry;
		expect(parsed.task_id).toBe('2.1');
		expect(parsed.token_estimate).toBe(1000);
	});

	test('multiple entries create multiple lines', () => {
		recordTelemetry(makeEntry({ task_id: '1.1' }), dir);
		recordTelemetry(makeEntry({ task_id: '1.2' }), dir);
		recordTelemetry(makeEntry({ task_id: '2.1' }), dir);

		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
		const lines = content.split('\n').filter((l) => l.trim() !== '');

		expect(lines.length).toBe(3);
	});

	test('returns false on write error when directory is not writable', () => {
		// Make the directory read-only on Unix; on Windows this is a no-op so we
		// skip the assertion there. The _internals override path below provides
		// cross-platform coverage.
		if (process.platform !== 'win32') {
			const entry = makeEntry();
			// Patch _internals to simulate failure
			const realAppend = _internals.appendFileSync;
			_internals.appendFileSync = (() => {
				throw new Error('simulated write error');
			}) as typeof _internals.appendFileSync;

			expect(recordTelemetry(entry, dir)).toBe(false);

			_internals.appendFileSync =
				realAppend as typeof _internals.appendFileSync;
		}
	});
});

// ---------------------------------------------------------------------------
// readTelemetry
// ---------------------------------------------------------------------------

describe('readTelemetry', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkTempDir();
	});

	afterEach(() => {
		fs.rmSync(dir, { force: true, recursive: true });
	});

	test('returns empty array when file does not exist', () => {
		expect(readTelemetry(dir)).toEqual([]);
	});

	test('parses valid JSONL entries correctly', () => {
		const entry1 = makeEntry({ task_id: '1.1', cache_hits: 5 });
		const entry2 = makeEntry({ task_id: '1.2', cache_hits: 10 });
		recordTelemetry(entry1, dir);
		recordTelemetry(entry2, dir);

		const entries = readTelemetry(dir);
		expect(entries.length).toBe(2);
		expect(entries[0]!.task_id).toBe('1.1');
		expect(entries[0]!.cache_hits).toBe(5);
		expect(entries[1]!.task_id).toBe('1.2');
		expect(entries[1]!.cache_hits).toBe(10);
	});

	test('skips malformed JSON lines', () => {
		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, 'not json\n', 'utf-8');

		expect(readTelemetry(dir)).toEqual([]);
	});

	test('skips structurally invalid entries (null)', () => {
		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, 'null\n', 'utf-8');

		expect(readTelemetry(dir)).toEqual([]);
	});

	test('skips structurally invalid entries (empty object)', () => {
		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, '{}\n', 'utf-8');

		expect(readTelemetry(dir)).toEqual([]);
	});

	test('skips entries missing required fields', () => {
		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			JSON.stringify({ task_id: '1.1' }) + '\n',
			'utf-8',
		);

		expect(readTelemetry(dir)).toEqual([]);
	});

	test('skips entries with wrong field types', () => {
		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		// token_estimate should be number, not string
		const bad = makeEntry({ token_estimate: '1000' as unknown as number });
		fs.writeFileSync(filePath, JSON.stringify(bad) + '\n', 'utf-8');

		expect(readTelemetry(dir)).toEqual([]);
	});

	test('skips empty lines', () => {
		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, '\n  \n\n', 'utf-8');

		expect(readTelemetry(dir)).toEqual([]);
	});

	test('returns entries in order', () => {
		const entries = [
			makeEntry({ task_id: '1.1' }),
			makeEntry({ task_id: '1.2' }),
			makeEntry({ task_id: '1.3' }),
		];
		for (const e of entries) {
			recordTelemetry(e, dir);
		}

		const read = readTelemetry(dir);
		expect(read.map((r) => r.task_id)).toEqual(['1.1', '1.2', '1.3']);
	});
});

// ---------------------------------------------------------------------------
// getTelemetrySummary
// ---------------------------------------------------------------------------

describe('getTelemetrySummary', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkTempDir();
	});

	afterEach(() => {
		fs.rmSync(dir, { force: true, recursive: true });
	});

	test('returns zero summary when no entries', () => {
		const summary = getTelemetrySummary(dir);
		expect(summary.total_delegations).toBe(0);
		expect(summary.total_cache_hits).toBe(0);
		expect(summary.total_cache_misses).toBe(0);
		expect(summary.total_stale_entries).toBe(0);
		expect(summary.avg_token_estimate).toBe(0);
		expect(summary.total_recommended_reads).toBe(0);
		expect(summary.total_skipped_reads).toBe(0);
		expect(summary.success_rate).toBe(0);
	});

	test('computes correct totals (cache_hits, cache_misses, stale_entries)', () => {
		recordTelemetry(
			makeEntry({ cache_hits: 5, cache_misses: 2, stale_entries: 1 }),
			dir,
		);
		recordTelemetry(
			makeEntry({ cache_hits: 3, cache_misses: 4, stale_entries: 2 }),
			dir,
		);

		const summary = getTelemetrySummary(dir);
		expect(summary.total_cache_hits).toBe(8);
		expect(summary.total_cache_misses).toBe(6);
		expect(summary.total_stale_entries).toBe(3);
	});

	test('computes correct avg_token_estimate', () => {
		recordTelemetry(makeEntry({ token_estimate: 1000 }), dir);
		recordTelemetry(makeEntry({ token_estimate: 2000 }), dir);
		recordTelemetry(makeEntry({ token_estimate: 3000 }), dir);

		const summary = getTelemetrySummary(dir);
		expect(summary.avg_token_estimate).toBe(Math.round(2000)); // 6000/3 = 2000
	});

	test('computes correct success_rate (percentage)', () => {
		recordTelemetry(makeEntry({ success: true }), dir);
		recordTelemetry(makeEntry({ success: true }), dir);
		recordTelemetry(makeEntry({ success: false }), dir);

		const summary = getTelemetrySummary(dir);
		expect(summary.success_rate).toBe(Math.round((2 / 3) * 100)); // ~67
	});

	test('computes correct recommended_reads and skipped_reads totals', () => {
		recordTelemetry(makeEntry({ recommended_reads: 3, skipped_reads: 7 }), dir);
		recordTelemetry(makeEntry({ recommended_reads: 1, skipped_reads: 9 }), dir);

		const summary = getTelemetrySummary(dir);
		expect(summary.total_recommended_reads).toBe(4);
		expect(summary.total_skipped_reads).toBe(16);
	});

	test('ignores malformed entries in aggregation', () => {
		recordTelemetry(makeEntry({ task_id: 'valid', token_estimate: 500 }), dir);

		// Inject a malformed line directly
		const filePath = path.join(dir, '.swarm', 'context-telemetry.jsonl');
		fs.appendFileSync(filePath, 'not json\n', 'utf-8');

		const summary = getTelemetrySummary(dir);
		// Only the valid entry should be counted
		expect(summary.total_delegations).toBe(1);
		expect(summary.avg_token_estimate).toBe(500);
	});
});

// ---------------------------------------------------------------------------
// Integration — real filesystem round-trip
// ---------------------------------------------------------------------------

describe('Integration (real filesystem)', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkTempDir();
	});

	afterEach(() => {
		fs.rmSync(dir, { force: true, recursive: true });
	});

	test('write and read round-trip preserves data', () => {
		const entry1 = makeEntry({
			task_id: '3.1',
			token_estimate: 2500,
			cache_hits: 10,
			cache_misses: 1,
			stale_entries: 0,
			recommended_reads: 5,
			skipped_reads: 15,
			success: true,
		});
		const entry2 = makeEntry({
			task_id: '3.2',
			token_estimate: 1800,
			cache_hits: 8,
			cache_misses: 3,
			stale_entries: 2,
			recommended_reads: 2,
			skipped_reads: 8,
			success: false,
		});

		recordTelemetry(entry1, dir);
		recordTelemetry(entry2, dir);

		const entries = readTelemetry(dir);
		expect(entries.length).toBe(2);
		expect(entries[0]!).toEqual(entry1);
		expect(entries[1]!).toEqual(entry2);
	});

	test('summary matches written entries', () => {
		recordTelemetry(
			makeEntry({
				token_estimate: 1000,
				cache_hits: 5,
				cache_misses: 1,
				stale_entries: 0,
				recommended_reads: 2,
				skipped_reads: 3,
				success: true,
			}),
			dir,
		);
		recordTelemetry(
			makeEntry({
				token_estimate: 2000,
				cache_hits: 3,
				cache_misses: 2,
				stale_entries: 1,
				recommended_reads: 1,
				skipped_reads: 4,
				success: true,
			}),
			dir,
		);
		recordTelemetry(
			makeEntry({
				token_estimate: 3000,
				cache_hits: 0,
				cache_misses: 0,
				stale_entries: 0,
				recommended_reads: 0,
				skipped_reads: 0,
				success: false,
			}),
			dir,
		);

		const summary = getTelemetrySummary(dir);
		expect(summary.total_delegations).toBe(3);
		expect(summary.total_cache_hits).toBe(8);
		expect(summary.total_cache_misses).toBe(3);
		expect(summary.total_stale_entries).toBe(1);
		expect(summary.avg_token_estimate).toBe(
			Math.round((1000 + 2000 + 3000) / 3),
		);
		expect(summary.total_recommended_reads).toBe(3);
		expect(summary.total_skipped_reads).toBe(7);
		expect(summary.success_rate).toBe(Math.round((2 / 3) * 100));
	});
});
