/**
 * Synonym expansion end-to-end (Change 5 / Task 6.2).
 *
 * A learned tag-co-occurrence synonym lets a query term surface an entry that
 * only uses the *other* member of the pair, and the expansion is recorded on the
 * retrieved event for auditability. Includes a poisoning regression: a tampered
 * synonym-map.json cannot break retrieval or inject a garbage token.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeConfigSchema } from '../../src/config/schema';
import {
	type RetrievedEvent,
	readKnowledgeEvents,
} from '../../src/hooks/knowledge-events';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../src/hooks/knowledge-types';
import { searchKnowledge } from '../../src/hooks/search-knowledge';
import {
	readSynonymMap,
	rebuildSynonymMap,
	resolveSynonymMapPath,
} from '../../src/services/synonym-map';

const config = KnowledgeConfigSchema.parse({});

function makeEntry(
	overrides: Partial<SwarmKnowledgeEntry> & { id: string; lesson: string },
): SwarmKnowledgeEntry {
	return {
		tier: 'swarm',
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.6,
		status: 'established',
		confirmed_by: [],
		project_name: 'test',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2024-01-01T00:00:00.000Z',
		updated_at: '2024-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('synonym expansion end-to-end (Task 6.2)', () => {
	let dir: string;
	let kp: string;
	let prevXdg: string | undefined;
	beforeEach(() => {
		dir = join(tmpdir(), `swarm-syn-${Date.now()}-${Math.random()}`);
		mkdirSync(dir, { recursive: true });
		kp = resolveSwarmKnowledgePath(dir);
		prevXdg = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = join(dir, 'xdg');
	});
	afterEach(() => {
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		rmSync(dir, { recursive: true, force: true });
	});

	// "mocks" and "seams" co-occur in three entries → a count-3 synonym pair.
	const synonymCorpus = [
		{ tags: ['mocks', 'seams'] },
		{ tags: ['mocks', 'seams'] },
		{ tags: ['mocks', 'seams'] },
	];

	it('a query term surfaces an entry that only uses its learned synonym', async () => {
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'seam-lesson',
				lesson: 'prefer dependency seams when isolating collaborators in tests',
			}),
		);

		// Baseline: no synonym map → "mocks" does not text-match the seam lesson.
		const baseline = await searchKnowledge({
			directory: dir,
			config,
			query: 'mocks',
			mode: 'manual',
			tier: 'swarm',
			applyScopeFilter: false,
			applyRoleScope: false,
			emitEvent: false,
		});
		const baseScore = baseline.results.find(
			(r) => r.id === 'seam-lesson',
		)?.finalScore;

		// Learn the synonym and retry.
		await rebuildSynonymMap(dir, synonymCorpus);
		const expanded = await searchKnowledge({
			directory: dir,
			config,
			query: 'mocks',
			mode: 'manual',
			tier: 'swarm',
			applyScopeFilter: false,
			applyRoleScope: false,
			emitEvent: true,
		});
		const expScore = expanded.results.find(
			(r) => r.id === 'seam-lesson',
		)?.finalScore;

		expect(baseScore).toBeDefined();
		expect(expScore).toBeDefined();
		expect(expScore as number).toBeGreaterThan(baseScore as number);

		// Trace visibility: the retrieved event records the expansion.
		const retrieved = (await readKnowledgeEvents(dir)).filter(
			(e): e is RetrievedEvent => e.type === 'retrieved',
		);
		expect(retrieved).toHaveLength(1);
		const breakdown = retrieved[0].score_breakdown as
			| {
					synonyms_expanded?: string[];
					synonym_matches?: Record<string, string[]>;
			  }
			| undefined;
		expect(breakdown?.synonyms_expanded).toContain('seams');
		expect(breakdown?.synonym_matches?.['seam-lesson']).toContain('seams');
	});

	it('survives a poisoned synonym map without throwing or injecting garbage', async () => {
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'seam-lesson',
				lesson: 'prefer dependency seams when isolating collaborators in tests',
			}),
		);
		// Tamper: control chars in tokens, an over-long token, a malformed pair,
		// and a huge fan-out — none of which may break retrieval.
		const longToken = 'x'.repeat(5000);
		const poisoned = {
			version: 1,
			cursor: 9,
			pairs: {
				ctl: { a: 'mocks', b: 'se\x1bams', count: 9, seq: 1 },
				big: { a: 'mocks', b: longToken, count: 9, seq: 2 },
				ok: { a: 'mocks', b: 'seams', count: 9, seq: 3 },
				junk: { a: 42, b: null, count: 'nope', seq: {} },
			},
		};
		writeFileSync(
			resolveSynonymMapPath(dir),
			JSON.stringify(poisoned),
			'utf-8',
		);

		const { results } = await searchKnowledge({
			directory: dir,
			config,
			query: 'mocks',
			mode: 'manual',
			tier: 'swarm',
			applyScopeFilter: false,
			applyRoleScope: false,
			emitEvent: true,
		});
		// Retrieval still works and the sanitised "seams" edge still helps.
		expect(results.map((r) => r.id)).toContain('seam-lesson');

		const retrieved = (await readKnowledgeEvents(dir)).filter(
			(e): e is RetrievedEvent => e.type === 'retrieved',
		);
		const breakdown = retrieved[0].score_breakdown as
			| { synonyms_expanded?: string[] }
			| undefined;
		const expandedTokens = breakdown?.synonyms_expanded ?? [];
		// No control characters and no over-long token leaked into the expansion.
		for (const t of expandedTokens) {
			expect(/[\x00-\x1f\x7f]/.test(t)).toBe(false);
			expect(t.length).toBeLessThanOrEqual(64);
		}
	});

	it('ignores an oversized synonym map without parsing it (byte-ceiling DoS guard)', async () => {
		// A tampered file far larger than the maxPairs-derived ceiling must be
		// rejected by size BEFORE parse, so retrieval never pays an unbounded cost.
		const pairs: Record<string, unknown> = {};
		for (let i = 0; i < 20000; i++) {
			pairs[`k${i}`] = { a: `tok${i}`, b: `syn${i}`, count: 9, seq: i + 1 };
		}
		mkdirSync(join(dir, '.swarm'), { recursive: true });
		writeFileSync(
			resolveSynonymMapPath(dir),
			JSON.stringify({ version: 1, cursor: 20000, pairs }),
			'utf-8',
		);
		// Default maxPairs (500) → ~256KB ceiling; this file is multiple MB.
		const map = await readSynonymMap(dir);
		expect(Object.keys(map.pairs)).toHaveLength(0);
	});

	it('caps a huge-but-under-ceiling map on read via the maxPairs argument', async () => {
		// A file that fits the byte ceiling but still has many tiny pairs is
		// LRU-capped to maxPairs on read.
		const pairs: Record<string, unknown> = {};
		for (let i = 0; i < 400; i++) {
			pairs[`k${i}`] = { a: `t${i}`, b: `s${i}`, count: 9, seq: i + 1 };
		}
		mkdirSync(join(dir, '.swarm'), { recursive: true });
		writeFileSync(
			resolveSynonymMapPath(dir),
			JSON.stringify({ version: 1, cursor: 400, pairs }),
			'utf-8',
		);
		const map = await readSynonymMap(dir, 50);
		expect(Object.keys(map.pairs).length).toBeLessThanOrEqual(50);
	});
});
