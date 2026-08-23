import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	collectCitationResolutionErrors,
	collectCoverageRatchetErrors,
	collectRegistryIdentityErrors,
	collectRetentionRegistryErrors,
	collectRowShapeErrors,
	enumerateWriterModules,
	extractCitationPaths,
	moduleWritesDurableState,
} from '../../../scripts/check-retention-registry';
import type { RetentionRow } from '../../../scripts/retention-registry.data';
import { canonicalTmpDir } from '../../helpers/tmpdir';

/**
 * Fixture-tree tests for the #2036 enumerator — the issue's acceptance
 * scenario: "a static/auditable enumerator catches a newly added durable
 * writer that lacks a registry row and owner." Positive and negative
 * fixtures drive a synthetic tree; the real repo is exercised by
 * `bun run check:retention` in CI.
 */

const fixtureRoot = path.join(
	canonicalTmpDir(),
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
			['await atomicWriteSwarmFileSync(p, data);', true],
			['await atomicWriteFileSync(p, data);', true],
			['await atomicWriteFileAnyRoot(p, data);', true],
			['writeFileFsyncedThenRename(tmp, p, data);', true],
			['writeDurableFileSync(tmp, p, data);', true],
			['const db = new Database(p);', true],
			['const db = new DatabaseSync(p);', true],
			['const Ctor = loadDatabaseCtor();', true],
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

/** A minimal well-formed row used as the base for malformed variants. */
function makeRow(overrides: Partial<RetentionRow> = {}): RetentionRow {
	return {
		id: 'synthetic-row',
		category: 1,
		pathGrammar: '.swarm/synthetic.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/some/writer.ts'],
		writerCitations: ['src/some/writer.ts:1 appendThing'],
		readerCitations: ['src/some/reader.ts:2 readThing — full-file, sync'],
		schemaVersion: 'none',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'cap 100',
			scope: 'global',
			citation: 'src/some/writer.ts:3',
		},
		readBound: {
			pattern: 'indexed',
			bound: 'single file',
			sync: true,
			citation: 'src/some/reader.ts:4',
		},
		lockModel: 'none',
		crashBehavior: 'append',
		closePolicy: 'untouched',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: {
			kind: 'not-a-defect',
			proof: 'bounded queue at src/some/writer.ts:5',
		},
		...overrides,
	} as RetentionRow;
}

describe('row-shape validation negatives (PRR-006/F-001/F-006)', () => {
	test('a well-formed synthetic row produces no shape errors', () => {
		expect(collectRowShapeErrors(makeRow())).toEqual([]);
	});

	test('invalid enum members are rejected at runtime', () => {
		const bad = makeRow({
			stateClass: 'derived' as RetentionRow['stateClass'],
		});
		expect(
			collectRowShapeErrors(bad).some((e) => e.includes('stateClass')),
		).toBe(true);
		const badScope = makeRow({
			writeLimits: {
				bound: 'x',
				scope: 'sometimes' as RetentionRow['writeLimits']['scope'],
				citation: 'src/some/writer.ts:3',
			},
		});
		expect(
			collectRowShapeErrors(badScope).some((e) => e.includes('scope')),
		).toBe(true);
	});

	test('forbidden placeholder text is caught in disposition, read bound, and citations', () => {
		const bad = makeRow({
			readBound: {
				pattern: 'indexed',
				bound: 'unknown today',
				sync: true,
				citation: 'src/some/reader.ts:4',
			},
		});
		expect(collectRowShapeErrors(bad).some((e) => e.includes('unknown'))).toBe(
			true,
		);
		const badCite = makeRow({
			readerCitations: ['src/some/reader.ts:2 — defer to later review'],
		});
		expect(
			collectRowShapeErrors(badCite).some((e) => e.includes('defer')),
		).toBe(true);
	});

	test('empty readerCitations on a non-planned row is rejected', () => {
		const bad = makeRow({ readerCitations: [] });
		expect(
			collectRowShapeErrors(bad).some((e) => e.includes('reader citation')),
		).toBe(true);
	});

	test('verified-unbounded (scope none) with a non-fix disposition is rejected', () => {
		const bad = makeRow({
			writeLimits: {
				bound: 'NONE',
				scope: 'none',
				citation: 'src/some/writer.ts:3',
			},
		});
		expect(
			collectRowShapeErrors(bad).some((e) => e.includes('unbounded')),
		).toBe(true);
	});
});

describe('citation resolution negatives (PRR-002/PRR-006)', () => {
	test('a rotted citation path is reported', () => {
		const bad = makeRow({
			writerCitations: ['src/gone/never-existed.ts:1 appendThing'],
		});
		const errors = collectCitationResolutionErrors(bad, fixtureRoot);
		expect(errors.some((e) => e.includes('rotted citation'))).toBe(true);
	});

	test('a citation that escapes the repo root is reported as malformed', () => {
		const bad = makeRow({
			writerCitations: ['src/../../outside/escape.ts:1 appendThing'],
		});
		const errors = collectCitationResolutionErrors(bad, fixtureRoot);
		expect(errors.some((e) => e.includes('escapes the repo root'))).toBe(true);
	});
});

describe('registry identity negatives (PRR-006)', () => {
	test('duplicate row ids are reported', () => {
		const errors = collectRegistryIdentityErrors([makeRow(), makeRow()]);
		expect(errors.some((e) => e.includes('Duplicate registry row id'))).toBe(
			true,
		);
	});

	test('an empty registry is reported as vacuous', () => {
		const errors = collectRegistryIdentityErrors([]);
		expect(errors.some((e) => e.includes('empty'))).toBe(true);
	});
});

describe('exempt-entry read robustness (PRR-001)', () => {
	test('an exempt entry resolving to a directory produces a clean error, not a crash', () => {
		fs.mkdirSync(path.join(fixtureRoot, 'src/exemptdir'), { recursive: true });
		const errors = collectCoverageRatchetErrors(fixtureRoot, [], {
			'src/exemptdir': 'test plumbing',
		});
		expect(errors.some((e) => e.includes('unreadable'))).toBe(true);
	});
});

describe('real-repo gate (slow path, mirrors CI)', () => {
	// NOTE: the collector scans the LIVE working tree, so an untracked writer
	// file under src/ on a developer machine fails this test (CI's clean
	// checkout is unaffected). That is intended fail-closed behavior — the
	// gate demands registration of in-progress writers too (PRR-007).
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
