/**
 * Memoization contract tests for normalizeCandidateArtifactCached
 * (issue #2472 W8 / AC-9; mirrors frozen check C9's behavioral requirements).
 *
 * Pins:
 *  1. first call misses, identical second call HITS with an equal result;
 *  2. invalidateCandidateArtifactCache() empties the cache (size 0) and the
 *     next identical call re-misses with an identical result;
 *  3. the cache is bounded — 2000 DISTINCT artifacts leave size < 2000
 *     (FIFO eviction; frozen check pins the ceiling below 2000);
 *  4. a different fallbackFamily for the same text is a DISTINCT entry;
 *  5. the cached twin returns the same result as the uncached function.
 *
 * The module cache and its hit/miss counters are process-global; each test
 * invalidates in beforeEach and asserts on DELTAS, not absolute counter
 * values, so tests stay independent of execution order.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
	CANDIDATE_MARKER,
	candidateArtifactCacheStats,
	formatCandidateHeader,
	invalidateCandidateArtifactCache,
	normalizeCandidateArtifact,
	normalizeCandidateArtifactCached,
	type RowFormatFamily,
} from '../../../src/background/candidate-contract';

/** A minimal but genuinely normalizable artifact, built from the module's own
 * exported surface (same construction as frozen check C9). */
function sampleArtifact(suffix = ''): string {
	return `${formatCandidateHeader('base_explorer')}\n${CANDIDATE_MARKER} ${Array.from(
		{ length: 11 },
		(_, i) => `field${i}`,
	).join(' | ')}${suffix}`;
}

beforeEach(() => {
	invalidateCandidateArtifactCache();
});

describe('normalizeCandidateArtifactCached (issue #2472 W8 / AC-9)', () => {
	it('first call misses and the identical second call hits with an equal result', () => {
		const artifact = sampleArtifact();
		const before = candidateArtifactCacheStats();

		const first = normalizeCandidateArtifactCached(artifact, 'base_explorer');
		const afterFirst = candidateArtifactCacheStats();
		const second = normalizeCandidateArtifactCached(artifact, 'base_explorer');
		const afterSecond = candidateArtifactCacheStats();

		expect(afterFirst.misses).toBe(before.misses + 1);
		expect(afterFirst.size).toBe(1);
		expect(afterSecond.hits).toBe(afterFirst.hits + 1);
		expect(afterSecond.misses).toBe(afterFirst.misses);
		expect(second).toEqual(first);
	});

	it('invalidate empties the cache and the next identical call re-misses', () => {
		const artifact = sampleArtifact();
		const original = normalizeCandidateArtifactCached(
			artifact,
			'base_explorer',
		);
		expect(candidateArtifactCacheStats().size).toBe(1);

		invalidateCandidateArtifactCache();
		expect(candidateArtifactCacheStats().size).toBe(0);

		const before = candidateArtifactCacheStats();
		const reMissed = normalizeCandidateArtifactCached(
			artifact,
			'base_explorer',
		);
		const after = candidateArtifactCacheStats();
		expect(after.misses).toBe(before.misses + 1);
		expect(after.hits).toBe(before.hits);
		expect(reMissed).toEqual(original);
	});

	it('is bounded: 2000 distinct artifacts leave size < 2000 (FIFO eviction)', () => {
		const artifact = sampleArtifact();
		for (let i = 0; i < 2000; i++) {
			normalizeCandidateArtifactCached(`${artifact} #${i}`, 'base_explorer');
		}
		const stats = candidateArtifactCacheStats();
		expect(stats.size).toBeGreaterThan(0);
		expect(stats.size).toBeLessThan(2000);
		// FIFO means the FIRST inserts are the evicted ones: re-asking for the
		// oldest artifact after the flood must be a miss, not a hit.
		const before = candidateArtifactCacheStats();
		normalizeCandidateArtifactCached(`${artifact} #0`, 'base_explorer');
		const after = candidateArtifactCacheStats();
		expect(after.misses).toBe(before.misses + 1);
	});

	it('different fallbackFamily for the same text produces distinct entries', () => {
		const artifact = sampleArtifact();
		const before = candidateArtifactCacheStats();

		const asExplorer = normalizeCandidateArtifactCached(
			artifact,
			'base_explorer',
		);
		const afterExplorer = candidateArtifactCacheStats();
		const asMicroLane = normalizeCandidateArtifactCached(
			artifact,
			'micro_lane',
		);
		const afterMicro = candidateArtifactCacheStats();

		expect(afterExplorer.misses).toBe(before.misses + 1);
		expect(afterMicro.misses).toBe(afterExplorer.misses + 1);
		expect(candidateArtifactCacheStats().size).toBe(2);
		// Same input text with a header that already declares base_explorer
		// normalizes identically in both families (the header leads), so only
		// the cache-key discrimination is asserted here — which is the point.
		expect(asMicroLane).toEqual(asExplorer);
	});

	it('returns the same result as the uncached normalizeCandidateArtifact', () => {
		const inputs: Array<[string, RowFormatFamily]> = [
			[sampleArtifact(), 'base_explorer'],
			[sampleArtifact(' | extra | pipes'), 'micro_lane'],
			['', 'base_explorer'],
			['no marker rows at all', 'micro_lane'],
		];
		for (const [text, family] of inputs) {
			expect(normalizeCandidateArtifactCached(text, family)).toEqual(
				normalizeCandidateArtifact(text, family),
			);
		}
	});
});
