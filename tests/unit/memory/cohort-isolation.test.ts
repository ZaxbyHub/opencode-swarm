/**
 * #1850: cohort isolation (acceptance #3, #9) — different cohorts cannot
 * read/mutrate each other's memory. Covers test category #3 from the issue.
 */
import { describe, expect, test } from 'bun:test';
import { stableScopeKey } from '../../../src/memory/schema';
import { scopeAllowed } from '../../../src/memory/scoring';
import type { MemoryScopeRef } from '../../../src/memory/types';

describe('#1850 cohort isolation (acceptance #3, #9 — category #3)', () => {
	test('F-12: records from cohort A are invisible to cohort B via scope key', () => {
		const recordScopeA: MemoryScopeRef = {
			type: 'cohort',
			cohortId: 'cohort-alpha',
		};
		const allowedScopesB: MemoryScopeRef[] = [
			{ type: 'cohort', cohortId: 'cohort-beta' },
		];
		const allowed = scopeAllowed(recordScopeA, allowedScopesB);
		expect(allowed).toBe(false);
	});

	test('F-13: records from cohort A are visible to cohort A', () => {
		const recordScope: MemoryScopeRef = {
			type: 'cohort',
			cohortId: 'cohort-alpha',
		};
		const allowedScopes: MemoryScopeRef[] = [
			{ type: 'cohort', cohortId: 'cohort-alpha' },
		];
		const allowed = scopeAllowed(recordScope, allowedScopes);
		expect(allowed).toBe(true);
	});

	test('F-14: cohort scope does not match repository scope (no cross-tier leak)', () => {
		const cohortRecord: MemoryScopeRef = {
			type: 'cohort',
			cohortId: 'cohort-x',
		};
		const repoScopes: MemoryScopeRef[] = [
			{ type: 'repository', repoId: 'repo-x' },
		];
		expect(scopeAllowed(cohortRecord, repoScopes)).toBe(false);
	});

	test('F-15: run-scoped records remain worktree-local (session isolation)', () => {
		const runRecordA: MemoryScopeRef = { type: 'run', runId: 'run-A' };
		const allowedScopesB: MemoryScopeRef[] = [{ type: 'run', runId: 'run-B' }];
		expect(scopeAllowed(runRecordA, allowedScopesB)).toBe(false);
	});

	test('F-16: stableScopeKey distinguishes unrelated cohorts', () => {
		const cohorts = ['alpha', 'beta', 'gamma', 'delta'];
		const keys = cohorts.map((c) =>
			stableScopeKey({ type: 'cohort', cohortId: c }),
		);
		// All keys must be unique.
		expect(new Set(keys).size).toBe(cohorts.length);
	});
});
