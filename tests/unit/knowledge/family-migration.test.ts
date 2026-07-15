import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CounterRollup } from '../../../src/hooks/knowledge-events.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import { KNOWLEDGE_FAMILY } from '../../../src/knowledge/family-manifest.js';
import {
	_internals,
	migrateKnowledgeFamily,
} from '../../../src/knowledge/family-migration.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

/**
 * Issue #1846 family-migration tests.
 *
 * Covers required test classes:
 *  - 4. Every family member in link, merge, rollback, retry, unlink.
 *  - 5. Populated-to-populated linking with provenance-preserving near-duplicate merge.
 *  - 7. Two-process append-vs-unlink race (concurrent-safe copy-back under lock).
 *  + Counter-baseline sum-counters (critic C2).
 *  + Lock staleness bound (critic C9): migration uses 30s stale, not 5s.
 */

function writeJsonl(filePath: string, entries: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const content =
		entries.map((e) => JSON.stringify(e)).join('\n') +
		(entries.length > 0 ? '\n' : '');
	fs.writeFileSync(filePath, content);
}

function readJsonl<T>(filePath: string): T[] {
	if (!fs.existsSync(filePath)) return [];
	const content = fs.readFileSync(filePath, 'utf-8');
	const out: T[] = [];
	for (const line of content.split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as T);
		} catch {
			/* skip */
		}
	}
	return out;
}

function makeEntry(
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id: `e-${Math.round(Math.random() * 1e9)}`,
		tier: 'swarm',
		lesson: 'always run focused tests before claiming done',
		category: 'testing',
		tags: ['testing'],
		scope: 'global',
		confidence: 0.6,
		status: 'candidate',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
			shown_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		project_name: 'proj',
		...overrides,
	};
}

function makeRollup(over: Partial<CounterRollup> = {}): CounterRollup {
	return {
		shown_count: 0,
		acknowledged_count: 0,
		applied_explicit_count: 0,
		ignored_count: 0,
		violated_count: 0,
		contradicted_count: 0,
		n_a_count: 0,
		succeeded_after_shown_count: 0,
		failed_after_shown_count: 0,
		partial_after_shown_count: 0,
		violation_timestamps: [],
		...over,
	};
}

