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
});
