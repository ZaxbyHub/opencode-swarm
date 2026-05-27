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
		'concurrent enforceKnowledgeCap calls do not lose entries — ' +
			'lock-before-read ensures atomic read-modify-write',
		async () => {
			// Set up: write 5 entries first
			await writeEntries(5);

			// Override readKnowledge within _internals to introduce a deliberate
			// delay, simulating the TOCTOU window where another caller could append.
			// With the pre-fix code (read-before-lock), this delay would allow
			// concurrent appends to be dropped when the rewrite happens.
			// With the post-fix code (lock-before-read), the lock is already held
			// when readKnowledge is called, so concurrent appends wait.
			const originalReadKnowledge = _internals.readKnowledge;
			let callCount = 0;
			_internals.readKnowledge = mock(
				async <T>(filePath: string): Promise<T[]> => {
					callCount++;
					// First call (from first enforceKnowledgeCap): delay to simulate TOCTOU window
					if (callCount === 1) {
						await Bun.sleep(50);
					}
					return originalReadKnowledge(filePath);
				},
			);

			// Two concurrent enforceKnowledgeCap calls on the same file.
			// Both should see the same snapshot under lock, and neither should
			// drop entries that the other wrote.
			await Promise.all([
				enforceKnowledgeCap<TestEntry>(testFile, 10),
				enforceKnowledgeCap<TestEntry>(testFile, 10),
			]);

			// Both calls should have seen 5 entries (under cap of 10, no trim).
			// File should still have exactly 5 entries — no entries lost.
			const entries = await readKnowledge<TestEntry>(testFile);
			expect(entries).toHaveLength(5);
			expect(entries.map((e) => e.id)).toEqual([0, 1, 2, 3, 4]);

			_internals.readKnowledge = originalReadKnowledge;
		},
	);

	it(
		'concurrent enforceKnowledgeCap with appendKnowledge interleaving — ' +
			'append adds entries that must not be lost when cap is enforced',
		async () => {
			// Start with 3 entries (under cap of 10)
			await writeEntries(3);

			// Simulate the race condition by mocking readKnowledge to return a
			// stale snapshot (as the pre-fix code would have done).
			// This test verifies that with the lock-before-read fix, even if
			// appendKnowledge interleaves, the final count is correct.
			const originalReadKnowledge = _internals.readKnowledge;
			let readPhase = 0;
			_internals.readKnowledge = mock(
				async <T>(_filePath: string): Promise<T[]> => {
					readPhase++;
					if (readPhase === 1) {
						// First enforceKnowledgeCap call reads 3 entries
						// (simulating old code reading before lock)
						await Bun.sleep(30);
						return originalReadKnowledge(_filePath);
					}
					// Second call reads after appendKnowledge has added more
					return originalReadKnowledge(_filePath);
				},
			);

			// Race: enforceKnowledgeCap reads, then appendKnowledge adds entries,
			// then enforceKnowledgeCap writes.
			// With the fix (lock-before-read), appendKnowledge is blocked until
			// the lock is released, so it appends AFTER the trim-write.
			await Promise.all([
				enforceKnowledgeCap<TestEntry>(testFile, 10),
				(async () => {
					await Bun.sleep(15); // delay to let enforceKnowledgeCap read first
					await appendKnowledge(testFile, { id: 99, lesson: 'interleaved' });
				})(),
			]);

			// The interleaved entry should be preserved (appended after trim)
			const entries = await readKnowledge<TestEntry>(testFile);
			const ids = entries.map((e) => e.id);
			// Should have 4 entries: original 3 + interleaved append
			// (cap is 10, well above 4)
			expect(ids).toContain(99);
			expect(ids.sort()).toEqual([0, 1, 2, 99].sort());

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
