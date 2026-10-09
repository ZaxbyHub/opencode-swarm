import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RETENTION_REGISTRY } from '../../../scripts/retention-registry.data';

/**
 * Doc↔data coherence for the #2036 registry document. The CI check
 * (check-retention-registry.ts) enforces the same contract at gate time;
 * these tests pin it in the unit suite so a doc regression is caught without
 * waiting for CI.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const DOC_PATH = path.join(
	REPO_ROOT,
	'docs',
	'observability-retention-registry.md',
);

describe('retention registry document coherence', () => {
	test('document exists and is substantial', () => {
		expect(fs.existsSync(DOC_PATH)).toBe(true);
		const doc = fs.readFileSync(DOC_PATH, 'utf-8');
		expect(doc.length).toBeGreaterThan(5000);
	});

	test('every registry row id appears in the document', () => {
		const doc = fs.readFileSync(DOC_PATH, 'utf-8');
		for (const row of RETENTION_REGISTRY) {
			// Backtick-anchored like the gate: a longer id (repo-graph-fingerprint)
			// must not satisfy a shorter one (repo-graph) via substring masking.
			expect(doc.includes(`\`${row.id}\``)).toBe(true);
		}
	});

	test('each category heading states its row count and lists its own rows', () => {
		// The gate only checks that every id appears somewhere: the headings
		// had drifted (Category 2 said 17 rows over a 20-row table) and two
		// rows sat under the wrong category.
		const doc = fs.readFileSync(DOC_PATH, 'utf-8');
		const tables = new Map<number, { says: number; ids: string[] }>();
		let current: number | null = null;
		for (const line of doc.split('\n')) {
			const heading = line.match(/^### Category (\d+) .*\((\d+) rows\)/);
			if (heading) {
				current = Number(heading[1]);
				tables.set(current, { says: Number(heading[2]), ids: [] });
				continue;
			}
			if (line.startsWith('## ')) current = null;
			const row = line.match(/^\| `([^`]+)`/);
			if (current !== null && row) tables.get(current)?.ids.push(row[1]);
		}
		for (const [category, table] of tables) {
			const expected = RETENTION_REGISTRY.filter((r) => r.category === category)
				.map((r) => r.id)
				.sort();
			expect({ category, ids: [...table.ids].sort() }).toEqual({
				category,
				ids: expected,
			});
			expect({ category, says: table.says }).toEqual({
				category,
				says: expected.length,
			});
		}
		expect(tables.size).toBe(9);
	});

	test('document link-definition anchors map back to registry rows', () => {
		const doc = fs.readFileSync(DOC_PATH, 'utf-8');
		const ids = new Set(RETENTION_REGISTRY.map((r) => r.id));
		const anchors = doc.match(/\[([a-z0-9-]+)\]:/g) ?? [];
		for (const anchor of anchors) {
			const id = anchor.slice(1, -2);
			expect(ids.has(id)).toBe(true);
		}
	});

	test('document names the canonical data module and the CI gate', () => {
		const doc = fs.readFileSync(DOC_PATH, 'utf-8');
		expect(doc.includes('scripts/retention-registry.data.ts')).toBe(true);
		expect(doc.includes('check:retention')).toBe(true);
	});

	test('appendices A-C present (enumeration evidence, issue index, contract checklist)', () => {
		const doc = fs.readFileSync(DOC_PATH, 'utf-8');
		expect(doc.includes('Appendix A')).toBe(true);
		expect(doc.includes('Appendix B')).toBe(true);
		expect(doc.includes('Appendix C')).toBe(true);
	});

	test('P3: pr-feedback evidence grammar matches the writer filename contract', () => {
		const row = RETENTION_REGISTRY.find(
			(candidate) => candidate.id === 'pr-feedback-loop-state',
		);
		expect(row).toBeDefined();
		if (!row) return;

		// The writer emits one durable evidence file as `{seq}-{uuid}.json`.
		// Keep the registry from silently drifting to a sequence-only grammar.
		const representative =
			'.swarm/pr-feedback-evidence/17-550e8400-e29b-41d4-a716-446655440000.json';
		const uuid =
			'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
		expect(row.pathGrammar).toContain(
			'.swarm/pr-feedback-evidence/{seq}-{uuid}.json',
		);
		expect(row.writerModules).toContain('src/background/pr-feedback-loop.ts');
		expect(row.writerCitations.join('\n')).toContain('oversight evidence');
		expect(
			new RegExp(
				`^\\.swarm/pr-feedback-evidence/\\d+-${uuid}\\.json$`,
				'i',
			).test(representative),
		).toBe(true);
	});
});
