import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { clearPool, getOrCreateProvider } from './provider-pool';
import { SQLiteMemoryProvider } from './sqlite-provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix = 'deferred-repromotion-'): string {
	return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Suite — Deferred re-promotion (HIGH fix)
// ---------------------------------------------------------------------------
// Verifies that when a provider is evicted from the LRU pool but still has
// an active refCount (deferredEntries), re-acquiring the same directory
// re-promotes the SAME provider instance instead of creating a new one.
//
// Scenario:
//   1. clearPool()
//   2. getOrCreateProvider(dirA) → provider1, refCount=1 (active in pool)
//   3. Fill pool with 16 other directories (dir1–dir16)
//      → dirA is now in deferredEntries (evicted, refCount=1)
//   4. getOrCreateProvider(dirA) → should return provider1 (re-promoted)
//   5. Assert provider1 === result (referential equality)
//
// This is the key invariant: eviction ≠ destruction when references remain.
// ---------------------------------------------------------------------------

describe('provider-pool — deferred re-promotion (HIGH fix)', () => {
	const scratchDirs: string[] = [];

	afterEach(() => {
		clearPool();
		for (const d of scratchDirs) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				// Best-effort; Windows may hold file locks briefly.
			}
		}
		scratchDirs.length = 0;
	});

	/**
	 * HIGH fix: evicted-but-still-referenced provider is re-promoted on re-access.
	 *
	 * Regression test — prior behavior called close() immediately on eviction,
	 * creating a NEW provider on re-access. The fix preserves the provider in
	 * deferredEntries and re-promotes it when re-requested.
	 */
	test('re-acquiring an evicted directory returns the SAME provider instance', () => {
		const cfg = {};

		// Step 1: create dirA (provider1, refCount=1 in active pool)
		const dirA = makeTmpDir('repromo-a-');
		scratchDirs.push(dirA);
		const provider1 = getOrCreateProvider(dirA, cfg);
		expect(provider1).toBeInstanceOf(SQLiteMemoryProvider);

		// Step 2: fill pool with 16 other directories (dir1–dir16).
		// This triggers evictLru() which evicts dirA into deferredEntries
		// (refCount=1, so not closed).
		const fillDirs: string[] = [];
		for (let i = 1; i <= 16; i++) {
			const d = makeTmpDir(`repromo-fill-${i}-`);
			scratchDirs.push(d);
			fillDirs.push(d);
		}
		for (const d of fillDirs) {
			getOrCreateProvider(d, cfg);
		}

		// Step 3: re-acquire dirA — should re-promote provider1 from deferredEntries.
		const result = getOrCreateProvider(dirA, cfg);

		// REFERENTIAL EQUALITY — the exact same object, not a new instance.
		expect(result).toBe(provider1);

		// Functional sanity check: the re-promoted provider is usable and stable.
		const result2 = getOrCreateProvider(dirA, cfg);
		expect(result2).toBe(provider1);
	});

	/**
	 * Verify that a provider with refCount=1 evicted to deferredEntries is
	 * correctly re-promoted. This is the simplest unit scenario.
	 */
	test('single entry evicted to deferredEntries is re-promoted to the same instance', () => {
		const cfg = {};

		// Create 2 entries: dirA (to be evicted) and dirB (filler)
		const dirA = makeTmpDir('repromo-simple-a-');
		const dirB = makeTmpDir('repromo-simple-b-');
		scratchDirs.push(dirA, dirB);

		const providerA = getOrCreateProvider(dirA, cfg);
		getOrCreateProvider(dirB, cfg); // dirB is now MRU

		// Fill to MAX_POOL_SIZE=16 — this will evict dirA (LRU).
		for (let i = 2; i <= 16; i++) {
			const d = makeTmpDir(`repromo-simple-fill-${i}-`);
			scratchDirs.push(d);
			getOrCreateProvider(d, cfg);
		}

		// Re-access dirA — should return the SAME provider instance.
		const reAccess = getOrCreateProvider(dirA, cfg);
		expect(reAccess).toBe(providerA);
	});

	/**
	 * After re-promotion, the provider's refCount is incremented correctly
	 * and subsequent accesses return the same instance.
	 */
	test('re-promoted provider has correct refCount and is stable across multiple accesses', () => {
		const cfg = {};

		const dirA = makeTmpDir('repromo-stable-a-');
		scratchDirs.push(dirA);
		const providerA = getOrCreateProvider(dirA, cfg);

		// Fill pool to evict dirA
		for (let i = 1; i <= 16; i++) {
			const d = makeTmpDir(`repromo-stable-fill-${i}-`);
			scratchDirs.push(d);
			getOrCreateProvider(d, cfg);
		}

		// First re-access (re-promotion)
		const r1 = getOrCreateProvider(dirA, cfg);
		expect(r1).toBe(providerA);

		// Second re-access (should be a cache hit, no re-promotion needed)
		const r2 = getOrCreateProvider(dirA, cfg);
		expect(r2).toBe(providerA);

		// Third re-access
		const r3 = getOrCreateProvider(dirA, cfg);
		expect(r3).toBe(providerA);

		// All three must be the exact same object reference.
		expect(r1).toBe(r2);
		expect(r2).toBe(r3);
	});
});
