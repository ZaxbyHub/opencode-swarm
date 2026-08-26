/**
 * Issue #2038 final critic, C4 — behavioral coverage for `pending_evicted`.
 *
 * `pending_evicted` is the counter that makes the DELIBERATE DIVERGENCE from
 * approved plan §4 measurable: the plan said the queue budget evicts "the
 * oldest `uncertain` (never a `pending`)", and `enforceQueueBounds` evicts a
 * `pending` when that is the only way back under `queueMaxBytes`. The price of
 * that divergence is that the eviction is COUNTED — under its own key, never
 * folded into `dropped` (which age expiry owns) — so a reader of
 * `skill_usage_health` can tell budget pressure from age expiry.
 *
 * Before this file the counter's only appearance in `tests/` was a literal in
 * an observability payload-shape fixture, so a refactor collapsing
 * `pending_evicted` back into `dropped` would have been green. The
 * discriminating assertion in every case below is therefore on BOTH counters:
 * the one that must move and the one that must not.
 *
 * Kept out of `skill-usage-pending.test.ts` (499 lines, new in this change)
 * because that file has one line of FR-006 cap headroom.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import {
	_resetSkillUsagePendingState,
	createPendingDocument,
	enforceQueueBounds,
	queueByteSize,
	SKILL_USAGE_LIMITS,
	type SkillUsagePendingDocument,
	type SkillUsagePendingRecord,
} from '../../../src/hooks/skill-usage-pending.js';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');

function makeRecord(
	index: number,
	state: SkillUsagePendingRecord['state'],
	ageMs = 0,
): SkillUsagePendingRecord {
	return {
		id: `rec-${String(index).padStart(6, '0')}`,
		skillPath: '.opencode/skills/generated/some-skill/SKILL.md',
		verdict: index % 2 === 0 ? 'compliant' : 'violated',
		timestamp: new Date(NOW - ageMs).toISOString(),
		enqueuedAt: new Date(NOW - ageMs).toISOString(),
		state,
		attempts: 0,
	};
}

/** A document whose records exceed `queueMaxBytes` by a comfortable margin. */
function docOverByteBudget(
	state: SkillUsagePendingRecord['state'],
): SkillUsagePendingDocument {
	const doc = createPendingDocument();
	let index = 0;
	// Records are minted newest-last so the oldest-first eviction order is
	// well-defined; all are inside the age budget (spread over one hour).
	while (queueByteSize(doc) <= SKILL_USAGE_LIMITS.queueMaxBytes * 1.2) {
		doc.records.push(makeRecord(index, state, (3_600_000 - index) % 3_600_000));
		index += 1;
	}
	return doc;
}

describe('queue-budget eviction counters (issue #2038 C4)', () => {
	afterEach(() => {
		_resetSkillUsagePendingState();
	});

	test('pending records evicted by queueMaxBytes increment pending_evicted and pressure — and never dropped', () => {
		const doc = docOverByteBudget('pending');
		const before = doc.records.length;
		expect(before).toBeLessThanOrEqual(SKILL_USAGE_LIMITS.queueMaxRecords);
		expect(queueByteSize(doc)).toBeGreaterThan(
			SKILL_USAGE_LIMITS.queueMaxBytes,
		);

		enforceQueueBounds(doc, NOW);

		const evicted = before - doc.records.length;
		expect(evicted).toBeGreaterThan(0);
		expect(queueByteSize(doc)).toBeLessThanOrEqual(
			SKILL_USAGE_LIMITS.queueMaxBytes,
		);
		// The divergence is observable...
		expect(doc.counters.pending_evicted).toBe(evicted);
		expect(doc.counters.pressure).toBe(evicted);
		// ...and NOT blended into the age-expiry counter. This is the assertion
		// that fails if the two branches are ever collapsed.
		expect(doc.counters.dropped).toBe(0);
		expect(doc.counters.uncertain_expired).toBe(0);
		// Eviction is oldest-first: the newest record must survive.
		expect(doc.records[doc.records.length - 1]?.id).toBe(
			`rec-${String(before - 1).padStart(6, '0')}`,
		);
	});

	test('in_flight records evicted by the budget also count as pending_evicted, never as dropped', () => {
		const doc = docOverByteBudget('in_flight');
		const before = doc.records.length;

		enforceQueueBounds(doc, NOW);

		const evicted = before - doc.records.length;
		expect(evicted).toBeGreaterThan(0);
		expect(doc.counters.pending_evicted).toBe(evicted);
		expect(doc.counters.pressure).toBe(evicted);
		expect(doc.counters.dropped).toBe(0);
		expect(doc.counters.uncertain_expired).toBe(0);
	});

	test('uncertain records absorb the budget first: uncertain_expired moves, pending_evicted stays at zero', () => {
		// A queue that is exactly WITHIN budget on its actionable records alone,
		// pushed over only by the `uncertain` ones prepended below — so evicting
		// the `uncertain` class is by construction sufficient.
		const doc = createPendingDocument();
		let index = 0;
		while (queueByteSize(doc) <= SKILL_USAGE_LIMITS.queueMaxBytes) {
			doc.records.push(
				makeRecord(index, 'pending', (3_600_000 - index) % 3_600_000),
			);
			index += 1;
		}
		doc.records.pop(); // back under the byte budget
		const pendingCount = doc.records.length;
		expect(queueByteSize(doc)).toBeLessThanOrEqual(
			SKILL_USAGE_LIMITS.queueMaxBytes,
		);

		const uncertain: SkillUsagePendingRecord[] = [];
		for (let i = 0; i < 200; i++) {
			uncertain.push(makeRecord(900_000 + i, 'uncertain', 7_200_000));
		}
		doc.records = [...uncertain, ...doc.records];
		expect(doc.records.length).toBeLessThanOrEqual(
			SKILL_USAGE_LIMITS.queueMaxRecords,
		);
		expect(queueByteSize(doc)).toBeGreaterThan(
			SKILL_USAGE_LIMITS.queueMaxBytes,
		);

		enforceQueueBounds(doc, NOW);

		expect(doc.counters.uncertain_expired).toBeGreaterThan(0);
		expect(doc.counters.pending_evicted).toBe(0);
		expect(doc.counters.dropped).toBe(0);
		// Every actionable record survived; only `uncertain` ones were spent.
		expect(doc.records.filter((r) => r.state === 'pending').length).toBe(
			pendingCount,
		);
	});

	test('age expiry keeps its own counter: an over-age pending record increments dropped, not pending_evicted', () => {
		const doc = createPendingDocument();
		doc.records.push(
			makeRecord(1, 'pending', SKILL_USAGE_LIMITS.maxAgeMs + 60_000),
			makeRecord(2, 'pending', 1_000),
		);

		enforceQueueBounds(doc, NOW);

		expect(doc.records.map((r) => r.id)).toEqual(['rec-000002']);
		expect(doc.counters.dropped).toBe(1);
		expect(doc.counters.pending_evicted).toBe(0);
		expect(doc.counters.pressure).toBe(0);
	});
});
