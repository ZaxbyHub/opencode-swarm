import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	collectCloseLifecycleCoherenceErrors,
	extractFlatSwarmFiles,
	loadCloseLifecycleFacts,
} from '../../../scripts/check-retention-registry';
import {
	type CloseLifecycleFacts,
	isSqliteArtifact,
	parseCloseLifecycleFacts,
} from '../../../scripts/close-lifecycle-facts';
import {
	CLOSE_ARTIFACTS_WITHOUT_REGISTRY_ROW,
	PROJECT_SWARM_ROWS_WITH_INDIRECT_ROOT,
	RETENTION_REGISTRY,
	type RetentionRow,
} from '../../../scripts/retention-registry.data';
import {
	baselineRows,
	closeFacts,
	retentionRow,
} from '../../helpers/close-lifecycle-fixtures';

/**
 * Issue #1534 recurrence guardrail — regression family for the close-lifecycle
 * coherence gate. The defect class: a durable `.swarm/` artifact whose creation
 * is wired but whose `/swarm close` lifecycle is not, in three sub-forms —
 * (a) missing from close.ts's archive/clean arrays, (b) a SQLite artifact
 * archived by raw copy instead of `archiveSqliteSnapshot` (VACUUM INTO),
 * (c) the cached handle not closed before `fs.unlink` (Windows-only EBUSY).
 * Every test below asserts the gate FIRES on one of those, or that the real
 * repo is coherent.
 */

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
);

const IDENTS: Record<string, string> = {
	REPO_MEMORY_FILENAME: 'repo-memory.sqlite',
};
const resolve = (name: string): string | undefined => IDENTS[name];

const BASELINE_ROWS: RetentionRow[] = baselineRows();

const collect = (
	rows: RetentionRow[],
	f: CloseLifecycleFacts,
	allowlist: readonly string[] = [],
	sqliteExempt: Readonly<Record<string, string>> = {},
): string[] =>
	collectCloseLifecycleCoherenceErrors(rows, f, allowlist, [], sqliteExempt);

describe('close.ts source parsing (fail-closed)', () => {
	const source = [
		"const ARCHIVE_ARTIFACTS = [\n\t'plan.json',\n\t// a comment entry\n\tREPO_MEMORY_FILENAME,\n];",
		"const ACTIVE_STATE_TO_CLEAN = [\n\t'plan.json',\n];",
		"if (artifact === 'swarm.db' || artifact === REPO_MEMORY_FILENAME) {\n\tconst r = await archiveSqliteSnapshot({ sourcePath });\n}",
		"if (artifact === 'swarm.db') {\n\ttry {\n\t\tcloseProjectDb(dir);\n\t} catch {}\n}",
		'if (artifact === REPO_MEMORY_FILENAME) {\n\t_internals.closeRepoMemory(dir);\n}',
	].join('\n\n');

	test('resolves string literals, identifiers, and skips comments', () => {
		const f = parseCloseLifecycleFacts(source, resolve);
		expect(f.parseErrors).toEqual([]);
		expect(f.archiveArtifacts).toEqual(['plan.json', 'repo-memory.sqlite']);
		expect(f.activeStateToClean).toEqual(['plan.json']);
	});

	test('extracts the VACUUM INTO dispatch and handle-close guard sets', () => {
		const f = parseCloseLifecycleFacts(source, resolve);
		expect(f.sqliteArchiveDispatch).toEqual(['swarm.db', 'repo-memory.sqlite']);
		expect(f.sqliteCleanHandleClose).toEqual([
			'swarm.db',
			'repo-memory.sqlite',
		]);
	});

	test('an unresolvable identifier is an error, never a dropped artifact', () => {
		const f = parseCloseLifecycleFacts(source, () => undefined);
		expect(f.archiveArtifacts).not.toContain('repo-memory.sqlite');
		expect(f.parseErrors.join('\n')).toContain(
			'could not be resolved to a string literal',
		);
	});

	test('an unrecognised array entry is an error, never silently skipped', () => {
		const f = parseCloseLifecycleFacts(
			"const ARCHIVE_ARTIFACTS = [\n\t...SPREAD_ME,\n];\n\nconst ACTIVE_STATE_TO_CLEAN = [\n\t'plan.json',\n];",
			resolve,
		);
		expect(f.parseErrors.join('\n')).toContain('unrecognised');
	});

	test('a missing array declaration is an error, not an empty set', () => {
		const f = parseCloseLifecycleFacts("const OTHER = [\n\t'x',\n];", resolve);
		expect(f.parseErrors.join('\n')).toContain(
			'could not locate the `const ARCHIVE_ARTIFACTS',
		);
	});

	test('a missing archiveSqliteSnapshot call site is an error', () => {
		const f = parseCloseLifecycleFacts(
			"const ARCHIVE_ARTIFACTS = [\n\t'plan.json',\n];\n\nconst ACTIVE_STATE_TO_CLEAN = [\n\t'plan.json',\n];",
			resolve,
		);
		expect(f.parseErrors.join('\n')).toContain(
			'no `archiveSqliteSnapshot({` call site found',
		);
	});

	test('an if-block without a closeXxx call is not a handle-close guard', () => {
		const f = parseCloseLifecycleFacts(
			`${source}\n\nif (artifact === 'plan.json') {\n\tawait fs.unlink(p);\n}`,
			resolve,
		);
		expect(f.sqliteCleanHandleClose).not.toContain('plan.json');
	});

	test('isSqliteArtifact matches .db/.sqlite/.sqlite3 only', () => {
		expect(isSqliteArtifact('swarm.db')).toBe(true);
		expect(isSqliteArtifact('repo-memory.sqlite')).toBe(true);
		expect(isSqliteArtifact('x.sqlite3')).toBe(true);
		expect(isSqliteArtifact('plan.json')).toBe(false);
		expect(isSqliteArtifact('swarm.db-wal')).toBe(false);
	});
});