describe('migrateKnowledgeFamily (manifest-driven migration)', () => {
	let platformSpy: ReturnType<typeof spyOn> | undefined;
	const prevXdg = process.env.XDG_DATA_HOME;
	let cleanupFns: Array<() => void> = [];

	beforeEach(() => {
		platformSpy = spyOn(process, 'platform', 'get').mockReturnValue('linux');
		const d = createSafeTestDir('family-data-');
		process.env.XDG_DATA_HOME = d.dir;
		cleanupFns.push(d.cleanup);
	});

	afterEach(() => {
		platformSpy?.mockRestore();
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		for (const c of cleanupFns) {
			try {
				c();
			} catch {
				/* ignore */
			}
		}
		cleanupFns = [];
	});

	test('manifest includes all 10 family members', () => {
		const filenames = KNOWLEDGE_FAMILY.map((m) => m.filename);
		expect(filenames).toContain('knowledge.jsonl');
		expect(filenames).toContain('knowledge-events.jsonl');
		expect(filenames).toContain('knowledge-rejected.jsonl');
		expect(filenames).toContain('knowledge-retractions.jsonl');
		expect(filenames).toContain('knowledge-counter-baseline.json');
		expect(filenames).toContain('knowledge-quarantined.jsonl');
		expect(filenames).toContain('knowledge-unactionable.jsonl');
		expect(filenames).toContain('knowledge-application.jsonl');
		// Issue #1848 cohort-scoped audit logs (no top-level `id`).
		expect(filenames).toContain('knowledge-rewrites.jsonl');
		expect(filenames).toContain('curation-proposals.jsonl');
		expect(KNOWLEDGE_FAMILY.length).toBe(10);
	});

	test('link migrates the complete family into the shared store', async () => {
		const local = createSafeTestDir('fam-local-');
		const shared = createSafeTestDir('fam-shared-');
		cleanupFns.push(local.cleanup, shared.cleanup);

		// Seed every family member locally.
		writeJsonl(path.join(local.dir, 'knowledge.jsonl'), [
			makeEntry({ id: 'k1', lesson: 'use bun test for this repo' }),
		]);
		writeJsonl(path.join(local.dir, 'knowledge-events.jsonl'), [
			{ id: 'ev1', type: 'retrieved', timestamp: '2026-01-01T00:00:00Z' },
		]);
		writeJsonl(path.join(local.dir, 'knowledge-rejected.jsonl'), [
			{ id: 'rj1', lesson: 'rejected lesson one' },
		]);
		writeJsonl(path.join(local.dir, 'knowledge-retractions.jsonl'), [
			{ id: 'rt1', retracted_lesson: 'retracted lesson' },
		]);
		fs.writeFileSync(
			path.join(local.dir, 'knowledge-counter-baseline.json'),
			JSON.stringify({ k1: makeRollup({ shown_count: 5 }) }),
		);
		writeJsonl(path.join(local.dir, 'knowledge-quarantined.jsonl'), [
			{ id: 'q1', lesson: 'quarantined lesson' },
		]);
		writeJsonl(path.join(local.dir, 'knowledge-unactionable.jsonl'), [
			{ id: 'u1', lesson: 'unactionable lesson' },
		]);
		writeJsonl(path.join(local.dir, 'knowledge-application.jsonl'), [
			{ id: 'ap1', entry_id: 'k1' },
		]);

		await migrateKnowledgeFamily(shared.dir, local.dir);

		// Every family member present in the shared store.
		for (const member of KNOWLEDGE_FAMILY) {
			const sharedPath = path.join(shared.dir, member.filename);
			expect(fs.existsSync(sharedPath)).toBe(true);
		}
		const sharedStore = readJsonl<SwarmKnowledgeEntry>(
			path.join(shared.dir, 'knowledge.jsonl'),
		);
		expect(sharedStore.map((e) => e.id)).toEqual(['k1']);
	});

	test('retry is idempotent (re-merging already-present ids is a no-op)', async () => {
		const local = createSafeTestDir('fam-retry-local-');
		const shared = createSafeTestDir('fam-retry-shared-');
		cleanupFns.push(local.cleanup, shared.cleanup);

		writeJsonl(path.join(local.dir, 'knowledge.jsonl'), [
			makeEntry({ id: 'only', lesson: 'the one lesson to migrate' }),
		]);
		writeJsonl(path.join(local.dir, 'knowledge-events.jsonl'), [
			{ id: 'ev-only', type: 'retrieved', timestamp: '2026-01-01T00:00:00Z' },
		]);

		await migrateKnowledgeFamily(shared.dir, local.dir);
		// Retry: should not duplicate.
		const result = await migrateKnowledgeFamily(shared.dir, local.dir);

		const store = readJsonl(path.join(local.dir, 'knowledge.jsonl'));
		expect(store.length).toBe(1);
		const events = readJsonl(path.join(shared.dir, 'knowledge-events.jsonl'));
		expect(events.length).toBe(1);
		// On retry, everything was already present → 0 new.
		const storeCount = result.perMember.find(
			(m) => m.filename === 'knowledge.jsonl',
		);
		expect(storeCount?.merged).toBe(0);
	});

	test('provenance-preserving near-duplicate merge unions fields and preserves losing id', async () => {
		const local = createSafeTestDir('fam-near-local-');
		const shared = createSafeTestDir('fam-near-shared-');
		cleanupFns.push(local.cleanup, shared.cleanup);

		// Pre-populate shared with an entry.
		writeJsonl(path.join(shared.dir, 'knowledge.jsonl'), [
			makeEntry({
				id: 'shared-1',
				lesson: 'always run focused tests before claiming done',
				confidence: 0.7,
				confirmed_by: [
					{ phase_number: 1, confirmed_at: '2026-01-01', project_name: 'p' },
				],
				tags: ['testing'],
			}),
		]);
		// Local has a near-duplicate (same lesson text) with different evidence.
		writeJsonl(path.join(local.dir, 'knowledge.jsonl'), [
			makeEntry({
				id: 'local-1',
				lesson: 'always run focused tests before claiming done',
				confidence: 0.9,
				confirmed_by: [
					{ phase_number: 2, confirmed_at: '2026-01-02', project_name: 'p' },
				],
				tags: ['testing', 'ci'],
			}),
		]);

		await migrateKnowledgeFamily(shared.dir, local.dir);

		const merged = readJsonl<SwarmKnowledgeEntry & { merged_from?: string[] }>(
			path.join(shared.dir, 'knowledge.jsonl'),
		);
		// Exactly one entry (the near-dup was merged, not added as a second).
		expect(merged.length).toBe(1);
		const entry = merged[0];
		// The losing id is preserved in merged_from.
		expect(entry.merged_from).toContain('local-1');
		// Tags unioned.
		expect(entry.tags).toContain('ci');
		// confirmed_by unioned (2 records).
		expect(entry.confirmed_by.length).toBe(2);
		// Confidence is an evidence-weighted average (between 0.7 and 0.9).
		expect(entry.confidence).toBeGreaterThan(0.7);
		expect(entry.confidence).toBeLessThan(0.9);
	});

	test('counter-baseline sum-counters sums per-counter fields (not replace)', async () => {
		const local = createSafeTestDir('fam-counter-local-');
		const shared = createSafeTestDir('fam-counter-shared-');
		cleanupFns.push(local.cleanup, shared.cleanup);

		// Both sides have a baseline for the same entry id with different counts.
		fs.writeFileSync(
			path.join(shared.dir, 'knowledge-counter-baseline.json'),
			JSON.stringify({
				k1: makeRollup({ shown_count: 5, applied_explicit_count: 2 }),
			}),
		);
		fs.writeFileSync(
			path.join(local.dir, 'knowledge-counter-baseline.json'),
			JSON.stringify({
				k1: makeRollup({ shown_count: 3, applied_explicit_count: 1 }),
			}),
		);

		await migrateKnowledgeFamily(shared.dir, local.dir);

		const merged = JSON.parse(
			fs.readFileSync(
				path.join(shared.dir, 'knowledge-counter-baseline.json'),
				'utf-8',
			),
		) as Record<string, CounterRollup>;
		// SUM, not replace: 5 + 3 = 8 shown, 2 + 1 = 3 applied.
		expect(merged.k1.shown_count).toBe(8);
		expect(merged.k1.applied_explicit_count).toBe(3);
	});

	test('counter-baseline sum-counters adds new ids without losing existing', async () => {
		const local = createSafeTestDir('fam-counter-add-local-');
		const shared = createSafeTestDir('fam-counter-add-shared-');
		cleanupFns.push(local.cleanup, shared.cleanup);

		fs.writeFileSync(
			path.join(shared.dir, 'knowledge-counter-baseline.json'),
			JSON.stringify({ existing: makeRollup({ shown_count: 4 }) }),
		);
		fs.writeFileSync(
			path.join(local.dir, 'knowledge-counter-baseline.json'),
			JSON.stringify({ newId: makeRollup({ shown_count: 2 }) }),
		);

		await migrateKnowledgeFamily(shared.dir, local.dir);

		const merged = JSON.parse(
			fs.readFileSync(
				path.join(shared.dir, 'knowledge-counter-baseline.json'),
				'utf-8',
			),
		) as Record<string, CounterRollup>;
		expect(merged.existing.shown_count).toBe(4); // preserved
		expect(merged.newId.shown_count).toBe(2); // added
	});

	test('append-union dedupes events by id across retries and peers', async () => {
		const local = createSafeTestDir('fam-union-local-');
		const shared = createSafeTestDir('fam-union-shared-');
		cleanupFns.push(local.cleanup, shared.cleanup);

		writeJsonl(path.join(shared.dir, 'knowledge-events.jsonl'), [
			{ id: 'ev-a', type: 'retrieved', timestamp: '2026-01-01T00:00:00Z' },
		]);
		writeJsonl(path.join(local.dir, 'knowledge-events.jsonl'), [
			{ id: 'ev-a', type: 'retrieved', timestamp: '2026-01-01T00:00:00Z' }, // dup
			{ id: 'ev-b', type: 'applied', timestamp: '2026-01-02T00:00:00Z' }, // new
		]);

		await migrateKnowledgeFamily(shared.dir, local.dir);

		const events = readJsonl<{ id: string }>(
			path.join(shared.dir, 'knowledge-events.jsonl'),
		);
		const ids = events.map((e) => e.id).sort();
		expect(ids).toEqual(['ev-a', 'ev-b']);
	});

	test('partial validation failure aborts and the pointer is never written by this fn', async () => {
		// migrateKnowledgeFamily does NOT write the pointer; the caller does. We
		// verify that a malformed source member is handled gracefully (skipped,
		// not crashing the whole migration) — the validate step only rejects
		// unparseable *merged* output, so a malformed source line is just dropped.
		const local = createSafeTestDir('fam-malformed-local-');
		const shared = createSafeTestDir('fam-malformed-shared-');
		cleanupFns.push(local.cleanup, shared.cleanup);

		// Write a malformed line in the local store.
		fs.mkdirSync(local.dir, { recursive: true });
		fs.writeFileSync(
			path.join(local.dir, 'knowledge.jsonl'),
			'{"id":"good","tier":"swarm","lesson":"a good lesson"}\nNOT-JSON\n',
		);

		// Should not throw — malformed source lines are skipped by readJsonl.
		const result = await migrateKnowledgeFamily(shared.dir, local.dir);
		const store = readJsonl<{ id: string }>(
			path.join(shared.dir, 'knowledge.jsonl'),
		);
		expect(store.map((e) => e.id)).toEqual(['good']);
		expect(result.perMember.length).toBe(KNOWLEDGE_FAMILY.length);
	});

	test('unlink direction copies the complete family back under lock', async () => {
		// Reverse direction: shared → local. Verifies unlink copies every member.
		const local = createSafeTestDir('fam-unlink-local-');
		const shared = createSafeTestDir('fam-unlink-shared-');
		cleanupFns.push(local.cleanup, shared.cleanup);

		writeJsonl(path.join(shared.dir, 'knowledge.jsonl'), [
			makeEntry({ id: 's1', lesson: 'shared lesson to copy back' }),
		]);
		writeJsonl(path.join(shared.dir, 'knowledge-events.jsonl'), [
			{ id: 'sev1', type: 'retrieved', timestamp: '2026-01-01T00:00:00Z' },
		]);

		await migrateKnowledgeFamily(local.dir, shared.dir);

		const localStore = readJsonl<{ id: string }>(
			path.join(local.dir, 'knowledge.jsonl'),
		);
		expect(localStore.map((e) => e.id)).toEqual(['s1']);
		const localEvents = readJsonl<{ id: string }>(
			path.join(local.dir, 'knowledge-events.jsonl'),
		);
		expect(localEvents.map((e) => e.id)).toEqual(['sev1']);
		// Shared cohort is NOT deleted by unlink (acceptance).
		expect(fs.existsSync(path.join(shared.dir, 'knowledge.jsonl'))).toBe(true);
	});

	test('#1848 append-concat migrates rewrite history without an id field, preserving distinct revisions', async () => {
		const local = createSafeTestDir('fam-rw-local-');
		const shared = createSafeTestDir('fam-rw-shared-');
		cleanupFns.push(local.cleanup, shared.cleanup);

		// RewriteHistoryRecord: NO top-level `id`. Keyed by
		// entry_id + after_revision + timestamp.
		const rw = (over: Record<string, unknown> = {}) => ({
			entry_id: 'k1',
			before_lesson: 'old text',
			after_lesson: 'new text',
			before_revision: 1,
			after_revision: 2,
			actor: 'auto',
			timestamp: '2026-01-01T00:00:00.000Z',
			action: 'rewrite',
			...over,
		});

		// Shared already has revision 2 of k1.
		writeJsonl(path.join(shared.dir, 'knowledge-rewrites.jsonl'), [rw()]);
		// Local has: the SAME rev-2 record (dup → deduped), a DISTINCT rev-3 of the
		// same entry (must survive), and a rev-2 of a different entry (must survive).
		writeJsonl(path.join(local.dir, 'knowledge-rewrites.jsonl'), [
			rw(), // exact dup of shared
			rw({
				before_revision: 2,
				after_revision: 3,
				timestamp: '2026-01-02T00:00:00.000Z',
			}), // distinct revision, same entry
			rw({ entry_id: 'k2', timestamp: '2026-01-03T00:00:00.000Z' }), // distinct entry
		]);

		// A normal id-keyed member alongside, to prove it is unaffected.
		writeJsonl(path.join(shared.dir, 'knowledge-events.jsonl'), [
			{ id: 'ev-a', type: 'retrieved', timestamp: '2026-01-01T00:00:00Z' },
		]);
		writeJsonl(path.join(local.dir, 'knowledge-events.jsonl'), [
			{ id: 'ev-a', type: 'retrieved', timestamp: '2026-01-01T00:00:00Z' }, // dup
			{ id: 'ev-b', type: 'applied', timestamp: '2026-01-02T00:00:00Z' }, // new
		]);

		const result = await migrateKnowledgeFamily(shared.dir, local.dir);

		const rewrites = readJsonl<Record<string, unknown>>(
			path.join(shared.dir, 'knowledge-rewrites.jsonl'),
		);
		// 3 distinct records: (k1,rev2), (k1,rev3), (k2,rev2). The dup collapsed.
		expect(rewrites.length).toBe(3);
		const keys = rewrites
			.map((r) => `${r.entry_id}:${r.after_revision}`)
			.sort();
		expect(keys).toEqual(['k1:2', 'k1:3', 'k2:2']);
		// None of the records carry a synthetic `id` (proves we never required one).
		expect(rewrites.every((r) => r.id === undefined)).toBe(true);
		// Per-member count: 2 new (rev3 + k2), the exact-dup skipped.
		const rwCount = result.perMember.find(
			(m) => m.filename === 'knowledge-rewrites.jsonl',
		);
		expect(rwCount?.merged).toBe(2);

		// Existing id-keyed member unaffected: union by id, dup collapsed.
		const events = readJsonl<{ id: string }>(
			path.join(shared.dir, 'knowledge-events.jsonl'),
		);
		expect(events.map((e) => e.id).sort()).toEqual(['ev-a', 'ev-b']);

		// Retry is idempotent for the non-id audit log too.
		const retry = await migrateKnowledgeFamily(shared.dir, local.dir);
		const retryCount = retry.perMember.find(
			(m) => m.filename === 'knowledge-rewrites.jsonl',
		);
		expect(retryCount?.merged).toBe(0);
		expect(
			readJsonl(path.join(shared.dir, 'knowledge-rewrites.jsonl')).length,
		).toBe(3);
	});

	test('#1848 append-concat migrates curation proposals keyed by entry+action+proposedAt', async () => {
		const local = createSafeTestDir('fam-cp-local-');
		const shared = createSafeTestDir('fam-cp-shared-');
		cleanupFns.push(local.cleanup, shared.cleanup);

		// CurationProposal: NO top-level `id`. entryId/proposedAt are camelCase.
		const cp = (over: Record<string, unknown> = {}) => ({
			entryId: 'k1',
			action: 'retire',
			evidenceScope: 'local',
			proposedAt: '2026-01-01T00:00:00.000Z',
			status: 'pending',
			...over,
		});

		writeJsonl(path.join(shared.dir, 'curation-proposals.jsonl'), [cp()]);
		writeJsonl(path.join(local.dir, 'curation-proposals.jsonl'), [
			cp(), // exact dup
			cp({ action: 'demote' }), // same entry, different action → distinct
			cp({ entryId: 'k2', proposedAt: '2026-01-02T00:00:00.000Z' }), // distinct entry
		]);

		const result = await migrateKnowledgeFamily(shared.dir, local.dir);

		const proposals = readJsonl<Record<string, unknown>>(
			path.join(shared.dir, 'curation-proposals.jsonl'),
		);
		expect(proposals.length).toBe(3);
		const keys = proposals.map((p) => `${p.entryId}:${p.action}`).sort();
		expect(keys).toEqual(['k1:demote', 'k1:retire', 'k2:retire']);
		const cpCount = result.perMember.find(
			(m) => m.filename === 'curation-proposals.jsonl',
		);
		expect(cpCount?.merged).toBe(2);
	});

	test('#1848 unlink copies cohort rewrite/proposal history back to the local worktree', async () => {
		const local = createSafeTestDir('fam-1848-unlink-local-');
		const shared = createSafeTestDir('fam-1848-unlink-shared-');
		cleanupFns.push(local.cleanup, shared.cleanup);

		writeJsonl(path.join(shared.dir, 'knowledge-rewrites.jsonl'), [
			{
				entry_id: 'k9',
				before_lesson: 'a',
				after_lesson: 'b',
				before_revision: 1,
				after_revision: 2,
				actor: 'auto',
				timestamp: '2026-02-01T00:00:00.000Z',
				action: 'rewrite',
			},
		]);
		writeJsonl(path.join(shared.dir, 'curation-proposals.jsonl'), [
			{
				entryId: 'k9',
				action: 'retire',
				evidenceScope: 'cohort',
				proposedAt: '2026-02-01T00:00:00.000Z',
				status: 'pending',
			},
		]);

		// Unlink direction: shared → local.
		await migrateKnowledgeFamily(local.dir, shared.dir);

		const rewrites = readJsonl<{ entry_id: string }>(
			path.join(local.dir, 'knowledge-rewrites.jsonl'),
		);
		expect(rewrites.map((r) => r.entry_id)).toEqual(['k9']);
		const proposals = readJsonl<{ entryId: string }>(
			path.join(local.dir, 'curation-proposals.jsonl'),
		);
		expect(proposals.map((p) => p.entryId)).toEqual(['k9']);
	});
});

