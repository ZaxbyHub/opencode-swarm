import { describe, expect, test } from 'bun:test';
import {
	DISPOSITION_FORBIDDEN_STRINGS,
	EXEMPT_WRITER_MODULES,
	RETENTION_ISSUE_SEQUENCE,
	RETENTION_REGISTRY,
	RETENTION_REGISTRY_SUMMARY,
	type RetentionRow,
} from '../../../scripts/retention-registry.data';

/**
 * Row-data validation for the #2036 retention registry: completeness,
 * disposition legality, sequence-window bounds, and the no-waiver rule.
 * The doc-coherence contract is covered by retention-registry-doc.test.ts;
 * the fixture-tree enumerator behavior by check-retention-registry.test.ts.
 */

const REQUIRED_STRING_FIELDS = [
	'schemaVersion',
	'lockModel',
	'crashBehavior',
	'closePolicy',
	'resetPolicy',
	'legacyCompatibility',
	'healthSignal',
	'owner',
] as const;

function rows(): RetentionRow[] {
	return RETENTION_REGISTRY as RetentionRow[];
}

describe('retention registry rows — shape completeness', () => {
	test('registry is non-empty and summary matches the data', () => {
		expect(RETENTION_REGISTRY.length).toBeGreaterThan(50);
		expect(RETENTION_REGISTRY_SUMMARY.rowCount).toBe(RETENTION_REGISTRY.length);
		const byKind = (kind: string) =>
			RETENTION_REGISTRY.filter((r) => r.disposition.kind === kind).length;
		expect(RETENTION_REGISTRY_SUMMARY.fixInIssue).toBe(byKind('fix-in-issue'));
		expect(RETENTION_REGISTRY_SUMMARY.retainByDesign).toBe(
			byKind('retain-by-design'),
		);
		expect(RETENTION_REGISTRY_SUMMARY.notADefect).toBe(byKind('not-a-defect'));
	});

	test('row ids are unique non-empty slugs', () => {
		const ids = new Set<string>();
		for (const row of rows()) {
			expect(row.id).toBeTruthy();
			expect(ids.has(row.id)).toBe(false);
			ids.add(row.id);
		}
	});

	test('every row carries all required string fields and citation arrays', () => {
		const violations: string[] = [];
		for (const row of rows()) {
			for (const field of REQUIRED_STRING_FIELDS) {
				if (String(row[field]).trim().length === 0) {
					violations.push(`${row.id}: field "${field}" is empty`);
				}
			}
			if (row.pathGrammar.trim().length === 0)
				violations.push(`${row.id}: pathGrammar empty`);
			if (row.category < 1 || row.category > 9)
				violations.push(`${row.id}: category out of range`);
			if (row.canonicalRoot !== 'planned') {
				if (row.writerModules.length === 0)
					violations.push(`${row.id}: no writerModules`);
				if (row.writerCitations.length === 0)
					violations.push(`${row.id}: no writerCitations`);
			}
			if (row.writeLimits.bound.trim().length === 0)
				violations.push(`${row.id}: writeLimits.bound empty`);
			if (row.writeLimits.citation.trim().length === 0)
				violations.push(`${row.id}: writeLimits.citation empty`);
			if (row.readBound.pattern.trim().length === 0)
				violations.push(`${row.id}: readBound.pattern empty`);
			if (row.readBound.bound.trim().length === 0)
				violations.push(`${row.id}: readBound.bound empty`);
			if (row.readBound.citation.trim().length === 0)
				violations.push(`${row.id}: readBound.citation empty`);
		}
		expect(violations).toEqual([]);
	});

	test('planned rows (category 9) declare no writer modules', () => {
		for (const row of rows()) {
			if (row.category === 9) {
				expect(row.canonicalRoot).toBe('planned');
				expect(row.writerModules).toHaveLength(0);
			}
		}
	});
});

describe('retention registry rows — disposition rules (issue #2036)', () => {
	test('every disposition is one of the three allowed kinds', () => {
		const allowed = new Set([
			'fix-in-issue',
			'retain-by-design',
			'not-a-defect',
		]);
		for (const row of rows()) {
			expect(allowed.has(row.disposition.kind)).toBe(true);
		}
	});

	test('fix-in-issue dispositions reference the sequence window or the #2309 amendment', () => {
		const { first, last, amendment } = RETENTION_ISSUE_SEQUENCE;
		for (const row of rows()) {
			const d = row.disposition;
			if (d.kind !== 'fix-in-issue') continue;
			expect(d.issue).toBeGreaterThanOrEqual(first);
			expect(d.issue <= last || d.issue === amendment).toBe(true);
			expect(d.note.trim().length).toBeGreaterThan(0);
		}
	});

	test('retain-by-design and not-a-defect dispositions carry citations/proofs', () => {
		for (const row of rows()) {
			const d = row.disposition;
			if (d.kind === 'retain-by-design') {
				expect(d.citation.trim().length).toBeGreaterThan(20);
			}
			if (d.kind === 'not-a-defect') {
				expect(d.proof.trim().length).toBeGreaterThan(20);
			}
		}
	});

	test('no row carries forbidden placeholder dispositions (no owner waiver)', () => {
		for (const row of rows()) {
			const texts: string[] = [];
			const d = row.disposition as unknown as Record<string, unknown>;
			for (const value of Object.values(d)) {
				if (typeof value === 'string') texts.push(value);
			}
			texts.push(row.writeLimits.bound);
			for (const forbidden of DISPOSITION_FORBIDDEN_STRINGS) {
				for (const text of texts) {
					expect(`${row.id} must not contain "${forbidden}"`).toBe(
						`${row.id} must not contain "${forbidden}"`,
					);
					expect(text.toLowerCase().includes(forbidden.toLowerCase())).toBe(
						false,
					);
				}
			}
		}
	});

	test('every verified-unbounded stream (scope none) is a fix-in-issue row', () => {
		for (const row of rows()) {
			if (row.writeLimits.scope === 'none') {
				expect(`${row.id} is unbounded and must be fix-in-issue`).toBe(
					`${row.id} is unbounded and must be fix-in-issue`,
				);
				expect(row.disposition.kind).toBe('fix-in-issue');
			}
		}
	});
});

describe('retention registry rows — coverage plumbing', () => {
	test('exempt writer modules each state a reason', () => {
		for (const [modulePath, reason] of Object.entries(EXEMPT_WRITER_MODULES)) {
			expect(modulePath.startsWith('src/')).toBe(true);
			expect(reason.trim().length).toBeGreaterThan(10);
		}
	});

	test('no module is both exempt and a row writer', () => {
		const exempt = new Set(Object.keys(EXEMPT_WRITER_MODULES));
		for (const row of rows()) {
			for (const m of row.writerModules) {
				expect(exempt.has(m)).toBe(false);
			}
		}
	});

	test('writer modules use forward-slash repo-relative paths under src/', () => {
		for (const row of rows()) {
			for (const m of row.writerModules) {
				expect(m.startsWith('src/')).toBe(true);
				expect(m.includes('\\')).toBe(false);
				expect(m.endsWith('.ts')).toBe(true);
			}
		}
	});
});
