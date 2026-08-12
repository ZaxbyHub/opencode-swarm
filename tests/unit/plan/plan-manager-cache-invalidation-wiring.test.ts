/**
 * Wired-path regression: plan.md/plan.json writers in src/plan/manager.ts
 * must call invalidateCachedArtifact after a successful atomic rename, or a
 * same-size rewrite landing within one filesystem timestamp tick of a prior
 * cached read can silently serve stale content (issue #1729,
 * src/utils/swarm-artifact-cache.ts:256-268).
 *
 * These tests force an identical stat-stamp collision via the
 * `_internals.stat` DI seam on swarm-artifact-cache.ts (utimesSync cannot
 * portably set ctime — see tests/unit/utils/swarm-artifact-cache.test.ts)
 * and prove the *actual* writer function invalidates the cache, not just
 * that invalidateCachedArtifact exists somewhere in the module.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { regeneratePlanMarkdown } from '../../../src/plan/manager';
import {
	_internals as artifactCacheInternals,
	readCachedTextFile,
	resetSwarmArtifactCache,
} from '../../../src/utils/swarm-artifact-cache';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;
let originalStat: typeof artifactCacheInternals.stat;

beforeEach(async () => {
	resetSwarmArtifactCache();
	// canonicalMkdtemp closes the macOS /var -> /private/var symlink gap and
	// the Windows 8.3 short-name mismatch (FR-011, issue #1737).
	tmpDir = canonicalMkdtemp('plan-manager-cache-');
	await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
	originalStat = artifactCacheInternals.stat;
});

afterEach(async () => {
	artifactCacheInternals.stat = originalStat;
	resetSwarmArtifactCache();
	try {
		await fs.rm(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

function minimalPlan(title: string): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'regression',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						description: 'Task 1.1',
						status: 'pending',
						size: 'small',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	} as Plan;
}

describe('plan/manager.ts — regression: plan.md write must invalidate cache (#1729)', () => {
	test('regeneratePlanMarkdown invalidates the cache so the next cached read sees fresh content under a forced identical stat stamp', async () => {
		const mdPath = path.join(tmpDir, '.swarm', 'plan.md');

		// Seed plan.md and prime the cache with a read.
		await fs.writeFile(mdPath, 'OLD', 'utf-8');
		const firstRead = await readCachedTextFile(mdPath, () =>
			fs.readFile(mdPath, 'utf-8'),
		);
		expect(firstRead).toBe('OLD');

		// Force every subsequent stat() to report the stamp captured right
		// after the first read, simulating a same-tick rewrite collision.
		const frozenStat = await fs.stat(mdPath);
		artifactCacheInternals.stat = (async () =>
			frozenStat) as typeof artifactCacheInternals.stat;

		// Real production writer under test.
		await regeneratePlanMarkdown(tmpDir, minimalPlan('Wiring Test'));

		// The `directRead` below is supplied by the test rather than reading the
		// file, so this asserts the one thing the wiring is responsible for: the
		// writer dropped the cache entry, forcing a real read. Asserting on the
		// written file's *content* instead would make this test depend on
		// `bunWrite`, which sibling files in this directory replace process-wide
		// by module-mocking `../../../src/utils/bun-compat` — that made the
		// assertion fail in a multi-file run for reasons unrelated to invalidation.
		// End-to-end proof that invalidation defeats a stamp collision lives in
		// tests/unit/hooks/agent-activity-context-md-stale-read-regression.test.ts.
		const secondRead = await readCachedTextFile(mdPath, async () => 'FRESH');
		expect(secondRead).toBe('FRESH');
	});
});
