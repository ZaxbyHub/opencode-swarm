import { describe, expect, test } from 'bun:test';
import { collectCloseLifecycleCoherenceErrors } from '../../../scripts/check-retention-registry';
import {
	RETENTION_REGISTRY,
	SQLITE_ARTIFACTS_EXEMPT_FROM_ARCHIVE_CLEAN,
} from '../../../scripts/retention-registry.data';
import {
	baselineRows,
	closeFacts,
	retentionRow,
} from '../../helpers/close-lifecycle-fixtures';

/**
 * Issue #1534 recurrence guardrail — the "declare `neither` and pass" escape.
 *
 * Rules (b) and (c) key on REAL close.ts array membership, so an author who
 * declares a brand-new `.swarm/*.sqlite` as `neither` AND leaves it out of both
 * arrays satisfies every other rule: the declaration matches reality, and
 * neither SQLite rule fires because the artifact is in no array. That is
 * sub-defect (a) reintroduced verbatim — a WAL-mode database orphaned on disk
 * across `/swarm close`. These tests pin the rule that shuts it.
 */

const collect = (
	rows: ReturnType<typeof baselineRows>,
	facts: ReturnType<typeof closeFacts>,
	sqliteExempt: Readonly<Record<string, string>> = {},
): string[] =>
	collectCloseLifecycleCoherenceErrors(rows, facts, [], [], sqliteExempt);

/** close.ts with repo-memory.sqlite removed from every wiring. */
const unwired = () =>
	closeFacts({
		archiveArtifacts: ['swarm.db', 'plan.json'],
		activeStateToClean: ['swarm.db', 'plan.json'],
		sqliteArchiveDispatch: ['swarm.db'],
		sqliteCleanHandleClose: ['swarm.db'],
	});

/** Rows where repo-memory.sqlite is declared `neither` — matching `unwired()`. */
const declaredNeither = () => [
	retentionRow({ closeArrayMembership: { 'repo-memory.sqlite': 'neither' } }),
	...baselineRows().slice(1),
];

describe('a SQLite artifact may not be declared anything but archive+clean', () => {
	test('the escape fires even though the declaration matches close.ts', () => {
		const errs = collect(declaredNeither(), unwired());
		expect(errs.join('\n')).toContain(
			'declares the SQLite artifact "repo-memory.sqlite" as "neither", not "archive+clean"',
		);
	});

	test('no OTHER rule fires on that state — this rule is the only guard', () => {
		const errs = collect(declaredNeither(), unwired());
		expect(errs).toHaveLength(1);
	});

	test('archive-only and clean-only are rejected too', () => {
		for (const declared of ['archive-only', 'clean-only'] as const) {
			const errs = collect(
				[
					retentionRow({
						closeArrayMembership: { 'repo-memory.sqlite': declared },
					}),
					...baselineRows().slice(1),
				],
				closeFacts(),
			);
			expect(errs.join('\n')).toContain(
				`as "${declared}", not "archive+clean"`,
			);
		}
	});

	test('a reviewed exemption is the only way through', () => {
		const errs = collect(declaredNeither(), unwired(), {
			'repo-memory.sqlite': 'reviewed reason',
		});
		expect(errs).toEqual([]);
	});

	test('a stale exemption must be removed — the map may only shrink', () => {
		const errs = collect(baselineRows(), closeFacts(), {
			'gone.sqlite': 'stale',
		});
		expect(errs.join('\n')).toContain(
			'no registry row declares it any more — remove the stale exemption',
		);
	});

	test('non-SQLite artifacts are unaffected by the rule', () => {
		const errs = collect(
			[
				retentionRow({
					id: 'md',
					pathGrammar: '.swarm/notes.md',
					closeArrayMembership: { 'notes.md': 'neither' },
				}),
				...baselineRows(),
			],
			closeFacts(),
		);
		expect(errs).toEqual([]);
	});

	test('the real exemption map is empty — both .swarm/ DBs are archive+clean', () => {
		expect(SQLITE_ARTIFACTS_EXEMPT_FROM_ARCHIVE_CLEAN).toEqual({});
		const sqliteDeclarations = RETENTION_REGISTRY.flatMap((r) =>
			Object.entries(r.closeArrayMembership ?? {}).filter(([file]) =>
				/\.(?:db|sqlite|sqlite3)$/i.test(file),
			),
		);
		expect(sqliteDeclarations.sort()).toEqual([
			['repo-memory.sqlite', 'archive+clean'],
			['swarm.db', 'archive+clean'],
		]);
	});
});
