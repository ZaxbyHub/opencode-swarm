/**
 * Wired-path regression for issue #1619 review round 4, finding F1.
 *
 * `loadPlan` (src/plan/manager.ts) writes `.swarm/spec-staleness.json` with a
 * plain `fsPromises.writeFile` — it does NOT route through `atomicWriteFile`.
 * `src/hooks/system-enhancer.ts:152` reads that same marker back through
 * `readCachedParsedFileSync`, in the SAME turn (`loadPlan` at :1002 →
 * `maybeAppendSpecDriftAdvisory` at :1009 → `readSpecStalenessSnapshot` at
 * :187; mirrored on Path B at :1854/:1861).
 *
 * The swarm-artifact cache decides freshness from the stat stamp alone
 * (mtimeMs + ctimeMs + size). On a later turn the marker is rewritten with an
 * unchanged `specHash_current`/`diff` and only the fixed-width ISO `timestamp`
 * differing — byte-identical in length. Inside one filesystem timestamp tick
 * `sameStamp()` therefore matches and the PREVIOUS turn's snapshot is served,
 * so the spec-drift advisory that gates `save_plan` / `update_task_status` /
 * `phase_complete` renders a stale reason and a stale diff.
 *
 * This test forces that exact stamp collision through the
 * `_internals.statSync` DI seam (utimesSync cannot portably set ctime — see
 * tests/unit/utils/swarm-artifact-cache.test.ts) and drives the REAL
 * production writer, so it fails if `invalidateCachedArtifact` is removed from
 * `loadPlan`'s marker write.
 *
 * Namespace note: the test reads through a test-local cache namespace rather
 * than importing system-enhancer's private `SPEC_STALENESS_CACHE_NAMESPACE`.
 * `invalidateCachedArtifact` prefix-deletes EVERY namespace registered for a
 * resolved path (src/utils/swarm-artifact-cache.ts:281-288), so the assertion
 * is namespace-independent by construction — and this keeps the test from
 * hand-copying a production constant it cannot import.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { loadPlan, resetStartupLedgerCheck } from '../../../src/plan/manager';
import {
	_internals as artifactCacheInternals,
	readCachedParsedFileSync,
	resetSwarmArtifactCache,
} from '../../../src/utils/swarm-artifact-cache';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Test-local namespace — see the namespace note in the file docblock. */
const TEST_NAMESPACE = 'spec-staleness-invalidation-wiring:v1';

/**
 * Same character length on purpose: this is the real-world shape of the bug —
 * a rewrite whose payload length is unchanged, so `size` in the stat stamp
 * cannot discriminate it even before the stamp is frozen.
 */
const REASON_TURN_1 = 'spec.md changed since plan was saved (AAAA)';
const REASON_TURN_2 = 'spec.md changed since plan was saved (BBBB)';

let tempDir: string;
let originalStatSync: typeof artifactCacheInternals.statSync;

function testPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Spec Staleness Cache Invalidation',
		swarm: 'test-swarm',
		current_phase: 1,
		specHash: 'original-spec-hash-12345',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	} as Plan;
}

function mockStaleWithReason(reason: string): void {
	mock.module('../../../src/utils/spec-hash', () => ({
		isSpecStale: mock(() =>
			Promise.resolve({
				stale: true,
				reason,
				currentHash: 'different-spec-hash-67890',
			}),
		),
		computeSpecHash: mock(() => Promise.resolve('different-spec-hash-67890')),
	}));
}

function readMarkerThroughCache(
	markerPath: string,
): { reason?: string } | null {
	return readCachedParsedFileSync<{ reason?: string }>(
		markerPath,
		TEST_NAMESPACE,
		() => readFileSync(markerPath, 'utf-8'),
		(raw) => JSON.parse(raw),
	);
}

beforeEach(async () => {
	resetSwarmArtifactCache();
	resetStartupLedgerCheck();
	// canonicalMkdtemp closes the macOS /var -> /private/var symlink gap and the
	// Windows 8.3 short-name mismatch (FR-011, issue #1737).
	tempDir = canonicalMkdtemp('spec-staleness-cache-');
	await mkdir(join(tempDir, '.swarm'), { recursive: true });
	await writeFile(
		join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify(testPlan(), null, 2),
	);
	originalStatSync = artifactCacheInternals.statSync;
});

afterEach(async () => {
	artifactCacheInternals.statSync = originalStatSync;
	mock.restore();
	resetSwarmArtifactCache();
	try {
		await rm(tempDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

describe('plan/manager.ts — spec-staleness.json write must invalidate the cache (#1619 F1)', () => {
	test('a second loadPlan under a frozen stat stamp is still read fresh by the cached reader', async () => {
		const markerPath = join(tempDir, '.swarm', 'spec-staleness.json');

		// Turn N: the real writer produces the marker.
		mockStaleWithReason(REASON_TURN_1);
		expect(await loadPlan(tempDir)).not.toBeNull();
		expect(readMarkerThroughCache(markerPath)?.reason).toBe(REASON_TURN_1);

		// Freeze the SYNC stat seam only. The cached readers are the sole
		// consumers of `_internals.statSync`, and `loadPlan`'s own plan.json read
		// goes through the ASYNC `_internals.stat`, so freezing this one simulates
		// the same-tick collision without disturbing the code under test.
		const frozen = statSync(markerPath);
		artifactCacheInternals.statSync = (() =>
			frozen) as typeof artifactCacheInternals.statSync;

		// Turn N+1: same length, different reason. Without the invalidation the
		// frozen stamp makes `sameStamp()` match and the turn-N snapshot is served.
		resetStartupLedgerCheck();
		mockStaleWithReason(REASON_TURN_2);
		expect(await loadPlan(tempDir)).not.toBeNull();

		// On-disk truth, so the assertion below cannot pass for the wrong reason.
		expect(JSON.parse(readFileSync(markerPath, 'utf-8')).reason).toBe(
			REASON_TURN_2,
		);
		expect(readMarkerThroughCache(markerPath)?.reason).toBe(REASON_TURN_2);
	});

	test('falsifiability: the frozen stamp really does serve a stale value when nothing invalidates', () => {
		const markerPath = join(tempDir, '.swarm', 'unrelated-marker.json');
		// A path no production writer invalidates, proving the harness above is
		// detecting invalidation rather than a stat stamp that changed anyway.
		writeFileSync(
			markerPath,
			JSON.stringify({ reason: REASON_TURN_1 }),
			'utf-8',
		);
		expect(readMarkerThroughCache(markerPath)?.reason).toBe(REASON_TURN_1);

		const frozen = statSync(markerPath);
		artifactCacheInternals.statSync = (() =>
			frozen) as typeof artifactCacheInternals.statSync;

		writeFileSync(
			markerPath,
			JSON.stringify({ reason: REASON_TURN_2 }),
			'utf-8',
		);
		// Same size, frozen stamp, no invalidation -> the cache serves turn N.
		expect(readMarkerThroughCache(markerPath)?.reason).toBe(REASON_TURN_1);
	});
});
