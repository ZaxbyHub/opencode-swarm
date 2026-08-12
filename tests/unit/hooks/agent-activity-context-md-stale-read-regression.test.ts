import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../../src/evidence/task-file';
import { readSwarmFileAsync } from '../../../src/hooks/utils';
import {
	_internals as artifactCacheInternals,
	resetSwarmArtifactCache,
} from '../../../src/utils/swarm-artifact-cache';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Regression: issue #1729 — a same-size rewrite of `.swarm/context.md`
 * landing within one filesystem timestamp tick of a prior cached read
 * produces an identical stat stamp (mtimeMs + ctimeMs + size), so the
 * cache's staleness check alone cannot detect the rewrite. Writers that
 * read-modify-write the same path in quick succession (agent-activity's
 * `doFlush`, which reads context.md at src/hooks/agent-activity.ts:151 and
 * writes it back via `atomicWriteFile`) MUST invalidate the cache after the
 * write so the next read cannot observe stale content.
 *
 * This test forces the identical-stamp collision deterministically via the
 * `_internals.stat` DI seam on `swarm-artifact-cache.ts` instead of relying
 * on `utimesSync`, because `utimesSync` cannot set ctime portably (POSIX
 * ctime is inode-change-time and bumps on every rewrite regardless; NTFS
 * ctime is birthtime and does not track content changes at all) — see the
 * documented platform divergence in
 * tests/unit/utils/swarm-artifact-cache.test.ts.
 */
describe('agent-activity — regression: context.md read-modify-write must invalidate cache (#1729)', () => {
	let tempDir: string;
	let contextPath: string;
	let originalStat: typeof artifactCacheInternals.stat;

	beforeEach(async () => {
		resetSwarmArtifactCache();
		// canonicalMkdtemp closes the macOS /var -> /private/var symlink gap and
		// the Windows 8.3 short-name mismatch (FR-011, issue #1737).
		tempDir = canonicalMkdtemp('agent-activity-stale-');
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		contextPath = join(tempDir, '.swarm', 'context.md');
		originalStat = artifactCacheInternals.stat;
	});

	afterEach(async () => {
		artifactCacheInternals.stat = originalStat;
		resetSwarmArtifactCache();
		await rm(tempDir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		});
	});

	test('readSwarmFileAsync returns the rewritten content after atomicWriteFile, even under a forced identical stat stamp', async () => {
		await writeFile(contextPath, 'AAA', 'utf-8');

		// Prime the cache with the first read.
		const first = await readSwarmFileAsync(tempDir, 'context.md');
		expect(first).toBe('AAA');

		// Capture the real post-read stamp and force every subsequent stat call
		// (from any caller, any path) to report this exact same stamp — this is
		// the deterministic equivalent of a same-tick rewrite collision.
		const frozenStat = await stat(contextPath);

		artifactCacheInternals.stat = (async () =>
			frozenStat) as typeof artifactCacheInternals.stat;

		// The writer rewrites context.md with SAME-length content (both are 3
		// bytes) through the actual production write path used by
		// agent-activity's doFlush.
		await atomicWriteFile(contextPath, 'BBB');

		const second = await readSwarmFileAsync(tempDir, 'context.md');
		expect(second).toBe('BBB');
	});

	test('control: without invalidation, a forced identical stamp DOES serve stale content (proves the collision is real)', async () => {
		await writeFile(contextPath, 'AAA', 'utf-8');

		const first = await readSwarmFileAsync(tempDir, 'context.md');
		expect(first).toBe('AAA');

		const frozenStat = await stat(contextPath);
		artifactCacheInternals.stat = (async () =>
			frozenStat) as typeof artifactCacheInternals.stat;

		// Raw rewrite that does NOT go through atomicWriteFile/invalidation —
		// same length as 'AAA' so the forced stamp is plausible.
		await writeFile(contextPath, 'BBB', 'utf-8');

		const second = await readSwarmFileAsync(tempDir, 'context.md');
		expect(second).toBe('AAA'); // stale — demonstrates the bug the fix closes
	});
});
