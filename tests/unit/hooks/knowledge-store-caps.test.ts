/**
 * Tests for enforceKnowledgeCap in src/hooks/knowledge-store.ts
 *
 * Verifies that swarm_max_entries and hive_max_entries caps are enforced
 * via FIFO truncation. Previously this function did not exist and caps
 * were silently ignored.
 *
 * Covers:
 * 1. No-op when entries are under the cap
 * 2. No-op at exactly the cap
 * 3. FIFO truncation when over the cap
 * 4. Preserves newest N entries (tail kept, head dropped)
 * 5. Large over-limit case (200 entries, cap 100 → 100 newest kept)
 * 6. Cap of 1 keeps only the last entry
 * 7. Non-existent file returns without error
 * 8. TOCTOU fix: concurrent enforceKnowledgeCap calls don't lose entries
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	appendKnowledge,
	appendKnowledgeWithCapEnforcement,
	enforceKnowledgeCap,
	readKnowledge,
} from '../../../src/hooks/knowledge-store.js';

// ============================================================================
// Helpers
// ============================================================================

interface TestEntry {
	id: number;
	lesson: string;
}

let tmpDir: string;
let testFile: string;

beforeEach(() => {
	tmpDir = path.join(
		os.tmpdir(),
		`caps-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	fs.mkdirSync(tmpDir, { recursive: true });
	testFile = path.join(tmpDir, 'knowledge.jsonl');
});

afterEach(() => {
	mock.restore();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writeEntries(count: number): Promise<TestEntry[]> {
	const entries: TestEntry[] = [];
	for (let i = 0; i < count; i++) {
		const entry: TestEntry = { id: i, lesson: `lesson-${i}` };
		entries.push(entry);
		await appendKnowledge(testFile, entry);
	}
	return entries;
}

// ============================================================================
// Tests
// ============================================================================

describe('enforceKnowledgeCap', () => {
	it('is a no-op when entry count is under the cap', async () => {
		await writeEntries(5);
		await enforceKnowledgeCap<TestEntry>(testFile, 10);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(5);
		expect(entries.map((e) => e.id)).toEqual([0, 1, 2, 3, 4]);
	});

	it('is a no-op when entry count equals the cap exactly', async () => {
		await writeEntries(10);
		await enforceKnowledgeCap<TestEntry>(testFile, 10);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(10);
	});

	it('truncates to cap when over-limit (FIFO: oldest dropped)', async () => {
		await writeEntries(15);
		await enforceKnowledgeCap<TestEntry>(testFile, 10);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(10);
		// Newest 10 entries (ids 5-14) should be kept
		expect(entries[0].id).toBe(5);
		expect(entries[9].id).toBe(14);
	});

	it('preserves the newest N entries when truncating', async () => {
		await writeEntries(20);
		await enforceKnowledgeCap<TestEntry>(testFile, 5);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(5);
		// Last 5 entries (ids 15-19) must survive
		const ids = entries.map((e) => e.id);
		expect(ids).toEqual([15, 16, 17, 18, 19]);
	});

	it('handles large over-limit: 200 entries with cap 100 → 100 newest kept', async () => {
		await writeEntries(200);
		await enforceKnowledgeCap<TestEntry>(testFile, 100);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(100);
		expect(entries[0].id).toBe(100);
		expect(entries[99].id).toBe(199);
	});

	it('cap of 1 retains only the most recent entry', async () => {
		await writeEntries(10);
		await enforceKnowledgeCap<TestEntry>(testFile, 1);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe(9); // last appended
	});

	it('does not error when file does not exist', async () => {
		const nonExistent = path.join(tmpDir, 'ghost.jsonl');
		await expect(
			enforceKnowledgeCap<TestEntry>(nonExistent, 10),
		).resolves.toBeUndefined();
	});

	it('cap enforcement is idempotent — running twice does not over-truncate', async () => {
		await writeEntries(25);
		await enforceKnowledgeCap<TestEntry>(testFile, 10);
		await enforceKnowledgeCap<TestEntry>(testFile, 10); // second run

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(10);
		expect(entries[0].id).toBe(15);
		expect(entries[9].id).toBe(24);
	});
});

// =============================================================================
// TOCTOU Fix Tests — enforceKnowledgeCap atomic read-modify-write
//
// The fix acquires the directory lock BEFORE reading knowledge entries, making
// the full read-modify-write cycle atomic. Previously it read before locking,
// creating a TOCTOU window where concurrent appendKnowledge calls could insert
// entries that get silently dropped by the rewrite.
// =============================================================================

describe('enforceKnowledgeCap — TOCTOU race fix', () => {
	it(
		'concurrent enforceKnowledgeCap with appendKnowledge interleaving — ' +
			'append adds entries that must not be lost when cap is enforced',
		async () => {
			// Start with 3 entries (under cap of 10)
			await writeEntries(3);

			// Delay readKnowledge to widen the window where a concurrent
			// appendKnowledge could interleave. With the lock held before
			// read, appendKnowledge blocks until enforceKnowledgeCap finishes
			// its read-modify-write, so the interleaved entry is never lost.
			const originalReadKnowledge = _internals.readKnowledge;
			let readCalls = 0;
			_internals.readKnowledge = mock(
				async <T>(filePath: string): Promise<T[]> => {
					readCalls++;
					if (readCalls === 1) {
						await Bun.sleep(50); // widen the interleave window
					}
					return originalReadKnowledge(filePath);
				},
			);

			// Concurrent append during enforceKnowledgeCap's locked read.
			// Without lock-before-read, the append would write to the file
			// while enforce is between its read and write, causing the
			// appended entry to be silently dropped by the rewrite.
			await Promise.all([
				enforceKnowledgeCap<TestEntry>(testFile, 10),
				(async () => {
					await Bun.sleep(10); // let enforce acquire lock and start read
					await appendKnowledge(testFile, { id: 99, lesson: 'interleaved' });
				})(),
			]);

			// The interleaved entry must be preserved (lock serialised it
			// after the enforce write, so it is present in the final file).
			const entries = await readKnowledge<TestEntry>(testFile);
			const ids = entries.map((e) => e.id);
			expect(ids).toContain(99);
			expect(ids.sort()).toEqual([0, 1, 2, 99].sort());

			_internals.readKnowledge = originalReadKnowledge;
		},
	);

	it(
		'stale-snapshot read during enforceKnowledgeCap does not drop ' +
			'interleaved appendKnowledge entries',
		async () => {
			// Start with 8 entries (under cap of 10)
			await writeEntries(8);

			// Simulate the pre-fix TOCTOU window: mock readKnowledge to
			// return a stale 5-entry snapshot (as if it read before some
			// concurrent appends landed). Concurrent appendKnowledge adds
			// 3 entries during the delay. Without lock-before-read, the
			// stale read would cause enforce to rewrite from the old
			// snapshot, dropping the 3 appended entries. With the fix,
			// the lock serialises the appends after enforce finishes, so
			// all 11 entries survive.
			const originalReadKnowledge = _internals.readKnowledge;
			_internals.readKnowledge = mock(
				async <T>(_filePath: string): Promise<T[]> => {
					await Bun.sleep(30); // widen the race window
					// Return a stale 5-entry snapshot (first 5 of the 8)
					const all = await originalReadKnowledge(_filePath);
					return all.slice(0, 5) as T[];
				},
			);

			await Promise.all([
				enforceKnowledgeCap<TestEntry>(testFile, 10),
				(async () => {
					await Bun.sleep(5); // interleave during the stale read
					await appendKnowledge(testFile, {
						id: 99,
						lesson: 'late-1',
					});
					await appendKnowledge(testFile, {
						id: 100,
						lesson: 'late-2',
					});
					await appendKnowledge(testFile, {
						id: 101,
						lesson: 'late-3',
					});
				})(),
			]);

			// All entries should be present: original 8 + 3 concurrent = 11.
			// enforceKnowledgeCap saw only 5 entries (stale mock) so no trim
			// was triggered; the 3 late entries were appended under the lock
			// after enforce released it, so they survive untouched.
			const entries = await readKnowledge<TestEntry>(testFile);
			const ids = entries.map((e) => e.id);
			expect(entries).toHaveLength(11);
			expect(ids).toContain(99);
			expect(ids).toContain(100);
			expect(ids).toContain(101);
			// Original entries are all still present (no trim happened)
			for (const id of [0, 1, 2, 3, 4, 5, 6, 7]) {
				expect(ids).toContain(id);
			}

			_internals.readKnowledge = originalReadKnowledge;
		},
	);

	it(
		'TOCTOU fix: enforceKnowledgeCap does not drop entries added by ' +
			'concurrent appendKnowledge calls',
		async () => {
			// Set up: 8 entries (under cap of 10)
			await writeEntries(8);

			// Race: two appendKnowledge calls interleave with one enforceKnowledgeCap.
			// The enforceKnowledgeCap should not drop the appended entries.
			const append1 = appendKnowledge(testFile, {
				id: 100,
				lesson: 'first-concurrent-append',
			});
			const cap = enforceKnowledgeCap<TestEntry>(testFile, 10);
			const append2 = appendKnowledge(testFile, {
				id: 101,
				lesson: 'second-concurrent-append',
			});

			await Promise.all([append1, cap, append2]);

			// All entries should be present: original 8 + 2 concurrent appends = 10
			// (exactly at cap, no trim needed)
			const entries = await readKnowledge<TestEntry>(testFile);
			expect(entries).toHaveLength(10);
			const ids = entries.map((e) => e.id);
			expect(ids).toContain(100);
			expect(ids).toContain(101);
		},
	);

	it(
		'TOCTOU fix: when over cap, trim preserves all entries that were ' +
			'appended before the lock was acquired',
		async () => {
			// Set up: 5 entries (under cap)
			await writeEntries(5);

			// Add entries up to 12 (over cap of 10)
			for (let i = 200; i < 212; i++) {
				await appendKnowledge(testFile, { id: i, lesson: `entry-${i}` });
			}

			// Now: 5 + 12 = 17 entries total
			// Cap is 10, so oldest 7 should be dropped (ids 0-4 and 200-201)
			// Newest 10 should survive (ids 202-211)
			await enforceKnowledgeCap<TestEntry>(testFile, 10);

			const entries = await readKnowledge<TestEntry>(testFile);
			expect(entries).toHaveLength(10);
			const ids = entries.map((e) => e.id);

			// Oldest entries (0-4, 200-201) must be gone
			for (const id of [0, 1, 2, 3, 4, 200, 201]) {
				expect(ids).not.toContain(id);
			}
			// Newest entries (202-211) must survive
			for (const id of [202, 203, 204, 205, 206, 207, 208, 209, 210, 211]) {
				expect(ids).toContain(id);
			}
		},
	);

	it('empty file (no entries) is handled correctly', async () => {
		// File exists but is empty — should be a no-op
		fs.writeFileSync(testFile, '');
		await enforceKnowledgeCap<TestEntry>(testFile, 10);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(0);
	});

	it('exactly at cap: no trim needed, file unchanged', async () => {
		// Exactly 10 entries with cap of 10 — no trim
		await writeEntries(10);
		await enforceKnowledgeCap<TestEntry>(testFile, 10);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(10);
		expect(entries.map((e) => e.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it('file does not exist: returns without error, no crash', async () => {
		const nonExistent = path.join(tmpDir, 'nonexistent.jsonl');
		// Should not throw
		await expect(
			enforceKnowledgeCap<TestEntry>(nonExistent, 10),
		).resolves.toBeUndefined();
		// Directory should still exist (mkdir with recursive: true inside enforceKnowledgeCap)
	});
});

// =============================================================================
// appendKnowledgeWithCapEnforcement — direct unit tests (issue #1219 F-002)
//
// These tests directly cover the function exported from src/hooks/knowledge-store.ts
// (added by PR #1207). Previously the function was only exercised indirectly through
// knowledge_add integration tests. We verify the three guarantees the issue calls out:
//   1. Appending within the cap limit succeeds.
//   2. When maxEntries is exceeded, the newest entries are retained (FIFO drop).
//   3. The operation is atomic (append + cap enforcement happen in one transaction
//      under a directory lock — concurrent appends do not silently get dropped).
// =============================================================================

describe('appendKnowledgeWithCapEnforcement (issue #1219 F-002)', () => {
	it('appends a single entry to an empty file and returns true', async () => {
		const appended = await appendKnowledgeWithCapEnforcement<TestEntry>(
			testFile,
			{ id: 0, lesson: 'first-entry' },
			10,
		);
		expect(appended).toBe(true);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe(0);
		expect(entries[0].lesson).toBe('first-entry');
	});

	it('appends within the cap without dropping existing entries', async () => {
		// Pre-populate 5 entries (cap is 10 — well under the limit).
		await writeEntries(5);

		// Append a 6th entry — cap not reached.
		const appended = await appendKnowledgeWithCapEnforcement<TestEntry>(
			testFile,
			{ id: 5, lesson: 'lesson-5' },
			10,
		);
		expect(appended).toBe(true);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(6);
		expect(entries.map((e) => e.id)).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it('appends when entry count equals cap exactly — no trim needed', async () => {
		// Pre-populate to exactly the cap (10).
		await writeEntries(10);

		const appended = await appendKnowledgeWithCapEnforcement<TestEntry>(
			testFile,
			{ id: 10, lesson: 'lesson-10' },
			10,
		);
		expect(appended).toBe(true);

		// 11 entries > cap of 10, so the oldest entry must be dropped.
		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(10);
		expect(entries[0].id).toBe(1); // id=0 dropped (oldest)
		expect(entries[9].id).toBe(10); // newest entry survives
	});

	it('drops the oldest entries (FIFO) when exceeding cap — newest retained', async () => {
		// Pre-populate 12 entries, cap is 10 → appending a 13th must keep newest 10.
		await writeEntries(12);

		const appended = await appendKnowledgeWithCapEnforcement<TestEntry>(
			testFile,
			{ id: 12, lesson: 'newest-entry' },
			10,
		);
		expect(appended).toBe(true);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(10);

		const ids = entries.map((e) => e.id);
		// Newest 10 must survive: ids 3-12 (oldest 3 dropped: 0, 1, 2)
		expect(ids).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(entries[entries.length - 1].lesson).toBe('newest-entry');
	});

	it('handles large over-limit: 200 entries + append with cap 100 → 100 newest kept', async () => {
		await writeEntries(200);

		const appended = await appendKnowledgeWithCapEnforcement<TestEntry>(
			testFile,
			{ id: 200, lesson: 'appended-after-200' },
			100,
		);
		expect(appended).toBe(true);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(100);
		expect(entries[0].id).toBe(101); // oldest 101 dropped
		expect(entries[99].id).toBe(200); // appended entry survives
	});

	it('cap of 1: appending evicts every prior entry', async () => {
		await writeEntries(5);

		const appended = await appendKnowledgeWithCapEnforcement<TestEntry>(
			testFile,
			{ id: 5, lesson: 'only-survivor' },
			1,
		);
		expect(appended).toBe(true);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe(5);
		expect(entries[0].lesson).toBe('only-survivor');
	});

	it('non-existent file: appends as the first entry', async () => {
		const newFile = path.join(tmpDir, 'fresh.jsonl');

		const appended = await appendKnowledgeWithCapEnforcement<TestEntry>(
			newFile,
			{ id: 0, lesson: 'first-ever' },
			10,
		);
		expect(appended).toBe(true);

		const entries = await readKnowledge<TestEntry>(newFile);
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe(0);
	});

	it('atomicity: concurrent appendKnowledgeWithCapEnforcement calls do not lose entries', async () => {
		// Pre-populate 5 entries (under cap of 10).
		await writeEntries(5);

		// Race 5 concurrent appends that will overflow the cap.
		// At most 10 entries can survive (5 original + 5 appended).
		const appends = Array.from({ length: 5 }, (_, i) =>
			appendKnowledgeWithCapEnforcement<TestEntry>(
				testFile,
				{ id: 100 + i, lesson: `concurrent-${i}` },
				10,
			),
		);

		const results = await Promise.all(appends);
		// Every call must have reported the append+enforce cycle ran.
		for (const r of results) expect(r).toBe(true);

		const entries = await readKnowledge<TestEntry>(testFile);
		// Cap is 10; with lock-before-read the final state must be exactly 10.
		expect(entries).toHaveLength(10);

		const ids = entries.map((e) => e.id);
		// All 5 concurrent appends (ids 100-104) must survive — none silently dropped
		// by a TOCTOU window between concurrent cap-enforcement rewrites.
		for (let i = 0; i < 5; i++) {
			expect(ids).toContain(100 + i);
		}
		// The 5 original entries (ids 0-4) are evicted since cap is 10
		// and 5+5=10 exactly fills it.
	});

	it('atomicity: concurrent appendKnowledgeWithCapEnforcement + standalone enforceKnowledgeCap do not lose entries', async () => {
		// Pre-populate 8 entries (under cap of 10).
		await writeEntries(8);

		// Race: two appends AND a standalone cap-enforcement call.
		const appendA = appendKnowledgeWithCapEnforcement<TestEntry>(
			testFile,
			{ id: 100, lesson: 'concurrent-A' },
			10,
		);
		const cap = enforceKnowledgeCap<TestEntry>(testFile, 10);
		const appendB = appendKnowledgeWithCapEnforcement<TestEntry>(
			testFile,
			{ id: 101, lesson: 'concurrent-B' },
			10,
		);

		await Promise.all([appendA, cap, appendB]);

		const entries = await readKnowledge<TestEntry>(testFile);
		// Cap is 10; lock-before-read must serialize all three callers so neither
		// concurrent append is silently dropped by the cap-enforcement rewrite.
		expect(entries).toHaveLength(10);
		const ids = entries.map((e) => e.id);
		expect(ids).toContain(100);
		expect(ids).toContain(101);
	});

	it('atomicity: append + cap rewrite happens in one transaction (no intermediate state)', async () => {
		// This test verifies the "atomic" guarantee by asserting on observable
		// persisted state after the call: append must not be visible without
		// the trim having happened, and trim must not drop the just-appended
		// entry. Both halves of the operation must complete together (PR #1207
		// explicit goal: prevent the race "entry is appended but cap enforcement
		// fails").
		await writeEntries(12);

		const appended = await appendKnowledgeWithCapEnforcement<TestEntry>(
			testFile,
			{ id: 12, lesson: 'newest' },
			10,
		);
		expect(appended).toBe(true);

		// Final persisted state must reflect both the append AND the trim:
		// exactly 10 entries, newest entry present, oldest entries dropped.
		// If the operation were split into two non-atomic writes (append, then
		// enforceKnowledgeCap), a crash between them would leave either:
		//   - 13 entries (append visible, trim never ran) — cap exceeded
		//   - 11 or 9 entries (append lost, trim ran on different snapshot)
		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(10);
		expect(entries[entries.length - 1].id).toBe(12);
		expect(entries.map((e) => e.id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

		// The appended entry MUST be the final entry in the file (it was the
		// newest, so cap-enforcement's FIFO drop must preserve it).
		expect(entries[entries.length - 1].lesson).toBe('newest');
	});
});
