/**
 * #1848 §2: cohort-safe curation authorization policy tests.
 *
 * Covers the decision ladder: config-mismatch guard, owner path, unknown-owner
 * legacy protection, not-owner+local-evidence → proposal, cohort quorum, and
 * override. Uses `_internals` DI to inject worktree ids, cohort events, and
 * config fingerprints without touching the real filesystem or git.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import type {
	CurationTargetEntry,
	KnowledgeConfig,
} from '../../../src/hooks/knowledge-types.js';
import {
	_internals,
	authorizeCuration,
	type CurationAuthorizationInput,
	type CurationContext,
} from '../../../src/knowledge/curation-policy.js';

// IR-5 fix: snapshot _internals before each test and restore after, so module-
// global mutations don't leak across test files in bun's shared process.
const _internalsSnapshot = { ..._internals };
beforeEach(() => {
	Object.assign(_internals, _internalsSnapshot);
});
afterEach(() => {
	Object.assign(_internals, _internalsSnapshot);
});

const baseConfig = (): KnowledgeConfig => KnowledgeConfigSchema.parse({});

const ownedEntry = (
	worktreeId: string,
	cohortId = 'cohort-abc',
	overrides: Partial<CurationTargetEntry> = {},
): CurationTargetEntry => ({
	id: 'entry-1',
	producer: { worktree_id: worktreeId, cohort_id: cohortId },
	revision: 1,
	content_hash: 'abc123',
	status: 'established',
	...overrides,
});

const baseInput = (
	entryId: string,
	overrides: Partial<CurationAuthorizationInput> = {},
): CurationAuthorizationInput => ({
	directory: '/fake/dir',
	action: 'archive',
	entryId,
	evidenceScope: 'local-session',
	actorWorktreeId: 'wt-A',
	...overrides,
});

const baseContext = (
	entry: CurationTargetEntry | null,
	overrides: Partial<CurationContext> = {},
): CurationContext => ({
	config: baseConfig(),
	entry,
	...overrides,
});

describe('authorizeCuration — owner path', () => {
	beforeEach(() => {
		// Owner path is exercised when linked (unlinked short-circuits to
		// config-skipped-unlinked). No stored fingerprint → config guard passes.
		_internals.isLinked = () => true;
		_internals.readCohortConfigFingerprint = async () => null;
	});
	it('authorizes owner acting on own entry with local-session evidence', async () => {
		const entry = ownedEntry('wt-A');
		const result = await authorizeCuration(
			baseInput('entry-1', {
				actorWorktreeId: 'wt-A',
				evidenceScope: 'local-session',
			}),
			baseContext(entry),
		);
		expect(result.authorized).toBe(true);
		if (result.authorized) expect(result.basis).toBe('owner');
	});

	it('authorizes owner with producer evidence scope', async () => {
		const entry = ownedEntry('wt-A');
		const result = await authorizeCuration(
			baseInput('entry-1', {
				actorWorktreeId: 'wt-A',
				evidenceScope: 'producer',
			}),
			baseContext(entry),
		);
		expect(result.authorized).toBe(true);
	});
});

describe('authorizeCuration — unknown-owner legacy protection', () => {
	beforeEach(() => {
		// Unknown-owner protection only applies when cohort-linked.
		_internals.isLinked = () => true;
		_internals.readCohortConfigFingerprint = async () => null;
	});
	it('blocks destructive action on legacy entry (no producer)', async () => {
		const entry: CurationTargetEntry = {
			id: 'legacy-1',
			producer: null,
			revision: 0,
			status: 'established',
		};
		const result = await authorizeCuration(
			baseInput('legacy-1', { actorWorktreeId: 'wt-A' }),
			baseContext(entry),
		);
		expect(result.authorized).toBe(false);
		if (!result.authorized) {
			expect(result.basis).toBe('protected-unknown-owner');
			expect(result.proposal.status).toBe('pending');
		}
	});
});

describe('authorizeCuration — not-owner local evidence', () => {
	beforeEach(() => {
		// Not-owner protection only applies when cohort-linked.
		_internals.isLinked = () => true;
		_internals.readCohortConfigFingerprint = async () => null;
	});
	it('blocks worktree B from mutating worktree A entry via local-only evidence', async () => {
		const entry = ownedEntry('wt-A');
		const result = await authorizeCuration(
			baseInput('entry-1', {
				actorWorktreeId: 'wt-B',
				evidenceScope: 'local-session',
			}),
			baseContext(entry),
		);
		expect(result.authorized).toBe(false);
		if (!result.authorized) {
			expect(result.basis).toBe('not-owner-local-evidence');
		}
	});
});

describe('authorizeCuration — cohort quorum', () => {
	let eventReader: () => Promise<unknown[]>;
	beforeEach(() => {
		// Cohort quorum requires a linked cohort.
		_internals.isLinked = () => true;
		_internals.readCohortConfigFingerprint = async () => null;
		_internals.readKnowledgeEvents = () => eventReader();
	});

	it('authorizes when cohort-wide evidence meets quorum', async () => {
		eventReader = async () =>
			Array.from({ length: 5 }, (_, i) => ({
				type: 'violated',
				knowledge_id: 'entry-1',
				event_id: `ev-${i}`,
			}));
		const entry = ownedEntry('wt-A');
		const result = await authorizeCuration(
			baseInput('entry-1', {
				actorWorktreeId: 'wt-B',
				evidenceScope: 'cohort-wide',
			}),
			baseContext(entry),
		);
		expect(result.authorized).toBe(true);
		if (result.authorized) expect(result.basis).toBe('quorum');
	});

	it('blocks when cohort-wide evidence is insufficient', async () => {
		eventReader = async () => [{ type: 'violated', knowledge_id: 'entry-1' }];
		const entry = ownedEntry('wt-A');
		const result = await authorizeCuration(
			baseInput('entry-1', {
				actorWorktreeId: 'wt-B',
				evidenceScope: 'cohort-wide',
			}),
			baseContext(entry),
		);
		expect(result.authorized).toBe(false);
		if (!result.authorized) expect(result.basis).toBe('quorum-insufficient');
	});

	it('IR-1: does NOT count positive evidence (applied/shown) toward destructive quorum', async () => {
		// 5 applied events — these are POSITIVE signals; they must NOT authorize
		// a destructive action against the entry.
		eventReader = async () =>
			Array.from({ length: 5 }, (_, i) => ({
				type: 'applied',
				knowledge_id: 'entry-1',
				event_id: `ev-${i}`,
			}));
		const entry = ownedEntry('wt-A');
		const result = await authorizeCuration(
			baseInput('entry-1', {
				actorWorktreeId: 'wt-B',
				evidenceScope: 'cohort-wide',
			}),
			baseContext(entry),
		);
		expect(result.authorized).toBe(false);
		if (!result.authorized) expect(result.basis).toBe('quorum-insufficient');
	});
});

describe('authorizeCuration — override', () => {
	beforeEach(() => {
		_internals.isLinked = () => false;
	});
	it('authorizes with an explicit audited override even on unknown-owner', async () => {
		const entry: CurationTargetEntry = {
			id: 'legacy-1',
			producer: null,
			revision: 0,
			status: 'established',
		};
		const result = await authorizeCuration(
			baseInput('legacy-1', {
				override: { actor: 'manual-override', reason: 'operator purge' },
			}),
			baseContext(entry),
		);
		expect(result.authorized).toBe(true);
		if (result.authorized) expect(result.basis).toBe('override');
	});
});

describe('authorizeCuration — entry not found', () => {
	it('blocks when entry is null', async () => {
		_internals.isLinked = () => false;
		const result = await authorizeCuration(
			baseInput('missing-1'),
			baseContext(null),
		);
		expect(result.authorized).toBe(false);
		if (!result.authorized) expect(result.basis).toBe('entry-not-found');
	});
});
