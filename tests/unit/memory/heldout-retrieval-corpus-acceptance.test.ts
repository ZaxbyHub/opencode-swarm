/** Acceptance coverage for issue #2490 / AC8.
 *
 * This is intentionally a NEW-SURFACE check: the baseline has no governed
 * held-out retrieval corpus.  The missing fixture is therefore an expected
 * Phase 2.5 ERROR, not a vacuous passing assertion.
 */

import { describe, expect, test } from 'bun:test';

function nonEmptyString(value: unknown): boolean {
	return typeof value === 'string' && value.trim().length > 0;
}

function requireNonEmptyStringList(value: unknown, label: string): void {
	expect(Array.isArray(value), `${label} must be an array`).toBe(true);
	const values = value as unknown[];
	expect(values.length, `${label} must not be empty`).toBeGreaterThan(0);
	for (const [index, item] of values.entries()) {
		expect(
			nonEmptyString(item),
			`${label}[${index}] must be a non-empty exact value`,
		).toBe(true);
	}
}

function requireEdgeList(value: unknown, label: string): void {
	expect(Array.isArray(value), `${label} must be an array`).toBe(true);
	const values = value as unknown[];
	expect(values.length, `${label} must not be empty`).toBeGreaterThan(0);
	for (const [index, item] of values.entries()) {
		if (typeof item === 'string') {
			expect(item.trim(), `${label}[${index}] must be non-empty`).not.toBe('');
			expect(item, `${label}[${index}] must name both edge endpoints`).toMatch(
				/\S+\s*(?:->|=>|::)\s*\S+/,
			);
			continue;
		}
		expect(item && typeof item === 'object').toBe(true);
		const edge = item as Record<string, unknown>;
		expect(nonEmptyString(edge.from ?? edge.source)).toBe(true);
		expect(nonEmptyString(edge.to ?? edge.target)).toBe(true);
	}
}

describe('issue #2490 AC8 — held-out multilingual retrieval corpus', () => {
	test('publishes exact symbol/edge expectations and known misses', async () => {
		const module = (await import(
			'../../../tests/fixtures/memory-recall-heldout/manifest.json'
		)) as {
			default?: {
				corpus_id?: string;
				split?: string;
				cases?: Array<Record<string, unknown>>;
			};
		};
		const manifest = module.default ?? module;
		expect(manifest.corpus_id).toBeTruthy();
		expect(manifest.split).toBe('heldout');
		expect(Array.isArray(manifest.cases)).toBe(true);
		expect(manifest.cases?.length ?? 0).toBeGreaterThan(0);
		for (const entry of manifest.cases ?? []) {
			expect(nonEmptyString(entry.language)).toBe(true);
			requireNonEmptyStringList(entry.expected_symbols, 'expected_symbols');
			requireEdgeList(entry.expected_edges, 'expected_edges');
			requireNonEmptyStringList(entry.known_misses, 'known_misses');
			requireEdgeList(entry.spurious_edges, 'spurious_edges');
			expect(nonEmptyString(entry.paraphrase)).toBe(true);
			expect(entry.paraphrase as string).toMatch(/\s/);
			expect((entry.paraphrase as string).trim().length).toBeGreaterThanOrEqual(
				8,
			);
		}
	});
});
