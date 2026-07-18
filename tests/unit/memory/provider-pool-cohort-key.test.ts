/**
 * #1850: cohort-aware provider pool keying (acceptance #5).
 * Verifies cohort roots get distinct pool keys from local roots, and that
 * evictAndCloseForRoot is scoped (does not clear unrelated entries).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MEMORY_CONFIG } from '../../../src/memory/config';
import {
	clearPool,
	evictAndCloseForRoot,
	getOrCreateProviderForRoot,
} from '../../../src/memory/provider-pool';
import { wrapLocalRoot } from '../../../src/memory/storage-root';

function makeTmp(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe('#1850 provider pool cohort keying (acceptance #5)', () => {
	const dirs: string[] = [];

	beforeEach(() => {
		clearPool();
	});

	afterEach(() => {
		clearPool();
		for (const d of dirs.splice(0)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* best-effort Windows EBUSY */
			}
		}
	});

	test('F-8: two distinct local roots get distinct providers', () => {
		const dirA = makeTmp('pool-local-a-');
		const dirB = makeTmp('pool-local-b-');
		dirs.push(dirA, dirB);
		const rootA = wrapLocalRoot(dirA);
		const rootB = wrapLocalRoot(dirB);
		const provA = getOrCreateProviderForRoot(rootA, DEFAULT_MEMORY_CONFIG);
		const provB = getOrCreateProviderForRoot(rootB, DEFAULT_MEMORY_CONFIG);
		expect(provA).not.toBe(provB);
	});

	test('F-9: same local root returns same provider (cache hit)', () => {
		const dir = makeTmp('pool-same-');
		dirs.push(dir);
		const root = wrapLocalRoot(dir);
		const prov1 = getOrCreateProviderForRoot(root, DEFAULT_MEMORY_CONFIG);
		const prov2 = getOrCreateProviderForRoot(root, DEFAULT_MEMORY_CONFIG);
		expect(prov1).toBe(prov2);
	});

	test('F-10: cohort root and local root for same directory get distinct providers', () => {
		const dir = makeTmp('pool-mixed-');
		dirs.push(dir);
		const localRoot = wrapLocalRoot(dir);
		const cohortRoot = {
			kind: 'cohort' as const,
			cohortRoot: path.join(dir, 'fake-cohort', 'memory'),
			cohortId: 'fake-cohort-id',
			generation: 1,
			linkId: 'fake-cohort',
			directory: dir,
		};
		const localProv = getOrCreateProviderForRoot(
			localRoot,
			DEFAULT_MEMORY_CONFIG,
		);
		const cohortProv = getOrCreateProviderForRoot(
			cohortRoot,
			DEFAULT_MEMORY_CONFIG,
		);
		expect(localProv).not.toBe(cohortProv);
	});

	test('F-11: evictAndCloseForRoot is scoped (does not evict unrelated entries)', () => {
		const dirA = makeTmp('pool-evict-a-');
		const dirB = makeTmp('pool-evict-b-');
		dirs.push(dirA, dirB);
		const rootA = wrapLocalRoot(dirA);
		const rootB = wrapLocalRoot(dirB);
		const provA = getOrCreateProviderForRoot(rootA, DEFAULT_MEMORY_CONFIG);
		const provB = getOrCreateProviderForRoot(rootB, DEFAULT_MEMORY_CONFIG);
		// Release A's refcount so eviction can really close it.
		provA.close();
		// Evict A only.
		evictAndCloseForRoot(rootA);
		// Re-acquire A — should be a new instance.
		const provA2 = getOrCreateProviderForRoot(rootA, DEFAULT_MEMORY_CONFIG);
		expect(provA2).not.toBe(provA);
		// B should still be cached (same instance).
		const provB2 = getOrCreateProviderForRoot(rootB, DEFAULT_MEMORY_CONFIG);
		expect(provB2).toBe(provB);
	});
});
