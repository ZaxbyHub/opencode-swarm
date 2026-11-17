// #3218 — frozen acceptance spec (corrected shape).
//
// Corrected shape: the retention classification reads the bundle JSON's
// `updated_at` field, NEVER filesystem mtime. `archiveEvidence` selects a
// bundle when `bundle.updated_at < cutoffIso` with a STRICT less-than, where
// the cutoff is `now` minus `max_age_days` computed with Date calendar-day
// arithmetic (`setDate`). Consequences pinned here:
//   - a bundle exactly AT the cutoff (F−90d) is NOT selected (strict <);
//   - only the old-side bundle (F−90d−1s) is selected by age;
//   - membership is identical across repeated dry-run classifications;
//   - a same-size `updated_at` rewrite that dodges the artifact-cache stamp
//     is picked up after `invalidateCachedArtifact` (the cache-flip leg).
//
// The clock is frozen at the fixed constant F via the repo's freezeClock
// helper (tests/helpers/test-clock.ts); the cutoff is derived with the exact
// production `setDate` semantics from the same constant so the boundary token
// equals the production `cutoffIso` byte-for-byte in any timezone.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { Evidence } from '../../../src/config/evidence-schema.js';
import {
	archiveEvidence,
	loadEvidence,
	saveEvidence,
} from '../../../src/evidence/manager.js';
import {
	_internals as artifactCacheInternals,
	invalidateCachedArtifact,
	resetSwarmArtifactCache,
} from '../../../src/utils/swarm-artifact-cache.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const FROZEN_NOW_MS = Date.UTC(2026, 6, 14, 12);
const MAX_AGE_DAYS = 90;
const ONE_SECOND_MS = 1000;
const DETERMINISM_ITERATIONS = 25;
const TEST_TIMEOUT_MS = 30_000;

const TASK_FRESH = '1.1';
const TASK_NEW_SIDE = '2.1';
const TASK_OLD_SIDE = '3.1';
const TASK_BOUNDARY = '4.1';
const TASK_FLIP = '5.1';

/** Production cutoff semantics mirrored from archiveEvidence (setDate path). */
function productionCutoffMs(): number {
	const cutoff = new Date(FROZEN_NOW_MS);
	cutoff.setDate(cutoff.getDate() - MAX_AGE_DAYS);
	return cutoff.getTime();
}

function isoOf(ms: number): string {
	return new Date(ms).toISOString();
}

/** Dry-run classification under the frozen clock; returns selected-by-age IDs. */
async function classifyByAge(directory: string): Promise<string[]> {
	return withFrozenClockAsync(
		async () => {
			const report = await archiveEvidence(directory, MAX_AGE_DAYS, undefined, {
				report: true,
				dryRun: true,
				now: new Date(FROZEN_NOW_MS),
			});
			return report.selectedEvidenceByAge;
		},
		{ fixedNow: FROZEN_NOW_MS },
	);
}

/**
 * Pin `updated_at` (and `created_at`, mirroring makeBundleOld in
 * tests/unit/commands/archive.test.ts) by rewriting the bundle JSON under the
 * temp root, bypassing saveEvidence. Returns the bundle path.
 */
async function pinBundleTimestamp(
	directory: string,
	taskId: string,
	iso: string,
): Promise<string> {
	const result = await loadEvidence(directory, taskId);
	if (result.status !== 'found') {
		throw new Error(`Bundle not found for task ${taskId}`);
	}
	const bundle = result.bundle;
	bundle.updated_at = iso;
	bundle.created_at = iso;
	const evidencePath = path.join(
		directory,
		'.swarm',
		'evidence',
		taskId,
		'evidence.json',
	);
	await Bun.write(evidencePath, JSON.stringify(bundle));
	return evidencePath;
}

/**
 * Same-size bundle rewrite WITHOUT cache invalidation — the #3218 H2 hazard
 * itself (the makeBundleOld idiom before the fix). Deliberately uninvalidated
 * so the mid-flip read can serve the cached pre-rewrite value under a
 * colliding stat stamp.
 */
async function rewriteBundleUninvalidated(
	directory: string,
	taskId: string,
	iso: string,
): Promise<string> {
	const result = await loadEvidence(directory, taskId);
	if (result.status !== 'found') {
		throw new Error(`Bundle not found for task ${taskId}`);
	}
	const bundle = result.bundle;
	bundle.updated_at = iso;
	bundle.created_at = iso;
	const evidencePath = path.join(
		directory,
		'.swarm',
		'evidence',
		taskId,
		'evidence.json',
	);
	await Bun.write(evidencePath, JSON.stringify(bundle));
	return evidencePath;
}

function createNoteEvidence(taskId: string, summary: string): Evidence {
	return {
		type: 'note',
		task_id: taskId,
		timestamp: isoOf(FROZEN_NOW_MS),
		agent: 'test-agent',
		verdict: 'info',
		summary,
	};
}

async function saveBundle(
	directory: string,
	taskId: string,
	summary: string,
): Promise<void> {
	await saveEvidence(directory, taskId, createNoteEvidence(taskId, summary));
}

