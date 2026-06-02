/**
 * Verifies the deterministic design-doc drift check (issue #1080):
 * DOC_FRESH when docs are newer than their code anchors, DOC_STALE when an
 * anchor changed after its owning doc, NO_DOCS when no design docs / registry
 * exist, the report is persisted under .swarm/, and the check never throws.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDesignDocDriftCheck } from '../../../src/hooks/design-doc-drift';

const OLD = new Date('2024-01-01T00:00:00Z');
const DOC = new Date('2024-02-01T00:00:00Z');
const NEW = new Date('2024-03-01T00:00:00Z');

function write(file: string, content: string, mtime: Date): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, 'utf-8');
	fs.utimesSync(file, mtime, mtime);
}

function scaffold(dir: string): void {
	const docs = path.join(dir, 'docs');
	// All five design docs present, mtime = DOC.
	write(path.join(docs, 'domain.md'), '# domain', DOC);
	write(path.join(docs, 'technical-spec.md'), '# tech', DOC);
	write(path.join(docs, 'behavior-spec.md'), '# behavior', DOC);
	write(path.join(docs, 'reference', 'reference-impl.md'), '# ref', DOC);
	write(path.join(docs, 'reference', 'idiom-notes.md'), '# idiom', DOC);
	// Section S-001 in technical-spec maps to src/foo.ts and FR-001.
	write(
		path.join(docs, 'reference', 'traceability.json'),
		JSON.stringify({
			schema_version: 1,
			sections: [
				{
					section_id: 'S-001',
					doc: 'technical-spec',
					title: 'Foo boundary',
					spec_frs: ['FR-001'],
					invariants: [],
					code_anchors: ['src/foo.ts'],
				},
			],
		}),
		DOC,
	);
	write(path.join(dir, '.swarm', 'spec.md'), 'FR-001 MUST foo', OLD);
}

describe('runDesignDocDriftCheck', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-drift-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reports DOC_FRESH when code anchors are older than the doc', async () => {
		scaffold(dir);
		write(path.join(dir, 'src', 'foo.ts'), 'export const foo = 1', OLD);
		const report = await runDesignDocDriftCheck(dir, 3, 'docs');
		expect(report).not.toBeNull();
		expect(report!.verdict).toBe('DOC_FRESH');
		expect(report!.stale_sections).toHaveLength(0);
	});

	it('reports DOC_STALE when a mapped anchor changed after the doc', async () => {
		scaffold(dir);
		write(path.join(dir, 'src', 'foo.ts'), 'export const foo = 2', NEW);
		const report = await runDesignDocDriftCheck(dir, 4, 'docs');
		expect(report!.verdict).toBe('DOC_STALE');
		expect(report!.stale_sections.map((s) => s.section_id)).toContain('S-001');
	});

	it('reports DOC_STALE when spec.md changed after a doc citing its FR', async () => {
		scaffold(dir);
		write(path.join(dir, 'src', 'foo.ts'), 'export const foo = 1', OLD);
		// Spec touched after the doc; section S-001 cites FR-001.
		fs.utimesSync(path.join(dir, '.swarm', 'spec.md'), NEW, NEW);
		const report = await runDesignDocDriftCheck(dir, 5, 'docs');
		expect(report!.verdict).toBe('DOC_STALE');
	});

	it('reports NO_DOCS when no design docs / registry exist', async () => {
		const report = await runDesignDocDriftCheck(dir, 1, 'docs');
		expect(report!.verdict).toBe('NO_DOCS');
		expect(report!.missing_docs.length).toBeGreaterThan(0);
	});

	it('persists the report under .swarm/doc-drift-phase-N.json', async () => {
		scaffold(dir);
		write(path.join(dir, 'src', 'foo.ts'), 'x', OLD);
		await runDesignDocDriftCheck(dir, 7, 'docs');
		const reportPath = path.join(dir, '.swarm', 'doc-drift-phase-7.json');
		expect(fs.existsSync(reportPath)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
		expect(parsed.phase).toBe(7);
		expect(parsed.schema_version).toBe(1);
	});

	it('ignores code anchors that escape the project root', async () => {
		scaffold(dir);
		// Point the anchor outside the repo — it must be skipped, not crash.
		write(
			path.join(dir, 'docs', 'reference', 'traceability.json'),
			JSON.stringify({
				schema_version: 1,
				sections: [
					{
						section_id: 'S-001',
						doc: 'technical-spec',
						spec_frs: [],
						code_anchors: ['../../etc/passwd'],
					},
				],
			}),
			DOC,
		);
		const report = await runDesignDocDriftCheck(dir, 8, 'docs');
		expect(report!.verdict).toBe('DOC_FRESH');
	});

	it('never throws on a non-existent directory', async () => {
		const ghost = path.join(dir, 'does', 'not', 'exist-yet');
		const report = await runDesignDocDriftCheck(ghost, 9, 'docs');
		// Either a NO_DOCS report or null (fail-open) — but no throw.
		expect(report === null || report.verdict === 'NO_DOCS').toBe(true);
	});

	it('does NOT flag a section whose doc name is unknown (registry error, not drift)', async () => {
		scaffold(dir);
		write(path.join(dir, 'src', 'foo.ts'), 'x', OLD);
		// Add a section referencing a doc name that is not one of the five.
		write(
			path.join(dir, 'docs', 'reference', 'traceability.json'),
			JSON.stringify({
				schema_version: 1,
				sections: [
					{
						section_id: 'G-001',
						doc: 'glossary',
						spec_frs: [],
						code_anchors: ['src/foo.ts'],
					},
				],
			}),
			DOC,
		);
		const report = await runDesignDocDriftCheck(dir, 10, 'docs');
		expect(report!.verdict).toBe('DOC_FRESH');
		expect(report!.stale_sections).toHaveLength(0);
	});

	it('refuses to probe a docs dir outside the project root (out_dir traversal)', async () => {
		const report = await runDesignDocDriftCheck(dir, 11, '../../etc');
		expect(report).toBeNull();
	});

	it('ignores an oversized traceability.json (size cap)', async () => {
		scaffold(dir);
		write(path.join(dir, 'src', 'foo.ts'), 'x', NEW);
		// >1 MiB registry — must be skipped (registry treated as absent → NO_DOCS),
		// not parsed into a DOC_STALE verdict.
		const huge = `{"schema_version":1,"sections":[],"pad":"${'a'.repeat(1024 * 1024 + 16)}"}`;
		write(path.join(dir, 'docs', 'reference', 'traceability.json'), huge, DOC);
		const report = await runDesignDocDriftCheck(dir, 12, 'docs');
		expect(report!.verdict).toBe('NO_DOCS');
	});
});
