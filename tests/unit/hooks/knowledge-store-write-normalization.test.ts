/**
 * Store write-boundary normalization tests (issue #1821 Lane 0b).
 *
 * The six positional-`.slice(0, 20)` call sites were fixed individually, but a
 * per-call-site fix cannot stop a SEVENTH caller from persisting duplicate or
 * over-cap arrays. The structural guardrail normalizes `tags` and the five
 * actionability arrays at the three store WRITE paths in `knowledge-store.ts`
 * — `appendKnowledge`, `rewriteKnowledge`, and the `transactKnowledge` commit
 * path — so the defect cannot reach disk through any of them.
 *
 * Scope, stated precisely: this is not a whole-repo guarantee. Writers that
 * deliberately bypass the guardrail (`applyConfidenceDeltas`, the validator's
 * quarantine/restore/unarchive paths, `hive-transaction.ts`,
 * `knowledge/family-migration.ts`) are documented on
 * `normalizeEntryArraysForWrite` in the source.
 *
 * These tests use real temp directories and real file I/O (no mocks) and assert
 * on the RAW persisted JSONL, which is the only thing the guardrail promises.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	appendKnowledge,
	readKnowledge,
	rewriteKnowledge,
	transactKnowledge,
} from '../../../src/hooks/knowledge-store';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let tmpDir: string;
let cleanupDir: () => void;
let knowledgePath: string;

beforeEach(() => {
	const created = createSafeTestDir('knowledge-write-normalize-');
	tmpDir = created.dir;
	cleanupDir = created.cleanup;
	knowledgePath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
});

afterEach(() => {
	cleanupDir();
});

/** Read the raw JSONL back, bypassing every in-memory read-path normalizer. */
function readPersisted(): Array<Record<string, unknown>> {
	return readFileSync(knowledgePath, 'utf-8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A minimal knowledge-shaped record; overrides supply the array fields. */
function entry(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		id: 'entry-1',
		tier: 'swarm',
		lesson: 'A lesson long enough to be realistic for the store',
		category: 'process',
		...overrides,
	};
}

describe('write boundary — appendKnowledge normalizes array fields', () => {
	it('dedupes tags case-insensitively, keeping the first casing', async () => {
		await appendKnowledge(
			knowledgePath,
			entry({ tags: ['Bun', 'bun', 'BUN', 'testing'] }),
		);
		expect(readPersisted()[0].tags).toEqual(['Bun', 'testing']);
	});

	it('caps tags at 20 after deduping', async () => {
		await appendKnowledge(
			knowledgePath,
			entry({ tags: Array.from({ length: 30 }, (_, i) => `t-${i}`) }),
		);
		expect(readPersisted()[0].tags).toHaveLength(20);
	});

	it('stops duplicates from evicting distinct values (the defect)', async () => {
		// A bare positional slice(0, 20) would persist 15 copies of 'dup' plus
		// only the first 5 distinct tags, silently losing keep-5..keep-9.
		await appendKnowledge(
			knowledgePath,
			entry({
				tags: [
					...Array.from({ length: 15 }, () => 'dup'),
					...Array.from({ length: 10 }, (_, i) => `keep-${i}`),
				],
			}),
		);
		const tags = readPersisted()[0].tags as string[];
		expect(tags).toHaveLength(11);
		expect(tags).toContain('keep-5');
		expect(tags).toContain('keep-9');
	});

	it('normalizes all five actionability arrays', async () => {
		await appendKnowledge(
			knowledgePath,
			entry({
				applies_to_agents: ['coder', 'Coder', 'reviewer'],
				applies_to_tools: ['bash', 'bash', 'edit'],
				required_actions: ['run tests', 'run tests'],
				forbidden_actions: Array.from({ length: 25 }, (_, i) => `never-${i}`),
				verification_checks: ['check a', 'CHECK A', 'check b'],
			}),
		);
		const persisted = readPersisted()[0];
		expect(persisted.applies_to_agents).toEqual(['coder', 'reviewer']);
		expect(persisted.applies_to_tools).toEqual(['bash', 'edit']);
		expect(persisted.required_actions).toEqual(['run tests']);
		expect(persisted.forbidden_actions).toHaveLength(20);
		expect(persisted.verification_checks).toEqual(['check a', 'check b']);
	});

	it('drops non-string items from a normalized array', async () => {
		await appendKnowledge(
			knowledgePath,
			entry({ tags: ['ok', 7, null, { a: 1 }, 'fine'] }),
		);
		expect(readPersisted()[0].tags).toEqual(['ok', 'fine']);
	});
});

describe('write boundary — transactKnowledge commit path normalizes too', () => {
	it('normalizes every entry written by the commit path', async () => {
		const wrote = await transactKnowledge<Record<string, unknown>>(
			knowledgePath,
			() => [
				entry({ id: 'a', tags: ['x', 'X', 'y'] }),
				entry({ id: 'b', required_actions: ['do it', 'DO IT', 'do that'] }),
			],
		);
		expect(wrote).toBe(true);

		const persisted = readPersisted();
		expect(persisted).toHaveLength(2);
		expect(persisted[0].tags).toEqual(['x', 'y']);
		expect(persisted[1].required_actions).toEqual(['do it', 'do that']);
	});

	it('normalizes an entry that an existing file already held un-deduped', async () => {
		// Simulate a record persisted before the guardrail existed, then let any
		// transaction touch the file: the rewrite normalizes it on the way out.
		// The seed append also creates the .swarm directory.
		await appendKnowledge(knowledgePath, entry({ id: 'seed', tags: ['a'] }));
		writeFileSync(
			knowledgePath,
			`${JSON.stringify({
				id: 'legacy',
				lesson: 'legacy lesson kept for back-compat coverage',
				retrieval_outcomes: {},
				tags: ['dupe', 'DUPE', 'dupe', 'other'],
			})}\n`,
			'utf-8',
		);

		const wrote = await transactKnowledge<Record<string, unknown>>(
			knowledgePath,
			(entries) => entries,
		);
		expect(wrote).toBe(true);
		expect(readPersisted()[0].tags).toEqual(['dupe', 'other']);
	});
});

describe('write boundary — rewriteKnowledge normalizes too', () => {
	it('normalizes every entry on a full rewrite', async () => {
		// rewriteKnowledge is the third store write path (knowledge-migrator,
		// knowledge-curator cap/sweep, system-enhancer). Leaving it unguarded
		// would let a migrated or enhanced entry re-persist duplicates.
		await rewriteKnowledge(knowledgePath, [
			entry({ id: 'a', tags: ['x', 'X', 'y'] }),
			entry({
				id: 'b',
				verification_checks: Array.from({ length: 25 }, (_, i) => `c-${i}`),
			}),
		]);

		const persisted = readPersisted();
		expect(persisted).toHaveLength(2);
		expect(persisted[0].tags).toEqual(['x', 'y']);
		expect(persisted[1].verification_checks).toHaveLength(20);
	});

	it('still writes an empty file for an empty entry list', async () => {
		await rewriteKnowledge(knowledgePath, []);
		expect(readFileSync(knowledgePath, 'utf-8')).toBe('');
	});
});

describe('write boundary — exclusions and non-interference', () => {
	it('does NOT cap or dedupe source_knowledge_ids', async () => {
		// source_knowledge_ids carries dedup markers for a separate workstream; a
		// cap of 20 would silently evict them.
		const ids = [
			...Array.from({ length: 25 }, (_, i) => `task:t-${i}`),
			'task:t-0',
			'task:t-0',
		];
		await appendKnowledge(knowledgePath, entry({ source_knowledge_ids: ids }));

		const persisted = readPersisted()[0].source_knowledge_ids as string[];
		expect(persisted).toHaveLength(27);
		expect(persisted).toEqual(ids);
		expect(persisted.filter((v) => v === 'task:t-0')).toHaveLength(3);
	});

	it('leaves triggers and source_refs untouched', async () => {
		const triggers = Array.from({ length: 25 }, () => 'same trigger');
		await appendKnowledge(
			knowledgePath,
			entry({ triggers, source_refs: ['ref', 'ref'] }),
		);
		const persisted = readPersisted()[0];
		expect(persisted.triggers).toHaveLength(25);
		expect(persisted.source_refs).toEqual(['ref', 'ref']);
	});

	it('does not add normalized keys to records that never had them', async () => {
		// appendKnowledge is generic and also persists non-knowledge payloads
		// (rejected lessons, retraction records, rewrite history). Adding
		// `tags: []` to those would corrupt their shape.
		const record = { id: 'test', message: 'test entry' };
		await appendKnowledge(knowledgePath, record);
		expect(readPersisted()[0]).toEqual(record);
	});

	it('leaves a non-array field alone instead of coercing it', async () => {
		await appendKnowledge(
			knowledgePath,
			entry({ id: 'null-tags', tags: null }),
		);
		expect(readPersisted()[0].tags).toBeNull();
	});

	it('does not mutate the caller in-memory entry', async () => {
		const input = entry({ tags: ['a', 'A', 'b'] });
		await appendKnowledge(knowledgePath, input);
		expect(input.tags).toEqual(['a', 'A', 'b']);
		expect(readPersisted()[0].tags).toEqual(['a', 'b']);
	});

	it('passes non-object payloads through untouched', async () => {
		// The guard `!entry || typeof entry !== 'object' || Array.isArray(entry)`
		// exists because appendKnowledge/transactKnowledge are generic; a bare
		// value must serialize exactly as it would without the guardrail.
		await appendKnowledge(knowledgePath, null);
		await appendKnowledge(knowledgePath, 42);
		await appendKnowledge(knowledgePath, 'plain string');
		await appendKnowledge(knowledgePath, ['a', 'A', 'a']);

		const lines = readFileSync(knowledgePath, 'utf-8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
		expect(lines).toEqual(['null', '42', '"plain string"', '["a","A","a"]']);
	});

	it('survives a throwing getter on a normalized field', async () => {
		// Prototype-pollution edge case: reading obj[field] can throw. The field
		// is skipped rather than taking down the whole write.
		const hostile: Record<string, unknown> = { id: 'hostile' };
		Object.defineProperty(hostile, 'tags', {
			get() {
				throw new Error('poisoned getter');
			},
			enumerable: false,
			configurable: true,
		});
		hostile.required_actions = ['do it', 'DO IT'];

		await appendKnowledge(knowledgePath, hostile);
		const persisted = readPersisted()[0];
		expect(persisted.id).toBe('hostile');
		expect(persisted.required_actions).toEqual(['do it']);
	});
});

describe('read path is NOT normalized', () => {
	it('readKnowledge preserves duplicate tags already on disk', async () => {
		// normalizeEntry is v1/v2 back-compat only. Deduping on read would rewrite
		// history for records written before the guardrail existed, so the read
		// path must surface exactly what is stored.
		const legacyPath = path.join(tmpDir, 'legacy.jsonl');
		writeFileSync(
			legacyPath,
			`${JSON.stringify({
				id: 'legacy-1',
				lesson: 'a legacy lesson stored before the write guardrail',
				retrieval_outcomes: {},
				tags: ['dup', 'dup', 'dup'],
				required_actions: Array.from({ length: 25 }, (_, i) => `a-${i}`),
			})}\n`,
			'utf-8',
		);

		const read = await readKnowledge<Record<string, unknown>>(legacyPath);
		expect(read).toHaveLength(1);
		expect(read[0].tags).toEqual(['dup', 'dup', 'dup']);
		expect(read[0].required_actions).toHaveLength(25);
	});
});
