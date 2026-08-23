import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	collectCoverageRatchetErrors,
	collectRetentionRegistryErrors,
	enumerateWriterModules,
	extractCitationPaths,
	moduleWritesDurableState,
} from '../../../scripts/check-retention-registry';

/**
 * Fixture-tree tests for the #2036 enumerator — the issue's acceptance
 * scenario: "a static/auditable enumerator catches a newly added durable
 * writer that lacks a registry row and owner." Positive and negative
 * fixtures drive a synthetic tree; the real repo is exercised by
 * `bun run check:retention` in CI.
 */

const fixtureRoot = path.join(
	fs.realpathSync(os.tmpdir()),
	`retention-registry-fixture-${randomUUID()}`,
);

function writeModule(rel: string, source: string): void {
	const abs = path.join(fixtureRoot, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, source, 'utf-8');
}

afterAll(() => {
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('writer detection patterns', () => {
	test('detects every enumerated write API shape', () => {
		const cases: Array<[string, boolean]> = [
			['export const w = (p: string) => fs.writeFileSync(p, "");', true],
			['export const w = (p: string) => fsPromises.writeFile(p, "");', true],
			['await writeFile(p, "");', true],
			['fs.appendFileSync(p, line);', true],
			['await appendFile(p, line);', true],
			['createWriteStream(p, { flags: "a" });', true],
			['await bunWrite(p, data);', true],
			['await atomicWriteFile(p, data);', true],
			['await atomicWriteSwarmFile(p, data);', true],
			['writeFileFsyncedThenRename(tmp, p, data);', true],
			['writeDurableFileSync(tmp, p, data);', true],
			['const db = new Database(p);', true],
			['const db = getProjectDb(dir);', true],
			['const db = getGlobalDb();', true],
			// Non-writers must stay invisible.
			['const x = fs.readFileSync(p, "utf-8");', false],
			['const y = JSON.parse(text);', false],
			['// fs.writeFileSync(p, "") — commented out', false],
		];
		for (const [source, expected] of cases) {
			expect(moduleWritesDurableState(source)).toBe(expected);
		}
	});

	test('commented-out writes do not count (line-comment stripping)', () => {
		const source = [
			'// await writeFile(p, data);',
			'const value = compute();',
			'',
		].join('\n');
		expect(moduleWritesDurableState(source)).toBe(false);
	});
});

describe('fixture-tree coverage ratchet', () => {
	test('positive fixture: registered writer + exempt plumbing passes', () => {
		writeModule(
			'src/owned/writer.ts',
			'import * as fs from "node:fs";\nexport const w = (p: string) => fs.writeFileSync(p, "");\n',
		);
		writeModule(
			'src/owned/helper.ts',
			'import * as fs from "node:fs";\nexport const h = (p: string) => fs.writeFileSync(p, "");\n',
		);
		writeModule('src/owned/reader.ts', 'export const r = 1;\n');
		const rows = [{ writerModules: ['src/owned/writer.ts'] }];
		const exempt = { 'src/owned/helper.ts': 'test plumbing' };
		const errors = collectCoverageRatchetErrors(fixtureRoot, rows, exempt);
		expect(errors).toEqual([]);
	});

	test('negative fixture: unregistered writer fails with an actionable message', () => {
		writeModule(
			'src/rogue/new-writer.ts',
			'import * as fs from "node:fs";\nexport const w = (p: string) => fs.writeFileSync(p, "");\n',
		);
		const errors = collectCoverageRatchetErrors(fixtureRoot, [], {});
		const hit = errors.find((e) => e.includes('src/rogue/new-writer.ts'));
		expect(hit).toBeDefined();
		expect(hit ?? '').toContain('no retention-registry row');
	});

	test('negative fixture: stale exempt module (stopped writing) is flagged', () => {
		writeModule('src/owned/helper.ts', 'export const h = 2;\n');
		const errors = collectCoverageRatchetErrors(fixtureRoot, [], {
			'src/owned/helper.ts': 'test plumbing',
		});
		expect(
			errors.some(
				(e) =>
					e.includes('src/owned/helper.ts') && e.includes('stale exemption'),
			),
		).toBe(true);
	});

	test('negative fixture: declared-but-missing module is flagged', () => {
		const errors = collectCoverageRatchetErrors(
			fixtureRoot,
			[{ writerModules: ['src/gone/moved-writer.ts'] }],
			{},
		);
		expect(
			errors.some(
				(e) =>
					e.includes('src/gone/moved-writer.ts') &&
					e.includes('no longer exists'),
			),
		).toBe(true);
	});

	test('empty tree trips the broken-scanner guard, not a vacuous pass', () => {
		const emptyRoot = path.join(fixtureRoot, 'empty');
		fs.mkdirSync(emptyRoot, { recursive: true });
		const errors = collectCoverageRatchetErrors(emptyRoot, [], {});
		expect(errors.some((e) => e.includes('scanned 0 modules'))).toBe(true);
	});
});

describe('citation path extraction', () => {
	test('extracts repo-relative source/doc paths from citation prose', () => {
		const citation =
			'src/telemetry.ts:291 emit() — see docs/observability-event-contract.md §4 for the projection';
		const paths = extractCitationPaths(citation);
		expect(paths).toContain('src/telemetry.ts');
		expect(paths).toContain('docs/observability-event-contract.md');
	});

	test('returns empty for citations without repo paths', () => {
		expect(extractCitationPaths('issue #2036 Required 1-5')).toEqual([]);
	});
});

describe('real-repo gate (slow path, mirrors CI)', () => {
	test('the full collector passes on the actual repository tree', () => {
		const errors = collectRetentionRegistryErrors();
		expect(errors).toEqual([]);
	});

	test('enumerator finds a substantial writer population on the real tree', () => {
		const repoRoot = path.resolve(import.meta.dir, '../../..');
		const writers = enumerateWriterModules(repoRoot);
		expect(writers.length).toBeGreaterThan(100);
		expect(writers.every((w) => w.startsWith('src/'))).toBe(true);
	});
});
