import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './config';
import {
	clearPool,
	getOrCreateProvider,
	isPooledProvider,
} from './provider-pool';

// Use a unique temp directory per test run to avoid cross-test pollution.
// Follows the pattern in provider-pool.test.ts: os.tmpdir() + mkdtempSync.
const TEST_DIR = mkdtempSync(path.join(os.tmpdir(), 'injector-reconcile-'));

/** Minimal config required by getOrCreateProvider — use defaults for everything else. */
const TEST_CONFIG: MemoryConfig = {
	...DEFAULT_MEMORY_CONFIG,
	provider: 'sqlite',
	storageDir: TEST_DIR,
};

beforeEach(() => {
	clearPool();
});

afterEach(() => {
	clearPool();
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; on Windows a locked DB file may prevent immediate deletion.
	}
});

describe('injector-dispose-reconciliation — provider pool lifecycle', () => {
	// -------------------------------------------------------------------------
	// Test 1: Dispose-then-construct reuse
	// -------------------------------------------------------------------------
	test(
		'getOrCreateProvider returns the SAME provider instance after gateway.dispose() ' +
			'(close does NOT evict the pool entry — it stays for reuse)',
		async () => {
			const canonical = TEST_DIR;

			// First acquisition: refCount=1
			const provider1 = getOrCreateProvider(canonical, TEST_CONFIG);
			expect(isPooledProvider(provider1)).toBe(true);

			// Simulate what injector.ts does in try/finally:
			// gateway.dispose() → provider.close() → releaseProvider()
			await provider1.close();

			// Second acquisition for the same directory: should return the SAME instance
			const provider2 = getOrCreateProvider(canonical, TEST_CONFIG);

			// The contract: close() must NOT have evicted the entry
			expect(provider2).toBe(provider1); // same reference
		},
	);

	// -------------------------------------------------------------------------
	// Test 2: Double-dispose safety
	// -------------------------------------------------------------------------
	test(
		'calling provider.close() twice is safe (idempotent) — no error thrown, ' +
			'entry stays in pool for reuse',
		async () => {
			const canonical = TEST_DIR;

			const provider = getOrCreateProvider(canonical, TEST_CONFIG);
			expect(isPooledProvider(provider)).toBe(true);

			// First close: refCount 1→0
			await provider.close();

			// Second close: refCount 0→0 (already 0, no-op for active-pool entry)
			// Must NOT throw
			await expect(provider.close()).resolves.toBeUndefined();

			// Entry still in pool — reuse still works
			const reuse = getOrCreateProvider(canonical, TEST_CONFIG);
			expect(reuse).toBe(provider);
		},
	);

	// -------------------------------------------------------------------------
	// Test 3: refCount tracking — full open/close/open/close/open cycle
	// -------------------------------------------------------------------------
	test(
		'refCount correctly tracks acquire/release cycles: the same provider ' +
			'remains reusable after every dispose, and subsequent getOrCreateProvider ' +
			'calls return the identical instance',
		async () => {
			const canonical = TEST_DIR;

			// --- Cycle 1: acquire (refCount=1), release (refCount=0) ---
			const p1 = getOrCreateProvider(canonical, TEST_CONFIG);
			expect(isPooledProvider(p1)).toBe(true);

			await p1.close();

			// Verify reuse still works after first close
			const p2 = getOrCreateProvider(canonical, TEST_CONFIG);
			expect(p2).toBe(p1);

			// --- Cycle 2: acquire again (refCount=1), release (refCount=0) ---
			await p2.close();

			// Verify reuse still works after second close
			const p3 = getOrCreateProvider(canonical, TEST_CONFIG);
			expect(p3).toBe(p1); // same provider instance

			// --- Cycle 3: acquire a third time, leave open ---
			const p4 = getOrCreateProvider(canonical, TEST_CONFIG);
			expect(p4).toBe(p1);

			// Provider should still be open and usable
			expect(isPooledProvider(p4)).toBe(true);

			// Final sanity: no error on cleanup
			await expect(p4.close()).resolves.toBeUndefined();
		},
	);

	// -------------------------------------------------------------------------
	// Test 4: Multiple directories get distinct providers
	// -------------------------------------------------------------------------
	test(
		'separate directories get separate providers — dispose of one does not ' +
			'affect the other',
		async () => {
			const dir1 = TEST_DIR + '-dir1';
			const dir2 = TEST_DIR + '-dir2';

			const provider1 = getOrCreateProvider(dir1, TEST_CONFIG);
			const provider2 = getOrCreateProvider(dir2, TEST_CONFIG);

			expect(provider1).not.toBe(provider2);

			// Close dir1's provider — dir2's should be unaffected
			await provider1.close();

			const provider1Reuse = getOrCreateProvider(dir1, TEST_CONFIG);
			const provider2Reuse = getOrCreateProvider(dir2, TEST_CONFIG);

			expect(provider1Reuse).toBe(provider1);
			expect(provider2Reuse).toBe(provider2);
		},
	);
});
