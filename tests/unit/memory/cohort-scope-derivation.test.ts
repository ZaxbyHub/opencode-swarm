/**
 * #1850 (critic GAP-1, GAP-2): cohort scope derivation + stableScopeKey.
 *
 * Falsification target: without the `cohort` branch in `stableScopeKey`
 * (schema.ts:219) and `cohortId` on `MemoryScopeRefSchema` (schema.ts:26),
 * cohort-scoped records either fail validation or collapse across all cohorts.
 */
import { describe, expect, test } from 'bun:test';
import {
	MemoryScopeRefSchema,
	stableScopeKey,
} from '../../../src/memory/schema';

describe('#1850 cohort scope — regression: stableScopeKey + schema (GAP-1, GAP-2)', () => {
	test('F-1: cohort scope keys on cohortId (GAP-1)', () => {
		// If stableScopeKey had no cohort branch, these would collide.
		const a = stableScopeKey({ type: 'cohort', cohortId: 'cohort-aaa' });
		const b = stableScopeKey({ type: 'cohort', cohortId: 'cohort-bbb' });
		expect(a).not.toBe(b);
		expect(a).toContain('cohort-aaa');
		expect(b).toContain('cohort-bbb');
	});

	test('F-2: same cohortId produces same key (idempotent scope matching)', () => {
		const a = stableScopeKey({ type: 'cohort', cohortId: 'cohort-x' });
		const b = stableScopeKey({ type: 'cohort', cohortId: 'cohort-x' });
		expect(a).toBe(b);
	});

	test('F-3: cohort scope parses with cohortId (GAP-2)', () => {
		const parsed = MemoryScopeRefSchema.parse({
			type: 'cohort',
			cohortId: 'cohort-aaa',
		});
		expect(parsed.type).toBe('cohort');
		expect(parsed.cohortId).toBe('cohort-aaa');
	});

	test('F-4: cohort scope type is in the enum', () => {
		const types = MemoryScopeRefSchema.shape.type.options;
		expect(types).toContain('cohort');
	});

	test('F-5: repository scope still keys on repoId only (unchanged)', () => {
		const a = stableScopeKey({ type: 'repository', repoId: 'repo-a' });
		const b = stableScopeKey({ type: 'repository', repoId: 'repo-b' });
		expect(a).not.toBe(b);
	});

	test('F-6: cohort scope with missing cohortId still keys (graceful)', () => {
		// A cohort scope without cohortId is malformed but should not throw —
		// it produces a key that won't match any well-formed cohort scope.
		const key = stableScopeKey({ type: 'cohort' });
		expect(key).toContain('"type":"cohort"');
	});
});
