import { describe, expect, test } from 'bun:test';
import {
	cohortConfigFingerprint,
	type CohortConfigFingerprintInput,
} from '../../../src/knowledge/config-fingerprint.js';

/**
 * Issue #1846 cohort config fingerprint tests.
 *
 * Two linked worktrees with cohort-relevant config differences produce
 * different fingerprints; equivalent configs (even with reordered keys)
 * produce identical fingerprints.
 */

describe('cohortConfigFingerprint', () => {
	test('produces a 12-hex id', () => {
		const fp = cohortConfigFingerprint({ dedup_threshold: 0.6 });
		expect(fp).toMatch(/^[0-9a-f]{12}$/);
	});

	test('equivalent configs converge regardless of key insertion order', () => {
		const a: CohortConfigFingerprintInput = {
			dedup_threshold: 0.6,
			default_max_phases: 10,
			scope_filter: ['global'],
		};
		// Same fields, different declaration order.
		const b: CohortConfigFingerprintInput = {
			default_max_phases: 10,
			dedup_threshold: 0.6,
			scope_filter: ['global'],
		};
		expect(cohortConfigFingerprint(a)).toBe(cohortConfigFingerprint(b));
	});

	test('a cohort-relevant difference produces a different fingerprint', () => {
		const a = cohortConfigFingerprint({ dedup_threshold: 0.6 });
		const b = cohortConfigFingerprint({ dedup_threshold: 0.7 });
		expect(a).not.toBe(b);
	});

	test('nested retrieval object is part of the fingerprint', () => {
		const a = cohortConfigFingerprint({
			retrieval: { mmr_lambda: 0.5, synonym_min_cooccurrence: 3 },
		});
		const b = cohortConfigFingerprint({
			retrieval: { mmr_lambda: 0.5, synonym_min_cooccurrence: 4 },
		});
		expect(a).not.toBe(b);
	});

	test('scope_filter order matters (different cohorts would rank differently)', () => {
		const a = cohortConfigFingerprint({ scope_filter: ['global', 'stack:x'] });
		const b = cohortConfigFingerprint({ scope_filter: ['stack:x', 'global'] });
		// Array order is preserved in JSON; the fingerprint is sensitive to it.
		expect(a).not.toBe(b);
	});

	test('empty config is stable', () => {
		expect(cohortConfigFingerprint({})).toBe(cohortConfigFingerprint({}));
	});
});