describe('extractFlatSwarmFiles', () => {
	test('reads plain tokens and brace lists', () => {
		expect(extractFlatSwarmFiles('.swarm/plan.json + .swarm/plan.md')).toEqual([
			'plan.json',
			'plan.md',
		]);
		expect(extractFlatSwarmFiles('.swarm/{a.md, b.json}')).toEqual([
			'a.md',
			'b.json',
		]);
	});

	test('never guesses sidecar shorthand, and never claims directories', () => {
		expect(
			extractFlatSwarmFiles(
				'.swarm/background-delegations.jsonl (+ .checkpoint.json)',
			),
		).toEqual(['background-delegations.jsonl']);
		expect(extractFlatSwarmFiles('.swarm/evidence/{id}/report.json')).toEqual(
			[],
		);
	});
});

describe('anti-vacuous anchors', () => {
	test('parse errors are surfaced verbatim', () => {
		const errs = collect(BASELINE_ROWS, closeFacts({ parseErrors: ['boom'] }));
		expect(errs).toContain('boom');
	});

	test('an empty ARCHIVE_ARTIFACTS fails instead of passing vacuously', () => {
		const errs = collect(
			[
				retentionRow({
					closeArrayMembership: { 'repo-memory.sqlite': 'clean-only' },
				}),
			],
			closeFacts({ archiveArtifacts: [] }),
		);
		expect(errs.join('\n')).toContain('ARCHIVE_ARTIFACTS parsed as EMPTY');
	});

	test('an empty ACTIVE_STATE_TO_CLEAN fails instead of passing vacuously', () => {
		const errs = collect(BASELINE_ROWS, closeFacts({ activeStateToClean: [] }));
		expect(errs.join('\n')).toContain('ACTIVE_STATE_TO_CLEAN parsed as EMPTY');
	});

	test('losing swarm.db from the VACUUM INTO dispatch set is parser rot', () => {
		const errs = collect(
			BASELINE_ROWS,
			closeFacts({ sqliteArchiveDispatch: ['repo-memory.sqlite'] }),
		);
		expect(errs.join('\n')).toContain('does not contain "swarm.db"');
	});

	test('losing swarm.db from the handle-close set is parser rot', () => {
		const errs = collect(
			BASELINE_ROWS,
			closeFacts({ sqliteCleanHandleClose: ['repo-memory.sqlite'] }),
		);
		expect(errs.join('\n')).toContain(
			'closeProjectDb has guarded the swarm.db unlink',
		);
	});

	test('the coherent baseline produces no errors', () => {
		expect(collect(BASELINE_ROWS, closeFacts())).toEqual([]);
	});
});