describe('evidence retention boundary — updated_at, strict cutoff (#3218 frozen acceptance spec)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('archive-retention-3218-');
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
	});

	afterEach(() => {
		// No _internals seams are mutated by this spec (classification is driven
		// via options.now and freezeClock restores itself). The cross-test state
		// surface here is the swarm artifact cache: reset it before teardown so
		// cached entries for the removed tree cannot leak into the next file.
		resetSwarmArtifactCache();
		removeTreeWithRetry(tempDir);
	});

	test(
		'strict < cutoff selects only the old-side bundle; the boundary instant is not selected',
		async () => {
			const cutoffMs = productionCutoffMs();
			const instants: Array<[taskId: string, iso: string]> = [
				[TASK_FRESH, isoOf(FROZEN_NOW_MS)],
				[TASK_NEW_SIDE, isoOf(cutoffMs + ONE_SECOND_MS)],
				[TASK_OLD_SIDE, isoOf(cutoffMs - ONE_SECOND_MS)],
				[TASK_BOUNDARY, isoOf(cutoffMs)],
			];
			for (const [taskId] of instants) {
				await saveBundle(tempDir, taskId, `note for ${taskId}`);
			}
			// Invalidate after each pin so the classification-under-test reads the
			// pinned updated_at deterministically on every filesystem (the
			// same-size/stamp-collision hazard is exercised separately below).
			for (const [taskId, iso] of instants) {
				const bundlePath = await pinBundleTimestamp(tempDir, taskId, iso);
				invalidateCachedArtifact(bundlePath);
			}

			const selected = await classifyByAge(tempDir);
			expect(selected).toEqual([TASK_OLD_SIDE]);

			const report = await withFrozenClockAsync(
				async () => {
					return archiveEvidence(tempDir, MAX_AGE_DAYS, undefined, {
						report: true,
						dryRun: true,
						now: new Date(FROZEN_NOW_MS),
					});
				},
				{ fixedNow: FROZEN_NOW_MS },
			);
			expect(report.selectedEvidence).toEqual([TASK_OLD_SIDE]);
			expect(report.selectedEvidenceByCount).toEqual([]);
			for (const kept of [TASK_FRESH, TASK_NEW_SIDE, TASK_BOUNDARY]) {
				expect(report.selectedEvidence).not.toContain(kept);
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'classification membership is identical across 25 repeated dry-run classifications',
		async () => {
			const cutoffMs = productionCutoffMs();
			const instants: Array<[taskId: string, iso: string]> = [
				[TASK_FRESH, isoOf(FROZEN_NOW_MS)],
				[TASK_NEW_SIDE, isoOf(cutoffMs + ONE_SECOND_MS)],
				[TASK_OLD_SIDE, isoOf(cutoffMs - ONE_SECOND_MS)],
				[TASK_BOUNDARY, isoOf(cutoffMs)],
			];
			for (const [taskId] of instants) {
				await saveBundle(tempDir, taskId, `note for ${taskId}`);
			}
			for (const [taskId, iso] of instants) {
				const bundlePath = await pinBundleTimestamp(tempDir, taskId, iso);
				invalidateCachedArtifact(bundlePath);
			}

			const first = await classifyByAge(tempDir);
			expect(first).toEqual([TASK_OLD_SIDE]);
			for (
				let iteration = 2;
				iteration <= DETERMINISM_ITERATIONS;
				iteration++
			) {
				const membership = await classifyByAge(tempDir);
				expect(membership).toEqual(first);
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'artifact-cache invalidation flips a same-size updated_at rewrite into selection',
		async () => {
			const ancientMs = (() => {
				const ancient = new Date(FROZEN_NOW_MS);
				ancient.setDate(ancient.getDate() - 100);
				return ancient.getTime();
			})();

			await saveBundle(tempDir, TASK_FLIP, 'cache-flip leg');
			const bundlePath = await pinBundleTimestamp(
				tempDir,
				TASK_FLIP,
				isoOf(FROZEN_NOW_MS),
			);

			// Fresh at F: not selected.
			expect(await classifyByAge(tempDir)).not.toContain(TASK_FLIP);

			// Same-size rewrite to F−100d WITHOUT invalidation (the #3218 H2
			// hazard itself), then FORCE a colliding stat stamp via the
			// cache's own _internals seam: capture the REAL stamp the cache
			// stored on the first read (before the rewrite), and make every
			// later stat/statSync return exactly it — the definition of a
			// same-stamp collision (swarm-artifact-cache.ts:106 documents the
			// seam; utimesSync cannot portably pin ctime). Under the colliding
			// stamp the next classification MUST serve the cached pre-rewrite
			// value: NOT selected.
			const stampBefore = statSync(bundlePath);
			await rewriteBundleUninvalidated(tempDir, TASK_FLIP, isoOf(ancientMs));
			const cachedStamp = {
				mtimeMs: stampBefore.mtimeMs,
				ctimeMs: stampBefore.ctimeMs,
				size: stampBefore.size,
				isFile: () => true,
			} as unknown as import('node:fs').Stats;
			const realStat = artifactCacheInternals.stat;
			const realStatSync = artifactCacheInternals.statSync;
			artifactCacheInternals.stat = (() =>
				Promise.resolve(cachedStamp)) as typeof artifactCacheInternals.stat;
			artifactCacheInternals.statSync = (() => cachedStamp) as typeof statSync;
			try {
				expect(await classifyByAge(tempDir)).not.toContain(TASK_FLIP);
				// After explicit invalidation the colliding stamp is discarded
				// and the next classification must observe the rewritten
				// updated_at and select the bundle.
				invalidateCachedArtifact(bundlePath);
				expect(await classifyByAge(tempDir)).toEqual([TASK_FLIP]);
			} finally {
				artifactCacheInternals.stat = realStat;
				artifactCacheInternals.statSync = realStatSync;
			}
		},
		TEST_TIMEOUT_MS,
	);
});
