/**
 * Plan-read cache tests (SC-001 through SC-005).
 *
 * Verifies that the per-invocation closure cache added to readSwarmFileAsync
 * prevents duplicate filesystem reads within a single transform invocation.
 *
 * Technique: we mock `_internals.validateSwarmPath` in utils.ts, which is
 * called by the retry loop AFTER the cache check. A cache hit returns the
 * stored Promise without reaching validateSwarmPath; a miss calls
 * validateSwarmPath and then reads the file. Counting validateSwarmPath calls
 * therefore measures exactly how many filesystem trips the code attempted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { detectArchitectMode } from '../../../src/hooks/system-enhancer';
import { _internals, readSwarmFileAsync } from '../../../src/hooks/utils';
import { loadPlan, savePlan } from '../../../src/plan/manager';

describe('plan-read-cache', () => {
	let tempDir: string;
	let originalValidateSwarmPath: typeof _internals.validateSwarmPath;
	let originalReadCachedTextFile: typeof _internals.readCachedTextFile;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'plan-cache-test-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		// Capture the real implementation so we can restore it and also wrap it.
		originalValidateSwarmPath = _internals.validateSwarmPath;
		originalReadCachedTextFile = _internals.readCachedTextFile;
	});

	afterEach(async () => {
		// Always restore the real seams so other tests are unaffected.
		_internals.validateSwarmPath = originalValidateSwarmPath;
		_internals.readCachedTextFile = originalReadCachedTextFile;
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * SC-001: Within a single cache Map, the same directory+filename is
	 * read at most once at the filesystem level regardless of how many times
	 * readSwarmFileAsync is called with that key.
	 */
	it('SC-001: same directory+filename uses the filesystem at most once per cache', async () => {
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '# Test Plan');

		let callCount = 0;
		_internals.validateSwarmPath = (dir: string, file: string): string => {
			callCount++;
			return originalValidateSwarmPath(dir, file);
		};

		const cache = new Map<string, Promise<string | null>>();

		const result1 = await readSwarmFileAsync(tempDir, 'plan.md', cache);
		const countAfterFirst = callCount;

		const result2 = await readSwarmFileAsync(tempDir, 'plan.md', cache);
		const countAfterSecond = callCount;

		expect(result1).toBe('# Test Plan');
		expect(result2).toBe('# Test Plan');
		// Second call must not add any validateSwarmPath calls — cache hit.
		expect(countAfterFirst).toBeGreaterThanOrEqual(1);
		expect(countAfterSecond).toBe(countAfterFirst);
	});

	/**
	 * SC-002: Different cache Map instances do not share entries.
	 * A fresh Map causes a new filesystem read.
	 */
	it('SC-002: a new invocation (new Map) does not share the cache', async () => {
		await writeFile(join(tempDir, '.swarm', 'plan.md'), 'First content');

		let callCount = 0;
		_internals.validateSwarmPath = (dir: string, file: string): string => {
			callCount++;
			return originalValidateSwarmPath(dir, file);
		};

		const cache1 = new Map<string, Promise<string | null>>();
		await readSwarmFileAsync(tempDir, 'plan.md', cache1);
		const countAfterCache1 = callCount;

		// Second Map starts empty — the read must reach validateSwarmPath again.
		const cache2 = new Map<string, Promise<string | null>>();
		await readSwarmFileAsync(tempDir, 'plan.md', cache2);
		const countAfterCache2 = callCount;

		expect(countAfterCache1).toBeGreaterThanOrEqual(1);
		// Cache2 is fresh, so validateSwarmPath must be called at least once more.
		expect(countAfterCache2).toBeGreaterThan(countAfterCache1);
	});

	/**
	 * SC-003: A null result (missing file) is also cached.
	 * The second call for the same missing file must not reach validateSwarmPath.
	 */
	it('SC-003: null result (missing file) is cached and not retried', async () => {
		// 'missing.md' is never created in .swarm/.

		let callCount = 0;
		_internals.validateSwarmPath = (dir: string, file: string): string => {
			callCount++;
			return originalValidateSwarmPath(dir, file);
		};

		const cache = new Map<string, Promise<string | null>>();

		const result1 = await readSwarmFileAsync(tempDir, 'missing.md', cache);
		const countAfterFirst = callCount;

		const result2 = await readSwarmFileAsync(tempDir, 'missing.md', cache);
		const countAfterSecond = callCount;

		expect(result1).toBeNull();
		expect(result2).toBeNull();
		// The second call must be a pure cache hit — no additional validateSwarmPath calls.
		// (The first call may invoke validateSwarmPath multiple times due to ENOENT retries;
		// what matters is that the second call adds zero.)
		expect(countAfterSecond).toBe(countAfterFirst);
	});

	/**
	 * SC-004: A non-ENOENT error (other I/O error → null) is also cached.
	 * Mocking validateSwarmPath to throw a generic Error causes readSwarmFileAsync
	 * to return null on the first attempt (no retry for non-ENOENT). The second
	 * call must hit the cache without reaching validateSwarmPath again.
	 */
	it('SC-004: non-ENOENT error result (null) is cached', async () => {
		let callCount = 0;
		_internals.validateSwarmPath = (_dir: string, _file: string): string => {
			callCount++;
			// Throw a generic error (not ENOENT) — this causes the retry loop to
			// return null immediately without retrying.
			throw new Error('Simulated I/O error');
		};

		const cache = new Map<string, Promise<string | null>>();

		const result1 = await readSwarmFileAsync(tempDir, 'error.md', cache);
		expect(result1).toBeNull();
		expect(callCount).toBe(1); // Exactly one call: no retry for non-ENOENT.

		const result2 = await readSwarmFileAsync(tempDir, 'error.md', cache);
		expect(result2).toBeNull();
		// Second call hits the cache — validateSwarmPath must not be called again.
		expect(callCount).toBe(1);
	});

	/**
	 * SC-005: When no cache is passed, behaviour is identical to before this change —
	 * every call reaches the filesystem (via validateSwarmPath).
	 */
	it('SC-005: callers without a cache behave identically to the original implementation', async () => {
		await writeFile(join(tempDir, '.swarm', 'plan.md'), '# Uncached Plan');

		let callCount = 0;
		_internals.validateSwarmPath = (dir: string, file: string): string => {
			callCount++;
			return originalValidateSwarmPath(dir, file);
		};

		// Call twice without passing a cache — each call must reach validateSwarmPath.
		const result1 = await readSwarmFileAsync(tempDir, 'plan.md');
		const countAfterFirst = callCount;

		const result2 = await readSwarmFileAsync(tempDir, 'plan.md');
		const countAfterSecond = callCount;

		expect(result1).toBe('# Uncached Plan');
		expect(result2).toBe('# Uncached Plan');
		// Without a cache, every call must reach validateSwarmPath.
		expect(countAfterFirst).toBeGreaterThanOrEqual(1);
		expect(countAfterSecond).toBeGreaterThan(countAfterFirst);
	});

	/**
	 * SC-001 (integration): plan.md is read at most once across loadPlan +
	 * detectArchitectMode when they share the same cache Map.
	 *
	 * Without the cache threading, loadPlan calls isPlanMdInSync which reads
	 * plan.md (count: 1), and detectArchitectMode→loadPlan→isPlanMdInSync reads
	 * it again (count: 2). With the shared cache the second call is a hit
	 * (count stays at 1). Regression value: if the cache param is accidentally
	 * dropped from any call site, this test fails.
	 */
	it('SC-001 (integration): shared cache prevents duplicate plan.md reads through loadPlan + detectArchitectMode', async () => {
		const plan: Plan = {
			schema_version: '1.0.0',
			title: 'Cache Test Plan',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'Task 1',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		// savePlan writes both plan.json and plan.md in sync.
		await savePlan(tempDir, plan);

		// Install the counting mock AFTER savePlan so its own reads are not counted.
		// Track calls per filename so plan.json noise from parsePlanJsonCached is
		// isolated from the plan.md count we care about.
		const countByFile = new Map<string, number>();
		_internals.validateSwarmPath = (dir: string, file: string): string => {
			countByFile.set(file, (countByFile.get(file) ?? 0) + 1);
			return originalValidateSwarmPath(dir, file);
		};

		const cache = new Map<string, Promise<string | null>>();

		// First consumer: loadPlan reads plan.json and plan.md (both misses → count: 1).
		await loadPlan(tempDir, cache);

		// Second consumer: detectArchitectMode calls loadPlan again with the same
		// cache — plan.md must be a hit (count must not increase).
		await detectArchitectMode(tempDir, cache);

		const planMdCount = countByFile.get('plan.md') ?? 0;
		expect(planMdCount).toBe(1);
	});

	/**
	 * SC-006: Concurrent in-flight reads for the same key share one underlying read.
	 * The cache stores the promise BEFORE awaiting (utils.ts:185-186) so two
	 * simultaneous callers must share the same promise and only one inner read occurs.
	 */
	it('SC-006: concurrent callers share one in-flight read', async () => {
		await writeFile(join(tempDir, '.swarm', 'concurrent.md'), 'shared content');

		let innerReadCount = 0;
		const originalReadCached = _internals.readCachedTextFile;
		_internals.readCachedTextFile = (async (
			p: string,
			factory: () => Promise<string>,
		) => {
			innerReadCount++;
			return factory();
		}) as typeof _internals.readCachedTextFile;

		const cache = new Map<string, Promise<string | null>>();

		// Start two concurrent reads WITHOUT awaiting
		const p1 = readSwarmFileAsync(tempDir, 'concurrent.md', cache);
		const p2 = readSwarmFileAsync(tempDir, 'concurrent.md', cache);

		// Allow microtasks to settle
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		const [r1, r2] = await Promise.all([p1, p2]);

		expect(r1).toBe('shared content');
		expect(r2).toBe('shared content');
		// Only one inner read should have occurred
		expect(innerReadCount).toBe(1);

		// Restore
		_internals.readCachedTextFile = originalReadCached;
	});

	/**
	 * SC-007: Non-ENOENT error inside the inner read (readCachedTextFile) is
	 * returned as null and the result is cached (no re-read on second call).
	 * This tests the actual error path inside readCachedTextFile → bunFile().text()
	 * rather than mocking at the validateSwarmPath layer.
	 */
	it('SC-007: non-ENOENT error from inner readCachedTextFile returns null and caches', async () => {
		let innerReadCount = 0;
		const originalReadCached = _internals.readCachedTextFile;
		_internals.readCachedTextFile = (async () => {
			innerReadCount++;
			const err = new Error('EACCES: permission denied');
			(err as NodeJS.ErrnoException).code = 'EACCES';
			throw err;
		}) as typeof _internals.readCachedTextFile;

		const cache = new Map<string, Promise<string | null>>();

		const result1 = await readSwarmFileAsync(tempDir, 'protected.md', cache);
		expect(result1).toBeNull();
		expect(innerReadCount).toBe(1);

		const result2 = await readSwarmFileAsync(tempDir, 'protected.md', cache);
		expect(result2).toBeNull();
		// Second call must be a cache hit — no additional inner read
		expect(innerReadCount).toBe(1);

		// Restore
		_internals.readCachedTextFile = originalReadCached;
	});
});