describe('sub-defect (a) — artifact missing from the close.ts arrays', () => {
	test('a declared archive+clean artifact absent from both arrays fails', () => {
		const errs = collect(
			BASELINE_ROWS,
			closeFacts({
				archiveArtifacts: ['swarm.db', 'plan.json'],
				activeStateToClean: ['swarm.db', 'plan.json'],
				sqliteArchiveDispatch: ['swarm.db'],
				sqliteCleanHandleClose: ['swarm.db'],
			}),
		);
		expect(errs.join('\n')).toContain(
			'declares "repo-memory.sqlite" as "archive+clean" but src/commands/close.ts actually has it as "neither"',
		);
	});

	test('archived-but-not-cleaned is caught as a partial wiring', () => {
		const errs = collect(
			BASELINE_ROWS,
			closeFacts({ activeStateToClean: ['swarm.db', 'plan.json'] }),
		);
		expect(errs.join('\n')).toContain('actually has it as "archive-only"');
	});

	test('a project-swarm row naming a flat file must declare it', () => {
		const errs = collect(
			[
				...BASELINE_ROWS,
				retentionRow({
					id: 'undeclared',
					pathGrammar: '.swarm/ghost.json',
					closeArrayMembership: undefined,
				}),
			],
			closeFacts(),
		);
		expect(errs.join('\n')).toContain(
			'pathGrammar names the flat .swarm/ artifact "ghost.json" but closeArrayMembership does not declare it',
		);
	});

	test('a prose-y pathGrammar cannot dodge the declaration requirement', () => {
		const errs = collect(
			[
				...BASELINE_ROWS,
				retentionRow({ id: 'prosey', pathGrammar: 'somewhere else' }),
			],
			closeFacts(),
		);
		expect(errs.join('\n')).toContain('does not start with ".swarm/"');
	});

	test('non-project-swarm rows are out of scope', () => {
		const errs = collect(
			[
				...BASELINE_ROWS,
				retentionRow({
					id: 'global',
					canonicalRoot: 'platform-config',
					pathGrammar: '~/.config/opencode/global-rules.db',
					closeArrayMembership: undefined,
				}),
			],
			closeFacts(),
		);
		expect(errs).toEqual([]);
	});
});

describe('sub-defect (b) — SQLite archived without VACUUM INTO', () => {
	test('an archived SQLite artifact outside the dispatch set fails', () => {
		const errs = collect(
			BASELINE_ROWS,
			closeFacts({ sqliteArchiveDispatch: ['swarm.db'] }),
		);
		expect(errs.join('\n')).toContain(
			'archives the SQLite artifact "repo-memory.sqlite" but does NOT route it through archiveSqliteSnapshot',
		);
	});

	test('non-SQLite artifacts are not held to the VACUUM INTO rule', () => {
		expect(
			collect(BASELINE_ROWS, closeFacts()).filter((e) =>
				e.includes('plan.json'),
			),
		).toEqual([]);
	});
});

describe('sub-defect (c) — SQLite cleaned without closing the handle', () => {
	test('a cleaned SQLite artifact with no handle-close guard fails', () => {
		const errs = collect(
			BASELINE_ROWS,
			closeFacts({ sqliteCleanHandleClose: ['swarm.db'] }),
		);
		expect(errs.join('\n')).toContain(
			'never closes its cached handle before fs.unlink',
		);
	});

	// NOTE: 'archive-only' is NOT generally acceptable for a SQLite artifact —
	// SQLITE_ARTIFACTS_EXEMPT_FROM_ARCHIVE_CLEAN is the ONLY path to a
	// non-archive+clean declaration (see check-retention-close-lifecycle-sqlite).
	test('an EXEMPTED archive-only SQLite artifact needs no handle-close guard', () => {
		const errs = collect(
			[
				retentionRow({
					closeArrayMembership: { 'repo-memory.sqlite': 'archive-only' },
				}),
				...BASELINE_ROWS.slice(1),
			],
			closeFacts({
				activeStateToClean: ['swarm.db', 'plan.json'],
				sqliteCleanHandleClose: ['swarm.db'],
			}),
			[],
			{ 'repo-memory.sqlite': 'reviewed reason' },
		);
		expect(errs).toEqual([]);
	});
});

