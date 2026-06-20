/**
 * Invariant 8 (AGENTS.md §8) regression test: the module-level
 * `seenRetroSections` idempotency map must be bounded by an explicit size cap
 * with eviction, not only 24-hour time pruning. A burst of distinct sessions
 * inside the prune window must not grow the map without bound, and eviction
 * must drop the oldest-timestamp entries first (recency preserved).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { _internals } from '../../../src/hooks/knowledge-curator.js';

const {
	seenRetroSections,
	recordSeenRetroSection,
	hashContent,
	MAX_TRACKED_RETRO_SECTIONS,
} = _internals;

afterEach(() => {
	seenRetroSections.clear();
});

describe('seenRetroSections size cap (Invariant 8)', () => {
	it('never exceeds MAX_TRACKED_RETRO_SECTIONS regardless of distinct sessions', () => {
		// Insert well over the cap, all with fresh timestamps (no time pruning).
		const total = MAX_TRACKED_RETRO_SECTIONS * 3;
		for (let i = 0; i < total; i++) {
			recordSeenRetroSection(`session-${i}`, `hash-${i}`, Date.now() + i);
		}
		expect(seenRetroSections.size).toBeLessThanOrEqual(
			MAX_TRACKED_RETRO_SECTIONS,
		);
	});

	it('evicts the oldest-timestamp entries first, keeping the most recent', () => {
		seenRetroSections.clear();
		const cap = MAX_TRACKED_RETRO_SECTIONS;
		// Oldest batch: timestamps 0..cap-1.
		for (let i = 0; i < cap; i++) {
			recordSeenRetroSection(`old-${i}`, `v-${i}`, i + 1);
		}
		// One newer entry forces eviction of exactly one oldest entry.
		recordSeenRetroSection('new-1', 'v-new', 10_000_000);

		expect(seenRetroSections.size).toBe(cap);
		// The single oldest entry (timestamp 1) was evicted.
		expect(seenRetroSections.has('old-0')).toBe(false);
		// The newest entry survived.
		expect(seenRetroSections.has('new-1')).toBe(true);
		// A mid-age entry survived.
		expect(seenRetroSections.has(`old-${cap - 1}`)).toBe(true);
	});

	it('keeps distinct session keys isolated (no cross-session value bleed)', () => {
		seenRetroSections.clear();
		recordSeenRetroSection('session-A', 'hash-A', Date.now());
		recordSeenRetroSection('session-B', 'hash-B', Date.now());
		expect(seenRetroSections.get('session-A')?.value).toBe('hash-A');
		expect(seenRetroSections.get('session-B')?.value).toBe('hash-B');
	});

	it('hashes full retrospective content, not only length and prefix', () => {
		const prefix = 'x'.repeat(100);
		const first = `${prefix}${'a'.repeat(20)}`;
		const second = `${prefix}${'b'.repeat(20)}`;

		expect(first.length).toBe(second.length);
		expect(first.slice(0, 100)).toBe(second.slice(0, 100));
		expect(hashContent(first)).not.toBe(hashContent(second));
	});
});
