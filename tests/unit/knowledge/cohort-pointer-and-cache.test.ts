import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type LinkPointer,
	invalidateKnowledgeStoreDirCache,
	readLinkPointer,
	removeLinkPointer,
	resolveKnowledgeStoreDir,
	writeLinkPointer,
} from '../../../src/hooks/knowledge-link.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

/**
 * Issue #1846 pointer schema v2 + cross-process cache revalidation tests.
 *
 * Covers required test classes:
 *  - 3. Legacy pointer compatibility and atomic pointer replacement.
 *  - 8. Cache invalidation / bounded eviction / cross-process revalidation.
 */

describe('pointer schema v2 (backward-compatible)', () => {
	let platformSpy: ReturnType<typeof spyOn> | undefined;
	const prevXdg = process.env.XDG_DATA_HOME;
	let cleanupFns: Array<() => void> = [];

	beforeEach(() => {
		invalidateKnowledgeStoreDirCache();
		platformSpy = spyOn(process, 'platform', 'get').mockReturnValue('linux');
		const d = createSafeTestDir('ptr-data-');
		process.env.XDG_DATA_HOME = d.dir;
		cleanupFns.push(d.cleanup);
	});

	afterEach(() => {
		platformSpy?.mockRestore();
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		invalidateKnowledgeStoreDirCache();
		for (const c of cleanupFns) {
			try {
				c();
			} catch {
				/* ignore */
			}
		}
		cleanupFns = [];
	});

	test('legacy v1 pointer on disk is read with version 1 and resolves correctly', async () => {
		const { dir, cleanup } = createSafeTestDir('ptr-v1-');
		cleanupFns.push(cleanup);
		// Hand-write a v1 pointer exactly as the legacy code would.
		const legacyPointer: LinkPointer = {
			version: 1,
			linkId: 'legacy-proj',
			createdAt: '2026-01-01T00:00:00.000Z',
			source: 'manual',
		};
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'link.json'),
			JSON.stringify(legacyPointer),
		);

		const read = readLinkPointer(dir);
		expect(read).not.toBeNull();
		expect(read?.version).toBe(1);
		expect(read?.linkId).toBe('legacy-proj');
		// v2 fields are absent on a v1 pointer.
		expect(read?.cohortId).toBeUndefined();
		expect(read?.identitySource).toBeUndefined();
		expect(read?.generation).toBeUndefined();
	});

	test('v2 pointer round-trips cohort metadata', async () => {
		const { dir, cleanup } = createSafeTestDir('ptr-v2-');
		cleanupFns.push(cleanup);
		const pointer: LinkPointer = {
			version: 2,
			linkId: 'cohort-1',
			createdAt: '2026-01-01T00:00:00.000Z',
			source: 'manual',
			cohortId: 'abc123def456',
			identitySource: 'remote',
			degraded: false,
			generation: 7,
			configFingerprint: 'fff888',
		};
		await writeLinkPointer(dir, pointer);

		const read = readLinkPointer(dir);
		expect(read?.version).toBe(2);
		expect(read?.cohortId).toBe('abc123def456');
		expect(read?.identitySource).toBe('remote');
		expect(read?.degraded).toBe(false);
		expect(read?.generation).toBe(7);
		expect(read?.configFingerprint).toBe('fff888');
	});

	test('readLinkPointer stops hard-stamping version (reads disk value)', async () => {
		const { dir, cleanup } = createSafeTestDir('ptr-version-');
		cleanupFns.push(cleanup);
		// Write a v2 pointer directly to disk.
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'link.json'),
			JSON.stringify({
				version: 2,
				linkId: 'v2-direct',
				createdAt: '2026-01-01T00:00:00.000Z',
				source: 'manual',
				cohortId: 'cccccc',
				identitySource: 'git-common-dir',
				degraded: true,
				generation: 3,
			}),
		);
		const read = readLinkPointer(dir);
		expect(read?.version).toBe(2); // not coerced to 1
		expect(read?.cohortId).toBe('cccccc');
		expect(read?.degraded).toBe(true);
	});

	test('unknown future version (3) degrades leniently to v1 semantics', async () => {
		const { dir, cleanup } = createSafeTestDir('ptr-future-');
		cleanupFns.push(cleanup);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'link.json'),
			JSON.stringify({
				version: 99,
				linkId: 'future',
				createdAt: '2026-01-01T00:00:00.000Z',
				source: 'manual',
			}),
		);
		const read = readLinkPointer(dir);
		// Unknown version coerced to 1 (lenient, forward-compat), linkId preserved.
		expect(read?.version).toBe(1);
		expect(read?.linkId).toBe('future');
	});
});

describe('cross-process cache revalidation (mtime+ctime+size)', () => {
	let platformSpy: ReturnType<typeof spyOn> | undefined;
	const prevXdg = process.env.XDG_DATA_HOME;
	let cleanupFns: Array<() => void> = [];

	beforeEach(() => {
		invalidateKnowledgeStoreDirCache();
		platformSpy = spyOn(process, 'platform', 'get').mockReturnValue('linux');
		const d = createSafeTestDir('cache-data-');
		process.env.XDG_DATA_HOME = d.dir;
		cleanupFns.push(d.cleanup);
	});

	afterEach(() => {
		platformSpy?.mockRestore();
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		invalidateKnowledgeStoreDirCache();
		for (const c of cleanupFns) {
			try {
				c();
			} catch {
				/* ignore */
			}
		}
		cleanupFns = [];
	});

	test('cache hit returns shared dir while pointer unchanged', async () => {
		const { dir, cleanup } = createSafeTestDir('cache-hit-');
		cleanupFns.push(cleanup);
		await writeLinkPointer(dir, {
			version: 2,
			linkId: 'cached',
			createdAt: '2026-01-01T00:00:00.000Z',
			source: 'manual',
		});
		const first = resolveKnowledgeStoreDir(dir);
		// Second call within TTL — should hit cache.
		const second = resolveKnowledgeStoreDir(dir);
		expect(second).toBe(first);
		expect(second).toContain('cached');
	});

	test('external pointer change invalidates cache without waiting for TTL', async () => {
		const { dir, cleanup } = createSafeTestDir('cache-inval-');
		cleanupFns.push(cleanup);
		await writeLinkPointer(dir, {
			version: 2,
			linkId: 'before',
			createdAt: '2026-01-01T00:00:00.000Z',
			source: 'manual',
		});
		const before = resolveKnowledgeStoreDir(dir);
		expect(before).toContain('before');

		// Simulate another process writing a different pointer (external atomic
		// replace → mtime/ctime/size change → cache must revalidate).
		await writeLinkPointer(dir, {
			version: 2,
			linkId: 'after',
			createdAt: '2026-01-02T00:00:00.000Z',
			source: 'manual',
		});

		const after = resolveKnowledgeStoreDir(dir);
		expect(after).toContain('after');
		expect(after).not.toBe(before);
	});

	test('external pointer removal invalidates cache (linked → local)', async () => {
		const { dir, cleanup } = createSafeTestDir('cache-remove-');
		cleanupFns.push(cleanup);
		await writeLinkPointer(dir, {
			version: 2,
			linkId: 'will-remove',
			createdAt: '2026-01-01T00:00:00.000Z',
			source: 'manual',
		});
		const linked = resolveKnowledgeStoreDir(dir);
		expect(linked).toContain('will-remove');

		// Another process unlinks (removes pointer).
		await removeLinkPointer(dir);

		const local = resolveKnowledgeStoreDir(dir);
		expect(local).toBe(path.join(dir, '.swarm'));
	});
});