describe('close.ts -> registry totality', () => {
	test('a new artifact wired into close.ts with no row fails', () => {
		const errs = collect(
			BASELINE_ROWS,
			closeFacts({
				archiveArtifacts: [...closeFacts().archiveArtifacts, 'ghost.sqlite'],
			}),
		);
		expect(errs.join('\n')).toContain(
			'close.ts wires the artifact "ghost.sqlite" into its archive/clean arrays but no registry row declares it',
		);
	});

	test('two rows declaring the same artifact is a contradiction risk', () => {
		const errs = collect(
			[...BASELINE_ROWS, retentionRow({ id: 'duplicate' })],
			closeFacts(),
		);
		expect(errs.join('\n')).toContain('is declared by 2 registry rows');
	});

	test('an allowlisted artifact is tolerated', () => {
		const errs = collect(
			BASELINE_ROWS,
			closeFacts({
				archiveArtifacts: [...closeFacts().archiveArtifacts, 'legacy.md'],
			}),
			['legacy.md'],
		);
		expect(errs).toEqual([]);
	});

	test('the allowlist may only shrink — a now-declared entry must go', () => {
		const errs = collect(BASELINE_ROWS, closeFacts(), ['plan.json']);
		expect(errs.join('\n')).toContain(
			'but a registry row now declares it — remove the allowlist entry',
		);
	});

	test('the allowlist may only shrink — an unwired entry must go', () => {
		const errs = collect(BASELINE_ROWS, closeFacts(), ['gone.md']);
		expect(errs.join('\n')).toContain('close.ts no longer wires it');
	});

	test('a stale declaration for an unwired artifact is caught', () => {
		const errs = collect(
			[
				...BASELINE_ROWS,
				retentionRow({
					id: 'stale',
					pathGrammar: '.swarm/removed.json',
					closeArrayMembership: { 'removed.json': 'archive+clean' },
				}),
			],
			closeFacts(),
		);
		expect(errs.join('\n')).toContain(
			'declares "removed.json" as "archive+clean" but src/commands/close.ts actually has it as "neither"',
		);
	});
});

describe('the real repository is coherent', () => {
	const real = loadCloseLifecycleFacts(REPO_ROOT);

	test('close.ts parses with no fail-closed diagnostics', () => {
		expect(real.parseErrors).toEqual([]);
		expect(real.archiveArtifacts.length).toBeGreaterThan(10);
		expect(real.activeStateToClean.length).toBeGreaterThan(10);
	});

	test('both SQLite artifacts are VACUUM INTO-archived and handle-closed', () => {
		expect(real.sqliteArchiveDispatch).toEqual([
			'swarm.db',
			'repo-memory.sqlite',
		]);
		expect(real.sqliteCleanHandleClose).toEqual([
			'swarm.db',
			'repo-memory.sqlite',
		]);
	});

	test('.swarm/ holds exactly two SQLite artifacts, both fully wired', () => {
		const sqlite = [
			...new Set([...real.archiveArtifacts, ...real.activeStateToClean]),
		].filter(isSqliteArtifact);
		expect(sqlite.sort()).toEqual(['repo-memory.sqlite', 'swarm.db']);
	});

	test('the live registry is coherent with the live close.ts', () => {
		expect(
			collectCloseLifecycleCoherenceErrors(RETENTION_REGISTRY, real),
		).toEqual([]);
	});

	test('repo-memory.sqlite is declared archive+clean by exactly one row', () => {
		const owners = RETENTION_REGISTRY.filter(
			(r) => r.closeArrayMembership?.['repo-memory.sqlite'] === 'archive+clean',
		).map((r) => r.id);
		expect(owners).toEqual(['repo-memory-index']);
	});

	test('the frozen allowlists are pinned so growth is a test failure', () => {
		expect([...CLOSE_ARTIFACTS_WITHOUT_REGISTRY_ROW]).toEqual([
			'close-lessons.md',
		]);
		expect([...PROJECT_SWARM_ROWS_WITH_INDIRECT_ROOT]).toEqual([
			'recommendation-ledger',
			'curation-proposals',
			// issue #2480: swarm.db table rows — the physical artifact is owned
			// by the project-db row; these own the logical tables + legacy files.
			'insight-candidates',
			// issue #2482: swarm.db observability_event tables — physical
			// artifact owned by the project-db row.
			'observability-events-sqlite',
			'drift-reports',
			'doc-drift-signals',
		]);
	});
});