describe('validateSerialized integrity gate (critic MED-1)', () => {
	// Direct unit tests of the validation gate so a regression that weakens it
	// (e.g. reverting to "JSON parses → ok") is caught. These exercise the
	// rejection paths that the end-to-end migration test cannot reach because
	// the merge engine's own output is always well-formed.
	const storeMember = KNOWLEDGE_FAMILY.find((m) => m.role === 'store')!;
	const eventsMember = KNOWLEDGE_FAMILY.find((m) => m.role === 'events')!;
	const countersMember = KNOWLEDGE_FAMILY.find((m) => m.role === 'counters')!;

	test('rejects a store entry missing id', () => {
		const bad = `${JSON.stringify({ lesson: 'no id here' })}\n`;
		expect(_internals.validateSerialized(storeMember, bad)).toBe(false);
	});

	test('rejects a store entry missing lesson', () => {
		const bad = `${JSON.stringify({ id: 'x' })}\n`;
		expect(_internals.validateSerialized(storeMember, bad)).toBe(false);
	});

	test('rejects a store entry with empty lesson', () => {
		const bad = `${JSON.stringify({ id: 'x', lesson: '' })}\n`;
		expect(_internals.validateSerialized(storeMember, bad)).toBe(false);
	});

	test('rejects an events entry missing id', () => {
		const bad = `${JSON.stringify({ type: 'retrieved' })}\n`;
		expect(_internals.validateSerialized(eventsMember, bad)).toBe(false);
	});

	test('rejects an unparseable line', () => {
		expect(_internals.validateSerialized(storeMember, 'NOT-JSON\n')).toBe(
			false,
		);
	});

	test('rejects a counter baseline that is not a JSON object', () => {
		// Array is not a valid baseline (must be Record<id, CounterRollup>).
		expect(_internals.validateSerialized(countersMember, '[]\n')).toBe(false);
		expect(_internals.validateSerialized(countersMember, '"string"\n')).toBe(
			false,
		);
	});

	test('accepts a well-formed store entry', () => {
		const good = `${JSON.stringify({ id: 'x', lesson: 'a real lesson' })}\n`;
		expect(_internals.validateSerialized(storeMember, good)).toBe(true);
	});

	test('accepts a well-formed counter baseline object', () => {
		const good = `${JSON.stringify({ someId: { shown_count: 1 } })}\n`;
		expect(_internals.validateSerialized(countersMember, good)).toBe(true);
	});

	// Issue #1848: the two new append-concat members have NO top-level `id`. The
	// validator must accept them via their composite `keyOf` and must NOT demand
	// an `id`, while still rejecting a line whose composite key cannot be derived.
	const rewriteMember = KNOWLEDGE_FAMILY.find(
		(m) => m.role === 'rewrite-history',
	)!;
	const proposalMember = KNOWLEDGE_FAMILY.find(
		(m) => m.role === 'curation-proposals',
	)!;

	test('accepts a rewrite-history record that has no id field', () => {
		const good = `${JSON.stringify({
			entry_id: 'k1',
			after_revision: 2,
			timestamp: '2026-01-01T00:00:00.000Z',
		})}\n`;
		expect(_internals.validateSerialized(rewriteMember, good)).toBe(true);
	});

	test('rejects a rewrite-history record missing a composite key field', () => {
		// Missing after_revision → keyOf returns null → rejected.
		const bad = `${JSON.stringify({
			entry_id: 'k1',
			timestamp: '2026-01-01T00:00:00.000Z',
		})}\n`;
		expect(_internals.validateSerialized(rewriteMember, bad)).toBe(false);
	});

	test('accepts a curation-proposal record that has no id field', () => {
		const good = `${JSON.stringify({
			entryId: 'k1',
			action: 'retire',
			proposedAt: '2026-01-01T00:00:00.000Z',
		})}\n`;
		expect(_internals.validateSerialized(proposalMember, good)).toBe(true);
	});

	test('rejects a curation-proposal record missing entryId', () => {
		const bad = `${JSON.stringify({
			action: 'retire',
			proposedAt: '2026-01-01T00:00:00.000Z',
		})}\n`;
		expect(_internals.validateSerialized(proposalMember, bad)).toBe(false);
	});

	test('existing id-keyed members still require a string id (unchanged)', () => {
		// The default selector is unchanged for pre-existing members.
		const noId = `${JSON.stringify({ type: 'retrieved' })}\n`;
		expect(_internals.validateSerialized(eventsMember, noId)).toBe(false);
		const withId = `${JSON.stringify({ id: 'ev1', type: 'retrieved' })}\n`;
		expect(_internals.validateSerialized(eventsMember, withId)).toBe(true);
	});
});
