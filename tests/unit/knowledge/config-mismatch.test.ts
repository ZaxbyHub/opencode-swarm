/**
 * #1848 §2/§3: cohort config-mismatch detection tests.
 *
 * Verifies that the curation policy blocks destructive actions when the acting
 * worktree's config fingerprint diverges from the cohort's stored fingerprint,
 * and that it permits when they match (or when no cohort fingerprint is stored).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import type {
	CurationTargetEntry,
	KnowledgeConfig,
} from '../../../src/hooks/knowledge-types.js';
import { cohortConfigFingerprint } from '../../../src/knowledge/config-fingerprint.js';
import {
	_internals,
	authorizeCuration,
	type CurationAuthorizationInput,
	type CurationContext,
} from '../../../src/knowledge/curation-policy.js';

const baseConfig = (): KnowledgeConfig => KnowledgeConfigSchema.parse({});

const ownedEntry = (): CurationTargetEntry => ({
	id: 'entry-1',
	producer: { worktree_id: 'wt-A', cohort_id: 'c1' },
	revision: 1,
	content_hash: 'abc123',
	status: 'established',
});

const baseInput = (
	overrides: Partial<CurationAuthorizationInput> = {},
): CurationAuthorizationInput => ({
	directory: '/fake/dir',
	action: 'archive',
	entryId: 'entry-1',
	evidenceScope: 'local-session',
	actorWorktreeId: 'wt-A',
	...overrides,
});

describe('authorizeCuration — config-mismatch guard', () => {
	let storedCohortFp: string | null = null;
	let currentFpOverride: string | null = null;
	// IR-5 fix: snapshot/restore _internals to prevent cross-file leak.
	const _internalsSnapshot = { ..._internals };

	beforeEach(() => {
		storedCohortFp = null;
		currentFpOverride = null;
		_internals.isLinked = () => true;
		_internals.cohortConfigFingerprint = (input: unknown) =>
			currentFpOverride ?? cohortConfigFingerprint(input as never);
		_internals.readCohortConfigFingerprint = async () => storedCohortFp;
	});
	afterEach(() => {
		Object.assign(_internals, _internalsSnapshot);
	});

	it('blocks destructive action when fingerprints mismatch', async () => {
		const matchingFp = cohortConfigFingerprint({
			dedup_threshold: 0.6,
			schema_version: 3,
		});
		storedCohortFp = matchingFp;
		// Override the "current" fingerprint to something different.
		currentFpOverride = 'ffffffffffff';

		const result = await authorizeCuration(
			baseInput({ actorWorktreeId: 'wt-A' }),
			{ config: baseConfig(), entry: ownedEntry() },
		);
		expect(result.authorized).toBe(false);
		if (!result.authorized) {
			expect(result.basis).toBe('config-mismatch');
			expect(result.detail).toContain('fingerprint mismatch');
		}
	});

	it('permits when fingerprints match', async () => {
		const matchingFp = cohortConfigFingerprint({
			dedup_threshold: baseConfig().dedup_threshold,
		});
		storedCohortFp = matchingFp;
		currentFpOverride = matchingFp;

		const result = await authorizeCuration(
			baseInput({ actorWorktreeId: 'wt-A' }),
			{ config: baseConfig(), entry: ownedEntry() },
		);
		expect(result.authorized).toBe(true);
	});

	it('permits when no cohort fingerprint is stored yet (first member)', async () => {
		storedCohortFp = null;
		const result = await authorizeCuration(
			baseInput({ actorWorktreeId: 'wt-A' }),
			{ config: baseConfig(), entry: ownedEntry() },
		);
		expect(result.authorized).toBe(true);
	});
});

describe('buildConfigFingerprintInput', () => {
	it('produces a stable fingerprint from the resolved config', async () => {
		const { buildConfigFingerprintInput } = await import(
			'../../../src/knowledge/curation-policy.js'
		);
		const config = baseConfig();
		const fp1 = cohortConfigFingerprint(buildConfigFingerprintInput(config));
		const fp2 = cohortConfigFingerprint(buildConfigFingerprintInput(config));
		expect(fp1).toBe(fp2);
		expect(fp1).toMatch(/^[0-9a-f]{12}$/);
	});
});
